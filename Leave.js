/**
 * DOVAKO OS
 * Leave.js
 * Employee leave schedule displayed on the internal notice board.
 */
class LeaveService {
  static get TABLE() { return CONFIG.SHEETS.LEAVE_SCHEDULES; }

  static get HEADERS() {
    return [
      'LeaveID', 'EmployeeID', 'EmployeeName', 'StartDate', 'EndDate',
      'Reason', 'Status', 'CreatedBy', 'CreatedDate', 'UpdatedBy', 'UpdatedDate'
    ];
  }

  static get STATUSES() { return ['Nháp', 'Đã đăng', 'Lưu trữ']; }

  static initialize() {
    Database.ensureTable(this.TABLE, this.HEADERS);
    return { sheet: this.TABLE, headers: this.HEADERS.slice() };
  }

  static canManage(session) {
    return Boolean(session) && [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER].indexOf(session.Role) !== -1;
  }

  static list(session, options) {
    this.initialize();
    const settings = options || {};
    const canManage = this.canManage(session);
    const month = String(settings.month || '').trim();
    const status = String(settings.Status || '').trim();
    const query = this.normalizeSearch(settings.query);
    const today = this.dateKey(new Date());

    const records = Database.findAll(this.TABLE).filter(function (item) {
      const startDate = LeaveService.dateKey(item.StartDate);
      const endDate = LeaveService.dateKey(item.EndDate || item.StartDate);
      if (!canManage) {
        if (item.Status !== 'Đã đăng') return false;
        if (endDate && endDate < today) return false;
      }
      if (canManage && status && item.Status !== status) return false;
      if (month && !LeaveService.overlapsMonth(startDate, endDate, month)) return false;
      if (!query) return true;
      return [item.EmployeeName, item.Reason, item.LeaveID].some(function (value) {
        return LeaveService.normalizeSearch(value).indexOf(query) !== -1;
      });
    });

    records.sort(function (left, right) {
      const statusWeight = function (item) {
        if (item.Status === 'Đã đăng') return 0;
        if (item.Status === 'Nháp') return 1;
        return 2;
      };
      const statusDifference = statusWeight(left) - statusWeight(right);
      if (statusDifference !== 0) return statusDifference;
      return LeaveService.dateKey(left.StartDate).localeCompare(LeaveService.dateKey(right.StartDate));
    });
    return records;
  }

  /**
   * Returns a lookup of staff who have a published leave schedule on a day.
   * Booking uses this on both the form and the server-side final validation.
   */
  static employeeIdsOnLeave(date) {
    this.initialize();
    const day = this.dateKey(date);
    if (!day) return {};
    return Database.findAll(this.TABLE).reduce(function (result, item) {
      if (item.Status !== 'Đã đăng') return result;
      const startDate = LeaveService.dateKey(item.StartDate);
      const endDate = LeaveService.dateKey(item.EndDate || item.StartDate);
      if (startDate && endDate && startDate <= day && endDate >= day) {
        result[String(item.EmployeeID)] = true;
      }
      return result;
    }, {});
  }

  static isEmployeeOnLeave(employeeId, date) {
    return Boolean(this.employeeIdsOnLeave(date)[String(employeeId)]);
  }

  static create(session, input) {
    this.assertManager(session);
    this.initialize();
    const now = new Date();
    const record = this.normalize(input, null, this.actor(session), now);
    this.assertNoDateConflict(record, '');
    const saved = Database.insertWithGeneratedId(this.TABLE, CONFIG.PREFIX.LEAVE, record, {
      idColumn: 'LeaveID', padding: 6
    });
    this.audit('CREATE', saved.LeaveID, session, saved);
    return saved;
  }

  static update(session, leaveId, input) {
    this.assertManager(session);
    this.initialize();
    const current = Database.findById(this.TABLE, Validator.required(leaveId, 'Mã lịch nghỉ'), 'LeaveID');
    if (!current) throw new Error('Không tìm thấy lịch nghỉ cần cập nhật.');
    const record = this.normalize(input, current, this.actor(session), new Date());
    this.assertNoDateConflict(record, current.LeaveID);
    const saved = Database.update(this.TABLE, current.LeaveID, record, 'LeaveID');
    this.audit('UPDATE', saved.LeaveID, session, saved);
    return saved;
  }

  static archive(session, leaveId) {
    this.assertManager(session);
    this.initialize();
    const current = Database.findById(this.TABLE, Validator.required(leaveId, 'Mã lịch nghỉ'), 'LeaveID');
    if (!current) throw new Error('Không tìm thấy lịch nghỉ cần lưu trữ.');
    const saved = Database.update(this.TABLE, current.LeaveID, {
      Status: 'Lưu trữ', UpdatedBy: this.actor(session), UpdatedDate: new Date()
    }, 'LeaveID');
    this.audit('ARCHIVE', saved.LeaveID, session, saved);
    return saved;
  }

  static normalize(input, current, actor, now) {
    const value = input || {};
    const employeeId = Validator.required(
      value.EmployeeID === undefined ? (current && current.EmployeeID) : value.EmployeeID,
      'Nhân viên'
    );
    const employee = CatalogService.employees(true).find(function (item) {
      return String(item.EmployeeID) === String(employeeId);
    });
    if (!employee) throw new Error('Không tìm thấy nhân viên được chọn.');
    if (employee.Status === 'Inactive') throw new Error('Nhân viên đã lưu trữ nên không thể tạo lịch nghỉ mới.');

    const startDate = Validator.date(
      value.StartDate === undefined ? (current && current.StartDate) : value.StartDate,
      'Ngày bắt đầu', { required: true }
    );
    const endDate = Validator.date(
      value.EndDate === undefined ? (current && current.EndDate) : value.EndDate,
      'Ngày kết thúc', { required: true }
    );
    if (this.dateKey(endDate) < this.dateKey(startDate)) {
      throw new Error('Ngày kết thúc phải bằng hoặc sau ngày bắt đầu.');
    }

    return {
      EmployeeID: employee.EmployeeID,
      EmployeeName: employee.FullName,
      StartDate: startDate,
      EndDate: endDate,
      Reason: Validator.text(
        value.Reason === undefined ? (current && current.Reason) : value.Reason,
        'Ghi chú', { required: true, maxLength: 1000 }
      ),
      Status: Validator.oneOf(
        value.Status || (current && current.Status) || 'Đã đăng',
        this.STATUSES, 'Trạng thái', { required: true }
      ),
      CreatedBy: current ? current.CreatedBy : actor,
      CreatedDate: current ? current.CreatedDate : now,
      UpdatedBy: actor,
      UpdatedDate: now
    };
  }

  static assertNoDateConflict(record, excludedLeaveId) {
    if (record.Status === 'Lưu trữ') return;
    const hasConflict = Database.findAll(this.TABLE).some(function (item) {
      if (item.LeaveID === excludedLeaveId || item.Status === 'Lưu trữ') return false;
      if (String(item.EmployeeID) !== String(record.EmployeeID)) return false;
      return LeaveService.dateKey(item.StartDate) <= LeaveService.dateKey(record.EndDate) &&
        LeaveService.dateKey(item.EndDate || item.StartDate) >= LeaveService.dateKey(record.StartDate);
    });
    if (hasConflict) throw new Error('Nhân viên này đã có lịch nghỉ trùng thời gian.');
  }

  static overlapsMonth(startDate, endDate, month) {
    if (!/^\d{4}-\d{2}$/.test(month)) return true;
    return startDate.slice(0, 7) <= month && endDate.slice(0, 7) >= month;
  }

  static assertManager(session) {
    if (!this.canManage(session)) throw new Error('Chỉ Admin hoặc Quản lý có quyền cập nhật lịch nghỉ nhân viên.');
  }

  static actor(session) {
    return String((session && (session.FullName || session.Username || session.UserID)) || 'DOVAKO').trim();
  }

  static dateKey(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return Utilities.formatDate(date, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }

  static normalizeSearch(value) {
    return String(value || '').toLocaleLowerCase('vi-VN').trim().replace(/\s+/g, ' ');
  }

  static audit(action, leaveId, session, record) {
    AppLogger.safe('AUDIT', 'LeaveSchedule', action, leaveId, 'Leave schedule ' + action, {
      actor: this.actor(session), role: session.Role,
      employeeId: record.EmployeeID, employeeName: record.EmployeeName,
      startDate: this.dateKey(record.StartDate), endDate: this.dateKey(record.EndDate), status: record.Status
    });
  }
}

function initializeLeaveModule() { return Utils.toClient(LeaveService.initialize()); }
function getLeaveSchedules(token, options) { return Utils.toClient(LeaveService.list(AuthService.requireSession(token), options)); }
function createLeaveSchedule(token, data) { return Utils.toClient(LeaveService.create(AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]), data)); }
function updateLeaveSchedule(token, leaveId, data) { return Utils.toClient(LeaveService.update(AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]), leaveId, data)); }
function archiveLeaveSchedule(token, leaveId) { return Utils.toClient(LeaveService.archive(AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]), leaveId)); }
