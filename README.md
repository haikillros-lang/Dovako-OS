# DOVAKO OS

Ứng dụng vận hành nội bộ cho DOVAKO Stretching, xây bằng Google Apps Script, Google Sheets và Google Drive.

## Chức năng MVP

- Dashboard doanh thu ngày, tuần, tháng và lịch hôm nay.
- Hồ sơ khách hàng: tạo, sửa, tìm kiếm, lưu trữ.
- Lưu phiếu tình trạng viết tay, ảnh trước/sau vào Google Drive.
- Booking: chống trùng giường, nhân viên và khách trong cùng thời điểm.
- Trạng thái: Chưa xác nhận, Đã xác nhận, Đang phục vụ, Hoàn thành, Hủy lịch, Không đến.
- Cài đặt danh mục nhân viên và dịch vụ.
- Báo cáo doanh thu theo khoảng ngày, dịch vụ và nhân viên.

## Vận hành

1. Chỉnh mã nguồn tại thư mục này.
2. Đồng bộ lên Google Apps Script bằng `clasp push`.
3. Trong Apps Script, chạy `resetEmptyDovakoSheetHeaders` chỉ khi một sheet hoàn toàn chưa có dữ liệu để tạo hàng tiêu đề.
4. Tạo nhân viên và dịch vụ trong mục **Cài đặt** trước khi tạo booking.

## Bảo mật

Không đưa file `.clasprc.json` lên GitHub vì file này chứa thông tin đăng nhập cục bộ của clasp.
