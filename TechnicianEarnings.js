/**
 * DOVAKO OS
 * TechnicianEarnings.js
 * Automatically records tour commission when a booking is completed.
 * Technicians can only enter their own tip amount.
 */
class TechnicianEarningService {
  static get TABLE() { return CONFIG.SHEETS.TECHNICIAN_EARNINGS; }

  static get HEADERS() {
    return [
      'EarningID', 'BookingID', 'EmployeeID', 'BookingDate', 'CustomerID', 'ServiceID',
      'CommissionRate', 'CommissionBase', 'CommissionAmount', 'TipAmount',
      'CreatedDate', 'UpdatedDate'
    ];
  }

  static initialize() {
    Database.ensureTable(this.TABLE, this.HEADERS);
    Database.ensureColumns(this.TABLE, this.HEADERS);
  }

  /**
   * Idempotently creates one earning row for every technician assigned to a
   * completed booking. Commission is calculated from the discounted tour value.
   */
  static ensureForCompletedBooking(booking, commissionBase) {
    this.initialize();
    if (!booking || !booking.BookingID) throw new Error('Không xác định được booking để tính % tour.');

    const employeeIds = BookingService.employeeIdsForBooking(booking);
    if (!employeeIds.length) return [];

    const employeeMap = CatalogService.employees(true).reduce(function (map, employee) {
      map[String(employee.EmployeeID)] = employee;
      return map;
    }, {});
    const existing = Database.where(this.TABLE, { BookingID: booking.BookingID }).reduce(function (map, row) {
      map[String(row.EmployeeID)] = row;
      return map;
    }, {});
    const base = Math.max(0, Number(commissionBase || 0));
    const now = new Date();
    const saved = [];

    employeeIds.forEach(function (employeeId) {
      const id = String(employeeId || '').trim();
      if (!id || existing[id]) return;
      const employee = employeeMap[id];
      if (!employee) throw new Error('Không tìm thấy kỹ thuật viên ' + id + ' để tính % tour.');
      const rate = Validator.number(employee.CommissionRate, '% tour', { defaultValue: 0, min: 0, max: 100 });
      const amount = Math.round(base * rate / 100);
      const record = Database.insertWithGeneratedId(TechnicianEarningService.TABLE, CONFIG.PREFIX.TECHNICIAN_EARNING, {
        BookingID: booking.BookingID,
        EmployeeID: id,
        BookingDate: booking.BookingDate || new Date(),
        CustomerID: booking.CustomerID || '',
        ServiceID: booking.ServiceID || '',
        CommissionRate: rate,
        CommissionBase: base,
        CommissionAmount: amount,
        TipAmount: 0,
        CreatedDate: now,
        UpdatedDate: now
      }, { idColumn: 'EarningID', padding: 6 });
      AppLogger.safe('AUDIT', 'TechnicianEarning', 'CREATE', record.EarningID, 'CREATE technician tour commission', {
        bookingId: booking.BookingID,
        employeeId: id,
        commissionRate: rate,
        commissionAmount: amount
      });
      saved.push(record);
    });

    return saved;
  }

  static listForSession(session, options) {
    this.initialize();
    if ([CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.TECHNICIAN].indexOf(session.Role) === -1) {
      throw new Error('Bạn không có quyền xem hoa hồng và tiền tip.');
    }
    const settings = options || {};
    const from = settings.from ? Validator.date(settings.from, 'Từ ngày') : null;
    const to = settings.to ? Validator.date(settings.to, 'Đến ngày') : null;
    const requestedEmployeeId = String(settings.employeeId || '').trim();
    const employeeId = session.Role === CONFIG.ROLES.TECHNICIAN
      ? String(session.EmployeeID || '').trim()
      : requestedEmployeeId;
    if (session.Role === CONFIG.ROLES.TECHNICIAN && !employeeId) {
      throw new Error('Tài khoản kỹ thuật viên chưa được liên kết với hồ sơ nhân viên.');
    }

    const customerMap = Database.findAll(CONFIG.SHEETS.CUSTOMERS).reduce(function (map, customer) {
      map[String(customer.CustomerID)] = customer.FullName || customer.CustomerID;
      return map;
    }, {});
    const serviceMap = CatalogService.services(true).reduce(function (map, service) {
      map[String(service.ServiceID)] = service.ServiceName || service.ServiceID;
      return map;
    }, {});
    const employeeMap = CatalogService.employees(true).reduce(function (map, employee) {
      map[String(employee.EmployeeID)] = employee.FullName || employee.EmployeeID;
      return map;
    }, {});

    const records = Database.findAll(this.TABLE).filter(function (record) {
      const date = Validator.date(record.BookingDate, 'Ngày booking');
      if (employeeId && String(record.EmployeeID) !== employeeId) return false;
      if (from && date < TechnicianEarningService.startOfDay(from)) return false;
      if (to && date > TechnicianEarningService.endOfDay(to)) return false;
      return true;
    }).map(function (record) {
      return Object.assign({}, record, {
        CustomerName: customerMap[String(record.CustomerID)] || record.CustomerID,
        ServiceName: serviceMap[String(record.ServiceID)] || record.ServiceID,
        EmployeeName: employeeMap[String(record.EmployeeID)] || record.EmployeeID
      });
    }).sort(function (left, right) {
      const byDate = new Date(right.BookingDate).getTime() - new Date(left.BookingDate).getTime();
      return byDate || String(right.EarningID).localeCompare(String(left.EarningID));
    });

    const summary = records.reduce(function (total, record) {
      total.tours += 1;
      total.commission += Number(record.CommissionAmount || 0);
      total.tip += Number(record.TipAmount || 0);
      return total;
    }, { tours: 0, commission: 0, tip: 0 });
    summary.total = summary.commission + summary.tip;
    return { records: records, summary: summary };
  }

  static saveOwnTip(session, earningId, tipAmount) {
    if (session.Role !== CONFIG.ROLES.TECHNICIAN) {
      throw new Error('Chỉ kỹ thuật viên được nhập tiền tip.');
    }
    const employeeId = String(session.EmployeeID || '').trim();
    if (!employeeId) throw new Error('Tài khoản chưa được liên kết với nhân viên.');
    this.initialize();
    const id = Validator.required(earningId, 'Mã tour');
    const record = Database.findById(this.TABLE, id, 'EarningID');
    if (!record) throw new Error('Không tìm thấy tour cần nhập tip.');
    if (String(record.EmployeeID) !== employeeId) throw new Error('Bạn chỉ được nhập tiền tip của tour được phân công cho mình.');

    const tip = Validator.number(tipAmount, 'Tiền tip', { required: true, min: 0, max: 100000000 });
    const saved = Database.update(this.TABLE, id, { TipAmount: Math.round(tip), UpdatedDate: new Date() }, 'EarningID');
    AppLogger.safe('AUDIT', 'TechnicianEarning', 'UPDATE_TIP', id, 'UPDATE own tip', {
      employeeId: employeeId,
      tipAmount: Math.round(tip)
    });
    return saved;
  }

  static startOfDay(value) {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  static endOfDay(value) {
    const date = new Date(value);
    date.setHours(23, 59, 59, 999);
    return date;
  }
}

function getTechnicianEarnings(token, options) {
  const session = AuthService.requireSession(token);
  return Utils.toClient(TechnicianEarningService.listForSession(session, options));
}

function updateTechnicianTip(token, earningId, tipAmount) {
  const session = AuthService.requireSession(token);
  return Utils.toClient(TechnicianEarningService.saveOwnTip(session, earningId, tipAmount));
}
