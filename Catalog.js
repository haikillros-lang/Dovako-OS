/** DOVAKO OS reference data: employees and services. */
class CatalogService {
  static get EMPLOYEE_HEADERS() {
    return ['EmployeeID', 'FullName', 'Phone', 'Role', 'Status', 'CreatedDate', 'UpdatedDate'];
  }

  static get SERVICE_HEADERS() {
    return ['ServiceID', 'ServiceName', 'Duration', 'Price', 'Status', 'CreatedDate', 'UpdatedDate'];
  }

  static initialize() {
    Database.ensureTable(CONFIG.SHEETS.EMPLOYEES, this.EMPLOYEE_HEADERS);
    Database.ensureTable(CONFIG.SHEETS.SERVICES, this.SERVICE_HEADERS);
  }

  static employees(includeInactive) {
    this.initialize();
    return Database.findAll(CONFIG.SHEETS.EMPLOYEES).filter(function (item) {
      return includeInactive === true || item.Status !== 'Inactive';
    });
  }

  static services(includeInactive) {
    this.initialize();
    return Database.findAll(CONFIG.SHEETS.SERVICES).filter(function (item) {
      return includeInactive === true || item.Status !== 'Inactive';
    });
  }

  static createEmployee(data) {
    this.initialize();
    const value = data || {};
    const now = new Date();
    const saved = Database.insertWithGeneratedId(CONFIG.SHEETS.EMPLOYEES, CONFIG.PREFIX.EMPLOYEE, {
      FullName: Validator.text(value.FullName, 'Tên nhân viên', { required: true, maxLength: 120 }),
      Phone: value.Phone ? Validator.phone(value.Phone, 'Số điện thoại') : '',
      Role: Validator.text(value.Role, 'Vai trò', { maxLength: 80 }),
      Status: Validator.oneOf(value.Status || 'Active', ['Active', 'Inactive'], 'Trạng thái', { required: true }),
      CreatedDate: now,
      UpdatedDate: now
    }, { idColumn: 'EmployeeID', padding: 4 });
    AppLogger.safe('AUDIT', 'Employee', 'CREATE', saved.EmployeeID, 'CREATE employee', { role: saved.Role });
    return saved;
  }

  static createService(data) {
    this.initialize();
    const value = data || {};
    const now = new Date();
    const saved = Database.insertWithGeneratedId(CONFIG.SHEETS.SERVICES, CONFIG.PREFIX.SERVICE, {
      ServiceName: Validator.text(value.ServiceName, 'Tên dịch vụ', { required: true, maxLength: 120 }),
      Duration: Validator.integer(value.Duration, 'Thời lượng', { required: true, min: 1, max: 480 }),
      Price: Validator.number(value.Price, 'Giá dịch vụ', { required: true, min: 0 }),
      Status: Validator.oneOf(value.Status || 'Active', ['Active', 'Inactive'], 'Trạng thái', { required: true }),
      CreatedDate: now,
      UpdatedDate: now
    }, { idColumn: 'ServiceID', padding: 4 });
    AppLogger.safe('AUDIT', 'Service', 'CREATE', saved.ServiceID, 'CREATE service', { price: saved.Price });
    return saved;
  }

  static archiveEmployee(employeeId) {
    return this.setStatus(CONFIG.SHEETS.EMPLOYEES, 'EmployeeID', employeeId, 'Employee');
  }

  /**
   * Admin-only cleanup: removes employee records that are not referenced by
   * any booking or user account. Linked employees are retained automatically.
   */
  static purgeUnlinkedEmployees() {
    this.initialize();
    AuthService.initialize();
    BookingService.initialize();

    const employees = Database.findAll(CONFIG.SHEETS.EMPLOYEES);
    const employeeIdsInBookings = Database.findAll(CONFIG.SHEETS.BOOKINGS)
      .reduce(function (set, booking) {
        set[String(booking.EmployeeID || '').trim()] = true;
        return set;
      }, {});
    const employeeIdsInUsers = Database.findAll(CONFIG.SHEETS.USERS)
      .reduce(function (set, user) {
        set[String(user.EmployeeID || '').trim()] = true;
        return set;
      }, {});

    const removable = employees.filter(function (employee) {
      const employeeId = String(employee.EmployeeID || '').trim();
      return !employeeIdsInBookings[employeeId] && !employeeIdsInUsers[employeeId];
    });
    const retained = employees.filter(function (employee) {
      const employeeId = String(employee.EmployeeID || '').trim();
      return employeeIdsInBookings[employeeId] || employeeIdsInUsers[employeeId];
    });
    const deletedCount = Database.removeRecords(CONFIG.SHEETS.EMPLOYEES, removable);

    AppLogger.safe('AUDIT', 'Employee', 'PURGE_UNLINKED', '', 'PURGE unlinked employees', {
      deletedCount: deletedCount,
      retainedCount: retained.length
    });
    return {
      deletedCount: deletedCount,
      retainedCount: retained.length,
      retainedEmployeeIds: retained.map(function (employee) { return employee.EmployeeID; })
    };
  }

  static archiveService(serviceId) {
    return this.setStatus(CONFIG.SHEETS.SERVICES, 'ServiceID', serviceId, 'Service');
  }

  /** Repairs legacy duplicate catalogue codes without deleting records. */
  static repairDuplicateIds() {
    this.initialize();
    const employees = Database.repairDuplicateIds(CONFIG.SHEETS.EMPLOYEES, CONFIG.PREFIX.EMPLOYEE, {
      idColumn: 'EmployeeID', padding: 4
    });
    const services = Database.repairDuplicateIds(CONFIG.SHEETS.SERVICES, CONFIG.PREFIX.SERVICE, {
      idColumn: 'ServiceID', padding: 4
    });
    const repairedCount = employees.repairedCount + services.repairedCount;

    AppLogger.safe('AUDIT', 'Catalog', 'REPAIR_DUPLICATE_IDS', '', 'REPAIR duplicate catalog IDs', {
      employees: employees.repairedCount,
      services: services.repairedCount
    });

    return { repairedCount: repairedCount, employees: employees, services: services };
  }

  static setStatus(sheetName, idColumn, id, moduleName) {
    this.initialize();
    const saved = Database.update(sheetName, Validator.required(id, 'Mã'), {
      Status: 'Inactive', UpdatedDate: new Date()
    }, idColumn);
    if (!saved) throw new Error('Không tìm thấy dữ liệu cần lưu trữ.');
    AppLogger.safe('AUDIT', moduleName, 'ARCHIVE', id, 'ARCHIVE ' + moduleName, {});
    return saved;
  }
}

function getEmployees(token, includeInactive) { AuthService.requireSession(token); return Utils.toClient(CatalogService.employees(includeInactive)); }
function getServices(token, includeInactive) { AuthService.requireSession(token); return Utils.toClient(CatalogService.services(includeInactive)); }
function createEmployee(token, data) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]); return Utils.toClient(CatalogService.createEmployee(data)); }
function createService(token, data) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]); return Utils.toClient(CatalogService.createService(data)); }
function archiveEmployee(token, employeeId) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]); return Utils.toClient(CatalogService.archiveEmployee(employeeId)); }
function archiveService(token, serviceId) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]); return Utils.toClient(CatalogService.archiveService(serviceId)); }
function repairDuplicateCatalogIds(token) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN]); return Utils.toClient(CatalogService.repairDuplicateIds()); }
function purgeUnlinkedEmployees(token, confirmation) {
  AuthService.requireSession(token, [CONFIG.ROLES.ADMIN]);
  if (String(confirmation || '').trim().toUpperCase() !== 'XOA NHAN SU') {
    throw new Error('Gõ chính xác XOA NHAN SU để xác nhận.');
  }
  return Utils.toClient(CatalogService.purgeUnlinkedEmployees());
}
