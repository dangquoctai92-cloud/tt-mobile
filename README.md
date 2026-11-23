# tt-mobile
Hệ thống quản lý sửa chữa điện thoại T&T Mobile

## Triển khai cấu hình chung máy chủ

### 1. Cloudflare Pages + Durable Object Worker (tách riêng Worker và Pages)
1. Triển khai Durable Object Worker trước từ thư mục `workers/config-do-worker`:
   - `wrangler deploy`
   - Khai báo tài khoản khởi tạo quản trị (`v0 -> v1`) dưới dạng Worker secret trên `tt-mobile-config-do`:
     - `wrangler secret put TT_BOOTSTRAP_ADMIN_USER`
     - `wrangler secret put TT_BOOTSTRAP_ADMIN_PASS` (hoặc `TT_BOOTSTRAP_ADMIN_SHA256` + `TT_BOOTSTRAP_ADMIN_SALT`)
2. Triển khai Cloudflare Pages từ thư mục gốc bằng `wrangler.toml` (đã tách sẵn `[[durable_objects.bindings]]` trỏ tới `script_name = "tt-mobile-config-do"` và không chứa `[[migrations]]`).

### 2. Node server nội bộ (`server.cjs`)
- Dùng SQLite WAL + `BEGIN IMMEDIATE` CAS (`.tt-data/shared-config.sqlite` hoặc `dbPath` cấu hình ngoài thư mục tĩnh).
- Truyền `bootstrapAdmin` (hoặc `TT_BOOTSTRAP_ADMIN_USER` / `TT_BOOTSTRAP_ADMIN_PASS`) khi khởi tạo server để xác thực lần cài đặt đầu tiên.
