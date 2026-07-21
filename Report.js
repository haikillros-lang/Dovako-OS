/** DOVAKO OS reporting built from completed bookings. */
class ReportService {
  static get(range) {
    const period = this.normalizeRange(range);
    const bookings = BookingService.list({ includeCancelled: true }).filter(function (booking) {
      const date = DashboardService.dateKey(booking.BookingDate);
      return date >= period.from && date <= period.to;
    });
    const completed = bookings.filter(function (booking) { return booking.Status === CONFIG.BOOKING_STATUS.COMPLETED; });
    const prepaidCards = typeof PrepaidService !== 'undefined'
      ? PrepaidService.cardsBetween(period.from, period.to) : [];
    return this.build(period, bookings, completed, prepaidCards);
  }

  static build(period, bookings, completed, prepaidCards) {
    const bookingRevenue = completed.reduce(function (total, booking) { return total + Number(booking.FinalPrice || 0); }, 0);
    const prepaidRevenue = prepaidCards.reduce(function (total, card) { return total + Number(card.PaidAmount || 0); }, 0);
    const services = CatalogService.services(true).reduce(function (map, item) { map[item.ServiceID] = item.ServiceName; return map; }, {});
    const employees = CatalogService.employees(true).reduce(function (map, item) { map[item.EmployeeID] = item.FullName; return map; }, {});
    return {
      from: period.from,
      to: period.to,
      summary: {
        revenue: bookingRevenue + prepaidRevenue,
        bookingRevenue: bookingRevenue,
        prepaidRevenue: prepaidRevenue,
        prepaidCards: prepaidCards.length,
        completedBookings: completed.length,
        totalBookings: bookings.length,
        cancelledBookings: bookings.filter(function (booking) {
          return booking.Status === CONFIG.BOOKING_STATUS.CANCELLED || booking.Status === CONFIG.BOOKING_STATUS.NOSHOW;
        }).length
      },
      byService: this.group(completed, 'ServiceID', services),
      byEmployee: this.group(completed, 'EmployeeID', employees)
    };
  }

  /** Monthly revenue for a selected YYYY-MM value. */
  static month(yearMonth) {
    const match = String(yearMonth || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) throw new Error('Chọn tháng cần xem theo định dạng YYYY-MM.');
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) throw new Error('Tháng không hợp lệ.');
    return this.get({
      From: Utilities.formatString('%04d-%02d-01', year, month),
      To: DashboardService.dateKey(new Date(year, month, 0))
    });
  }

  /** Annual revenue with a January–December breakdown for management. */
  static year(value) {
    const year = Number(value);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('Năm báo cáo không hợp lệ.');
    const from = Utilities.formatString('%04d-01-01', year);
    const to = Utilities.formatString('%04d-12-31', year);
    const allBookings = BookingService.list({ includeCancelled: true });
    const allCards = typeof PrepaidService !== 'undefined' ? PrepaidService.list({ includeInactive: true }) : [];
    const months = [];
    for (let month = 1; month <= 12; month += 1) {
      const period = {
        from: Utilities.formatString('%04d-%02d-01', year, month),
        to: DashboardService.dateKey(new Date(year, month, 0))
      };
      const bookings = allBookings.filter(function (booking) {
        const key = DashboardService.dateKey(booking.BookingDate);
        return key >= period.from && key <= period.to;
      });
      const completed = bookings.filter(function (booking) { return booking.Status === CONFIG.BOOKING_STATUS.COMPLETED; });
      const cards = allCards.filter(function (card) {
        const key = DashboardService.dateKey(card.PurchasedDate);
        return key >= period.from && key <= period.to;
      });
      const bookingRevenue = completed.reduce(function (sum, booking) { return sum + Number(booking.FinalPrice || 0); }, 0);
      const prepaidRevenue = cards.reduce(function (sum, card) { return sum + Number(card.PaidAmount || 0); }, 0);
      months.push({
        month: month,
        label: 'Tháng ' + month,
        revenue: bookingRevenue + prepaidRevenue,
        bookingRevenue: bookingRevenue,
        prepaidRevenue: prepaidRevenue,
        completedBookings: completed.length,
        prepaidCards: cards.length
      });
    }
    const total = months.reduce(function (sum, row) { return sum + row.revenue; }, 0);
    return {
      year: year,
      from: from,
      to: to,
      summary: {
        revenue: total,
        bookingRevenue: months.reduce(function (sum, row) { return sum + row.bookingRevenue; }, 0),
        prepaidRevenue: months.reduce(function (sum, row) { return sum + row.prepaidRevenue; }, 0),
        completedBookings: months.reduce(function (sum, row) { return sum + row.completedBookings; }, 0),
        prepaidCards: months.reduce(function (sum, row) { return sum + row.prepaidCards; }, 0)
      },
      months: months
    };
  }

  static normalizeRange(input) {
    const value = input || {};
    const now = new Date();
    const from = value.From ? Validator.date(value.From, 'Từ ngày', { required: true }) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = value.To ? Validator.date(value.To, 'Đến ngày', { required: true }) : now;
    const fromKey = DashboardService.dateKey(from);
    const toKey = DashboardService.dateKey(to);
    if (fromKey > toKey) throw new Error('Từ ngày không được sau đến ngày.');
    return { from: fromKey, to: toKey };
  }

  static group(bookings, field, names) {
    const aggregate = bookings.reduce(function (map, booking) {
      const key = String(booking[field] || '');
      if (!map[key]) map[key] = { id: key, name: names[key] || key || 'Chưa xác định', bookings: 0, revenue: 0 };
      map[key].bookings += 1;
      map[key].revenue += Number(booking.FinalPrice || 0);
      return map;
    }, {});
    return Object.keys(aggregate).map(function (key) { return aggregate[key]; }).sort(function (a, b) { return b.revenue - a.revenue; });
  }
}

function getReport(token, range) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]); return Utils.toClient(ReportService.get(range)); }
function getMonthlyRevenue(token, yearMonth) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]); return Utils.toClient(ReportService.month(yearMonth)); }
function getYearlyRevenue(token, year) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]); return Utils.toClient(ReportService.year(year)); }
