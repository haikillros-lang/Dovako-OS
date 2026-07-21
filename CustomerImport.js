/**
 * One-time legacy customer importer for DOVAKO OS.
 *
 * Data is generated locally from the approved Excel file into
 * LegacyCustomerImportData.js.  This importer is intentionally idempotent:
 * it recognizes each old record by its LegacyCustomerID marker in Note and
 * never inserts it twice.
 */
class CustomerImportService {
  static get TABLE() { return CONFIG.SHEETS.CUSTOMERS; }
  static get MARKER_PREFIX() { return '[LegacyCustomerID:'; }

  static preview() {
    return this.prepare().summary;
  }

  static importAll() {
    throw new Error('Chức năng nhập dữ liệu khách cũ đã được tắt.');
  }

  static prepare() {
    CustomerService.initialize();
    const data = this.getData();
    const existing = Database.findAll(this.TABLE);
    const legacyIds = {};
    const phones = {};

    existing.forEach(function (customer) {
      const legacyId = CustomerImportService.readLegacyId(customer.Note);
      if (legacyId) legacyIds[legacyId] = true;
      const phone = CustomerImportService.phoneKey(customer.Phone);
      if (phone) phones[phone] = true;
    });

    const toInsert = [];
    let skippedExistingLegacyId = 0;
    let skippedPhoneMatch = 0;
    let skippedInvalidRecord = 0;

    data.forEach(function (item) {
      const record = CustomerImportService.toCustomerRecord(item);
      if (!record) {
        skippedInvalidRecord += 1;
        return;
      }
      if (legacyIds[item.LegacyCustomerID]) {
        skippedExistingLegacyId += 1;
        return;
      }
      const phone = CustomerImportService.phoneKey(record.Phone);
      if (phone && phones[phone]) {
        skippedPhoneMatch += 1;
        return;
      }
      toInsert.push(record);
      legacyIds[item.LegacyCustomerID] = true;
      if (phone) phones[phone] = true;
    });

    return {
      toInsert: toInsert,
      summary: {
        sourceRecords: data.length,
        readyToImport: toInsert.length,
        inserted: 0,
        skippedExistingLegacyId: skippedExistingLegacyId,
        skippedPhoneMatch: skippedPhoneMatch,
        skippedInvalidRecord: skippedInvalidRecord
      }
    };
  }

  static getData() {
    if (typeof LEGACY_CUSTOMER_IMPORT_DATA === 'undefined' || !Array.isArray(LEGACY_CUSTOMER_IMPORT_DATA)) {
      throw new Error('Chưa có dữ liệu khách hàng cần nhập.');
    }
    return LEGACY_CUSTOMER_IMPORT_DATA.slice().sort(function (left, right) {
      return Number(left.SourceRow || 0) - Number(right.SourceRow || 0);
    });
  }

  static toCustomerRecord(item) {
    if (!item || !this.clean(item.LegacyCustomerID) || !this.clean(item.FullName)) return null;
    const createdDate = this.toDate(item.CreatedDate) || new Date();
    return {
      FullName: this.limit(this.clean(item.FullName), 120),
      Phone: this.limit(this.clean(item.Phone), 30),
      Birthday: this.toDate(item.Birthday),
      Gender: this.normalizeGender(item.Gender),
      Occupation: this.limit(this.clean(item.Occupation), 120),
      Address: this.limit(this.clean(item.Address), 300),
      Source: this.limit(this.clean(item.Source), 100),
      Note: this.buildNote(item),
      CreatedDate: createdDate,
      UpdatedDate: new Date(),
      Status: CONFIG.CUSTOMER_STATUS.ACTIVE
    };
  }

  static buildNote(item) {
    const lines = [this.MARKER_PREFIX + this.clean(item.LegacyCustomerID) + ']'];
    const labels = [
      ['Nhóm khách cũ', item.LegacyGroup],
      ['Dịch vụ đã sử dụng', item.ServiceHistory],
      ['Ngày dùng dịch vụ gần nhất', item.LastServiceDate],
      ['Tổng tiền lịch sử', item.HistoricalSpend],
      ['Ghi chú cũ', item.LegacyNote],
      ['Facebook', item.Facebook],
      ['Mã giới thiệu', item.ReferralCode],
      ['Nhân viên liên hệ', item.ContactEmployee],
      ['Nhân viên phụ trách', item.ResponsibleEmployee],
      ['Dịch vụ quan tâm', item.InterestedService],
      ['Người tạo cũ', item.CreatedBy],
      ['Chi nhánh', item.Branch],
      ['Thông tin tình trạng', item.HealthNote]
    ];
    labels.forEach(function (entry) {
      const value = CustomerImportService.clean(entry[1]);
      if (value) lines.push(entry[0] + ': ' + value);
    });
    return this.limit(lines.join('\n'), 1900);
  }

  static readLegacyId(note) {
    const match = String(note || '').match(/\[LegacyCustomerID:([^\]]+)\]/);
    return match ? match[1].trim() : '';
  }

  static phoneKey(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits || '';
  }

  static normalizeGender(value) {
    const normalized = this.clean(value).toLocaleLowerCase('vi-VN');
    if (normalized === 'nam') return CONFIG.GENDER.MALE;
    if (normalized === 'nữ' || normalized === 'nu') return CONFIG.GENDER.FEMALE;
    if (normalized === 'khác' || normalized === 'khac') return CONFIG.GENDER.OTHER;
    return '';
  }

  static toDate(value) {
    if (!value) return null;
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
  }

  static clean(value) {
    return String(value === null || value === undefined ? '' : value).trim().replace(/\s+/g, ' ');
  }

  static limit(value, maxLength) {
    const text = this.clean(value);
    return text.length > maxLength ? text.slice(0, maxLength - 1).trim() + '…' : text;
  }
}

/** Preview first, then run importLegacyCustomers once in Apps Script. */
function previewLegacyCustomerImport() { throw new Error('Chức năng nhập dữ liệu khách cũ đã được tắt.'); }
function importLegacyCustomers() { throw new Error('Chức năng nhập dữ liệu khách cũ đã được tắt.'); }

function getLegacyCustomerImportPreview(token) {
  AuthService.requireSession(token, [CONFIG.ROLES.ADMIN]);
  return { disabled: true, message: 'Chức năng nhập dữ liệu khách cũ đã được tắt.' };
}

function importLegacyCustomersForAdmin(token, confirmationPhrase) {
  AuthService.requireSession(token, [CONFIG.ROLES.ADMIN]);
  throw new Error('Chức năng nhập dữ liệu khách cũ đã được tắt.');
}
