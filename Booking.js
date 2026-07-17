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
    let bookings = Database.findAll(this.TABLE);

    if (date) bookings = bookings.filter(function (booking) {
      return BookingService.sameDay(booking.BookingDate, date);
    });
    if (customerId) bookings = bookings.filter(function (booking) { return booking.CustomerID === customerId; });
    if (!includeCancelled) bookings = bookings.filter(function (booking) {
      return !BookingService.isUnavailableStatus(booking.Status);
    });
    return bookings.sort(this.sortByDateTime);
  }

  static get(bookingId) {
    this.initialize();
    return Database.findById(this.TABLE, Validator.required(bookingId, 'Mã booking'), 'BookingID');
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
    return this.changeStatus(bookingId, CONFIG.BOOKING_STATUS.COMPLETED);
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
    const conflicts = Database.findAll(this.TABLE).filter(function (booking) {
      if (booking.BookingID === excludedBookingId || BookingService.isUnavailableStatus(booking.Status)) return false;
      if (!BookingService.sameDay(booking.BookingDate, candidate.BookingDate)) return false;
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
function getBookings(options) { return Utils.toClient(BookingService.list(options)); }
function getBooking(bookingId) { return Utils.toClient(BookingService.get(bookingId)); }
function getTodayBookings() { return Utils.toClient(BookingService.today()); }
function getBookingOptions() { return Utils.toClient(BookingService.options()); }
function createBooking(data) { return Utils.toClient(BookingService.create(data)); }
function updateBooking(bookingId, changes) { return Utils.toClient(BookingService.update(bookingId, changes)); }
function confirmBooking(bookingId) { return Utils.toClient(BookingService.confirm(bookingId)); }
function checkInBooking(bookingId) { return Utils.toClient(BookingService.checkIn(bookingId)); }
function completeBooking(bookingId) { return Utils.toClient(BookingService.complete(bookingId)); }
function cancelBooking(bookingId, note) { return Utils.toClient(BookingService.cancel(bookingId, note)); }
function markBookingNoShow(bookingId, note) { return Utils.toClient(BookingService.markNoShow(bookingId, note)); }
