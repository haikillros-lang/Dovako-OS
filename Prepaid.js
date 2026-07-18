/**
 * DOVAKO OS prepaid cards.
 *
 * Supports legacy service-session cards and current value-based cards.
 * Value cards are sold from configurable denominations; their balance is
 * deducted only when the related booking is completed.
 */
class PrepaidService {
  static get CARD_TABLE() { return CONFIG.SHEETS.PREPAID_CARDS; }
  static get USAGE_TABLE() { return CONFIG.SHEETS.PREPAID_USAGE; }
  static get PLAN_TABLE() { return CONFIG.SHEETS.PREPAID_PLANS; }

  static get CARD_HEADERS() {
    return [
      'CardID', 'CustomerID', 'ServiceID', 'ServiceName', 'PurchasedDate',
      'PaidSessions', 'BonusSessions', 'TotalSessions', 'UsedSessions',
      'RemainingSessions', 'UnitPrice', 'DiscountPercent', 'DiscountAmount',
      'PaidAmount', 'Status', 'Note', 'CreatedDate', 'UpdatedDate',
      'CardMode', 'PlanID', 'PlanName', 'FaceValue', 'BonusServiceID',
      'BonusServiceName', 'BonusUnitPrice', 'BonusValue', 'UsedValue',
      'RemainingValue'
    ];
  }

  static get USAGE_HEADERS() {
    return [
      'UsageID', 'CardID', 'BookingID', 'CustomerID', 'ServiceID',
      'UsedSessions', 'CreatedDate', 'UsageType', 'UsedValue'
    ];
  }

  static get PLAN_HEADERS() {
    return [
      'PlanID', 'PlanName', 'FaceValue', 'DiscountPercent', 'BonusSessions',
      'BonusServiceID', 'BonusServiceName', 'Status', 'CreatedDate', 'UpdatedDate'
    ];
  }

  /** Applies additive schema upgrades without changing existing card rows. */
  static initialize() {
    Database.ensureColumns(this.CARD_TABLE, this.CARD_HEADERS);
    Database.ensureColumns(this.USAGE_TABLE, this.USAGE_HEADERS);
    Database.ensureTable(this.PLAN_TABLE, this.PLAN_HEADERS);
  }

  static options() {
    this.initialize();
    CatalogService.initialize();
    return {
      services: CatalogService.services(false),
      plans: this.plans(false),
      bonusSessions: this.bonusSessions(),
      nearEndRemaining: this.nearEndRemaining(),
      nearEndBalance: this.nearEndBalance()
    };
  }

  static plans(includeInactive) {
    this.initialize();
    return Database.findAll(this.PLAN_TABLE)
      .filter(function (plan) { return includeInactive === true || plan.Status !== 'Inactive'; })
      .sort(function (left, right) {
        return Number(left.FaceValue || 0) - Number(right.FaceValue || 0);
      });
  }

  static createPlan(input) {
    this.initialize();
    CatalogService.initialize();
    const plan = this.normalizePlan(input, null);
    const saved = Database.insertWithGeneratedId(this.PLAN_TABLE, CONFIG.PREFIX.PREPAID_PLAN, plan, {
      idColumn: 'PlanID', padding: 4
    });
    AppLogger.safe('AUDIT', 'PrepaidPlan', 'CREATE', saved.PlanID, 'CREATE prepaid denomination', {
      faceValue: saved.FaceValue, discountPercent: saved.DiscountPercent
    });
    return saved;
  }

  static updatePlan(planId, input) {
    this.initialize();
    const current = Database.findById(this.PLAN_TABLE, Validator.required(planId, 'Mã mệnh giá'), 'PlanID');
    if (!current) throw new Error('Không tìm thấy mệnh giá thẻ.');
    const saved = Database.update(this.PLAN_TABLE, current.PlanID, this.normalizePlan(input, current), 'PlanID');
    AppLogger.safe('AUDIT', 'PrepaidPlan', 'UPDATE', current.PlanID, 'UPDATE prepaid denomination', {
      faceValue: saved.FaceValue, discountPercent: saved.DiscountPercent
    });
    return saved;
  }

  static archivePlan(planId) {
    this.initialize();
    const current = Database.findById(this.PLAN_TABLE, Validator.required(planId, 'Mã mệnh giá'), 'PlanID');
    if (!current) throw new Error('Không tìm thấy mệnh giá thẻ.');
    const saved = Database.update(this.PLAN_TABLE, current.PlanID, {
      Status: 'Inactive', UpdatedDate: new Date()
    }, 'PlanID');
    AppLogger.safe('AUDIT', 'PrepaidPlan', 'ARCHIVE', current.PlanID, 'ARCHIVE prepaid denomination', {});
    return saved;
  }

  static normalizePlan(input, current) {
    const data = input || {};
    const services = CatalogService.services(false);
    const now = new Date();
    const bonusSessions = Validator.integer(
      data.BonusSessions === undefined || data.BonusSessions === ''
        ? (current ? current.BonusSessions : this.bonusSessions())
        : data.BonusSessions,
      'Buổi tặng', { required: true, min: 0, max: 100 }
    );
    const bonusServiceId = String(
      data.BonusServiceID === undefined ? (current ? current.BonusServiceID : '') : data.BonusServiceID
    ).trim();
    const bonusService = bonusServiceId
      ? services.find(function (service) { return service.ServiceID === bonusServiceId; })
      : null;
    if (bonusSessions > 0 && !bonusService) {
      throw new Error('Chọn dịch vụ tặng kèm cho mệnh giá này.');
    }

    return {
      PlanName: Validator.text(data.PlanName === undefined ? (current ? current.PlanName : '') : data.PlanName, 'Tên mệnh giá', { required: true, maxLength: 120 }),
      FaceValue: Validator.number(data.FaceValue === undefined ? (current ? current.FaceValue : '') : data.FaceValue, 'Mệnh giá', { required: true, min: 1 }),
      DiscountPercent: Validator.number(data.DiscountPercent === undefined ? (current ? current.DiscountPercent : '') : data.DiscountPercent, 'Chiết khấu', { required: true, min: 0, max: 100 }),
      BonusSessions: bonusSessions,
      BonusServiceID: bonusService ? bonusService.ServiceID : '',
      BonusServiceName: bonusService ? bonusService.ServiceName : '',
      Status: Validator.oneOf(data.Status === undefined ? (current ? current.Status : 'Active') : data.Status, ['Active', 'Inactive'], 'Trạng thái', { required: true }),
      CreatedDate: current ? current.CreatedDate : now,
      UpdatedDate: now
    };
  }

  static list(options) {
    this.initialize();
    const settings = options || {};
    const customerId = settings.customerId ? Validator.required(settings.customerId, 'Mã khách hàng') : '';
    const query = CustomerService.normalizeSearch(settings.query || '');
    const includeInactive = settings.includeInactive === true;
    const customers = CustomerService.list({ includeInactive: true }).reduce(function (map, customer) {
      map[customer.CustomerID] = customer;
      return map;
    }, {});

    const cards = Database.findAll(this.CARD_TABLE).filter(function (card) {
      if (customerId && card.CustomerID !== customerId) return false;
      if (!includeInactive && card.Status === 'Inactive') return false;
      const customer = customers[card.CustomerID] || {};
      if (!query) return true;
      return [card.CardID, card.CustomerID, customer.FullName, customer.Phone, card.PlanName, card.ServiceName]
        .some(function (value) { return CustomerService.normalizeSearch(value).indexOf(query) !== -1; });
    }).map(function (card) {
      const customer = customers[card.CustomerID] || {};
      return Object.assign({}, card, {
        CustomerName: customer.FullName || card.CustomerID,
        CustomerPhone: customer.Phone || ''
      });
    });

    return cards.sort(function (left, right) {
      return new Date(right.PurchasedDate || 0).getTime() - new Date(left.PurchasedDate || 0).getTime();
    });
  }

  /** Creates a value card from the selected configurable denomination. */
  static create(input) {
    this.initialize();
    CatalogService.initialize();
    const data = input || {};
    const customerId = Validator.required(data.CustomerID, 'Khách hàng');
    const customer = CustomerService.get(customerId);
    if (!customer || customer.Status === CONFIG.CUSTOMER_STATUS.INACTIVE || customer.Status === CONFIG.CUSTOMER_STATUS.BLACKLIST) {
      throw new Error('Khách hàng hiện không thể mua thẻ trả trước.');
    }

    const planId = Validator.required(data.PlanID, 'Mệnh giá thẻ');
    const plan = this.plans(false).find(function (item) { return item.PlanID === planId; });
    if (!plan) throw new Error('Mệnh giá đã chọn không còn hoạt động.');

    const bonusSessions = Validator.integer(
      data.BonusSessions === undefined || data.BonusSessions === '' ? plan.BonusSessions : data.BonusSessions,
      'Buổi tặng', { required: true, min: 0, max: 100 }
    );
    const requestedBonusServiceId = String(data.BonusServiceID === undefined || data.BonusServiceID === ''
      ? (plan.BonusServiceID || '') : data.BonusServiceID).trim();
    const services = CatalogService.services(false);
    const bonusService = requestedBonusServiceId
      ? services.find(function (service) { return service.ServiceID === requestedBonusServiceId; })
      : null;
    if (bonusSessions > 0 && !bonusService) {
      throw new Error('Chọn dịch vụ tặng kèm cho thẻ này.');
    }

    const faceValue = Number(plan.FaceValue || 0);
    const discountPercent = Number(plan.DiscountPercent || 0);
    const discountAmount = Math.round(faceValue * discountPercent / 100);
    const paidAmount = Math.max(0, faceValue - discountAmount);
    const bonusUnitPrice = bonusService ? Number(bonusService.Price || 0) : 0;
    const bonusValue = bonusUnitPrice * bonusSessions;
    const remainingValue = faceValue + bonusValue;
    const now = new Date();
    const purchasedDate = data.PurchasedDate
      ? Validator.date(data.PurchasedDate, 'Ngày mua thẻ', { required: true })
      : now;

    const saved = Database.insertWithGeneratedId(this.CARD_TABLE, CONFIG.PREFIX.PREPAID_CARD, {
      CustomerID: customerId,
      ServiceID: bonusService ? bonusService.ServiceID : '',
      ServiceName: bonusService ? bonusService.ServiceName : '',
      PurchasedDate: purchasedDate,
      PaidSessions: 0,
      BonusSessions: bonusSessions,
      TotalSessions: 0,
      UsedSessions: 0,
      RemainingSessions: 0,
      UnitPrice: faceValue,
      DiscountPercent: discountPercent,
      DiscountAmount: discountAmount,
      PaidAmount: paidAmount,
      Status: this.statusForValue(remainingValue),
      Note: Validator.text(data.Note, 'Ghi chú', { maxLength: 1000 }),
      CreatedDate: now,
      UpdatedDate: now,
      CardMode: 'Value',
      PlanID: plan.PlanID,
      PlanName: plan.PlanName,
      FaceValue: faceValue,
      BonusServiceID: bonusService ? bonusService.ServiceID : '',
      BonusServiceName: bonusService ? bonusService.ServiceName : '',
      BonusUnitPrice: bonusUnitPrice,
      BonusValue: bonusValue,
      UsedValue: 0,
      RemainingValue: remainingValue
    }, { idColumn: 'CardID', padding: 6 });

    AppLogger.safe('AUDIT', 'PrepaidCard', 'CREATE_VALUE', saved.CardID, 'CREATE prepaid value card', {
      customerId: customerId,
      planId: plan.PlanID,
      faceValue: faceValue,
      paidAmount: paidAmount,
      remainingValue: remainingValue
    });
    return saved;
  }

  /** Admin and Reception can correct the complimentary sessions after sale. */
  static updateBonus(cardId, bonusSessions) {
    this.initialize();
    const current = Database.findById(this.CARD_TABLE, Validator.required(cardId, 'Mã thẻ'), 'CardID');
    if (!current) throw new Error('Không tìm thấy thẻ trả trước.');

    const bonus = Validator.integer(bonusSessions, 'Buổi tặng', { required: true, min: 0, max: 100 });
    if (this.isValueCard(current)) {
      const bonusUnitPrice = Number(current.BonusUnitPrice || 0);
      if (bonus > 0 && bonusUnitPrice <= 0) {
        throw new Error('Thẻ này chưa có dịch vụ tặng kèm để tính giá trị quà tặng.');
      }
      const bonusValue = bonus * bonusUnitPrice;
      const totalCredit = Number(current.FaceValue || 0) + bonusValue;
      const usedValue = Number(current.UsedValue || 0);
      if (totalCredit < usedValue) {
        throw new Error('Không thể giảm buổi tặng vì khách đã sử dụng giá trị cao hơn số dư mới.');
      }
      const remainingValue = totalCredit - usedValue;
      const saved = Database.update(this.CARD_TABLE, current.CardID, {
        BonusSessions: bonus,
        BonusValue: bonusValue,
        RemainingValue: remainingValue,
        Status: this.statusForValue(remainingValue),
        UpdatedDate: new Date()
      }, 'CardID');
      AppLogger.safe('AUDIT', 'PrepaidCard', 'UPDATE_BONUS', current.CardID, 'UPDATE prepaid card bonus', {
        bonusSessions: bonus, remainingValue: remainingValue
      });
      return saved;
    }

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
      Status: this.statusForSessions(remaining),
      UpdatedDate: new Date()
    }, 'CardID');
    AppLogger.safe('AUDIT', 'PrepaidCard', 'UPDATE_BONUS', current.CardID, 'UPDATE prepaid session card bonus', {
      bonusSessions: bonus, remainingSessions: remaining
    });
    return saved;
  }

  /** Legacy cards: one session can be consumed only for the matching service. */
  static availableSessions(customerId, serviceId) {
    this.initialize();
    return this.list({ customerId: customerId, includeInactive: false })
      .filter(function (card) {
        return PrepaidService.isSessionCard(card) && card.ServiceID === serviceId &&
          Number(card.RemainingSessions || 0) > 0 && card.Status !== 'Exhausted';
      })
      .sort(this.sortOldestFirst);
  }

  static availableValue(customerId, amount) {
    const requiredValue = Number(amount || 0);
    if (!Number.isFinite(requiredValue) || requiredValue <= 0) return [];
    return this.list({ customerId: customerId, includeInactive: false })
      .filter(function (card) {
        return PrepaidService.isValueCard(card) && Number(card.RemainingValue || 0) >= requiredValue &&
          card.Status !== 'Exhausted';
      })
      .sort(this.sortOldestFirst);
  }

  /** Cards currently usable for a booking. Session cards are preferred. */
  static availableForBooking(customerId, serviceId, amount) {
    return this.availableSessions(customerId, serviceId)
      .concat(this.availableValue(customerId, amount));
  }

  static warnings() {
    return this.list({ includeInactive: false }).filter(function (card) {
      return PrepaidService.isNearEnd(card);
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
        return {
          used: true,
          alreadyApplied: true,
          cardId: existing.CardID,
          cardMode: existing.UsageType || 'Session',
          remainingSessions: null,
          remainingValue: null,
          deductedAmount: Number(existing.UsedValue || 0)
        };
      }

      const sessionCard = this.availableSessions(booking.CustomerID, booking.ServiceID)[0];
      if (sessionCard) return this.consumeSessionCard(sessionCard, booking);

      const charge = Math.max(0, Number(booking.FinalPrice || 0));
      const valueCard = this.availableValue(booking.CustomerID, charge)[0];
      if (valueCard) return this.consumeValueCard(valueCard, booking, charge);

      return { used: false, alreadyApplied: false, cardId: '', cardMode: '', remainingSessions: null, remainingValue: null, deductedAmount: 0 };
    } finally {
      lock.releaseLock();
    }
  }

  static consumeSessionCard(card, booking) {
    const remaining = Math.max(0, Number(card.RemainingSessions || 0) - 1);
    Database.insert(this.USAGE_TABLE, {
      UsageID: this.nextUsageId(),
      CardID: card.CardID,
      BookingID: booking.BookingID,
      CustomerID: booking.CustomerID,
      ServiceID: booking.ServiceID,
      UsedSessions: 1,
      CreatedDate: new Date(),
      UsageType: 'Session',
      UsedValue: 0
    });
    Database.update(this.CARD_TABLE, card.CardID, {
      UsedSessions: Number(card.UsedSessions || 0) + 1,
      RemainingSessions: remaining,
      Status: this.statusForSessions(remaining),
      UpdatedDate: new Date()
    }, 'CardID');
    AppLogger.safe('AUDIT', 'PrepaidCard', 'CONSUME_SESSION', card.CardID, 'CONSUME prepaid session', {
      bookingId: booking.BookingID, remainingSessions: remaining
    });
    return { used: true, alreadyApplied: false, cardId: card.CardID, cardMode: 'Session', remainingSessions: remaining, remainingValue: null, deductedAmount: 0 };
  }

  static consumeValueCard(card, booking, charge) {
    const remaining = Math.max(0, Number(card.RemainingValue || 0) - charge);
    Database.insert(this.USAGE_TABLE, {
      UsageID: this.nextUsageId(),
      CardID: card.CardID,
      BookingID: booking.BookingID,
      CustomerID: booking.CustomerID,
      ServiceID: booking.ServiceID,
      UsedSessions: 0,
      CreatedDate: new Date(),
      UsageType: 'Value',
      UsedValue: charge
    });
    Database.update(this.CARD_TABLE, card.CardID, {
      UsedValue: Number(card.UsedValue || 0) + charge,
      RemainingValue: remaining,
      Status: this.statusForValue(remaining),
      UpdatedDate: new Date()
    }, 'CardID');
    AppLogger.safe('AUDIT', 'PrepaidCard', 'CONSUME_VALUE', card.CardID, 'CONSUME prepaid value', {
      bookingId: booking.BookingID, deductedAmount: charge, remainingValue: remaining
    });
    return { used: true, alreadyApplied: false, cardId: card.CardID, cardMode: 'Value', remainingSessions: null, remainingValue: remaining, deductedAmount: charge };
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

  static isValueCard(card) {
    return String(card.CardMode || '').trim().toLowerCase() === 'value';
  }

  static isSessionCard(card) { return !this.isValueCard(card); }

  static isNearEnd(card) {
    if (this.isValueCard(card)) {
      const remaining = Number(card.RemainingValue || 0);
      return remaining > 0 && remaining <= this.nearEndBalance();
    }
    const remaining = Number(card.RemainingSessions || 0);
    return remaining > 0 && remaining <= this.nearEndRemaining();
  }

  static remainingLabel(card) {
    if (this.isValueCard(card)) {
      return { mode: 'Value', amount: Number(card.RemainingValue || 0), text: 'Số dư ' + Number(card.RemainingValue || 0) };
    }
    return { mode: 'Session', amount: Number(card.RemainingSessions || 0), text: 'Còn ' + Number(card.RemainingSessions || 0) + ' buổi' };
  }

  static sortOldestFirst(left, right) {
    return new Date(left.PurchasedDate || 0).getTime() - new Date(right.PurchasedDate || 0).getTime();
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
  static nearEndBalance() { return Number((CONFIG.PREPAID && CONFIG.PREPAID.NEAR_END_BALANCE) || 200000); }
  static statusForSessions(remaining) {
    if (Number(remaining) <= 0) return 'Exhausted';
    return Number(remaining) <= this.nearEndRemaining() ? 'NearEnd' : 'Active';
  }
  static statusForValue(remaining) {
    if (Number(remaining) <= 0) return 'Exhausted';
    return Number(remaining) <= this.nearEndBalance() ? 'NearEnd' : 'Active';
  }
  static dateKey(value) { return Utilities.formatDate(new Date(value), CONFIG.TIMEZONE, 'yyyy-MM-dd'); }
}

function getPrepaidOptions(token) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(PrepaidService.options()); }
function getPrepaidCards(token, options) { AuthService.requireSession(token); return Utils.toClient(PrepaidService.list(options)); }
function getPrepaidPlans(token, includeInactive) { AuthService.requireSession(token); return Utils.toClient(PrepaidService.plans(includeInactive)); }
function getAvailablePrepaidCards(token, customerId, serviceId, amount) { AuthService.requireSession(token); return Utils.toClient(PrepaidService.availableForBooking(customerId, serviceId, amount)); }
function createPrepaidCard(token, data) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(PrepaidService.create(data)); }
function updatePrepaidCardBonus(token, cardId, bonusSessions) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.RECEPTION]); return Utils.toClient(PrepaidService.updateBonus(cardId, bonusSessions)); }
function createPrepaidPlan(token, data) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]); return Utils.toClient(PrepaidService.createPlan(data)); }
function updatePrepaidPlan(token, planId, data) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]); return Utils.toClient(PrepaidService.updatePlan(planId, data)); }
function archivePrepaidPlan(token, planId) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]); return Utils.toClient(PrepaidService.archivePlan(planId)); }
