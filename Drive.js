/** DOVAKO OS file storage for handwritten assessments and customer photos. */
class DriveService {
  static get ROOT_FOLDER_CACHE_KEY() { return 'DOVAKO_FILES_ROOT_FOLDER_ID'; }

  static get FILE_HEADERS() {
    return ['FileID', 'CustomerID', 'BookingID', 'FileType', 'FileName', 'DriveFileID', 'UploadDate'];
  }

  static ensureFilesTable() {
    Database.ensureTable(CONFIG.SHEETS.FILES, this.FILE_HEADERS);
  }

  static rootFolder() {
    const rootName = CONFIG.DRIVE && CONFIG.DRIVE.ROOT_FOLDER_NAME ? CONFIG.DRIVE.ROOT_FOLDER_NAME : 'DOVAKO OS FILES';
    const cache = CacheService.getScriptCache();
    const cachedId = cache.get(this.ROOT_FOLDER_CACHE_KEY);
    if (cachedId) {
      try { return DriveApp.getFolderById(cachedId); } catch (error) { cache.remove(this.ROOT_FOLDER_CACHE_KEY); }
    }
    const folders = DriveApp.getFoldersByName(rootName);
    const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(rootName);
    cache.put(this.ROOT_FOLDER_CACHE_KEY, folder.getId(), 21600);
    return folder;
  }

  static customerFolder(customerId) {
    const root = this.rootFolder();
    const folders = root.getFoldersByName(customerId);
    return folders.hasNext() ? folders.next() : root.createFolder(customerId);
  }

  static list(customerId) {
    this.ensureFilesTable();
    return Database.where(CONFIG.SHEETS.FILES, { CustomerID: Validator.required(customerId, 'Mã khách hàng') })
      .sort(function (left, right) { return new Date(right.UploadDate).getTime() - new Date(left.UploadDate).getTime(); })
      .map(function (item) {
        const url = item.DriveFileID
          ? 'https://drive.google.com/open?id=' + encodeURIComponent(item.DriveFileID)
          : '';
        return Object.assign({}, item, { Url: url });
      });
  }

  static upload(data) {
    this.ensureFilesTable();
    if (!data || typeof data !== 'object') throw new Error('Dữ liệu file không hợp lệ.');
    const customerId = Validator.required(data.CustomerID, 'Mã khách hàng');
    if (!CustomerService.get(customerId)) throw new Error('Không tìm thấy hồ sơ khách hàng.');
    const allowedTypes = ['Assessment', 'ProgressAssessment', 'Before', 'After', 'Other'];
    const fileType = Validator.oneOf(data.FileType || 'Assessment', allowedTypes, 'Loại file', { required: true });
    const base64 = String(data.Base64 || '').replace(/^data:[^;]+;base64,/, '');
    if (!base64) throw new Error('Chưa chọn file để tải lên.');
    const byteSize = Math.floor(base64.length * 0.75);
    if (byteSize > 5 * 1024 * 1024) throw new Error('File tối đa 5 MB.');
    const filename = this.safeFilename(data.FileName || (fileType + '_' + new Date().getTime()));
    const blob = Utilities.newBlob(Utilities.base64Decode(base64), data.MimeType || 'application/octet-stream', filename);
    const file = this.customerFolder(customerId).createFile(blob);
    const saved = Database.insertWithGeneratedId(CONFIG.SHEETS.FILES, CONFIG.PREFIX.FILE, {
      CustomerID: customerId,
      BookingID: String(data.BookingID || ''),
      FileType: fileType,
      FileName: filename,
      DriveFileID: file.getId(),
      UploadDate: new Date()
    }, { idColumn: 'FileID', padding: 6 });
    AppLogger.safe('AUDIT', 'File', 'UPLOAD', saved.FileID, 'UPLOAD customer file', { customerId: customerId, fileType: fileType });
    return Object.assign({}, saved, { Url: file.getUrl() });
  }

  static safeFilename(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 180);
  }

  /** Returns only status-update forms recorded for one booking. */
  static listProgressAssessmentsForBooking(bookingId) {
    this.ensureFilesTable();
    const id = Validator.required(bookingId, 'Mã booking');
    return Database.where(CONFIG.SHEETS.FILES, { BookingID: id })
      .filter(function (item) { return item.FileType === 'ProgressAssessment'; })
      .sort(function (left, right) { return new Date(right.UploadDate || 0).getTime() - new Date(left.UploadDate || 0).getTime(); })
      .map(function (item) {
        return Object.assign({}, item, {
          Url: item.DriveFileID ? 'https://drive.google.com/open?id=' + encodeURIComponent(item.DriveFileID) : ''
        });
      });
  }

  /** A technician may update forms only for a booking assigned to them. */
  static uploadTechnicianProgressAssessment(session, bookingId, data) {
    const booking = this.assertTechnicianBooking(session, bookingId);
    if (BookingService.isUnavailableStatus(booking.Status)) {
      throw new Error('Không thể cập nhật phiếu cho booking đã hủy hoặc khách không đến.');
    }
    const saved = this.upload(Object.assign({}, data || {}, {
      CustomerID: booking.CustomerID,
      BookingID: booking.BookingID,
      FileType: 'ProgressAssessment'
    }));
    AppLogger.safe('AUDIT', 'File', 'UPLOAD_PROGRESS_ASSESSMENT', saved.FileID, 'Technician uploaded progress assessment', {
      bookingId: booking.BookingID, customerId: booking.CustomerID, employeeId: session.EmployeeID
    });
    return saved;
  }

  static listTechnicianProgressAssessments(session, bookingId) {
    this.assertTechnicianBooking(session, bookingId);
    return this.listProgressAssessmentsForBooking(bookingId);
  }

  static assertTechnicianBooking(session, bookingId) {
    if (!session || session.Role !== CONFIG.ROLES.TECHNICIAN) {
      throw new Error('Chỉ kỹ thuật viên được dùng chức năng cập nhật phiếu này.');
    }
    const employeeId = String(session.EmployeeID || '').trim();
    if (!employeeId) throw new Error('Tài khoản kỹ thuật viên chưa liên kết với hồ sơ nhân viên.');
    const booking = BookingService.get(Validator.required(bookingId, 'Mã booking'));
    if (!booking) throw new Error('Không tìm thấy booking.');
    if (!BookingService.isEmployeeAssigned(booking, employeeId)) {
      throw new Error('Bạn chỉ có thể cập nhật phiếu cho booking được phân công cho mình.');
    }
    return booking;
  }
}

function getCustomerFiles(token, customerId) { AuthService.requireSession(token); return Utils.toClient(DriveService.list(customerId)); }
function uploadCustomerFile(token, data) { AuthService.requireSession(token, [CONFIG.ROLES.ADMIN, CONFIG.ROLES.MANAGER, CONFIG.ROLES.RECEPTION]); return Utils.toClient(DriveService.upload(data)); }
function getTechnicianBookingAssessmentFiles(token, bookingId) { return Utils.toClient(DriveService.listTechnicianProgressAssessments(AuthService.requireSession(token, [CONFIG.ROLES.TECHNICIAN]), bookingId)); }
function uploadTechnicianBookingAssessment(token, bookingId, data) { return Utils.toClient(DriveService.uploadTechnicianProgressAssessment(AuthService.requireSession(token, [CONFIG.ROLES.TECHNICIAN]), bookingId, data)); }
