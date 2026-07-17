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

  static archiveService(serviceId) {
    return this.setStatus(CONFIG.SHEETS.SERVICES, 'ServiceID', serviceId, 'Service');
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
