/**
 * ============================================================
 * DOVAKO OS
 * Utils.gs
 * Version: 1.0
 * ============================================================
 */

class Utils {

  /**
   * Lấy Spreadsheet hiện tại
   */
  static getSpreadsheet() {
    return SpreadsheetApp.getActiveSpreadsheet();
  }

  /**
   * Lấy Sheet theo tên
   */
  static getSheet(sheetName) {

    const sheet = this.getSpreadsheet().getSheetByName(sheetName);

    if (!sheet) {
      throw new Error("Không tìm thấy Sheet: " + sheetName);
    }

    return sheet;
  }

  /**
   * Thời gian hiện tại
   */
  static now() {
    return new Date();
  }

  /**
   * Format ngày
   */
  static formatDate(date) {

    if (!date) return "";

    return Utilities.formatDate(
      new Date(date),
      CONFIG.TIMEZONE,
      CONFIG.DATE_FORMAT
    );

  }

  /**
   * Format ngày giờ
   */
  static formatDateTime(date) {

    if (!date) return "";

    return Utilities.formatDate(
      new Date(date),
      CONFIG.TIMEZONE,
      CONFIG.DATETIME_FORMAT
    );

  }

  /**
   * Chuẩn hóa số điện thoại
   */
  static normalizePhone(phone) {

    if (!phone) return "";

    return phone.toString().replace(/\D/g, "");

  }

  /**
   * Kiểm tra SĐT Việt Nam
   */
  static validatePhone(phone) {

    phone = this.normalizePhone(phone);

    return /^(0[3|5|7|8|9])[0-9]{8}$/.test(phone);

  }

  /**
   * Kiểm tra rỗng
   */
  static isEmpty(value) {

    return value === null ||
      value === undefined ||
      value === "";

  }

  /**
   * Response thành công
   */
  static success(data = null, message = "Success") {

    return {

      success: true,

      message: message,

      data: data

    };

  }

  /**
   * Response lỗi
   */
  static error(message = "Error") {

    return {

      success: false,

      message: message,

      data: null

    };

  }

  /**
   * Sinh ID
   */
  static generateId(prefix, length = 6) {

    const id = Math.floor(Math.random() * Math.pow(10, length));

    return prefix + id.toString().padStart(length, "0");

  }

  /**
   * Sinh CustomerID
   */
  static generateCustomerId() {
    return this.generateId(CONFIG.PREFIX.CUSTOMER);
  }

  /**
   * Sinh EmployeeID
   */
  static generateEmployeeId() {
    return this.generateId(CONFIG.PREFIX.EMPLOYEE, 4);
  }

  /**
   * Sinh ServiceID
   */
  static generateServiceId() {
    return this.generateId(CONFIG.PREFIX.SERVICE, 4);
  }

  /**
   * Sinh FileID
   */
  static generateFileId() {
    return this.generateId(CONFIG.PREFIX.FILE);
  }

  /**
   * Sinh BookingID
   * Ví dụ:
   * BK202607170001
   */
  static generateBookingId() {

    const date = Utilities.formatDate(
      new Date(),
      CONFIG.TIMEZONE,
      "yyyyMMdd"
    );

    const random = Math.floor(Math.random() * 9999);

    return CONFIG.PREFIX.BOOKING +
      date +
      random.toString().padStart(4, "0");

  }

  /** Converts Apps Script values, especially Date, into HTML-service-safe data. */
  static toClient(value) {
    if (value instanceof Date) {
      return Utilities.formatDate(value, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss");
    }
    if (Array.isArray(value)) {
      return value.map(function (item) { return Utils.toClient(item); });
    }
    if (value && typeof value === 'object') {
      return Object.keys(value).reduce(function (result, key) {
        result[key] = Utils.toClient(value[key]);
        return result;
      }, {});
    }
    return value;
  }

}
