/**
 * DOVAKO OS
 * Receipt.js
 * Creates a clear prepaid-card deduction receipt and optionally emails it.
 * Email delivery never blocks a completed booking or a successful card debit.
 */
class PrepaidReceiptService {
  static buildForBooking(bookingId) {
    BookingService.initialize();
    PrepaidService.initialize();

    const id = Validator.required(bookingId, 'Mã booking');
    const booking = BookingService.get(id);
    if (!booking) throw new Error('Không tìm thấy booking: ' + id);

    const usage = Database.first(CONFIG.SHEETS.PREPAID_USAGE, 'BookingID', id);
    if (!usage) return null;

    const card = Database.findById(CONFIG.SHEETS.PREPAID_CARDS, usage.CardID, 'CardID');
    if (!card) throw new Error('Không tìm thấy thẻ trả trước đã dùng cho booking này.');

    const customer = CustomerService.get(booking.CustomerID) || {};
    const cardOwnerId = usage.CardOwnerCustomerID || booking.CardOwnerCustomerID || booking.CustomerID;
    const cardOwner = CustomerService.get(cardOwnerId) || {};
    const service = CatalogService.services(true).find(function (item) {
      return String(item.ServiceID) === String(booking.ServiceID);
    }) || {};

    const usageType = String(usage.UsageType || card.CardMode || 'Value');
    const chargeAmount = Math.max(0, Number(booking.Price || 0) - Number(booking.Discount || 0));
    const deductedAmount = Math.max(0, Number(usage.UsedValue || 0));
    const outstandingAmount = Math.max(0, chargeAmount - deductedAmount);
    const usedSessions = Math.max(0, Number(usage.UsedSessions || 0));
    const isSession = usageType === 'Session';
    const isSharedCard = String(cardOwnerId) !== String(booking.CustomerID);

    const receipt = {
      BookingID: booking.BookingID,
      CardID: card.CardID,
      CustomerID: booking.CustomerID,
      CustomerName: customer.FullName || booking.CustomerID,
      CustomerEmail: customer.Email || '',
      CardOwnerCustomerID: cardOwnerId,
      CardOwnerName: cardOwner.FullName || cardOwnerId,
      ServiceName: service.ServiceName || booking.ServiceID,
      BookingDate: this.date(booking.BookingDate),
      StartTime: booking.StartTime || '',
      EndTime: booking.EndTime || '',
      ChargeAmount: chargeAmount,
      DiscountAmount: Math.max(0, Number(booking.Discount || 0)),
      DeductedAmount: deductedAmount,
      OutstandingAmount: outstandingAmount,
      UsedSessions: usedSessions,
      RemainingValue: isSession ? null : Math.max(0, Number(card.RemainingValue || 0)),
      RemainingSessions: isSession ? Math.max(0, Number(card.RemainingSessions || 0)) : null,
      UsageType: usageType,
      IsSharedCard: isSharedCard
    };

    receipt.Subject = 'DOVAKO – Phiếu trừ thẻ ' + receipt.CardID;
    receipt.Text = this.text(receipt);
    receipt.Html = this.html(receipt);
    return receipt;
  }

  /** Sends one receipt email only when the service user has supplied an email. */
  static sendForBooking(bookingId) {
    const receipt = this.buildForBooking(bookingId);
    if (!receipt) return { receipt: null, email: { sent: false, reason: 'NO_PREPAID_USAGE' } };

    if (!receipt.CustomerEmail) {
      return { receipt: receipt, email: { sent: false, reason: 'NO_CUSTOMER_EMAIL' } };
    }

    try {
      MailApp.sendEmail({
        to: receipt.CustomerEmail,
        subject: receipt.Subject,
        body: receipt.Text,
        htmlBody: receipt.Html,
        name: 'DOVAKO Stretching'
      });
      this.audit('EMAIL_SENT', receipt, { recipient: receipt.CustomerEmail });
      return { receipt: receipt, email: { sent: true, recipient: receipt.CustomerEmail } };
    } catch (error) {
      const message = error && error.message ? error.message : String(error || 'Không gửi được email.');
      this.audit('EMAIL_FAILED', receipt, { message: message });
      // A receipt remains available for copying even if MailApp is unavailable.
      return { receipt: receipt, email: { sent: false, reason: 'SEND_FAILED', message: message } };
    }
  }

  /**
   * Builds a printable check-in ledger for the prepaid card used by a booking.
   * Each completed use remains visible with the balance immediately after it.
   */
  static buildCheckinSheetForBooking(bookingId) {
    BookingService.initialize();
    PrepaidService.initialize();

    const receipt = this.buildForBooking(bookingId);
    if (!receipt) return null;
    const card = Database.findById(CONFIG.SHEETS.PREPAID_CARDS, receipt.CardID, 'CardID');
    if (!card) throw new Error('Không tìm thấy thẻ trả trước: ' + receipt.CardID);

    const owner = CustomerService.get(card.CustomerID) || {};
    const bookings = Database.findAll(CONFIG.SHEETS.BOOKINGS).reduce(function (map, item) {
      map[item.BookingID] = item;
      return map;
    }, {});
    const customers = CustomerService.list({ includeInactive: true }).reduce(function (map, item) {
      map[item.CustomerID] = item;
      return map;
    }, {});
    const services = CatalogService.services(true).reduce(function (map, item) {
      map[item.ServiceID] = item;
      return map;
    }, {});
    const isSession = String(card.CardMode || 'Value') !== 'Value';
    const uses = Database.findAll(CONFIG.SHEETS.PREPAID_USAGE)
      .filter(function (item) { return String(item.CardID) === String(card.CardID); })
      .sort(function (left, right) {
        const leftBooking = bookings[left.BookingID] || {};
        const rightBooking = bookings[right.BookingID] || {};
        const leftTime = new Date(leftBooking.BookingDate || left.CreatedDate || 0).getTime();
        const rightTime = new Date(rightBooking.BookingDate || right.CreatedDate || 0).getTime();
        if (leftTime !== rightTime) return leftTime - rightTime;
        return String(left.CreatedDate || '').localeCompare(String(right.CreatedDate || ''));
      });

    let remainingValue = Math.max(0, Number(card.FaceValue || 0) + Number(card.BonusValue || 0));
    let remainingSessions = Math.max(0, Number(card.TotalSessions || 0));
    if (isSession && !remainingSessions) {
      remainingSessions = Math.max(0, Number(card.PaidSessions || 0) + Number(card.BonusSessions || 0));
    }

    const history = uses.map(function (usage, index) {
      const booking = bookings[usage.BookingID] || {};
      const customer = customers[booking.CustomerID || usage.CustomerID] || {};
      const service = services[booking.ServiceID || usage.ServiceID] || {};
      const bookingPrice = Math.max(0, Number(booking.Price || 0));
      const discount = Math.max(0, Number(booking.Discount || 0));
      const usedValue = Math.max(0, Number(usage.UsedValue || 0));
      const usedSessions = Math.max(0, Number(usage.UsedSessions || 0));
      let note = (customer.FullName || booking.CustomerID || usage.CustomerID || 'Khách hàng') + ' · ' + (service.ServiceName || booking.ServiceID || usage.ServiceID || 'Dịch vụ');

      if (isSession) {
        remainingSessions = Math.max(0, remainingSessions - (usedSessions || 1));
        note += ' · trừ ' + (usedSessions || 1) + ' buổi';
      } else {
        remainingValue = Math.max(0, remainingValue - usedValue);
        if (discount > 0) note += ' · ' + this.money(bookingPrice) + ' - ưu đãi ' + this.money(discount) + ' = ' + this.money(Math.max(0, bookingPrice - discount));
        else note += ' · đã trừ ' + this.money(usedValue);
      }

      return {
        Index: index + 1,
        Date: this.date(booking.BookingDate || usage.CreatedDate),
        Checkin: 'X',
        Note: note,
        UsedValue: usedValue,
        UsedSessions: usedSessions || (isSession ? 1 : 0),
        RemainingValue: isSession ? null : remainingValue,
        RemainingSessions: isSession ? remainingSessions : null,
        OutstandingAmount: Math.max(0, Number(booking.FinalPrice || 0) - usedValue)
      };
    }, this);

    const initialCredit = isSession
      ? Math.max(0, Number(card.TotalSessions || 0) || Number(card.PaidSessions || 0) + Number(card.BonusSessions || 0))
      : Math.max(0, Number(card.FaceValue || 0) + Number(card.BonusValue || 0));
    const discountText = Number(card.DiscountPercent || 0) > 0
      ? (String(card.DiscountMode || 'Upfront') === 'PerSession'
        ? 'Giảm ' + Number(card.DiscountPercent || 0) + '% cho mỗi buổi dịch vụ'
        : 'Giảm ' + Number(card.DiscountPercent || 0) + '% khi mua thẻ')
      : 'Không áp dụng chiết khấu';
    const bonusText = Number(card.BonusSessions || 0) > 0
      ? 'Tặng ' + Number(card.BonusSessions || 0) + ' buổi' + (card.BonusServiceName ? ' ' + card.BonusServiceName : '')
      : 'Không có buổi tặng';

    return {
      CardID: card.CardID,
      CardMode: isSession ? 'Session' : 'Value',
      CustomerName: owner.FullName || card.CustomerID,
      CustomerPhone: owner.Phone || '',
      CustomerAddress: owner.Address || '',
      PlanName: card.PlanName || 'Thẻ trả trước',
      PurchasedDate: this.date(card.PurchasedDate),
      DiscountText: discountText,
      BonusText: bonusText,
      InitialCredit: initialCredit,
      RemainingValue: isSession ? null : Math.max(0, Number(card.RemainingValue || 0)),
      RemainingSessions: isSession ? Math.max(0, Number(card.RemainingSessions || 0)) : null,
      History: history
    };
  }

  static date(value) {
    if (!value) return '';
    return Utilities.formatDate(new Date(value), CONFIG.TIMEZONE, CONFIG.DATE_FORMAT);
  }

  static money(value) {
    return Math.round(Number(value || 0)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' đ';
  }

  static text(receipt) {
    const rows = [
      'DOVAKO STRETCHING',
      'PHIẾU TRỪ THẺ TRẢ TRƯỚC',
      '--------------------------------',
      'Khách sử dụng: ' + receipt.CustomerName,
      'Dịch vụ: ' + receipt.ServiceName,
      'Thời gian: ' + receipt.BookingDate + (receipt.StartTime ? ' · ' + receipt.StartTime + (receipt.EndTime ? '–' + receipt.EndTime : '') : ''),
      'Mã booking: ' + receipt.BookingID,
      'Mã thẻ: ' + receipt.CardID
    ];

    if (receipt.IsSharedCard) rows.push('Chủ thẻ: ' + receipt.CardOwnerName);
    rows.push('Giá dịch vụ: ' + this.money(receipt.ChargeAmount));
    if (receipt.DiscountAmount > 0) rows.push('Chiết khấu: ' + this.money(receipt.DiscountAmount));

    if (receipt.UsageType === 'Session') {
      rows.push('Đã trừ: ' + (receipt.UsedSessions || 1) + ' buổi từ thẻ');
      rows.push('Số buổi còn lại: ' + receipt.RemainingSessions + ' buổi');
    } else {
      rows.push('Đã trừ từ thẻ: ' + this.money(receipt.DeductedAmount));
      rows.push('Số dư thẻ còn lại: ' + this.money(receipt.RemainingValue));
    }

    if (receipt.OutstandingAmount > 0) rows.push('Cần thanh toán thêm: ' + this.money(receipt.OutstandingAmount));
    rows.push('--------------------------------', 'Cảm ơn bạn đã sử dụng dịch vụ DOVAKO Stretching.');
    return rows.join('\n');
  }

  static html(receipt) {
    const rows = this.text(receipt).split('\n').map(function (line) {
      return PrepaidReceiptService.escape(line);
    });
    return '<div style="font-family:Arial,sans-serif;color:#152238;line-height:1.6;max-width:620px">' +
      '<h2 style="margin:0 0 8px">DOVAKO STRETCHING</h2>' +
      '<h3 style="margin:0 0 16px">PHIẾU TRỪ THẺ TRẢ TRƯỚC</h3>' +
      '<div style="white-space:pre-line;border:1px solid #d7dce6;border-radius:10px;padding:16px;background:#f9fbff">' +
      rows.join('<br>') + '</div></div>';
  }

  static escape(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  static audit(action, receipt, metadata) {
    if (typeof AppLogger !== 'undefined') {
      AppLogger.safe('AUDIT', 'PrepaidReceipt', action, receipt.BookingID, action + ' prepaid receipt', Object.assign({
        cardId: receipt.CardID,
        customerId: receipt.CustomerID
      }, metadata || {}));
    }
  }
}

/* Apps Script entry points for the Booking screen. */
function getPrepaidReceipt(token, bookingId) {
  AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]);
  const receipt = PrepaidReceiptService.buildForBooking(bookingId);
  if (!receipt) throw new Error('Booking này chưa dùng thẻ trả trước nên không có phiếu trừ thẻ.');
  return Utils.toClient(receipt);
}

function resendPrepaidReceiptEmail(token, bookingId) {
  AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]);
  const result = PrepaidReceiptService.sendForBooking(bookingId);
  if (!result.receipt) throw new Error('Booking này chưa dùng thẻ trả trước nên không có phiếu để gửi.');
  return Utils.toClient(result);
}

function getPrepaidCheckinSheet(token, bookingId) {
  AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]);
  const sheet = PrepaidReceiptService.buildCheckinSheetForBooking(bookingId);
  if (!sheet) throw new Error('Booking này chưa dùng thẻ trả trước nên chưa có phiếu check-in.');
  return Utils.toClient(sheet);
}
