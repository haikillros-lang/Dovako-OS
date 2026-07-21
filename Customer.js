/**
 * DOVAKO OS
 * Customer.js
 * Customer business logic; uses Database, Validator, and AppLogger.
 */
class CustomerService {
  static get TABLE() { return CONFIG.SHEETS.CUSTOMERS; }

  static get HEADERS() {
    return [
      'CustomerID', 'FullName', 'Phone', 'Birthday', 'Gender', 'Occupation',
      'Address', 'Source', 'Note', 'CreatedDate', 'UpdatedDate', 'Status'
    ];
  }

  /** Creates CUSTOMERS only when absent; never overwrites existing data. */
  static initialize() {
    Database.ensureTable(this.TABLE, this.HEADERS);
    return { sheet: this.TABLE, headers: this.HEADERS.slice() };
  }

  static list(options) {
    this.initialize();
    const settings = options || {};
    const query = this.normalizeSearch(settings.query);
    const includeInactive = settings.includeInactive === true;
    const limit = settings.limit === undefined || settings.limit === null
      ? 0 : Validator.integer(settings.limit, 'Giới hạn kết quả', { min: 1 });

    let customers = Database.findAll(this.TABLE).filter(function (customer) {
      return includeInactive || customer.Status !== CONFIG.CUSTOMER_STATUS.INACTIVE;
    });
    if (query) {
      customers = customers.filter(function (customer) {
        return [customer.CustomerID, customer.FullName, customer.Phone].some(function (value) {
          return CustomerService.normalizeSearch(value).indexOf(query) !== -1;
        });
      });
    }
    customers.sort(function (left, right) {
      return new Date(right.CreatedDate || 0).getTime() - new Date(left.CreatedDate || 0).getTime();
    });
    return limit ? customers.slice(0, limit) : customers;
  }

  static get(customerId) {
    this.initialize();
    return Database.findById(this.TABLE, Validator.required(customerId, 'Mã khách hàng'), 'CustomerID');
  }

  static create(input) {
    this.initialize();
    const customer = this.normalizeForCreate(input);
    this.assertPhoneAvailable(customer.Phone);
    const saved = Database.insertWithGeneratedId(this.TABLE, CONFIG.PREFIX.CUSTOMER, customer, {
      idColumn: 'CustomerID', padding: 6
    });
    this.audit('CREATE', saved.CustomerID, { status: saved.Status, source: saved.Source });
    return saved;
  }

  static update(customerId, changes) {
    this.initialize();
    const current = this.get(customerId);
    if (!current) throw new Error('Không tìm thấy khách hàng: ' + customerId);
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new Error('Dữ liệu cập nhật khách hàng không hợp lệ.');
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'CustomerID') && String(changes.CustomerID) !== String(customerId)) {
      throw new Error('Không thể thay đổi CustomerID.');
    }

    const editable = this.pickEditableFields(changes);
    const customer = this.normalizeForUpdate(Object.assign({}, current, editable), current);
    if (customer.Phone !== current.Phone) this.assertPhoneAvailable(customer.Phone, customerId);
    const saved = Database.update(this.TABLE, customerId, customer, 'CustomerID');
    this.audit('UPDATE', customerId, { changedFields: Object.keys(editable) });
    return saved;
  }

  /** Preserves bookings and files by archiving instead of deleting a customer. */
  static archive(customerId) {
    return this.setStatus(customerId, CONFIG.CUSTOMER_STATUS.INACTIVE, 'ARCHIVE');
  }

  static restore(customerId) {
    return this.setStatus(customerId, CONFIG.CUSTOMER_STATUS.ACTIVE, 'RESTORE');
  }

  static setStatus(customerId, status, action) {
    this.initialize();
    if (!this.get(customerId)) throw new Error('Không tìm thấy khách hàng: ' + customerId);
    const normalizedStatus = Validator.oneOf(status, this.customerStatusValues(), 'Trạng thái khách hàng', { required: true });
    const saved = Database.update(this.TABLE, customerId, {
      Status: normalizedStatus, UpdatedDate: new Date()
    }, 'CustomerID');
    this.audit(action || 'SET_STATUS', customerId, { status: normalizedStatus });
    return saved;
  }

  static search(query, options) {
    return this.list(Object.assign({}, options || {}, { query: query }));
  }

  /**
   * Derived customer information for operations and CRM. The lifecycle Status
   * is deliberately not overwritten: a Blacklist/Inactive customer remains
   * protected even when their accumulated spending qualifies for VIP.
   */
  static insights(options) {
    return this.insightsFromCustomers(this.list(options));
  }

  /** Returns customer data prepared for the logged-in user's role. */
  static listForSession(session, options) {
    const customers = this.isTechnician(session)
      ? this.listForTechnician(options)
      : this.list(options);
    return this.applySessionPrivacy(customers, session);
  }

  static insightsForSession(session, options) {
    const customers = this.isTechnician(session)
      ? this.listForTechnician(options)
      : this.list(options);
    return this.applySessionPrivacy(this.insightsFromCustomers(customers), session);
  }

  static getForSession(session, customerId) {
    return this.applySessionPrivacy(this.get(customerId), session);
  }

  static searchForSession(session, query, options) {
    const settings = Object.assign({}, options || {}, { query: query });
    return this.listForSession(session, settings);
  }

  /** A technician can search by name or customer code, never by phone. */
  static listForTechnician(options) {
    const settings = options || {};
    const query = this.normalizeSearch(settings.query);
    const listOptions = Object.assign({}, settings, { query: '' });
    delete listOptions.limit;
    let customers = this.list(listOptions);
    if (query) {
      customers = customers.filter(function (customer) {
        return [customer.CustomerID, customer.FullName].some(function (value) {
          return CustomerService.normalizeSearch(value).indexOf(query) !== -1;
        });
      });
    }
    const limit = settings.limit === undefined || settings.limit === null
      ? 0 : Validator.integer(settings.limit, 'Giới hạn kết quả', { min: 1 });
    return limit ? customers.slice(0, limit) : customers;
  }

  static isTechnician(session) {
    return Boolean(session && session.Role === CONFIG.ROLES.TECHNICIAN);
  }

  static applySessionPrivacy(data, session) {
    if (!this.isTechnician(session)) return data;
    const redact = function (customer) {
      if (!customer) return customer;
      const safe = Object.assign({}, customer);
      // Do not send phone numbers to the browser of a technician at all.
      safe.Phone = '';
      return safe;
    };
    return Array.isArray(data) ? data.map(redact) : redact(data);
  }

  static insightsFromCustomers(customers) {
    const spending = this.spendingByCustomer();
    const vipThreshold = this.vipSpendThreshold();
    return customers.map(function (customer) {
      const stats = spending[customer.CustomerID] || { prepaidSpend: 0, bookingSpend: 0, cardCount: 0 };
      const totalSpend = Number(stats.prepaidSpend || 0) + Number(stats.bookingSpend || 0);
      return Object.assign({}, customer, {
        CustomerType: stats.cardCount > 0 ? 'Khách thẻ' : 'Khách lẻ',
        PrepaidCardCount: Number(stats.cardCount || 0),
        PrepaidSpend: Number(stats.prepaidSpend || 0),
        BookingSpend: Number(stats.bookingSpend || 0),
        TotalSpend: totalSpend,
        CustomerTier: totalSpend >= vipThreshold ? 'VIP' : 'Thường',
        VipThreshold: vipThreshold
      });
    });
  }

  /** Calculates actual money paid: card purchase plus completed cash bookings. */
  static spendingByCustomer() {
    const totals = {};
    const ensure = function (customerId) {
      if (!totals[customerId]) totals[customerId] = { prepaidSpend: 0, bookingSpend: 0, cardCount: 0 };
      return totals[customerId];
    };

    if (typeof PrepaidService !== 'undefined') {
      PrepaidService.list({ includeInactive: true }).forEach(function (card) {
        const stats = ensure(card.CustomerID);
        stats.prepaidSpend += Math.max(0, Number(card.PaidAmount || 0));
        stats.cardCount += 1;
      });
    }
    if (typeof BookingService !== 'undefined') {
      BookingService.list({ includeCancelled: true }).forEach(function (booking) {
        if (booking.Status !== CONFIG.BOOKING_STATUS.COMPLETED) return;
        const stats = ensure(booking.CustomerID);
        // Prepaid bookings are set to zero after card consumption, preventing
        // a card purchase from being counted twice.
        stats.bookingSpend += Math.max(0, Number(booking.FinalPrice || 0));
      });
    }
    return totals;
  }

  static vipSpendThreshold() {
    return Number((CONFIG.CUSTOMER_VIP && CONFIG.CUSTOMER_VIP.SPEND_THRESHOLD) || 10000000);
  }

  static normalizeForCreate(input) {
    const data = input || {};
    const now = new Date();
    return Object.assign(this.normalizeEditable(data), {
      CreatedDate: now,
      UpdatedDate: now,
      Status: this.validateCustomerStatus(data.Status || CONFIG.CUSTOMER_STATUS.ACTIVE)
    });
  }

  static normalizeForUpdate(data, current) {
    return Object.assign(this.normalizeEditable(data), {
      CreatedDate: current.CreatedDate,
      UpdatedDate: new Date(),
      Status: this.validateCustomerStatus(data.Status)
    });
  }

  static normalizeEditable(data) {
    return {
      FullName: Validator.text(data.FullName, 'Họ và tên', { required: true, maxLength: 120 }),
      Phone: Validator.phone(data.Phone, 'Số điện thoại'),
      Birthday: Validator.date(data.Birthday, 'Ngày sinh'),
      Gender: this.validateGender(data.Gender),
      Occupation: Validator.text(data.Occupation, 'Nghề nghiệp', { maxLength: 120 }),
      Address: Validator.text(data.Address, 'Địa chỉ', { maxLength: 300 }),
      Source: Validator.text(data.Source, 'Nguồn khách', { maxLength: 100 }),
      Note: Validator.text(data.Note, 'Ghi chú', { maxLength: 2000 })
    };
  }

  static pickEditableFields(input) {
    const allowed = ['FullName', 'Phone', 'Birthday', 'Gender', 'Occupation', 'Address', 'Source', 'Note', 'Status'];
    return allowed.reduce(function (result, key) {
      if (Object.prototype.hasOwnProperty.call(input, key)) result[key] = input[key];
      return result;
    }, {});
  }

  static assertPhoneAvailable(phone, exceptCustomerId) {
    const match = Database.first(this.TABLE, 'Phone', phone);
    if (match && match.CustomerID !== exceptCustomerId) {
      throw new Error('Số điện thoại này đã tồn tại trong hồ sơ khách hàng.');
    }
  }

  static validateGender(value) {
    if (value === null || value === undefined || value === '') return '';
    const genders = CONFIG.GENDER ? Object.keys(CONFIG.GENDER).map(function (key) { return CONFIG.GENDER[key]; }) : [];
    return genders.length ? Validator.oneOf(value, genders, 'Giới tính') : Validator.text(value, 'Giới tính', { maxLength: 20 });
  }

  static validateCustomerStatus(value) {
    return Validator.oneOf(value, this.customerStatusValues(), 'Trạng thái khách hàng', { required: true });
  }

  static customerStatusValues() {
    return Object.keys(CONFIG.CUSTOMER_STATUS).map(function (key) { return CONFIG.CUSTOMER_STATUS[key]; });
  }

  static normalizeSearch(value) {
    return String(value || '').toLocaleLowerCase('vi-VN').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').trim();
  }

  static audit(action, customerId, metadata) {
    if (typeof AppLogger !== 'undefined') {
      AppLogger.safe('AUDIT', 'Customer', action, customerId, action + ' customer', metadata);
    }
  }
}

/* Apps Script entry points for google.script.run and manual administration. */
function initializeCustomerModule() { return CustomerService.initialize(); }
function getCustomers(token, options) { const session = AuthService.requireSession(token); return Utils.toClient(CustomerService.listForSession(session, options)); }
function getCustomerInsights(token, options) { const session = AuthService.requireSession(token); return Utils.toClient(CustomerService.insightsForSession(session, options)); }
function getCustomer(token, customerId) { const session = AuthService.requireSession(token); return Utils.toClient(CustomerService.getForSession(session, customerId)); }
function searchCustomers(token, query, options) { const session = AuthService.requireSession(token); return Utils.toClient(CustomerService.searchForSession(session, query, options)); }
function createCustomer(token, data) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(CustomerService.create(data)); }
function updateCustomer(token, customerId, changes) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(CustomerService.update(customerId, changes)); }
function archiveCustomer(token, customerId) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(CustomerService.archive(customerId)); }
function restoreCustomer(token, customerId) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]); return Utils.toClient(CustomerService.restore(customerId)); }
