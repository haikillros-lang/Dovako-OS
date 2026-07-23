/**
 * ============================================================
 * DOVAKO OS
 * Config.gs
 * Version: 1.0
 * ============================================================
 */

const CONFIG = Object.freeze({

  APP_NAME: "DOVAKO OS",

  VERSION: "1.0.0",

  TIMEZONE: "Asia/Ho_Chi_Minh",

  DATE_FORMAT: "dd/MM/yyyy",

  DATETIME_FORMAT: "dd/MM/yyyy HH:mm:ss",

  //==========================
  // DATABASE
  // A standalone Apps Script has no active spreadsheet. The system therefore
  // locates the DOVAKO database file in Drive, or uses this ID when supplied.
  //==========================

  DATABASE: {

    SPREADSHEET_ID: "",

    SPREADSHEET_NAMES: [

      "DOVAKO_DATABASE",

      "DOVAKO DATABASE"

    ]

  },

  DRIVE: {

    ROOT_FOLDER_NAME: "DOVAKO OS FILES"

  },

  //==========================
  // SHEETS
  //==========================

  SHEETS: {

    CUSTOMERS: "CUSTOMERS",

    BOOKINGS: "BOOKINGS",

    BOOKING_ASSIGNMENTS: "BOOKING_ASSIGNMENTS",

    EMPLOYEES: "EMPLOYEES",

    SERVICES: "SERVICES",

    FILES: "FILES",

    PREPAID_CARDS: "PREPAID_CARDS",

    PREPAID_USAGE: "PREPAID_USAGE",

    PREPAID_PLANS: "PREPAID_PLANS",

    REPORTS: "REPORTS",

    SETTINGS: "SETTINGS",

    LOGS: "LOGS",

    USERS: "USERS",

    NOTICES: "NOTICES",

    LEAVE_SCHEDULES: "LEAVE_SCHEDULES",

    TECHNICIAN_EARNINGS: "TECHNICIAN_EARNINGS"

  },

  //==========================
  // CUSTOMER STATUS
  //==========================

  CUSTOMER_STATUS: {

    ACTIVE: "Active",

    INACTIVE: "Inactive",

    VIP: "VIP",

    BLACKLIST: "Blacklist"

  },

  //==========================
  // BOOKING STATUS
  //==========================

  BOOKING_STATUS: {

    PENDING_CONFIRMATION: "Chưa xác nhận",

    CONFIRMED: "Đã xác nhận",

    CHECKED_IN: "Đang phục vụ",

    COMPLETED: "Hoàn thành",

    CANCELLED: "Hủy lịch",

    NOSHOW: "Không đến"

  },

  //==========================
  // PREPAID CARDS
  //==========================

  PREPAID: {

    DISCOUNT_OPTIONS: [20, 25],

    BONUS_SESSIONS: 1,

    NEAR_END_REMAINING: 2,

    NEAR_END_BALANCE: 200000

  },

  //==========================
  // CUSTOMER INSIGHTS
  //==========================

  CUSTOMER_VIP: {

    // A customer automatically receives the VIP tier once total spending
    // (prepaid purchases + completed non-card bookings) reaches this amount.
    SPEND_THRESHOLD: 10000000

  },

  //==========================
  // USER ROLE
  //==========================

  ROLES: {

    ADMIN: "Admin",

    MANAGER: "Manager",

    RECEPTION: "Reception",

    TECHNICIAN: "Technician"

  },

  AUTH: {

    SESSION_TTL_SECONDS: 21600

  },

  //==========================
  // GENDER
  //==========================

  GENDER: {

    MALE: "Nam",

    FEMALE: "Nữ",

    OTHER: "Khác"

  },

  //==========================
  // FILE TYPE
  //==========================

  FILE_TYPE: {

    BEFORE: "Before",

    AFTER: "After",

    ASSESSMENT: "Assessment",

    OTHER: "Other"

  },

  //==========================
  // ID PREFIX
  //==========================

  PREFIX: {

    CUSTOMER: "KH",

    BOOKING: "BK",

    EMPLOYEE: "NV",

    SERVICE: "DV",

    FILE: "FL",

    NOTICE: "TB",

    LEAVE: "NP",

    PREPAID_CARD: "PT",

    BOOKING_ASSIGNMENT: "BA"

    ,PREPAID_USAGE: "PU"

    ,PREPAID_PLAN: "PM",

    TECHNICIAN_EARNING: "TN"

  },

  //==========================
  // SYSTEM
  //==========================

  SYSTEM: {

    START_HOUR: 9,

    END_HOUR: 19,

    TOTAL_BEDS: 5,

    SLOT_MINUTES: 30

  }

});
