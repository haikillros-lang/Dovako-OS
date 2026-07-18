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
