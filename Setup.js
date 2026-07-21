/**
 * DOVAKO OS
 * Setup.js
 * Safe database initialization for a new or still-empty spreadsheet.
 */
class SystemSetup {
  static get TABLES() {
    return {
      CUSTOMERS: CustomerService.HEADERS,
      BOOKINGS: BookingService.HEADERS,
      EMPLOYEES: [
        'EmployeeID', 'FullName', 'Phone', 'Role', 'Status', 'CreatedDate', 'UpdatedDate'
      ],
      SERVICES: [
        'ServiceID', 'ServiceName', 'Duration', 'Price', 'Status', 'CreatedDate', 'UpdatedDate'
      ],
      FILES: [
        'FileID', 'CustomerID', 'BookingID', 'FileType', 'FileName', 'DriveFileID', 'UploadDate'
      ],
      PREPAID_CARDS: PrepaidService.CARD_HEADERS,
      PREPAID_USAGE: PrepaidService.USAGE_HEADERS,
      PREPAID_PLANS: PrepaidService.PLAN_HEADERS,
      LOGS: AppLogger.HEADERS,
      USERS: AuthService.HEADERS,
      NOTICES: NoticeService.HEADERS,
      LEAVE_SCHEDULES: LeaveService.HEADERS
    };
  }

  /**
   * Creates missing sheets. Set resetEmptyHeaders=true only to replace legacy
   * headers on sheets that have no data rows; existing records are never reset.
   */
  static initialize(options) {
    const settings = options || {};
    const resetEmptyHeaders = settings.resetEmptyHeaders === true;
    const results = [];

    Object.keys(this.TABLES).forEach(function (configKey) {
      const sheetName = CONFIG.SHEETS[configKey];
      const headers = SystemSetup.TABLES[configKey];
      const spreadsheet = Database.getSpreadsheet();
      const exists = Boolean(spreadsheet.getSheetByName(sheetName));

      if (configKey === 'BOOKINGS' || configKey === 'PREPAID_CARDS' || configKey === 'PREPAID_USAGE') {
        Database.ensureColumns(sheetName, headers);
        results.push({ sheet: sheetName, action: exists ? 'upgraded' : 'created' });
        return;
      }

      if (!exists) {
        Database.ensureTable(sheetName, headers);
        results.push({ sheet: sheetName, action: 'created' });
        return;
      }

      try {
        Database.ensureTable(sheetName, headers);
        results.push({ sheet: sheetName, action: 'verified' });
      } catch (error) {
        const sheet = Database.table(sheetName);
        if (resetEmptyHeaders && sheet.getLastRow() <= 1) {
          Database.resetHeadersIfEmpty(sheetName, headers);
          results.push({ sheet: sheetName, action: 'headers-reset' });
          return;
        }
        results.push({ sheet: sheetName, action: 'requires-review', message: error.message });
      }
    });

    return results;
  }
}

function initializeDovakoDatabase(options) {
  return SystemSetup.initialize(options);
}

/** Run manually only when legacy sheets contain no data rows. */
function resetEmptyDovakoSheetHeaders() {
  return SystemSetup.initialize({ resetEmptyHeaders: true });
}
