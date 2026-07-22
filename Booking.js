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
      'FinalPrice', 'Note', 'CreatedDate', 'UpdatedDate', 'CardOwnerCustomerID',
      'BookingGroupID'
    ];
  }

  static get ASSIGNMENT_TABLE() { return CONFIG.SHEETS.BOOKING_ASSIGNMENTS; }

  static get ASSIGNMENT_HEADERS() {
    return ['AssignmentID', 'BookingID', 'EmployeeID', 'AssignmentRole', 'CreatedDate', 'UpdatedDate'];
  }

  static initialize() {
    // Add new fields without changing any booking already recorded.
    Database.ensureColumns(this.TABLE, this.HEADERS);
    Database.ensureTable(this.ASSIGNMENT_TABLE, this.ASSIGNMENT_HEADERS);
    this.ensureVietnamTimezone();
    return {
      sheet: this.TABLE,
      headers: this.HEADERS.slice(),
      assignmentSheet: this.ASSIGNMENT_TABLE,
      assignmentHeaders: this.ASSIGNMENT_HEADERS.slice()
    };
  }

  /** Keeps the shared Google Sheet on the application's Vietnam time zone. */
  static ensureVietnamTimezone() {
    const spreadsheet = Database.getSpreadsheet();
    if (spreadsheet.getSpreadsheetTimeZone() !== CONFIG.TIMEZONE) {
      spreadsheet.setSpreadsheetTimeZone(CONFIG.TIMEZONE);
    }
  }

  static list(options) {
    this.initialize();
    const settings = options || {};
    const date = settings.date ? Validator.date(settings.date, 'Ngày booking') : null;
    const customerId = settings.customerId ? Validator.required(settings.customerId, 'Mã khách hàng') : '';
    const includeCancelled = settings.includeCancelled === true;
    let bookings = this.attachAssignments(this.readAll());

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
    const booking = this.readAll().find(function (item) { return item.BookingID === id; }) || null;
    return booking ? this.attachAssignments([booking])[0] : null;
  }

  static today() {
    return this.list({ date: new Date(), includeCancelled: true });
  }

  /** Reference data for the booking form. Admin can maintain these sheets later. */
  static options(input) {
    this.initialize();
    CatalogService.initialize();
    const request = input || {};
    const date = request.date ? Validator.date(request.date, 'Ngày booking', { required: true }) : new Date();
    const leaveEmployeeIds = this.employeeIdsOnLeave(date);
    return {
      customers: CustomerService.list({ includeInactive: false }),
      employees: CatalogService.employees(false).filter(function (employee) {
        return !leaveEmployeeIds[String(employee.EmployeeID)];
      }),
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
    const leaveEmployeeIds = this.employeeIdsOnLeave(date);
    const employees = CatalogService.employees(false).filter(function (employee) {
      return !leaveEmployeeIds[String(employee.EmployeeID)];
    });
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
      const busyEmployees = overlapping.reduce(function (map, booking) {
        BookingService.employeeIdsForBooking(booking).forEach(function (employeeId) { map[employeeId] = true; });
        return map;
      }, {});
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
    return this.createBatch([input], '')[0];
  }

  /**
   * Creates one booking per service user under a shared group code.  A group
   * is used when one person books a time slot for friends or family.  Every
   * participant retains an individual booking, history, status, and bed.
   */
  static createGroup(input) {
    const data = input || {};
    const participants = Array.isArray(data.Participants) ? data.Participants : [];
    if (!participants.length) return { BookingGroupID: '', bookings: [this.create(data)] };

    const base = Object.assign({}, data);
    delete base.Participants;
    const groupId = 'BG' + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
    const records = [base].concat(participants.map(function (participant) {
      return Object.assign({}, base, participant || {});
    }));
    const saved = this.createBatch(records, groupId);
    return { BookingGroupID: groupId, bookings: saved };
  }

  /** Saves a validated set of new bookings while one script lock is held. */
  static createBatch(inputs, groupId) {
    this.initialize();
    if (!Array.isArray(inputs) || !inputs.length) throw new Error('Cần có ít nhất một khách để tạo booking.');
    const bookings = inputs.map(function (input) {
      const booking = BookingService.normalizeForCreate(input);
      booking.BookingGroupID = groupId || '';
      return booking;
    });

    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      this.assertBookingSetAvailable(bookings);
      const bookingIds = this.nextSequentialIds(this.TABLE, 'BookingID', CONFIG.PREFIX.BOOKING, 6, bookings.length);
      const assignmentCount = bookings.reduce(function (total, booking) { return total + booking.EmployeeIDs.length; }, 0);
      const assignmentIds = this.nextSequentialIds(this.ASSIGNMENT_TABLE, 'AssignmentID', CONFIG.PREFIX.BOOKING_ASSIGNMENT, 6, assignmentCount);
      let assignmentIndex = 0;
      const saved = bookings.map(function (booking, index) {
        const bookingId = bookingIds[index];
        const stored = BookingService.storeBooking(booking, bookingId);
        const record = Database.insert(BookingService.TABLE, stored);
        booking.EmployeeIDs.forEach(function (employeeId, employeeIndex) {
          Database.insert(BookingService.ASSIGNMENT_TABLE, {
            AssignmentID: assignmentIds[assignmentIndex++],
            BookingID: bookingId,
            EmployeeID: employeeId,
            AssignmentRole: employeeIndex === 0 ? 'Primary' : 'Support',
            CreatedDate: new Date(),
            UpdatedDate: new Date()
          });
        });
        return Object.assign({}, record, { EmployeeIDs: booking.EmployeeIDs.slice() });
      });
      SpreadsheetApp.flush();
      saved.forEach(function (booking) {
        BookingService.audit('CREATE', booking.BookingID, BookingService.auditMetadata(booking));
      });
      return this.attachAssignments(saved);
    } finally {
      lock.releaseLock();
    }
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

    const editable = this.pickEditableFields(changes);
    const merged = Object.assign({}, current, editable);
    // If a caller replaces only the lead technician, do not silently retain
    // the previous lead as an assistant. Explicit EmployeeIDs still wins.
    if (Object.prototype.hasOwnProperty.call(editable, 'EmployeeID') &&
        !Object.prototype.hasOwnProperty.call(editable, 'EmployeeIDs')) {
      merged.EmployeeIDs = [editable.EmployeeID];
    }
    const updated = this.normalizeForUpdate(merged, current);
    this.assertCustomerAvailable(updated.CustomerID);
    this.assertCardOwnerAvailable(updated.CardOwnerCustomerID);
    this.assertEmployeesAvailable(updated.EmployeeIDs, updated.BookingDate);
    this.assertNoConflict(updated, bookingId);
    const saved = Database.update(this.TABLE, bookingId, this.storeBooking(updated, bookingId), 'BookingID');
    this.replaceAssignments(bookingId, updated.EmployeeIDs);
    this.audit('UPDATE', bookingId, { changedFields: Object.keys(this.pickEditableFields(changes)) });
    return this.attachAssignments([saved])[0];
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
    // Revenue already paid into a prepaid card was recorded on its purchase
    // date.  If the card balance is insufficient, keep only the shortfall as
    // this booking's revenue so it can be collected at check-out.
    if (prepaid.used) changes.FinalPrice = Math.max(0, Number(prepaid.outstandingAmount || 0));

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
    core.CardOwnerCustomerID = this.normalizeCardOwnerId(data.CardOwnerCustomerID, core.CustomerID);
    core.EmployeeIDs = this.normalizeEmployeeIds(data.EmployeeIDs, core.EmployeeID);
    core.BookingGroupID = '';
    this.applyPrepaidDiscount(core);
    this.assertPrice(core);
    const now = new Date();
    return Object.assign(core, { CreatedDate: now, UpdatedDate: now });
  }

  static normalizeForUpdate(data, current) {
    const core = Validator.booking(Object.assign({}, data, { Status: current.Status }));
    core.CardOwnerCustomerID = this.normalizeCardOwnerId(data.CardOwnerCustomerID, core.CustomerID);
    core.EmployeeIDs = this.normalizeEmployeeIds(data.EmployeeIDs, core.EmployeeID);
    core.BookingGroupID = current.BookingGroupID || '';
    this.applyPrepaidDiscount(core);
    this.assertPrice(core);
    return Object.assign(core, { CreatedDate: current.CreatedDate, UpdatedDate: new Date() });
  }

  static pickEditableFields(input) {
    const allowed = [
      'CustomerID', 'EmployeeID', 'ServiceID', 'BedID', 'BookingDate',
      'StartTime', 'EndTime', 'Price', 'Discount', 'FinalPrice', 'Note',
      'CardOwnerCustomerID', 'EmployeeIDs'
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

  /** A blank owner means the service user is also the owner of the card. */
  static normalizeCardOwnerId(value, customerId) {
    const ownerId = value === null || value === undefined ? '' : String(value).trim();
    return ownerId && ownerId !== String(customerId) ? Validator.required(ownerId, 'Mã chủ thẻ') : '';
  }

  static prepaidCustomerId(booking) {
    return String((booking && booking.CardOwnerCustomerID) || (booking && booking.CustomerID) || '').trim();
  }

  static assertCardOwnerAvailable(cardOwnerCustomerId) {
    if (!cardOwnerCustomerId) return;
    this.assertCustomerAvailable(cardOwnerCustomerId);
  }

  static employeeIdsOnLeave(date) {
    return typeof LeaveService !== 'undefined'
      ? LeaveService.employeeIdsOnLeave(date)
      : {};
  }

  static assertEmployeeAvailable(employeeId, date) {
    CatalogService.initialize();
    const employee = CatalogService.employees(false).find(function (item) {
      return String(item.EmployeeID) === String(employeeId);
    });
    if (!employee) throw new Error('Nhân viên không tồn tại hoặc đã lưu trữ.');
    if (this.employeeIdsOnLeave(date)[String(employeeId)]) {
      throw new Error('Nhân viên đang nghỉ ngày ' + Utilities.formatDate(new Date(date), CONFIG.TIMEZONE, 'dd/MM/yyyy') + '. Hãy chọn nhân viên khác.');
    }
  }

  static assertEmployeesAvailable(employeeIds, date) {
    this.normalizeEmployeeIds(employeeIds, '').forEach(function (employeeId) {
      BookingService.assertEmployeeAvailable(employeeId, date);
    });
  }

  static assertNoConflict(candidate, excludedBookingId) {
    // Read through list() so legacy Sheet time cells are normalized to HH:mm
    // before overlap checking. Direct raw reads can contain 1899-12-30 dates.
    const conflicts = this.list({ date: candidate.BookingDate, includeCancelled: true }).filter(function (booking) {
      if (booking.BookingID === excludedBookingId || BookingService.isUnavailableStatus(booking.Status)) return false;
      if (!BookingService.timesOverlap(booking.StartTime, booking.EndTime, candidate.StartTime, candidate.EndTime)) return false;
      return booking.BedID === candidate.BedID ||
        BookingService.employeeIdsOverlap(BookingService.employeeIdsForBooking(booking), BookingService.employeeIdsForBooking(candidate)) ||
        booking.CustomerID === candidate.CustomerID;
    });

    if (conflicts.length === 0) return;
    const conflict = conflicts[0];
    if (conflict.BedID === candidate.BedID) {
      throw new Error('Giường ' + candidate.BedID + ' đã có lịch ' + conflict.StartTime + '–' + conflict.EndTime + '.');
    }
    if (this.employeeIdsOverlap(this.employeeIdsForBooking(conflict), this.employeeIdsForBooking(candidate))) {
      throw new Error('Nhân viên đã có lịch ' + conflict.StartTime + '–' + conflict.EndTime + '.');
    }
    throw new Error('Khách hàng đã có lịch ' + conflict.StartTime + '–' + conflict.EndTime + '.');
  }

  /** Validates existing schedule conflicts and conflicts inside a new group. */
  static assertBookingSetAvailable(bookings) {
    bookings.forEach(function (booking) {
      BookingService.assertCustomerAvailable(booking.CustomerID);
      BookingService.assertCardOwnerAvailable(booking.CardOwnerCustomerID);
      BookingService.assertEmployeesAvailable(booking.EmployeeIDs, booking.BookingDate);
      BookingService.assertNoConflict(booking);
    });

    for (let left = 0; left < bookings.length; left += 1) {
      for (let right = left + 1; right < bookings.length; right += 1) {
        const first = bookings[left];
        const second = bookings[right];
        if (!this.sameDay(first.BookingDate, second.BookingDate) ||
            !this.timesOverlap(first.StartTime, first.EndTime, second.StartTime, second.EndTime)) continue;
        if (first.CustomerID === second.CustomerID) {
          throw new Error('Một khách không thể có hai lịch trùng giờ trong cùng nhóm.');
        }
        if (first.BedID === second.BedID) {
          throw new Error('Các khách trong cùng nhóm không thể dùng chung giường ' + first.BedID + ' cùng giờ.');
        }
        if (this.employeeIdsOverlap(this.employeeIdsForBooking(first), this.employeeIdsForBooking(second))) {
          throw new Error('Một kỹ thuật viên không thể phục vụ hai khách trong cùng nhóm cùng giờ.');
        }
      }
    }
  }

  /** Converts a multi-select value into distinct employee IDs, primary first. */
  static normalizeEmployeeIds(value, primaryEmployeeId) {
    const raw = Array.isArray(value)
      ? value
      : (value === null || value === undefined || value === '' ? [] : String(value).split(','));
    const ids = raw.map(function (item) { return String(item || '').trim(); })
      .filter(function (item) { return item !== ''; });
    const primary = String(primaryEmployeeId || '').trim();
    if (primary) ids.unshift(primary);
    const unique = ids.filter(function (item, index, all) { return all.indexOf(item) === index; });
    if (!unique.length) throw new Error('Cần chọn ít nhất một nhân viên.');
    return unique;
  }

  static employeeIdsForBooking(booking) {
    if (!booking) return [];
    if (Array.isArray(booking.EmployeeIDs) && booking.EmployeeIDs.length) {
      return this.normalizeEmployeeIds(booking.EmployeeIDs, '');
    }
    return booking.EmployeeID ? [String(booking.EmployeeID)] : [];
  }

  static employeeIdsOverlap(left, right) {
    const leftIds = this.employeeIdsForBooking({ EmployeeIDs: left });
    const rightIds = this.employeeIdsForBooking({ EmployeeIDs: right });
    return leftIds.some(function (employeeId) { return rightIds.indexOf(employeeId) !== -1; });
  }

  static isEmployeeAssigned(booking, employeeId) {
    return this.employeeIdsForBooking(booking).indexOf(String(employeeId || '').trim()) !== -1;
  }

  /** Adds assignment data to records while keeping legacy single-staff rows working. */
  static attachAssignments(bookings) {
    if (!Array.isArray(bookings) || !bookings.length) return bookings || [];
    const assignmentMap = Database.findAll(this.ASSIGNMENT_TABLE).reduce(function (map, assignment) {
      const bookingId = String(assignment.BookingID || '');
      if (!bookingId) return map;
      if (!map[bookingId]) map[bookingId] = [];
      map[bookingId].push(assignment);
      return map;
    }, {});
    const employeeMap = CatalogService.employees(true).reduce(function (map, employee) {
      map[String(employee.EmployeeID)] = employee.FullName || employee.EmployeeID;
      return map;
    }, {});

    return bookings.map(function (booking) {
      const assignments = (assignmentMap[String(booking.BookingID)] || []).slice().sort(function (left, right) {
        return left.AssignmentRole === right.AssignmentRole ? left._rowNumber - right._rowNumber :
          (left.AssignmentRole === 'Primary' ? -1 : 1);
      });
      const employeeIds = assignments.length
        ? assignments.map(function (assignment) { return String(assignment.EmployeeID); })
        : (booking.EmployeeID ? [String(booking.EmployeeID)] : []);
      return Object.assign({}, booking, {
        EmployeeIDs: employeeIds,
        EmployeeNames: employeeIds.map(function (employeeId) { return employeeMap[employeeId] || employeeId; })
      });
    });
  }

  /** Produces only the columns that are stored in BOOKINGS. */
  static storeBooking(booking, bookingId) {
    const record = {};
    this.HEADERS.forEach(function (header) {
      if (header === 'BookingID') record[header] = bookingId || booking.BookingID || '';
      else record[header] = Object.prototype.hasOwnProperty.call(booking, header) ? booking[header] : '';
    });
    return record;
  }

  /** Calculates several sequential IDs under the caller's script lock. */
  static nextSequentialIds(sheetName, idColumn, prefix, padding, count) {
    const pattern = new RegExp('^' + Database.escapeRegExp(prefix) + '(\\d+)$');
    let highest = Database.findAll(sheetName).reduce(function (max, record) {
      const match = String(record[idColumn] || '').match(pattern);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return Array.from({ length: count }, function () {
      highest += 1;
      return prefix + String(highest).padStart(padding, '0');
    });
  }

  static replaceAssignments(bookingId, employeeIds) {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const ids = this.normalizeEmployeeIds(employeeIds, '');
      Database.removeWhere(this.ASSIGNMENT_TABLE, { BookingID: bookingId });
      const assignmentIds = this.nextSequentialIds(this.ASSIGNMENT_TABLE, 'AssignmentID', CONFIG.PREFIX.BOOKING_ASSIGNMENT, 6, ids.length);
      ids.forEach(function (employeeId, index) {
        Database.insert(BookingService.ASSIGNMENT_TABLE, {
          AssignmentID: assignmentIds[index],
          BookingID: bookingId,
          EmployeeID: employeeId,
          AssignmentRole: index === 0 ? 'Primary' : 'Support',
          CreatedDate: new Date(),
          UpdatedDate: new Date()
        });
      });
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
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
    const prepaidCustomerId = this.prepaidCustomerId(booking);
    // A complimentary legacy session takes priority and is free at completion;
    // do not also attach a value-card discount to the same booking.
    if (PrepaidService.availableSessions(prepaidCustomerId, booking.ServiceID).length) return booking;
    const quote = PrepaidService.quoteForBooking(prepaidCustomerId, booking.ServiceID, booking.Price);
    if (!quote) {
      return booking;
    }
    if (String(quote.DiscountMode) !== 'PerSession') return booking;

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
      cardOwnerCustomerId: booking.CardOwnerCustomerID || booking.CustomerID,
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
function getBookingOptions(token, input) {
  const session = AuthService.requireSession(token);
  const options = BookingService.options(input);
  options.customers = CustomerService.listForSession(session, { includeInactive: false });
  return Utils.toClient(options);
}
function getBookingAvailability(token, input) { AuthService.requireSession(token); return Utils.toClient(BookingService.availability(input)); }
function createBooking(token, data) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(BookingService.create(data)); }
function createBookingGroup(token, data) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(BookingService.createGroup(data)); }
function updateBooking(token, bookingId, changes) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(BookingService.update(bookingId, changes)); }
function confirmBooking(token, bookingId) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(BookingService.confirm(bookingId)); }
function checkInBooking(token, bookingId) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(BookingService.checkIn(bookingId)); }
function completeBooking(token, bookingId) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(BookingService.complete(bookingId)); }
function cancelBooking(token, bookingId, note) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(BookingService.cancel(bookingId, note)); }
function markBookingNoShow(token, bookingId, note) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(BookingService.markNoShow(bookingId, note)); }
