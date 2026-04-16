# Facebook Photo Crawler

Crawl tất cả image URL từ trang photos Facebook của bạn, lưu realtime vào JSON.

## Cài đặt

```bash
npm install playwright uuid
npx playwright install chromium
```

## Chạy

```bash
node fb_photo_crawler.js
```

## Output

| File | Nội dung |
|------|----------|
| `fb_images.json` | Tất cả image URLs (lưu realtime) |
| `fb_errors.json` | Log lỗi nếu có |

### Cấu trúc `fb_images.json`
```json
[
  {
    "id": "uuid-v4",
    "name": "tên file ảnh",
    "url": "https://scontent.fbcdn.net/...",
    "status": "found",
    "index": 0
  }
]
```

## Cơ chế hoạt động

### Thu thập URL (2 lớp)
1. **Network intercept** — bắt ngay khi browser tải ảnh (realtime nhất)
2. **DOM scan** — quét `<img>` tags sau mỗi lần scroll

### Scroll loop
- Scroll `1.5x viewport` mỗi vòng, đợi `2.5s` để content load
- Phát hiện stuck: nếu `scrollHeight` không đổi **5 lần liên tiếp** → dừng
- Mỗi lần stuck sẽ đợi thêm `6s` trước khi kết luận

### Xử lý internet không ổn định
- Retry tự động **5 lần** với delay `5s` cho mọi network call
- Lỗi được ghi vào `fb_errors.json` kèm timestamp
- **Resume hỗ trợ**: nếu script bị crash, chạy lại sẽ tiếp tục từ chỗ dừng

### Login
Facebook yêu cầu đăng nhập. Script sẽ mở browser, bạn login thủ công, sau đó nhấn Enter để tiếp tục crawl.

## Config (đầu file)

```js
const SCROLL_PAUSE_MS = 2500;      // Đợi sau mỗi scroll
const MAX_STUCK_ROUNDS = 5;        // Số lần stuck trước khi dừng
const NETWORK_RETRY_LIMIT = 5;     // Số lần retry khi lỗi mạng
const HEADLESS = false;            // false = hiện browser, true = ẩn
```
