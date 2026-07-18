/**
 * DOVAKO OS prepaid cards.
 * A card is paid when purchased and one session is consumed only after a
 * matching booking is completed. This prevents double-counting revenue.
 */
class PrepaidService {
  static get CARD_TABLE() { return CONFIG.SHEETS.PREPAID_CARDS; }
  static get USAGE_TABLE() { return CONFIG.SHEETS.PREPAID_USAGE; }

  static get CARD_HEADERS() {
    return [
      'CardID', 'CustomerID', 'ServiceID', 'ServiceName', 'PurchasedDate',
      'PaidSessions', 'BonusSessions', 'TotalSessions', 'UsedSessions',
      'RemainingSessions', 'UnitPrice', 'DiscountPercent', 'DiscountAmount',
      'PaidAmount', 'Status', 'Note', 'CreatedDate', 'UpdatedDate'
    ];
  }

  static get USAGE_HEADERS() {
    return ['UsageID', 'CardID', 'BookingID', 'CustomerID', 'ServiceID', 'UsedSessions', 'CreatedDate'];
  }

  static initialize() {
    Database.ensureTable(this.CARD_TABLE, this.CARD_HEADERS);
    Database.ensureTable(this.USAGE_TABLE, this.USAGE_HEADERS);
  }

  static options() {
    this.initialize();
    CatalogService.initialize();
    return {
      customers: CustomerService.list({ includeInactive: false }),
      services: CatalogService.services(false),
      discountOptions: (CONFIG.PREPAID && CONFIG.PREPAID.DISCOUNT_OPTIONS) || [20, 25],
      bonusSessions: this.bonusSessions(),
      nearEndRemaining: this.nearEndRemaining()
    };
  }

  static list(options) {
    this.initialize();
    const settings = options || {};
    const customerId = settings.customerId ? Validator.required(settings.customerId, 'Mã khách hàng') : '';
    const includeInactive = settings.includeInactive === true;
    const cards = Database.findAll(this.CARD_TABLE).filter(function (card) {
      if (customerId && card.CustomerID !== customerId) return false;
      return includeInactive || card.Status !== 'Inactive';
    });
    return cards.sort(function (left, right) {
      return new Date(right.PurchasedDate || 0).getTime() - new Date(left.PurchasedDate || 0).getTime();
    });
  }

  static create(input) {
    this.initialize();
    CatalogService.initialize();
    const data = input || {};
    const customerId = Validator.required(data.CustomerID, 'Khách hàng');
    const serviceId = Validator.required(data.ServiceID, 'Dịch vụ');
    const customer = CustomerService.get(customerId);
    if (!customer || customer.Status === CONFIG.CUSTOMER_STATUS.INACTIVE || customer.Status === CONFIG.CUSTOMER_STATUS.BLACKLIST) {
      throw new Error('Khách hàng hiện không thể mua thẻ trả trước.');
    }
    const service = CatalogService.services(false).find(function (item) { return item.ServiceID === serviceId; });
    if (!service) throw new Error('Không tìm thấy dịch vụ đang hoạt động.');

    const paidSessions = Validator.integer(data.PaidSessions, 'Số buổi mua', { required: true, min: 1, max: 500 });
    const discountPercent = Number(data.DiscountPercent);
    const discounts = (CONFIG.PREPAID && CONFIG.PREPAID.DISCOUNT_OPTIONS) || [20, 25];
    if (!Number.isFinite(discountPercent) || discounts.indexOf(discountPercent) === -1) {
      throw new Error('Giảm giá chỉ áp dụng 20% hoặc 25%.');
    }

    const bonusSessions = data.BonusSessions === undefined || data.BonusSessions === ''
      ? this.bonusSessions()
      : Validator.integer(data.BonusSessions, 'Buổi tặng', { required: true, min: 0, max: 100 });
    const unitPrice = Number(service.Price || 0);
    const listPrice = unitPrice * paidSessions;
    const discountAmount = Math.round(listPrice * discountPercent / 100);
    const paidAmount = Math.max(0, listPrice - discountAmount);
    const totalSessions = paidSessions + bonusSessions;
    const now = new Date();
    const purchasedDate = data.PurchasedDate
      ? Validator.date(data.PurchasedDate, 'Ngày mua thẻ', { required: true })
      : now;

    const saved = Database.insertWithGeneratedId(this.CARD_TABLE, CONFIG.PREFIX.PREPAID_CARD, {
      CustomerID: customerId,
      ServiceID: serviceId,
      ServiceName: service.ServiceName,
      PurchasedDate: purchasedDate,
      PaidSessions: paidSessions,
      BonusSessions: bonusSessions,
      TotalSessions: totalSessions,
      UsedSessions: 0,
      RemainingSessions: totalSessions,
      UnitPrice: unitPrice,
      DiscountPercent: discountPercent,
      DiscountAmount: discountAmount,
      PaidAmount: paidAmount,
      Status: this.statusForRemaining(totalSessions),
      Note: Validator.text(data.Note, 'Ghi chú', { maxLength: 1000 }),
      CreatedDate: now,
      UpdatedDate: now
    }, { idColumn: 'CardID', padding: 6 });

    AppLogger.safe('AUDIT', 'PrepaidCard', 'CREATE', saved.CardID, 'CREATE prepaid card', {
      customerId: customerId, serviceId: serviceId, paidAmount: paidAmount, totalSessions: totalSessions
    });
    return saved;
  }

  /** Admin and Reception can correct the complimentary sessions after sale. */
  static updateBonus(cardId, bonusSessions) {
    this.initialize();
    const current = Database.findById(this.CARD_TABLE, Validator.required(cardId, 'Mã thẻ'), 'CardID');
    if (!current) throw new Error('Không tìm thấy thẻ trả trước.');

    const bonus = Validator.integer(bonusSessions, 'Buổi tặng', { required: true, min: 0, max: 100 });
    const paidSessions = Number(current.PaidSessions || 0);
    const usedSessions = Number(current.UsedSessions || 0);
    const totalSessions = paidSessions + bonus;
    if (totalSessions < usedSessions) {
      throw new Error('Không thể giảm buổi tặng vì khách đã sử dụng ' + usedSessions + ' buổi.');
    }

    const remaining = totalSessions - usedSessions;
    const saved = Database.update(this.CARD_TABLE, current.CardID, {
      BonusSessions: bonus,
      TotalSessions: totalSessions,
      RemainingSessions: remaining,
      Status: this.statusForRemaining(remaining),
      UpdatedDate: new Date()
    }, 'CardID');
    AppLogger.safe('AUDIT', 'PrepaidCard', 'UPDATE_BONUS', current.CardID, 'UPDATE prepaid bonus sessions', {
      bonusSessions: bonus, remainingSessions: remaining
    });
    return saved;
  }

  static available(customerId, serviceId) {
    this.initialize();
    return this.list({ customerId: customerId, includeInactive: false })
      .filter(function (card) {
        return card.ServiceID === serviceId && Number(card.RemainingSessions || 0) > 0 && card.Status !== 'Exhausted';
      })
      .sort(function (left, right) {
        return new Date(left.PurchasedDate || 0).getTime() - new Date(right.PurchasedDate || 0).getTime();
      });
  }

  static warnings() {
    return this.list({ includeInactive: false }).filter(function (card) {
      const remaining = Number(card.RemainingSessions || 0);
      return remaining > 0 && remaining <= PrepaidService.nearEndRemaining();
    });
  }

  /** Called by BookingService only when a booking reaches Hoàn thành. */
  static consumeForBooking(booking) {
    this.initialize();
    if (!booking || !booking.BookingID) throw new Error('Không thể trừ thẻ cho booking không hợp lệ.');

    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const existing = Database.first(this.USAGE_TABLE, 'BookingID', booking.BookingID);
      if (existing) {
        return { used: true, alreadyApplied: true, cardId: existing.CardID, remainingSessions: null };
      }

      const card = this.available(booking.CustomerID, booking.ServiceID)[0];
      if (!card) return { used: false, alreadyApplied: false, cardId: '', remainingSessions: null };

      const remaining = Math.max(0, Number(card.RemainingSessions || 0) - 1);
      const usage = {
        UsageID: this.nextUsageId(),
        CardID: card.CardID,
        BookingID: booking.BookingID,
        CustomerID: booking.CustomerID,
        ServiceID: booking.ServiceID,
        UsedSessions: 1,
        CreatedDate: new Date()
      };
      Database.insert(this.USAGE_TABLE, usage);
      Database.update(this.CARD_TABLE, card.CardID, {
        UsedSessions: Number(card.UsedSessions || 0) + 1,
        RemainingSessions: remaining,
        Status: this.statusForRemaining(remaining),
        UpdatedDate: new Date()
      }, 'CardID');
      AppLogger.safe('AUDIT', 'PrepaidCard', 'CONSUME', card.CardID, 'CONSUME prepaid card session', {
        bookingId: booking.BookingID, remainingSessions: remaining
      });
      return { used: true, alreadyApplied: false, cardId: card.CardID, remainingSessions: remaining };
    } finally {
      lock.releaseLock();
    }
  }

  static revenueBetween(fromKey, toKey) {
    return this.list({ includeInactive: true }).reduce(function (total, card) {
      const key = PrepaidService.dateKey(card.PurchasedDate);
      if (key < fromKey || key > toKey) return total;
      return total + Number(card.PaidAmount || 0);
    }, 0);
  }

  static cardsBetween(fromKey, toKey) {
    return this.list({ includeInactive: true }).filter(function (card) {
      const key = PrepaidService.dateKey(card.PurchasedDate);
      return key >= fromKey && key <= toKey;
    });
  }

  static nextUsageId() {
    const pattern = new RegExp('^' + Database.escapeRegExp(CONFIG.PREFIX.PREPAID_USAGE) + '(\\d+)$');
    const highest = Database.findAll(this.USAGE_TABLE).reduce(function (max, usage) {
      const match = String(usage.UsageID || '').match(pattern);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return CONFIG.PREFIX.PREPAID_USAGE + String(highest + 1).padStart(6, '0');
  }

  static bonusSessions() { return Number((CONFIG.PREPAID && CONFIG.PREPAID.BONUS_SESSIONS) || 1); }
  static nearEndRemaining() { return Number((CONFIG.PREPAID && CONFIG.PREPAID.NEAR_END_REMAINING) || 2); }
  static statusForRemaining(remaining) {
    if (Number(remaining) <= 0) return 'Exhausted';
    return Number(remaining) <= this.nearEndRemaining() ? 'NearEnd' : 'Active';
  }
  static dateKey(value) { return Utilities.formatDate(new Date(value), CONFIG.TIMEZONE, 'yyyy-MM-dd'); }
}

function getPrepaidOptions(token) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(PrepaidService.options()); }
function getPrepaidCards(token, options) { AuthService.requireSession(token); return Utils.toClient(PrepaidService.list(options)); }
function getAvailablePrepaidCards(token, customerId, serviceId) { AuthService.requireSession(token); return Utils.toClient(PrepaidService.available(customerId, serviceId)); }
function createPrepaidCard(token, data) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(PrepaidService.create(data)); }
function updatePrepaidCardBonus(token, cardId, bonusSessions) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.RECEPTION]); return Utils.toClient(PrepaidService.updateBonus(cardId, bonusSessions)); }
