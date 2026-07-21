/**
 * DOVAKO OS
 * Validator.js
 *
 * Shared input validation. Service modules should call these methods before
 * writing to Database so invalid data never reaches Google Sheets.
 */
class Validator {
  static required(value, label) {
    if (value === null || value === undefined || String(value).trim() === '') {
      throw new Error((label || 'Trường này') + ' là bắt buộc.');
    }
    return this.cleanText(value);
  }

  static text(value, label, options) {
    const settings = options || {};
    if (settings.required) this.required(value, label);
    if (value === null || value === undefined || value === '') return '';

    const result = this.cleanText(value);
    if (settings.maxLength && result.length > settings.maxLength) {
      throw new Error((label || 'Trường này') + ' không được vượt quá ' + settings.maxLength + ' ký tự.');
    }
    return result;
  }

  static phone(value, label) {
    const name = label || 'Số điện thoại';
    const phone = this.required(value, name).replace(/\D/g, '');
    if (!/^(0(3|5|7|8|9))\d{8}$/.test(phone)) {
      throw new Error(name + ' không đúng định dạng Việt Nam.');
    }
    return phone;
  }

  static number(value, label, options) {
    const settings = options || {};
    const name = label || 'Giá trị';
    if (value === '' || value === null || value === undefined) {
      if (settings.required) throw new Error(name + ' là bắt buộc.');
      return settings.defaultValue === undefined ? null : settings.defaultValue;
    }

    const numeric = typeof value === 'number'
      ? value
      : Number(String(value).replace(/,/g, '').trim());
    if (!Number.isFinite(numeric)) throw new Error(name + ' phải là số hợp lệ.');
    if (settings.min !== undefined && numeric < settings.min) {
      throw new Error(name + ' phải lớn hơn hoặc bằng ' + settings.min + '.');
    }
    if (settings.max !== undefined && numeric > settings.max) {
      throw new Error(name + ' phải nhỏ hơn hoặc bằng ' + settings.max + '.');
    }
    return numeric;
  }

  static integer(value, label, options) {
    const numeric = this.number(value, label, options);
    if (numeric !== null && !Number.isInteger(numeric)) {
      throw new Error((label || 'Giá trị') + ' phải là số nguyên.');
    }
    return numeric;
  }

  static date(value, label, options) {
    const settings = options || {};
    const name = label || 'Ngày';
    if (value === '' || value === null || value === undefined) {
      if (settings.required) throw new Error(name + ' là bắt buộc.');
      return null;
    }

    const date = this.parseDate(value);
    if (Number.isNaN(date.getTime())) throw new Error(name + ' không hợp lệ.');
    if (settings.notPast && this.startOfDay(date) < this.startOfDay(new Date())) {
      throw new Error(name + ' không được ở quá khứ.');
    }
    return date;
  }

  /**
   * Accepts both the Vietnamese UI format (dd/MM/yyyy) and ISO dates.
   * Dates are constructed at noon local time so Apps Script does not shift a
   * calendar date when it serializes data between the browser and Sheets.
   */
  static parseDate(value) {
    if (value instanceof Date) return new Date(value.getTime());
    const text = String(value || '').trim();
    let match = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (match) return this.createCalendarDate(Number(match[3]), Number(match[2]), Number(match[1]));

    match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
    if (match) return this.createCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));

    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? new Date('invalid') : parsed;
  }

  static createCalendarDate(year, month, day) {
    const date = new Date(year, month - 1, day, 12, 0, 0, 0);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
      ? date
      : new Date('invalid');
  }

  static time(value, label, options) {
    const settings = options || {};
    const name = label || 'Giờ';
    if (value === '' || value === null || value === undefined) {
      if (settings.required) throw new Error(name + ' là bắt buộc.');
      return '';
    }

    const match = String(value).trim().match(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
    if (!match) throw new Error(name + ' phải có định dạng HH:mm.');
    return match[0];
  }

  static oneOf(value, allowedValues, label, options) {
    const settings = options || {};
    const name = label || 'Giá trị';
    if (value === '' || value === null || value === undefined) {
      if (settings.required) throw new Error(name + ' là bắt buộc.');
      return '';
    }
    if (!Array.isArray(allowedValues) || allowedValues.indexOf(value) === -1) {
      throw new Error(name + ' không hợp lệ.');
    }
    return value;
  }

  /**
   * Validates the portable booking fields before BookingService persists them.
   * The service remains responsible for checking employee, bed, and time
   * conflicts against existing bookings.
   */
  static booking(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Dữ liệu booking không hợp lệ.');
    }

    const statusValues = typeof CONFIG !== 'undefined' && CONFIG.BOOKING_STATUS
      ? Object.keys(CONFIG.BOOKING_STATUS).map(function (key) {
        return CONFIG.BOOKING_STATUS[key];
      })
      : [];
    const bookingDate = this.date(data.BookingDate, 'Ngày đặt lịch', { required: true });
    const startTime = this.time(data.StartTime, 'Giờ bắt đầu', { required: true });
    const endTime = this.time(data.EndTime, 'Giờ kết thúc', { required: true });

    if (this.timeToMinutes(endTime) <= this.timeToMinutes(startTime)) {
      throw new Error('Giờ kết thúc phải sau giờ bắt đầu.');
    }

    return {
      CustomerID: this.required(data.CustomerID, 'Khách hàng'),
      EmployeeID: this.required(data.EmployeeID, 'Nhân viên'),
      ServiceID: this.required(data.ServiceID, 'Dịch vụ'),
      BedID: this.required(data.BedID, 'Giường'),
      BookingDate: bookingDate,
      StartTime: startTime,
      EndTime: endTime,
      Status: statusValues.length
        ? this.oneOf(data.Status || CONFIG.BOOKING_STATUS.BOOKED, statusValues, 'Trạng thái', { required: true })
        : this.required(data.Status, 'Trạng thái'),
      Price: this.number(data.Price, 'Giá dịch vụ', { required: true, min: 0 }),
      Discount: this.number(data.Discount, 'Giảm giá', { defaultValue: 0, min: 0 }),
      FinalPrice: this.number(data.FinalPrice, 'Thành tiền', { required: true, min: 0 }),
      Note: this.text(data.Note, 'Ghi chú', { maxLength: 2000 })
    };
  }

  static cleanText(value) {
    return String(value).trim().replace(/\s+/g, ' ');
  }

  static timeToMinutes(time) {
    const parts = String(time).split(':').map(Number);
    return parts[0] * 60 + parts[1];
  }

  static startOfDay(value) {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
}
