/**
 * DOVAKO OS
 * Dashboard.js
 * Read-only operational metrics built from Customers and Bookings.
 */
class DashboardService {
  static getDashboard(referenceDate) {
    const date = referenceDate ? Validator.date(referenceDate, 'Ngày báo cáo', { required: true }) : new Date();
    const todayKey = this.dateKey(date);
    const week = this.weekRange(date);
    const month = this.monthRange(date);
    const todayBookings = BookingService.list({ date: date, includeCancelled: true });
    const allBookings = BookingService.list({ includeCancelled: true });
    const customers = CustomerService.list({ includeInactive: true });

    return {
      date: todayKey,
      revenue: {
        today: this.revenueBetween(allBookings, todayKey, todayKey),
        week: this.revenueBetween(allBookings, week.from, week.to),
        month: this.revenueBetween(allBookings, month.from, month.to)
      },
      bookings: {
        today: todayBookings.length,
        activeToday: todayBookings.filter(function (booking) {
          return !BookingService.isUnavailableStatus(booking.Status);
        }).length,
        pendingConfirmation: this.countByStatus(todayBookings, CONFIG.BOOKING_STATUS.PENDING_CONFIRMATION),
        confirmed: this.countByStatus(todayBookings, CONFIG.BOOKING_STATUS.CONFIRMED),
        serving: this.countByStatus(todayBookings, CONFIG.BOOKING_STATUS.CHECKED_IN),
        completed: this.countByStatus(todayBookings, CONFIG.BOOKING_STATUS.COMPLETED),
        cancelled: this.countByStatus(todayBookings, CONFIG.BOOKING_STATUS.CANCELLED),
        noShow: this.countByStatus(todayBookings, CONFIG.BOOKING_STATUS.NOSHOW)
      },
      customers: {
        newToday: customers.filter(function (customer) {
          return DashboardService.dateKey(customer.CreatedDate) === todayKey;
        }).length,
        total: customers.length
      },
      todaySchedule: this.decorateSchedule(todayBookings, customers),
      period: { week: week, month: month }
    };
  }

  static getTodaySchedule(referenceDate) {
    const date = referenceDate ? Validator.date(referenceDate, 'Ngày xem lịch', { required: true }) : new Date();
    const customers = CustomerService.list({ includeInactive: true });
    return this.decorateSchedule(BookingService.list({ date: date, includeCancelled: true }), customers);
  }

  static getRevenueSummary(referenceDate) {
    const date = referenceDate ? Validator.date(referenceDate, 'Ngày báo cáo', { required: true }) : new Date();
    const bookings = BookingService.list({ includeCancelled: true });
    const todayKey = this.dateKey(date);
    const week = this.weekRange(date);
    const month = this.monthRange(date);
    return {
      today: this.revenueBetween(bookings, todayKey, todayKey),
      week: this.revenueBetween(bookings, week.from, week.to),
      month: this.revenueBetween(bookings, month.from, month.to)
    };
  }

  static revenueBetween(bookings, fromKey, toKey) {
    return bookings.reduce(function (total, booking) {
      const bookingKey = DashboardService.dateKey(booking.BookingDate);
      if (booking.Status !== CONFIG.BOOKING_STATUS.COMPLETED || bookingKey < fromKey || bookingKey > toKey) {
        return total;
      }
      const value = Number(booking.FinalPrice);
      return total + (Number.isFinite(value) ? value : 0);
    }, 0);
  }

  static decorateSchedule(bookings, customers) {
    const names = customers.reduce(function (map, customer) {
      map[customer.CustomerID] = customer.FullName;
      return map;
    }, {});
    return bookings.slice().sort(BookingService.sortByDateTime).map(function (booking) {
      return {
        BookingID: booking.BookingID,
        CustomerID: booking.CustomerID,
        CustomerName: names[booking.CustomerID] || 'Khách đã xóa',
        EmployeeID: booking.EmployeeID,
        ServiceID: booking.ServiceID,
        BedID: booking.BedID,
        BookingDate: booking.BookingDate,
        StartTime: booking.StartTime,
        EndTime: booking.EndTime,
        Status: booking.Status,
        FinalPrice: booking.FinalPrice,
        Note: booking.Note
      };
    });
  }

  static countByStatus(bookings, status) {
    return bookings.filter(function (booking) { return booking.Status === status; }).length;
  }

  static dateKey(value) {
    return Utilities.formatDate(new Date(value), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }

  static weekRange(referenceDate) {
    const date = new Date(referenceDate);
    const day = date.getDay();
    const offsetToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(date);
    monday.setDate(date.getDate() + offsetToMonday);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { from: this.dateKey(monday), to: this.dateKey(sunday) };
  }

  static monthRange(referenceDate) {
    const date = new Date(referenceDate);
    const firstDay = new Date(date.getFullYear(), date.getMonth(), 1);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return { from: this.dateKey(firstDay), to: this.dateKey(lastDay) };
  }
}

/* Apps Script entry points for google.script.run. */
function getDashboard(referenceDate) { return Utils.toClient(DashboardService.getDashboard(referenceDate)); }
function getTodaySchedule(referenceDate) { return Utils.toClient(DashboardService.getTodaySchedule(referenceDate)); }
function getRevenueSummary(referenceDate) { return Utils.toClient(DashboardService.getRevenueSummary(referenceDate)); }
