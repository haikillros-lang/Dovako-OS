/**
 * DOVAKO OS
 * Booking.js
 * Appointment operations, schedule-conflict protection, and status workflow.
 */
class BookingService {
  static get TABLE() { return CONFIG.SHEETS.BOOKINGS; }

  static get HEADERS() {
    return [
      'BookingID', 'CustomerID', 'EmployeeID', 'ServiceID', 'BedID',
      'BookingDate', 'StartTime', 'EndTime', 'Status', 'Price', 'Discount',
      'FinalPrice', 'Note', 'CreatedDate', 'UpdatedDate'
    ];
  }

  static initialize() {
    Database.ensureTable(this.TABLE, this.HEADERS);
    return { sheet: this.TABLE, headers: this.HEADERS.slice() };
  }

  static list(options) {
    this.initialize();
    const settings = options || {};
    const date = settings.date ? Validator.date(settings.date, 'Ngày booking') : null;
    const customerId = settings.customerId ? Validator.required(settings.customerId, 'Mã khách hàng') : '';
    const includeCancelled = settings.includeCancelled === true;
    let bookings = this.readAll();

    if (date) bookings = bookings.filter(function (booking) {
      return BookingService.sameDay(booking.BookingDate, date);
    });
    if (customerId) bookings = bookings.filter(function (booking) { return booking.CustomerID === customerId; });
    if (!includeCancelled) bookings = bookings.filter(function (booking) {
      return !BookingService.isUnavailableStatus(booking.Status);
    });
    return bookings
      .map(function (booking) { return BookingService.normalizeTimeFields(booking); })
      .sort(this.sortByDateTime);
  }

  static get(bookingId) {
    this.initialize();
    const id = Validator.required(bookingId, 'Mã booking');
    return this.readAll().find(function (booking) { return booking.BookingID === id; }) || null;
  }

  static today() {
    return this.list({ date: new Date(), includeCancelled: true });
  }

  /** Reference data for the booking form. Admin can maintain these sheets later. */
  static options() {
    this.initialize();
    CatalogService.initialize();
    return {
      customers: CustomerService.list({ includeInactive: false }),
      employees: CatalogService.employees(false),
      services: CatalogService.services(false),
      beds: Array.from({ length: CONFIG.SYSTEM.TOTAL_BEDS }, function (_, index) {
        return String(index + 1);
      })
    };
  }

  /** Returns time slots with available staff and beds for the selected duration. */
  static availability(input) {
    this.initialize();
    CatalogService.initialize();
    const request = input || {};
    const date = request.date ? Validator.date(request.date, 'Ngày xem lịch', { required: true }) : new Date();
    const duration = request.duration ? Validator.integer(request.duration, 'Thời lượng', { required: true, min: 15, max: 480 }) : 60;
    const employees = CatalogService.employees(false);
    const bookings = this.list({ date: date, includeCancelled: false });
    const slotMinutes = Number(CONFIG.SYSTEM.SLOT_MINUTES || 30);
    const opening = Number(CONFIG.SYSTEM.START_HOUR) * 60;
    const closing = Number(CONFIG.SYSTEM.END_HOUR) * 60;
    const beds = Array.from({ length: CONFIG.SYSTEM.TOTAL_BEDS }, function (_, index) { return String(index + 1); });
    const slots = [];
    for (let start = opening; start + duration <= closing; start += slotMinutes) {
      const end = start + duration;
      const startTime = this.minutesToTime(start);
      const endTime = this.minutesToTime(end);
      const overlapping = bookings.filter(function (booking) { return BookingService.timesOverlap(booking.StartTime, booking.EndTime, startTime, endTime); });
      const busyEmployees = overlapping.reduce(function (map, booking) { map[booking.EmployeeID] = true; return map; }, {});
      const busyBeds = overlapping.reduce(function (map, booking) { map[booking.BedID] = true; return map; }, {});
      const availableEmployees = employees.filter(function (employee) { return !busyEmployees[employee.EmployeeID]; }).map(function (employee) {
        return { EmployeeID: employee.EmployeeID, FullName: employee.FullName, Role: employee.Role || '' };
      });
      const availableBeds = beds.filter(function (bed) { return !busyBeds[bed]; });
      slots.push({ StartTime: startTime, EndTime: endTime, availableEmployees: availableEmployees, availableBeds: availableBeds, employeeCount: availableEmployees.length, bedCount: availableBeds.length });
    }
    return { date: DashboardService.dateKey(date), duration: duration, employeesConfigured: employees.length, slots: slots };
  }

  static create(input) {
    this.initialize();
    const booking = this.normalizeForCreate(input);
    this.assertCustomerAvailable(booking.CustomerID);
    this.assertNoConflict(booking);

    const saved = Database.insertWithGeneratedId(this.TABLE, CONFIG.PREFIX.BOOKING, booking, {
      idColumn: 'BookingID', padding: 6
    });
    this.audit('CREATE', saved.BookingID, this.auditMetadata(saved));
    return saved;
  }

  static update(bookingId, changes) {
    this.initialize();
    const current = this.get(bookingId);
    if (!current) throw new Error('Không tìm thấy booking: ' + bookingId);
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new Error('Dữ liệu cập nhật booking không hợp lệ.');
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'BookingID') && String(changes.BookingID) !== String(bookingId)) {
      throw new Error('Không thể thay đổi BookingID.');
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'Status') && changes.Status !== current.Status) {
      throw new Error('Hãy sử dụng thao tác cập nhật trạng thái booking riêng.');
    }

    const updated = this.normalizeForUpdate(Object.assign({}, current, this.pickEditableFields(changes)), current);
    this.assertCustomerAvailable(updated.CustomerID);
    this.assertNoConflict(updated, bookingId);
    const saved = Database.update(this.TABLE, bookingId, updated, 'BookingID');
    this.audit('UPDATE', bookingId, { changedFields: Object.keys(this.pickEditableFields(changes)) });
    return saved;
  }

  static confirm(bookingId) {
    return this.changeStatus(bookingId, CONFIG.BOOKING_STATUS.CONFIRMED);
  }

  static checkIn(bookingId) {
    return this.changeStatus(bookingId, CONFIG.BOOKING_STATUS.CHECKED_IN);
  }

  static complete(bookingId) {
    this.initialize();
    const current = this.get(bookingId);
    if (!current) throw new Error('Không tìm thấy booking: ' + bookingId);
    if (current.Status === CONFIG.BOOKING_STATUS.COMPLETED) return current;
    this.assertStatusTransition(current.Status, CONFIG.BOOKING_STATUS.COMPLETED);

    const prepaid = typeof PrepaidService !== 'undefined'
      ? PrepaidService.consumeForBooking(current)
      : { used: false };
    const changes = {
      Status: CONFIG.BOOKING_STATUS.COMPLETED,
      UpdatedDate: new Date()
    };
    // Revenue for prepaid cards is recorded on the purchase date. A session
    // paid by card is therefore zero-priced here to prevent double counting.
    if (prepaid.used) changes.FinalPrice = 0;

    const saved = Database.update(this.TABLE, bookingId, changes, 'BookingID');
    this.audit('STATUS_' + this.statusKey(CONFIG.BOOKING_STATUS.COMPLETED), bookingId, Object.assign(
      this.auditMetadata(saved), { prepaidCardId: prepaid.cardId || '', prepaidUsed: Boolean(prepaid.used) }
    ));
    return Object.assign({}, saved, { Prepaid: prepaid });
  }

  static cancel(bookingId, note) {
    return this.changeStatus(bookingId, CONFIG.BOOKING_STATUS.CANCELLED, note);
  }

  static markNoShow(bookingId, note) {
    return this.changeStatus(bookingId, CONFIG.BOOKING_STATUS.NOSHOW, note);
  }

  static changeStatus(bookingId, nextStatus, note) {
    this.initialize();
    const current = this.get(bookingId);
    if (!current) throw new Error('Không tìm thấy booking: ' + bookingId);
    this.assertStatusTransition(current.Status, nextStatus);

    const changes = { Status: nextStatus, UpdatedDate: new Date() };
    if (note !== undefined && note !== null && String(note).trim() !== '') {
      changes.Note = Validator.text(note, 'Ghi chú', { maxLength: 2000 });
    }
    const saved = Database.update(this.TABLE, bookingId, changes, 'BookingID');
    this.audit('STATUS_' + this.statusKey(nextStatus), bookingId, this.auditMetadata(saved));
    return saved;
  }

  static normalizeForCreate(input) {
    const data = input || {};
    const core = Validator.booking(Object.assign({}, data, {
      Status: CONFIG.BOOKING_STATUS.PENDING_CONFIRMATION
    }));
    this.applyPrepaidDiscount(core);
    this.assertPrice(core);
    const now = new Date();
    return Object.assign(core, { CreatedDate: now, UpdatedDate: now });
  }

  static normalizeForUpdate(data, current) {
    const core = Validator.booking(Object.assign({}, data, { Status: current.Status }));
    this.assertPrice(core);
    return Object.assign(core, { CreatedDate: current.CreatedDate, UpdatedDate: new Date() });
  }

  static pickEditableFields(input) {
    const allowed = [
      'CustomerID', 'EmployeeID', 'ServiceID', 'BedID', 'BookingDate',
      'StartTime', 'EndTime', 'Price', 'Discount', 'FinalPrice', 'Note'
    ];
    return allowed.reduce(function (result, key) {
      if (Object.prototype.hasOwnProperty.call(input, key)) result[key] = input[key];
      return result;
    }, {});
  }

  static assertCustomerAvailable(customerId) {
    if (typeof CustomerService === 'undefined') return;
    const customer = CustomerService.get(customerId);
    if (!customer) throw new Error('Không tìm thấy hồ sơ khách hàng: ' + customerId);
    if (customer.Status === CONFIG.CUSTOMER_STATUS.INACTIVE || customer.Status === CONFIG.CUSTOMER_STATUS.BLACKLIST) {
      throw new Error('Khách hàng hiện không thể đặt lịch.');
    }
  }

  static assertNoConflict(candidate, excludedBookingId) {
    // Read through list() so legacy Sheet time cells are normalized to HH:mm
    // before overlap checking. Direct raw reads can contain 1899-12-30 dates.
    const conflicts = this.list({ date: candidate.BookingDate, includeCancelled: true }).filter(function (booking) {
      if (booking.BookingID === excludedBookingId || BookingService.isUnavailableStatus(booking.Status)) return false;
      if (!BookingService.timesOverlap(booking.StartTime, booking.EndTime, candidate.StartTime, candidate.EndTime)) return false;
      return booking.BedID === candidate.BedID ||
        booking.EmployeeID === candidate.EmployeeID ||
        booking.CustomerID === candidate.CustomerID;
    });

    if (conflicts.length === 0) return;
    const conflict = conflicts[0];
    if (conflict.BedID === candidate.BedID) {
      throw new Error('Giường ' + candidate.BedID + ' đã có lịch ' + conflict.StartTime + '–' + conflict.EndTime + '.');
    }
    if (conflict.EmployeeID === candidate.EmployeeID) {
      throw new Error('Nhân viên đã có lịch ' + conflict.StartTime + '–' + conflict.EndTime + '.');
    }
    throw new Error('Khách hàng đã có lịch ' + conflict.StartTime + '–' + conflict.EndTime + '.');
  }

  static assertStatusTransition(currentStatus, nextStatus) {
    const status = CONFIG.BOOKING_STATUS;
    const transitions = {};
    transitions[status.PENDING_CONFIRMATION] = [status.CONFIRMED, status.CANCELLED, status.NOSHOW];
    transitions[status.CONFIRMED] = [status.CHECKED_IN, status.CANCELLED, status.NOSHOW];
    transitions[status.CHECKED_IN] = [status.COMPLETED, status.CANCELLED];
    transitions[status.COMPLETED] = [];
    transitions[status.CANCELLED] = [];
    transitions[status.NOSHOW] = [];

    if (currentStatus === nextStatus) return;
    if (!transitions[currentStatus] || transitions[currentStatus].indexOf(nextStatus) === -1) {
      throw new Error('Không thể chuyển trạng thái từ "' + currentStatus + '" sang "' + nextStatus + '".');
    }
  }

  static assertPrice(booking) {
    if (booking.Discount > booking.Price) throw new Error('Giảm giá không được lớn hơn giá dịch vụ.');
    const expected = Number((booking.Price - booking.Discount).toFixed(2));
    if (Math.abs(booking.FinalPrice - expected) > 0.009) {
      throw new Error('Thành tiền phải bằng giá dịch vụ trừ giảm giá.');
    }
  }

  /**
   * Legacy Google Sheet time cells may be returned as Date values based on
   * 1899-12-30. Convert them to a plain HH:mm string before any scheduling
   * or client rendering so the fake date is never displayed.
   */
  static normalizeTimeFields(booking) {
    if (!booking) return booking;
    return Object.assign({}, booking, {
      StartTime: this.normalizeTimeValue(booking.StartTime),
      EndTime: this.normalizeTimeValue(booking.EndTime)
    });
  }

  /**
   * Read time fields from Google Sheets' displayed values. This is the only
   * reliable representation for legacy time-only cells, because converting
   * their 1899 base date through time zones can shift the clock by hours.
   */
  static readAll() {
    const sheet = Database.table(this.TABLE);
    const headers = Database.headers(this.TABLE);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    const displayed = sheet.getRange(2, 1, lastRow - 1, headers.length).getDisplayValues();
    const startIndex = headers.indexOf('StartTime');
    const endIndex = headers.indexOf('EndTime');
    return values.map(function (row, index) {
      const booking = Database.rowToObject(headers, row, index + 2);
      if (startIndex >= 0) booking.StartTime = BookingService.normalizeTimeValue(booking.StartTime, displayed[index][startIndex]);
      if (endIndex >= 0) booking.EndTime = BookingService.normalizeTimeValue(booking.EndTime, displayed[index][endIndex]);
      return booking;
    }).filter(function (booking) {
      return headers.some(function (header) { return booking[header] !== '' && booking[header] !== null; });
    });
  }

  static normalizeTimeValue(value, displayedValue) {
    if (value === null || value === undefined || value === '') return '';
    const display = String(displayedValue || '').trim();
    const displayTime = this.parseTimeText(display);
    if (displayTime) return displayTime;
    if (value instanceof Date) {
      return String(value.getUTCHours()).padStart(2, '0') + ':' + String(value.getUTCMinutes()).padStart(2, '0');
    }
    const text = String(value).trim();
    const parsed = this.parseTimeText(text);
    if (parsed) return parsed;
    const serial = Number(text);
    if (Number.isFinite(serial) && serial >= 0 && serial < 1) {
      const totalMinutes = Math.round(serial * 24 * 60) % (24 * 60);
      return this.minutesToTime(totalMinutes);
    }
    return text;
  }

  static parseTimeText(value) {
    const match = String(value || '').match(/(?:T|^|\s)(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
    if (!match) return '';
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const meridiem = String(match[3] || '').toUpperCase();
    if (meridiem === 'PM' && hour < 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
      ? String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') : '';
  }

  /**
   * Applies a value-card's per-session benefit when a booking is created.
   * A manually entered larger discount is preserved. Legacy cards and plans
   * discounted at purchase do not receive a second discount.
   */
  static applyPrepaidDiscount(booking) {
    if (typeof PrepaidService === 'undefined') return booking;
    // A complimentary legacy session takes priority and is free at completion;
    // do not also attach a value-card discount to the same booking.
    if (PrepaidService.availableSessions(booking.CustomerID, booking.ServiceID).length) return booking;
    const quote = PrepaidService.quoteForBooking(booking.CustomerID, booking.ServiceID, booking.Price);
    if (!quote || String(quote.DiscountMode) !== 'PerSession') return booking;

    const automaticDiscount = Number(quote.DiscountAmount || 0);
    if (automaticDiscount <= 0) return booking;
    booking.Discount = Math.max(Number(booking.Discount || 0), automaticDiscount);
    booking.FinalPrice = Number((Number(booking.Price || 0) - booking.Discount).toFixed(2));
    return booking;
  }

  static isUnavailableStatus(status) {
    return status === CONFIG.BOOKING_STATUS.CANCELLED || status === CONFIG.BOOKING_STATUS.NOSHOW;
  }

  static sameDay(left, right) {
    const zone = CONFIG.TIMEZONE || Session.getScriptTimeZone();
    return Utilities.formatDate(new Date(left), zone, 'yyyy-MM-dd') ===
      Utilities.formatDate(new Date(right), zone, 'yyyy-MM-dd');
  }

  static timesOverlap(startA, endA, startB, endB) {
    return Validator.timeToMinutes(startA) < Validator.timeToMinutes(endB) &&
      Validator.timeToMinutes(endA) > Validator.timeToMinutes(startB);
  }

  static minutesToTime(minutes) {
    return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
  }

  static sortByDateTime(left, right) {
    const dateCompare = new Date(left.BookingDate).getTime() - new Date(right.BookingDate).getTime();
    if (dateCompare !== 0) return dateCompare;
    return Validator.timeToMinutes(left.StartTime) - Validator.timeToMinutes(right.StartTime);
  }

  static statusKey(status) {
    return String(status).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  static audit(action, bookingId, metadata) {
    if (typeof AppLogger !== 'undefined') {
      AppLogger.safe('AUDIT', 'Booking', action, bookingId, action + ' booking', metadata);
    }
  }

  static auditMetadata(booking) {
    return {
      customerId: booking.CustomerID,
      employeeId: booking.EmployeeID,
      bookingDate: booking.BookingDate,
      startTime: booking.StartTime,
      status: booking.Status
    };
  }
}

/* Apps Script entry points for google.script.run and manual administration. */
function initializeBookingModule() { return BookingService.initialize(); }
function getBookings(token, options) { AuthService.requireSession(token); return Utils.toClient(BookingService.list(options)); }
function getBooking(token, bookingId) { AuthService.requireSession(token); return Utils.toClient(BookingService.get(bookingId)); }
function getTodayBookings(token) { AuthService.requireSession(token); return Utils.toClient(BookingService.today()); }
function getBookingOptions(token) { AuthService.requireSession(token); return Utils.toClient(BookingService.options()); }
function getBookingAvailability(token, input) { AuthService.requireSession(token); return Utils.toClient(BookingService.availability(input)); }
function createBooking(token, data) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(BookingService.create(data)); }
function updateBooking(token, bookingId, changes) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(BookingService.update(bookingId, changes)); }
function confirmBooking(token, bookingId) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(BookingService.confirm(bookingId)); }
function checkInBooking(token, bookingId) { AuthService.requireSession(token); return Utils.toClient(BookingService.checkIn(bookingId)); }
function completeBooking(token, bookingId) { AuthService.requireSession(token); return Utils.toClient(BookingService.complete(bookingId)); }
function cancelBooking(token, bookingId, note) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(BookingService.cancel(bookingId, note)); }
function markBookingNoShow(token, bookingId, note) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(BookingService.markNoShow(bookingId, note)); }
