/**
 * DOVAKO OS
 * Auth.js
 * Internal username/password login, role checks, and short-lived sessions.
 */
class AuthService {
  static get TABLE() { return CONFIG.SHEETS.USERS; }

  static get HEADERS() {
    return ['UserID', 'Username', 'PasswordHash', 'FullName', 'Role', 'EmployeeID', 'Status', 'CreatedDate', 'UpdatedDate', 'LastLogin'];
  }

  static initialize() {
    Database.ensureTable(this.TABLE, this.HEADERS);
  }

  static bootstrapStatus() {
    this.initialize();
    return { setupRequired: Database.findAll(this.TABLE).length === 0 };
  }

  static bootstrap(data) {
    this.initialize();
    if (Database.findAll(this.TABLE).length) throw new Error('Hệ thống đã có tài khoản. Hãy đăng nhập.');
    return this.createAccount(data, CONFIG.ROLES.ADMIN);
  }

  static login(username, password) {
    this.initialize();
    const normalized = this.username(username);
    const account = Database.findAll(this.TABLE).find(function (item) { return item.Username === normalized; });
    if (!account || account.Status !== 'Active' || account.PasswordHash !== this.passwordHash(password)) {
      throw new Error('Tên đăng nhập hoặc mật khẩu không đúng.');
    }
    Database.update(this.TABLE, account.UserID, { LastLogin: new Date(), UpdatedDate: new Date() }, 'UserID');
    const current = Database.findById(this.TABLE, account.UserID, 'UserID');
    const session = this.createSession(current);
    AppLogger.safe('AUDIT', 'Auth', 'LOGIN', current.UserID, 'User login', { role: current.Role });
    return session;
  }

  static logout(token) {
    if (token) CacheService.getScriptCache().remove(this.cacheKey(token));
    return true;
  }

  static getSession(token) {
    const value = token ? CacheService.getScriptCache().get(this.cacheKey(token)) : null;
    if (!value) return null;
    try { return JSON.parse(value); } catch (error) { return null; }
  }

  static requireSession(token, allowedRoles) {
    const session = this.getSession(token);
    if (!session) throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
    if (allowedRoles && allowedRoles.length && allowedRoles.indexOf(session.Role) === -1) {
      throw new Error('Bạn không có quyền thực hiện thao tác này.');
    }
    return session;
  }

  static createUser(token, data) {
    this.requireSession(token, [CONFIG.ROLES.ADMIN]);
    return this.createAccount(data);
  }

  static updateUser(token, userId, data) {
    const session = this.requireSession(token, [CONFIG.ROLES.ADMIN]);
    this.initialize();
    const id = Validator.required(userId, 'Mã tài khoản');
    const current = Database.findById(this.TABLE, id, 'UserID');
    if (!current) throw new Error('Không tìm thấy tài khoản.');

    const value = data || {};
    const username = this.username(value.Username);
    const role = Validator.oneOf(value.Role, Object.keys(CONFIG.ROLES).map(function (key) {
      return CONFIG.ROLES[key];
    }), 'Vai trò', { required: true });

    if (Database.findAll(this.TABLE).some(function (item) {
      return item.UserID !== id && String(item.Username || '').toLowerCase() === username;
    })) {
      throw new Error('Tên đăng nhập đã tồn tại.');
    }
    if (String(session.UserID) === String(id) && role !== current.Role) {
      throw new Error('Không thể tự thay đổi quyền của tài khoản đang đăng nhập.');
    }
    if (current.Role === CONFIG.ROLES.ADMIN && current.Status === 'Active' && role !== CONFIG.ROLES.ADMIN &&
        this.activeAdminCount() <= 1) {
      throw new Error('Hệ thống phải luôn có ít nhất một Admin đang hoạt động.');
    }

    const changes = {
      FullName: Validator.text(value.FullName, 'Họ và tên', { required: true, maxLength: 120 }),
      Username: username,
      Role: role,
      EmployeeID: Validator.text(value.EmployeeID, 'Nhân viên', { maxLength: 50 }),
      UpdatedDate: new Date()
    };
    if (String(value.Password || '')) {
      this.validatePassword(value.Password);
      changes.PasswordHash = this.passwordHash(value.Password);
    }

    const saved = Database.update(this.TABLE, id, changes, 'UserID');
    if (String(session.UserID) === String(id)) {
      const refreshed = Object.assign({}, session, this.clientUser(saved));
      CacheService.getScriptCache().put(this.cacheKey(token), JSON.stringify(refreshed), CONFIG.AUTH.SESSION_TTL_SECONDS);
    }
    AppLogger.safe('AUDIT', 'Auth', 'UPDATE_USER', id, 'User updated', { role: saved.Role });
    return this.clientUser(saved);
  }

  static listUsers(token, includeInactive) {
    this.requireSession(token, [CONFIG.ROLES.ADMIN]);
    this.initialize();
    return Database.findAll(this.TABLE)
      .filter(function (item) { return includeInactive === true || item.Status !== 'Inactive'; })
      .map(this.clientUser);
  }

  static deactivateUser(token, userId) {
    const session = this.requireSession(token, [CONFIG.ROLES.ADMIN]);
    if (String(session.UserID) === String(userId)) throw new Error('Không thể tự khóa tài khoản đang đăng nhập.');
    const user = Database.update(this.TABLE, Validator.required(userId, 'Mã tài khoản'), { Status: 'Inactive', UpdatedDate: new Date() }, 'UserID');
    if (!user) throw new Error('Không tìm thấy tài khoản.');
    AppLogger.safe('AUDIT', 'Auth', 'DEACTIVATE', userId, 'User deactivated', {});
    return this.clientUser(user);
  }

  /**
   * Repairs legacy duplicate UserID/Username records without deleting audit
   * data. The earliest valid account is kept active; later duplicates receive
   * a unique ID and are locked so an Admin can safely create a clean account.
   */
  static repairDuplicateAccounts(token) {
    this.requireSession(token, [CONFIG.ROLES.ADMIN]);
    this.initialize();

    const idResult = Database.repairDuplicateIds(this.TABLE, 'US', {
      idColumn: 'UserID', padding: 4
    });
    const users = Database.findAll(this.TABLE).sort(function (left, right) {
      return left._rowNumber - right._rowNumber;
    });
    const usernames = {};
    const usernameRepairs = [];
    const now = new Date();

    users.forEach(function (user) {
      const username = String(user.Username || '').trim().toLowerCase();
      if (username && !usernames[username]) {
        usernames[username] = true;
        return;
      }

      const replacement = AuthService.inactiveUsername(username || 'user', user._rowNumber, usernames);
      const saved = Database.update(AuthService.TABLE, user.UserID, {
        Username: replacement,
        Status: 'Inactive',
        UpdatedDate: now
      }, 'UserID');
      usernames[replacement] = true;
      usernameRepairs.push({
        rowNumber: user._rowNumber,
        oldUsername: username,
        newUsername: saved.Username,
        userId: saved.UserID
      });
    });

    const repairedCount = idResult.repairedCount + usernameRepairs.length;
    AppLogger.safe('AUDIT', 'Auth', 'REPAIR_DUPLICATE_ACCOUNTS', '', 'REPAIR duplicate user accounts', {
      repairedIds: idResult.repairedCount,
      lockedDuplicates: usernameRepairs.length
    });

    return {
      repairedCount: repairedCount,
      repairedIds: idResult.repairedCount,
      lockedDuplicates: usernameRepairs.length,
      idRepairs: idResult.repairs,
      usernameRepairs: usernameRepairs
    };
  }

  static changePassword(token, currentPassword, newPassword) {
    const session = this.requireSession(token);
    const account = Database.findById(this.TABLE, session.UserID, 'UserID');
    if (!account || account.PasswordHash !== this.passwordHash(currentPassword)) throw new Error('Mật khẩu hiện tại không đúng.');
    this.validatePassword(newPassword);
    Database.update(this.TABLE, session.UserID, { PasswordHash: this.passwordHash(newPassword), UpdatedDate: new Date() }, 'UserID');
    AppLogger.safe('AUDIT', 'Auth', 'CHANGE_PASSWORD', session.UserID, 'Password changed', {});
    return true;
  }

  static createAccount(data, forcedRole) {
    const value = data || {};
    const username = this.username(value.Username);
    this.validatePassword(value.Password);
    const role = forcedRole || Validator.oneOf(value.Role, Object.keys(CONFIG.ROLES).map(function (key) { return CONFIG.ROLES[key]; }), 'Vai trò', { required: true });
    this.initialize();
    if (Database.findAll(this.TABLE).some(function (item) { return item.Username === username; })) throw new Error('Tên đăng nhập đã tồn tại.');
    const now = new Date();
    const saved = Database.insertWithGeneratedId(this.TABLE, 'US', {
      Username: username,
      PasswordHash: this.passwordHash(value.Password),
      FullName: Validator.text(value.FullName, 'Họ tên', { required: true, maxLength: 120 }),
      Role: role,
      EmployeeID: String(value.EmployeeID || ''),
      Status: 'Active',
      CreatedDate: now,
      UpdatedDate: now,
      LastLogin: ''
    }, { idColumn: 'UserID', padding: 4 });
    AppLogger.safe('AUDIT', 'Auth', 'CREATE_USER', saved.UserID, 'User created', { role: saved.Role });
    return this.clientUser(saved);
  }

  static createSession(account) {
    const token = Utilities.getUuid();
    const session = Object.assign({ token: token, expiresIn: CONFIG.AUTH.SESSION_TTL_SECONDS }, this.clientUser(account));
    CacheService.getScriptCache().put(this.cacheKey(token), JSON.stringify(session), CONFIG.AUTH.SESSION_TTL_SECONDS);
    return session;
  }

  static clientUser(account) {
    return {
      UserID: account.UserID,
      Username: account.Username,
      FullName: account.FullName,
      Role: account.Role,
      EmployeeID: account.EmployeeID || '',
      Status: account.Status
    };
  }

  static username(value) {
    const username = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,50}$/.test(username)) throw new Error('Tên đăng nhập gồm 3–50 ký tự: chữ thường, số, dấu chấm, gạch dưới hoặc gạch ngang.');
    return username;
  }

  static inactiveUsername(value, rowNumber, used) {
    const normalized = String(value || 'user').toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .replace(/^-+|-+$/g, '') || 'user';
    const suffix = '.inactive.' + rowNumber;
    const base = normalized.slice(0, Math.max(3, 50 - suffix.length));
    let candidate = base + suffix;
    let sequence = 1;
    while (used[candidate]) {
      candidate = base.slice(0, Math.max(3, 46 - String(sequence).length)) + '.x' + sequence;
      sequence += 1;
    }
    return candidate;
  }

  static activeAdminCount() {
    return Database.findAll(this.TABLE).filter(function (item) {
      return item.Status === 'Active' && item.Role === CONFIG.ROLES.ADMIN;
    }).length;
  }

  static validatePassword(value) {
    const password = String(value || '');
    if (password.length < 8) throw new Error('Mật khẩu cần có ít nhất 8 ký tự.');
  }

  static passwordHash(value) {
    this.validatePassword(value);
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, this.passwordSalt() + ':' + String(value), Utilities.Charset.UTF_8);
    return bytes.map(function (byte) { return ((byte + 256) % 256).toString(16).padStart(2, '0'); }).join('');
  }

  static passwordSalt() {
    const properties = PropertiesService.getScriptProperties();
    let salt = properties.getProperty('DOVAKO_AUTH_SALT');
    if (!salt) {
      salt = Utilities.getUuid() + Utilities.getUuid();
      properties.setProperty('DOVAKO_AUTH_SALT', salt);
    }
    return salt;
  }

  static cacheKey(token) { return 'DOVAKO_SESSION:' + token; }
}

function getAuthBootstrapStatus() { return Utils.toClient(AuthService.bootstrapStatus()); }
function bootstrapAdmin(data) { return Utils.toClient(AuthService.bootstrap(data)); }
function loginUser(username, password) { return Utils.toClient(AuthService.login(username, password)); }
function getCurrentUser(token) { return Utils.toClient(AuthService.getSession(token)); }
function logoutUser(token) { return AuthService.logout(token); }
function getUsers(token, includeInactive) { return Utils.toClient(AuthService.listUsers(token, includeInactive)); }
function createUser(token, data) { return Utils.toClient(AuthService.createUser(token, data)); }
function updateUser(token, userId, data) { return Utils.toClient(AuthService.updateUser(token, userId, data)); }
function deactivateUser(token, userId) { return Utils.toClient(AuthService.deactivateUser(token, userId)); }
function repairDuplicateAccounts(token) { return Utils.toClient(AuthService.repairDuplicateAccounts(token)); }
function changeMyPassword(token, currentPassword, newPassword) { return AuthService.changePassword(token, currentPassword, newPassword); }
