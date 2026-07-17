/**
 * DOVAKO OS
 * Logger.js
 *
 * Audit trail for business actions. Log failures are intentionally swallowed
 * by safe() so a secondary audit problem cannot block customer-facing work.
 */
class AppLogger {
  static get HEADERS() {
    return [
      'LogID',
      'Timestamp',
      'Level',
      'UserEmail',
      'Module',
      'Action',
      'RecordID',
      'Message',
      'Metadata'
    ];
  }

  static info(moduleName, action, recordId, message, metadata) {
    return this.write('INFO', moduleName, action, recordId, message, metadata);
  }

  static warning(moduleName, action, recordId, message, metadata) {
    return this.write('WARNING', moduleName, action, recordId, message, metadata);
  }

  static error(moduleName, action, recordId, error, metadata) {
    const message = error instanceof Error ? error.message : String(error || 'Unknown error');
    const details = Object.assign({}, metadata || {});
    if (error instanceof Error && error.stack) details.stack = error.stack;
    return this.write('ERROR', moduleName, action, recordId, message, details);
  }

  /** Records a durable business audit entry. */
  static audit(moduleName, action, recordId, metadata) {
    return this.write(
      'AUDIT',
      moduleName,
      action,
      recordId,
      String(action || 'Action') + ' on ' + String(recordId || 'record'),
      metadata
    );
  }

  static write(level, moduleName, action, recordId, message, metadata) {
    const sheetName = this.logSheetName();
    Database.ensureTable(sheetName, this.HEADERS);

    return Database.insertWithGeneratedId(sheetName, 'LOG', {
      Timestamp: new Date(),
      Level: this.clean(level),
      UserEmail: this.currentUserEmail(),
      Module: this.clean(moduleName),
      Action: this.clean(action),
      RecordID: this.clean(recordId),
      Message: this.clean(message),
      Metadata: this.stringifyMetadata(metadata)
    }, {
      idColumn: 'LogID',
      padding: 6
    });
  }

  /**
   * Performs logging without interrupting a successful business transaction.
   * Use this in CustomerService and BookingService after their database write.
   */
  static safe(level, moduleName, action, recordId, message, metadata) {
    try {
      return this.write(level, moduleName, action, recordId, message, metadata);
    } catch (error) {
      console.warn('DOVAKO OS audit logging failed: ' + error.message);
      return null;
    }
  }

  static currentUserEmail() {
    try {
      return Session.getActiveUser().getEmail() || 'Unknown';
    } catch (error) {
      return 'Unknown';
    }
  }

  static logSheetName() {
    if (typeof CONFIG !== 'undefined' && CONFIG.SHEETS && CONFIG.SHEETS.LOGS) {
      return CONFIG.SHEETS.LOGS;
    }
    return 'LOGS';
  }

  static stringifyMetadata(metadata) {
    if (metadata === null || metadata === undefined) return '';
    try {
      return JSON.stringify(metadata);
    } catch (error) {
      return JSON.stringify({ serializationError: 'Metadata could not be serialized.' });
    }
  }

  static clean(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }
}
