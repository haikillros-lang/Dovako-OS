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

/**
 * Builds printable and Excel-compatible report files without creating a
 * permanent Drive file. The recipient only receives the report requested by
 * an Admin or Manager at the time the button is pressed.
 */
class ReportExportService {
  static resolve(request) {
    const input = request || {};
    const type = String(input.Type || input.type || 'Range').toUpperCase();
    if (type === 'MONTH') {
      const month = Validator.required(input.Month || input.month, 'Tháng báo cáo');
      return { type: type, report: ReportService.month(month), label: 'tháng ' + month };
    }
    if (type === 'YEAR') {
      const year = Validator.integer(input.Year || input.year, 'Năm báo cáo', { required: true, min: 2000, max: 2100 });
      return { type: type, report: ReportService.year(year), label: 'năm ' + year };
    }
    return { type: 'RANGE', report: ReportService.get({ From: input.From, To: input.To }), label: 'khoảng thời gian đã chọn' };
  }

  static sendEmail(session, request) {
    const input = request || {};
    const recipient = Validator.email(input.Email || input.email, 'Email nhận báo cáo', { required: true });
    const resolved = this.resolve(input);
    const attachment = this.csvBlob(resolved.report, resolved.type);
    const title = 'DOVAKO – Báo cáo doanh thu ' + this.periodText(resolved.report, resolved.type);

    MailApp.sendEmail({
      to: recipient,
      subject: title,
      body: this.plainText(resolved.report, resolved.type),
      htmlBody: this.html(resolved.report, resolved.type),
      attachments: [attachment],
      name: 'DOVAKO Stretching'
    });

    AppLogger.safe('AUDIT', 'Report', 'EMAIL_EXPORT', recipient, 'Đã gửi file báo cáo doanh thu', {
      user: session && session.Username ? session.Username : '',
      role: session && session.Role ? session.Role : '',
      type: resolved.type,
      from: resolved.report.from,
      to: resolved.report.to
    });

    return {
      recipient: recipient,
      fileName: attachment.getName(),
      message: 'Đã gửi báo cáo kèm file đến ' + recipient + '.'
    };
  }

  static csvBlob(report, type) {
    const rows = this.csvRows(report, type);
    const csv = '\uFEFF' + rows.map(function (row) {
      return row.map(ReportExportService.csvCell).join(';');
    }).join('\r\n');
    return Utilities.newBlob(csv, MimeType.CSV, this.fileName(report, type));
  }

  static csvRows(report, type) {
    const summary = report.summary || {};
    const rows = [
      ['DOVAKO STRETCHING'],
      ['BÁO CÁO DOANH THU'],
      ['Thời gian', this.periodText(report, type)],
      [],
      ['Chỉ tiêu', 'Giá trị'],
      ['Tổng doanh thu', Number(summary.revenue || 0)],
      ['Doanh thu booking', Number(summary.bookingRevenue || 0)],
      ['Doanh thu bán thẻ', Number(summary.prepaidRevenue || 0)],
      ['Số thẻ đã bán', Number(summary.prepaidCards || 0)],
      ['Booking hoàn thành', Number(summary.completedBookings || 0)],
      ['Tổng booking', Number(summary.totalBookings || 0)],
      ['Hủy / không đến', Number(summary.cancelledBookings || 0)],
      []
    ];

    if (type === 'YEAR') {
      rows.push(['DOANH THU THEO THÁNG']);
      rows.push(['Tháng', 'Booking hoàn thành', 'Doanh thu booking', 'Tiền bán thẻ', 'Tổng doanh thu']);
      (report.months || []).forEach(function (row) {
        rows.push([row.label, Number(row.completedBookings || 0), Number(row.bookingRevenue || 0), Number(row.prepaidRevenue || 0), Number(row.revenue || 0)]);
      });
      return rows;
    }

    rows.push(['DOANH THU THEO DỊCH VỤ']);
    rows.push(['Dịch vụ', 'Số ca', 'Doanh thu']);
    (report.byService || []).forEach(function (row) {
      rows.push([row.name, Number(row.bookings || 0), Number(row.revenue || 0)]);
    });
    rows.push([]);
    rows.push(['DOANH THU THEO NHÂN VIÊN']);
    rows.push(['Nhân viên', 'Số ca', 'Doanh thu']);
    (report.byEmployee || []).forEach(function (row) {
      rows.push([row.name, Number(row.bookings || 0), Number(row.revenue || 0)]);
    });
    return rows;
  }

  static html(report, type) {
    const summary = report.summary || {};
    const money = this.money.bind(this);
    const summaryRows = [
      ['Tổng doanh thu', money(summary.revenue)],
      ['Doanh thu booking', money(summary.bookingRevenue)],
      ['Doanh thu bán thẻ', money(summary.prepaidRevenue)],
      ['Số thẻ đã bán', summary.prepaidCards || 0],
      ['Booking hoàn thành', summary.completedBookings || 0],
      ['Hủy / không đến', summary.cancelledBookings || 0]
    ].map(function (row) {
      return '<tr><td>' + ReportExportService.escape(row[0]) + '</td><td style="text-align:right"><strong>' + ReportExportService.escape(row[1]) + '</strong></td></tr>';
    }).join('');
    const detail = type === 'YEAR'
      ? this.htmlTable(['Tháng', 'Booking hoàn thành', 'Doanh thu booking', 'Tiền bán thẻ', 'Tổng doanh thu'], (report.months || []).map(function (row) {
        return [row.label, row.completedBookings || 0, money(row.bookingRevenue), money(row.prepaidRevenue), money(row.revenue)];
      }))
      : '<h3>Doanh thu theo dịch vụ</h3>' + this.htmlTable(['Dịch vụ', 'Số ca', 'Doanh thu'], (report.byService || []).map(function (row) {
        return [row.name, row.bookings || 0, money(row.revenue)];
      })) + '<h3>Doanh thu theo nhân viên</h3>' + this.htmlTable(['Nhân viên', 'Số ca', 'Doanh thu'], (report.byEmployee || []).map(function (row) {
        return [row.name, row.bookings || 0, money(row.revenue)];
      }));
    return '<div style="font-family:Arial,sans-serif;color:#17223b;line-height:1.5;max-width:720px">' +
      '<h2 style="margin:0 0 4px">DOVAKO STRETCHING</h2>' +
      '<h3 style="margin:0 0 18px">BÁO CÁO DOANH THU</h3>' +
      '<p><strong>Thời gian:</strong> ' + this.escape(this.periodText(report, type)) + '</p>' +
      this.htmlTable(['Chỉ tiêu', 'Giá trị'], [], summaryRows) +
      detail +
      '<p style="color:#667085;margin-top:20px">File Excel-compatible được đính kèm trong email này.</p></div>';
  }

  static htmlTable(headers, rows, prebuiltRows) {
    const head = '<thead><tr>' + headers.map(function (item) { return '<th style="background:#eef3ff;text-align:left">' + ReportExportService.escape(item) + '</th>'; }).join('') + '</tr></thead>';
    const body = prebuiltRows || (rows.length ? rows.map(function (row) {
      return '<tr>' + row.map(function (item) { return '<td>' + ReportExportService.escape(item) + '</td>'; }).join('') + '</tr>';
    }).join('') : '<tr><td colspan="' + headers.length + '" style="color:#667085">Chưa có dữ liệu.</td></tr>');
    return '<table cellspacing="0" cellpadding="8" style="border-collapse:collapse;border:1px solid #d9e0eb;width:100%;margin:10px 0 20px">' + head + '<tbody>' + body + '</tbody></table>';
  }

  static plainText(report, type) {
    const summary = report.summary || {};
    return [
      'DOVAKO STRETCHING',
      'BÁO CÁO DOANH THU',
      'Thời gian: ' + this.periodText(report, type),
      '',
      'Tổng doanh thu: ' + this.money(summary.revenue),
      'Doanh thu booking: ' + this.money(summary.bookingRevenue),
      'Doanh thu bán thẻ: ' + this.money(summary.prepaidRevenue),
      'Booking hoàn thành: ' + (summary.completedBookings || 0),
      '',
      'File Excel-compatible được đính kèm.'
    ].join('\n');
  }

  static periodText(report, type) {
    if (type === 'YEAR') return 'Năm ' + report.year;
    return Utils.formatDate(report.from) + ' – ' + Utils.formatDate(report.to);
  }

  static fileName(report, type) {
    const suffix = type === 'YEAR' ? String(report.year) : String(report.from) + '-den-' + String(report.to);
    return 'DOVAKO-bao-cao-doanh-thu-' + suffix + '.csv';
  }

  static money(value) {
    const amount = Math.round(Number(value || 0));
    const sign = amount < 0 ? '-' : '';
    return sign + String(Math.abs(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' đ';
  }

  static csvCell(value) {
    const text = String(value === null || value === undefined ? '' : value).replace(/"/g, '""');
    return '"' + text + '"';
  }

  static escape(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
}

function getReport(token, range) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]); return Utils.toClient(ReportService.get(range)); }
function getMonthlyRevenue(token, yearMonth) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]); return Utils.toClient(ReportService.month(yearMonth)); }
function getYearlyRevenue(token, year) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]); return Utils.toClient(ReportService.year(year)); }
function sendReportEmail(token, request) {
  const session = AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER]);
  return Utils.toClient(ReportExportService.sendEmail(session, request));
}
