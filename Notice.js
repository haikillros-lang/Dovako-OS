/**
 * DOVAKO OS
 * Notice.js
 * Internal announcements, regulations, procedures, and promotions.
 */
class NoticeService {
  static get TABLE() { return CONFIG.SHEETS.NOTICES; }

  static get HEADERS() {
    return [
      'NoticeID', 'Category', 'Title', 'Content', 'EffectiveDate', 'ExpiryDate',
      'Status', 'CreatedBy', 'CreatedDate', 'UpdatedBy', 'UpdatedDate'
    ];
  }

  static get CATEGORIES() {
    return ['Thông báo', 'Quy định', 'Quy trình', 'Khuyến mãi'];
  }

  static get STATUSES() {
    return ['Nháp', 'Đã đăng', 'Lưu trữ'];
  }

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
    const category = String(settings.Category || '').trim();
    const status = String(settings.Status || '').trim();
    const query = this.normalizeSearch(settings.query);
    const today = this.dateKey(new Date());

    let records = Database.findAll(this.TABLE).filter(function (item) {
      if (category && item.Category !== category) return false;
      if (canManage && status && item.Status !== status) return false;
      if (!canManage) {
        if (item.Status !== 'Đã đăng') return false;
        const effectiveDate = NoticeService.dateKey(item.EffectiveDate || item.CreatedDate);
        const expiryDate = NoticeService.dateKey(item.ExpiryDate);
        if (effectiveDate && effectiveDate > today) return false;
        if (expiryDate && expiryDate < today) return false;
      }
      if (!query) return true;
      return [item.Category, item.Title, item.Content].some(function (value) {
        return NoticeService.normalizeSearch(value).indexOf(query) !== -1;
      });
    });

    records.sort(function (left, right) {
      const statusWeight = function (item) {
        if (item.Status === 'Đã đăng') return 0;
        if (item.Status === 'Nháp') return 1;
        return 2;
      };
      const weight = statusWeight(left) - statusWeight(right);
      if (weight !== 0) return weight;
      const leftDate = new Date(left.UpdatedDate || left.CreatedDate || 0).getTime();
      const rightDate = new Date(right.UpdatedDate || right.CreatedDate || 0).getTime();
      return rightDate - leftDate;
    });
    return records;
  }

  static getForSession(session, noticeId) {
    this.initialize();
    const record = Database.findById(this.TABLE, Validator.required(noticeId, 'Mã nội dung'), 'NoticeID');
    if (!record || this.canManage(session)) return record;
    return this.list(session, {}).find(function (item) {
      return item.NoticeID === record.NoticeID;
    }) || null;
  }

  static create(session, input) {
    this.assertManager(session);
    this.initialize();
    const now = new Date();
    const record = this.normalize(input, null, this.actor(session), now);
    const saved = Database.insertWithGeneratedId(this.TABLE, CONFIG.PREFIX.NOTICE, record, {
      idColumn: 'NoticeID', padding: 6
    });
    this.audit('CREATE', saved.NoticeID, session, { category: saved.Category, status: saved.Status });
    return saved;
  }

  static update(session, noticeId, input) {
    this.assertManager(session);
    this.initialize();
    const current = Database.findById(this.TABLE, Validator.required(noticeId, 'Mã nội dung'), 'NoticeID');
    if (!current) throw new Error('Không tìm thấy nội dung cần cập nhật.');
    const saved = Database.update(this.TABLE, current.NoticeID, this.normalize(input, current, this.actor(session), new Date()), 'NoticeID');
    this.audit('UPDATE', saved.NoticeID, session, { category: saved.Category, status: saved.Status });
    return saved;
  }

  static archive(session, noticeId) {
    this.assertManager(session);
    this.initialize();
    const current = Database.findById(this.TABLE, Validator.required(noticeId, 'Mã nội dung'), 'NoticeID');
    if (!current) throw new Error('Không tìm thấy nội dung cần lưu trữ.');
    const saved = Database.update(this.TABLE, current.NoticeID, {
      Status: 'Lưu trữ', UpdatedBy: this.actor(session), UpdatedDate: new Date()
    }, 'NoticeID');
    this.audit('ARCHIVE', saved.NoticeID, session, { category: saved.Category });
    return saved;
  }

  static normalize(input, current, actor, now) {
    const value = input || {};
    const effectiveDate = Validator.date(
      value.EffectiveDate || (current && current.EffectiveDate) || now,
      'Ngày hiệu lực', { required: true }
    );
    const expiryDate = Validator.date(
      value.ExpiryDate === undefined ? (current && current.ExpiryDate) : value.ExpiryDate,
      'Ngày hết hiệu lực'
    );
    if (expiryDate && this.dateKey(expiryDate) < this.dateKey(effectiveDate)) {
      throw new Error('Ngày hết hiệu lực phải bằng hoặc sau ngày hiệu lực.');
    }
    const content = String(value.Content === undefined ? (current && current.Content) || '' : value.Content)
      .replace(/\r\n/g, '\n').trim();
    if (!content) throw new Error('Nội dung là bắt buộc.');
    if (content.length > 10000) throw new Error('Nội dung không được vượt quá 10.000 ký tự.');

    return {
      Category: Validator.oneOf(value.Category || (current && current.Category), this.CATEGORIES, 'Loại nội dung', { required: true }),
      Title: Validator.text(value.Title === undefined ? (current && current.Title) : value.Title, 'Tiêu đề', { required: true, maxLength: 160 }),
      Content: content,
      EffectiveDate: effectiveDate,
      ExpiryDate: expiryDate || '',
      Status: Validator.oneOf(value.Status || (current && current.Status) || 'Đã đăng', this.STATUSES, 'Trạng thái', { required: true }),
      CreatedBy: current ? current.CreatedBy : actor,
      CreatedDate: current ? current.CreatedDate : now,
      UpdatedBy: actor,
      UpdatedDate: now
    };
  }

  static assertManager(session) {
    if (!this.canManage(session)) throw new Error('Chỉ Admin hoặc Quản lý có quyền cập nhật bảng nội bộ.');
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

  static audit(action, noticeId, session, metadata) {
    AppLogger.safe('AUDIT', 'Notice', action, noticeId, 'Internal notice ' + action, Object.assign({
      actor: this.actor(session), role: session.Role
    }, metadata || {}));
  }
}

function initializeNoticeModule() { return Utils.toClient(NoticeService.initialize()); }
function getNotices(token, options) { return Utils.toClient(NoticeService.list(AuthService.requireSession(token), options)); }
function getNotice(token, noticeId) { return Utils.toClient(NoticeService.getForSession(AuthService.requireSession(token), noticeId)); }
function createNotice(token, data) { return Utils.toClient(NoticeService.create(AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]), data)); }
function updateNotice(token, noticeId, data) { return Utils.toClient(NoticeService.update(AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]), noticeId, data)); }
function archiveNotice(token, noticeId) { return Utils.toClient(NoticeService.archive(AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]), noticeId)); }
