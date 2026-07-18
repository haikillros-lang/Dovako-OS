/**
 * DOVAKO OS
 * Database.js
 *
 * Single data-access layer for Google Sheets. Business modules should use this
 * class instead of calling SpreadsheetApp directly.
 */
class Database {
  static get SPREADSHEET_CACHE_KEY() { return 'DOVAKO_DATABASE_SPREADSHEET_ID'; }

  /**
   * Returns the spreadsheet bound to this Apps Script project.
   * The Utils integration keeps this compatible with the existing project.
   */
  static getSpreadsheet() {
    if (this._spreadsheet) return this._spreadsheet;

    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) {
      this._spreadsheet = active;
      return active;
    }

    const databaseConfig = typeof CONFIG !== 'undefined' ? CONFIG.DATABASE : null;
    const cache = CacheService.getScriptCache();
    const configuredId = databaseConfig && databaseConfig.SPREADSHEET_ID;
    const cachedId = configuredId ? '' : cache.get(this.SPREADSHEET_CACHE_KEY);
    const spreadsheetId = configuredId || cachedId;

    if (spreadsheetId) {
      try {
        const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
        this._spreadsheet = spreadsheet;
        if (!configuredId) cache.put(this.SPREADSHEET_CACHE_KEY, spreadsheet.getId(), 21600);
        return spreadsheet;
      } catch (error) {
        if (!configuredId) cache.remove(this.SPREADSHEET_CACHE_KEY);
      }
    }

    const names = databaseConfig && Array.isArray(databaseConfig.SPREADSHEET_NAMES)
      ? databaseConfig.SPREADSHEET_NAMES
      : [];
    for (let index = 0; index < names.length; index += 1) {
      const files = DriveApp.getFilesByName(names[index]);
      if (files.hasNext()) {
        const spreadsheet = SpreadsheetApp.open(files.next());
        this._spreadsheet = spreadsheet;
        cache.put(this.SPREADSHEET_CACHE_KEY, spreadsheet.getId(), 21600);
        return spreadsheet;
      }
    }

    if (typeof Utils !== 'undefined' && typeof Utils.getSpreadsheet === 'function') {
      const spreadsheet = Utils.getSpreadsheet();
      if (spreadsheet) {
        this._spreadsheet = spreadsheet;
        cache.put(this.SPREADSHEET_CACHE_KEY, spreadsheet.getId(), 21600);
        return spreadsheet;
      }
    }

    throw new Error(
      'Không tìm thấy file Google Sheet DOVAKO_DATABASE. ' +
      'Hãy đổi tên file hoặc đặt CONFIG.DATABASE.SPREADSHEET_ID.'
    );
  }

  /**
   * Returns a sheet and fails with an actionable message when it is missing.
   */
  static table(sheetName) {
    if (!sheetName) {
      throw new Error('Database.table requires a sheet name.');
    }

    const sheet = this.getSpreadsheet().getSheetByName(sheetName);
    if (!sheet) {
      throw new Error('Không tìm thấy sheet: ' + sheetName);
    }
    return sheet;
  }

  /**
   * Returns a sheet, creating it with the supplied headers when necessary.
   * System modules use this for infrastructure tables such as LOGS.
   */
  static ensureTable(sheetName, headers) {
    if (!Array.isArray(headers) || headers.length === 0) {
      throw new Error('Database.ensureTable requires one or more headers.');
    }
    if (new Set(headers).size !== headers.length || headers.some(function (header) {
      return !header || String(header).trim() === '';
    })) {
      throw new Error('Database.ensureTable requires unique, non-empty headers.');
    }

    const spreadsheet = this.getSpreadsheet();
    let sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(sheetName);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
      return sheet;
    }

    const existingHeaders = this.headers(sheetName);
    if (existingHeaders.join('|') !== headers.join('|')) {
      throw new Error('Sheet ' + sheetName + ' không đúng cấu trúc dữ liệu yêu cầu.');
    }
    return sheet;
  }

  /**
   * Ensures a table contains the supplied columns, adding only missing
   * columns at the end. This is used for backward-compatible schema updates
   * where existing operational data must never be overwritten.
   */
  static ensureColumns(sheetName, requiredHeaders) {
    if (!Array.isArray(requiredHeaders) || requiredHeaders.length === 0) {
      throw new Error('Database.ensureColumns requires one or more headers.');
    }
    if (new Set(requiredHeaders).size !== requiredHeaders.length || requiredHeaders.some(function (header) {
      return !header || String(header).trim() === '';
    })) {
      throw new Error('Database.ensureColumns requires unique, non-empty headers.');
    }

    const spreadsheet = this.getSpreadsheet();
    let sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(sheetName);
      sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
      sheet.setFrozenRows(1);
      return sheet;
    }

    const existing = this.headers(sheetName);
    const missing = requiredHeaders.filter(function (header) {
      return existing.indexOf(header) === -1;
    });
    if (missing.length) {
      sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
      sheet.setFrozenRows(1);
      SpreadsheetApp.flush();
    }
    return sheet;
  }

  /**
   * Replaces headers only when the sheet has no records. This supports safe
   * first-time setup without risking any customer or booking data.
   */
  static resetHeadersIfEmpty(sheetName, headers) {
    const sheet = this.table(sheetName);
    if (sheet.getLastRow() > 1) {
      throw new Error('Sheet ' + sheetName + ' đã có dữ liệu nên không thể tự động đổi cấu trúc.');
    }
    sheet.clearContents();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  /** Returns the first-row column names, removing trailing empty headings. */
  static headers(sheetName) {
    const sheet = this.table(sheetName);
    const columnCount = sheet.getLastColumn();
    if (columnCount === 0) {
      throw new Error('Sheet ' + sheetName + ' chưa có hàng tiêu đề.');
    }

    const headers = sheet.getRange(1, 1, 1, columnCount).getDisplayValues()[0]
      .map(function (header) { return String(header).trim(); });

    const validHeaders = headers.filter(function (header) { return header !== ''; });
    if (validHeaders.length === 0) {
      throw new Error('Sheet ' + sheetName + ' chưa có tên cột.');
    }
    if (validHeaders.length !== headers.length) {
      throw new Error('Sheet ' + sheetName + ' có cột tiêu đề trống.');
    }
    if (new Set(headers).size !== headers.length) {
      throw new Error('Sheet ' + sheetName + ' có tên cột bị trùng.');
    }
    return headers;
  }

  /** Converts one sheet row into an object keyed by the sheet headers. */
  static rowToObject(headers, row, rowNumber) {
    const record = {};
    headers.forEach(function (header, index) {
      record[header] = row[index];
    });
    if (rowNumber) {
      Object.defineProperty(record, '_rowNumber', {
        value: rowNumber,
        enumerable: false,
        writable: false
      });
    }
    return record;
  }

  /** Converts a record into a row that follows the sheet header order. */
  static objectToRow(headers, record) {
    this.assertRecordKeys(headers, record);
    return headers.map(function (header) {
      return Object.prototype.hasOwnProperty.call(record, header) ? record[header] : '';
    });
  }

  /** Reads every non-empty record in a sheet. */
  static findAll(sheetName) {
    const sheet = this.table(sheetName);
    const headers = this.headers(sheetName);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    return values
      .map(function (row, index) {
        return Database.rowToObject(headers, row, index + 2);
      })
      .filter(function (record) {
        return headers.some(function (header) {
          return record[header] !== '' && record[header] !== null;
        });
      });
  }

  /** Alias for code that reads more naturally in reporting modules. */
  static getAll(sheetName) {
    return this.findAll(sheetName);
  }

  /** Finds the first record where a column exactly equals value. */
  static first(sheetName, columnName, value) {
    this.assertColumn(sheetName, columnName);
    const target = this.comparable(value);
    return this.findAll(sheetName).find(function (record) {
      return Database.comparable(record[columnName]) === target;
    }) || null;
  }

  /** Finds every record where a column exactly equals value. */
  static where(sheetName, criteria) {
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
      throw new Error('Database.where requires a criteria object.');
    }

    const keys = Object.keys(criteria);
    if (keys.length === 0) return this.findAll(sheetName);
    const headers = this.headers(sheetName);
    keys.forEach(function (key) {
      if (headers.indexOf(key) === -1) {
        throw new Error('Không tìm thấy cột ' + key + ' trong sheet ' + sheetName + '.');
      }
    });

    return this.findAll(sheetName).filter(function (record) {
      return keys.every(function (key) {
        const expected = criteria[key];
        return typeof expected === 'function'
          ? expected(record[key], record)
          : Database.comparable(record[key]) === Database.comparable(expected);
      });
    });
  }

  /** Finds one record by its primary-key column (first column by default). */
  static findById(sheetName, id, idColumn) {
    const primaryKey = idColumn || this.headers(sheetName)[0];
    return this.first(sheetName, primaryKey, id);
  }

  static exists(sheetName, criteria) {
    return this.where(sheetName, criteria).length > 0;
  }

  static count(sheetName, criteria) {
    return criteria ? this.where(sheetName, criteria).length : this.findAll(sheetName).length;
  }

  /** Inserts a record and returns the saved record, including its row number. */
  static insert(sheetName, record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('Database.insert requires a record object.');
    }

    const sheet = this.table(sheetName);
    const headers = this.headers(sheetName);
    const row = this.objectToRow(headers, record);
    const rowNumber = Math.max(sheet.getLastRow() + 1, 2);
    sheet.getRange(rowNumber, 1, 1, headers.length).setValues([row]);
    SpreadsheetApp.flush();
    return this.rowToObject(headers, row, rowNumber);
  }

  /**
   * Updates one record. Only fields supplied in changes are overwritten.
   * The primary key is intentionally immutable.
   */
  static update(sheetName, id, changes, idColumn) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new Error('Database.update requires a changes object.');
    }

    const headers = this.headers(sheetName);
    const primaryKey = idColumn || headers[0];
    this.assertRecordKeys(headers, changes);
    if (Object.prototype.hasOwnProperty.call(changes, primaryKey) &&
        this.comparable(changes[primaryKey]) !== this.comparable(id)) {
      throw new Error('Không thể thay đổi khóa chính ' + primaryKey + '.');
    }

    const current = this.findById(sheetName, id, primaryKey);
    if (!current) return null;

    const updated = {};
    headers.forEach(function (header) {
      updated[header] = Object.prototype.hasOwnProperty.call(changes, header)
        ? changes[header]
        : current[header];
    });

    this.table(sheetName)
      .getRange(current._rowNumber, 1, 1, headers.length)
      .setValues([this.objectToRow(headers, updated)]);
    SpreadsheetApp.flush();
    return this.rowToObject(headers, this.objectToRow(headers, updated), current._rowNumber);
  }

  /** Permanently deletes a record. Prefer status-based archiving for core data. */
  static remove(sheetName, id, idColumn) {
    const record = this.findById(sheetName, id, idColumn);
    if (!record) return false;
    this.table(sheetName).deleteRow(record._rowNumber);
    return true;
  }

  /**
   * Permanently removes every record matching the supplied exact criteria.
   * Rows are deleted from bottom to top so row numbers remain valid.
   */
  static removeWhere(sheetName, criteria) {
    const records = this.where(sheetName, criteria)
      .sort(function (left, right) { return right._rowNumber - left._rowNumber; });
    if (!records.length) return 0;

    const sheet = this.table(sheetName);
    records.forEach(function (record) {
      sheet.deleteRow(record._rowNumber);
    });
    SpreadsheetApp.flush();
    return records.length;
  }

  /** Permanently removes an already-selected set of records from one table. */
  static removeRecords(sheetName, records) {
    if (!Array.isArray(records)) {
      throw new Error('Database.removeRecords requires a record array.');
    }

    const rows = records
      .map(function (record) { return Number(record && record._rowNumber); })
      .filter(function (rowNumber) { return Number.isInteger(rowNumber) && rowNumber > 1; })
      .filter(function (rowNumber, index, all) { return all.indexOf(rowNumber) === index; })
      .sort(function (left, right) { return right - left; });
    if (!rows.length) return 0;

    const sheet = this.table(sheetName);
    rows.forEach(function (rowNumber) { sheet.deleteRow(rowNumber); });
    SpreadsheetApp.flush();
    return rows.length;
  }

  /** Alias retained for conventional CRUD naming. */
  static delete(sheetName, id, idColumn) {
    return this.remove(sheetName, id, idColumn);
  }

  /**
   * Returns the next sequential ID, for example KH000001.
   * For concurrent writes, use insertWithGeneratedId instead.
   */
  static generateRunningId(sheetName, prefix, options) {
    const settings = options || {};
    const idColumn = settings.idColumn || this.headers(sheetName)[0];
    const padding = settings.padding || 6;
    const lock = LockService.getScriptLock();
    lock.waitLock(settings.lockTimeoutMs || 30000);

    try {
      const values = this.findAll(sheetName).map(function (record) {
        return String(record[idColumn] || '');
      });
      const pattern = new RegExp('^' + this.escapeRegExp(prefix) + '(\\d+)$');
      const highest = values.reduce(function (max, value) {
        const match = value.match(pattern);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0);
      return prefix + String(highest + 1).padStart(padding, '0');
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * Atomically assigns a sequential primary key and inserts the record.
   * This is the recommended creation method for Customers, Bookings, Files,
   * Employees, and Services because the lock covers both ID generation and
   * the write operation.
   */
  static insertWithGeneratedId(sheetName, prefix, record, options) {
    const settings = options || {};
    const headers = this.headers(sheetName);
    const idColumn = settings.idColumn || headers[0];
    const padding = settings.padding || 6;
    const lock = LockService.getScriptLock();
    lock.waitLock(settings.lockTimeoutMs || 30000);

    try {
      const pattern = new RegExp('^' + this.escapeRegExp(prefix) + '(\\d+)$');
      const highest = this.findAll(sheetName).reduce(function (max, current) {
        const match = String(current[idColumn] || '').match(pattern);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0);
      const generatedId = prefix + String(highest + 1).padStart(padding, '0');
      const data = Object.assign({}, record);

      if (Object.prototype.hasOwnProperty.call(data, idColumn) && data[idColumn] &&
          Database.comparable(data[idColumn]) !== generatedId) {
        throw new Error('Không thể ghi đè ID tự sinh ở trường ' + idColumn + '.');
      }
      data[idColumn] = generatedId;
      return this.insert(sheetName, data);
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * Repairs blank or repeated IDs in a reference table without deleting data.
   * The first record using a duplicated ID keeps that ID so existing booking
   * references continue to point to the same record. Every later duplicate
   * receives the next available sequential ID.
   */
  static repairDuplicateIds(sheetName, prefix, options) {
    const settings = options || {};
    const headers = this.headers(sheetName);
    const idColumn = settings.idColumn || headers[0];
    const padding = settings.padding || 6;
    const idIndex = headers.indexOf(idColumn);

    if (idIndex === -1) {
      throw new Error('Không tìm thấy cột mã ' + idColumn + ' trong sheet ' + sheetName + '.');
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(settings.lockTimeoutMs || 30000);

    try {
      const sheet = this.table(sheetName);
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) {
        return { sheetName: sheetName, repairedCount: 0, repairs: [] };
      }

      const rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
      const pattern = new RegExp('^' + this.escapeRegExp(prefix) + '(\\d+)$');
      let highest = 0;
      const used = {};
      const repairs = [];

      rows.forEach(function (row) {
        const value = String(row[idIndex] || '').trim();
        const match = value.match(pattern);
        if (match) highest = Math.max(highest, Number(match[1]));
      });

      rows.forEach(function (row, index) {
        const currentId = String(row[idIndex] || '').trim();
        if (currentId && !used[currentId]) {
          used[currentId] = true;
          return;
        }

        let nextId;
        do {
          highest += 1;
          nextId = prefix + String(highest).padStart(padding, '0');
        } while (used[nextId]);

        row[idIndex] = nextId;
        used[nextId] = true;
        repairs.push({ rowNumber: index + 2, oldId: currentId, newId: nextId });
      });

      if (repairs.length) {
        sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
        SpreadsheetApp.flush();
      }

      return { sheetName: sheetName, repairedCount: repairs.length, repairs: repairs };
    } finally {
      lock.releaseLock();
    }
  }

  static assertColumn(sheetName, columnName) {
    if (this.headers(sheetName).indexOf(columnName) === -1) {
      throw new Error('Không tìm thấy cột ' + columnName + ' trong sheet ' + sheetName + '.');
    }
  }

  static assertRecordKeys(headers, record) {
    Object.keys(record).forEach(function (key) {
      if (key !== '_rowNumber' && headers.indexOf(key) === -1) {
        throw new Error('Trường ' + key + ' không tồn tại trong sheet.');
      }
    });
  }

  static comparable(value) {
    if (value instanceof Date) return value.getTime();
    return value === null || value === undefined ? '' : String(value).trim();
  }

  static escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
