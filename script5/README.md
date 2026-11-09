# Facebook User Photos Crawler (script5)

Crawl **ảnh trên tab Photos của một hoặc nhiều tài khoản Facebook**, lấy **ảnh gốc chất lượng cao**, rồi tải về máy.

Quy trình 3 bước:

1. **`crawl.js`** — scroll grid từng profile để lấy toàn bộ ảnh + link từng photo page (`web_url`).
2. **`fetch-originals.js`** — mở lại từng photo page, lấy URL ảnh gốc trong viewer và ghi đè vào JSON.
3. **`download.js`** — tải ảnh gốc về `script5/data/<profile>/photo/`.

Cách crawl ở bước 1 đúng như README gốc mô tả:

- **Network intercept** — bắt ảnh ngay khi browser tải từ Facebook CDN.
- **DOM scan** — quét `<img>` và `background-image` sau mỗi lần scroll.
- **Scroll loop** — cuộn từng bước, dừng khi nhiều vòng liên tiếp không có ảnh mới.

Ngoài ra:

- Lưu **realtime** vào JSON (debounce 1s, ghi atomic).
- **Resume** được ở cả 3 bước.
- Dùng **persistent profile** → chỉ cần login Facebook một lần.
- Bước lấy ảnh gốc chạy song song nhiều page và tự dừng nếu bị checkpoint.

---

## 1. Cấu hình nhiều link Photos

Có 3 cách, chọn 1:

### Cách A — sửa `script5/profiles.txt` (khuyến nghị)

Mỗi dòng một link:

```text
https://www.facebook.com/genkosama/photos
https://www.facebook.com/account2/photos
https://www.facebook.com/profile.php?id=123456789&sk=photos_by
```

Dòng bắt đầu bằng `#` bị bỏ qua.

### Cách B — truyền link trực tiếp

```bash
node script5/crawl.js \
  "https://www.facebook.com/genkosama/photos" \
  "https://www.facebook.com/account2/photos"
```

### Cách C — biến môi trường

```bash
PHOTOS_URLS="url1,url2,url3" node script5/crawl.js
```

### Cách D — file `.env` (tiện nhất)

```bash
cp script5/.env.example script5/.env
# sửa script5/.env
node script5/crawl.js
```

Script tự đọc `script5/.env`. Biến truyền từ shell/CLI vẫn ưu tiên hơn file `.env`.
File `.env` đã được thêm vào `.gitignore`.

> Nếu có link ở CLI hoặc `PHOTOS_URLS`, script dùng danh sách đó và **bỏ qua** `profiles.txt`.
> Nếu không truyền gì, script đọc `profiles.txt`; nếu file rỗng thì dùng profile mặc định
> `https://www.facebook.com/genkosama/photos`.

Cách lấy link:

1. Vào Facebook → trang cá nhân.
2. Chọn tab **Photos** (hoặc **Ảnh**).
3. Copy URL trên thanh địa chỉ.

Các dạng URL hợp lệ:

```
https://www.facebook.com/username/photos
https://www.facebook.com/username/photos_by
https://www.facebook.com/profile.php?id=123456789&sk=photos_by
```

Nếu chỉ đưa link profile (`https://www.facebook.com/username`), script tự thêm `/photos`.

> `photos_by` = ảnh **tài khoản đăng**. Nếu muốn ảnh **được tag**, dùng `photos_of`.
>
> Mặc định script bỏ qua ảnh có `set=t.<uid>` (ảnh được gắn thẻ bởi người khác).
> Muốn lấy cả ảnh được tag: `INCLUDE_TAGGED=1 node script5/crawl.js`.

---

## 2. Crawl danh sách ảnh

Chạy từ thư mục gốc repo:

```bash
node script5/crawl.js
```

Script lần lượt crawl từng profile trong danh sách. Lần đầu sẽ mở browser và chờ bạn login Facebook thủ công.
Login xong **nhấn Enter** trong terminal (hoặc chờ tối đa 5 phút).

> **Nên đăng nhập** để Facebook trả đủ danh sách ảnh. Nếu không login, profile public
> thường chỉ hiện một phần ảnh rồi dừng. Nếu chỉ muốn lấy phần public:
> `FORCE_LOGIN=0 node script5/crawl.js`.

Các lần sau session được lưu trong `script5/.fb-profile/` nên không cần login lại.

### Output — mỗi profile một thư mục riêng

Ví dụ có 3 link:

```text
script5/data/genkosama/
  fb_user_images.json
  fb_user_errors.json
  fb_user_crawl.log

script5/data/account2/
  fb_user_images.json
  ...

script5/data/account3/
  fb_user_images.json
  ...
```

| File | Nội dung |
|------|----------|
| `script5/data/<profile>/fb_user_images.json` | Ảnh của riêng profile đó |
| `script5/data/<profile>/fb_user_errors.json` | Log lỗi của profile đó |
| `script5/data/<profile>/fb_user_crawl.log` | Log crawl của profile đó |
| `script5/.fb-profile/` | Session Facebook dùng chung (đừng commit) |

Cấu trúc JSON:

```json
[
  {
    "id": "uuid-v4",
    "name": "671720572_10215390629475070_..._n.jpg",
    "url": "https://scontent...fbcdn.net/v/t39.30808-6/...jpg?...",
    "web_url": "https://www.facebook.com/photo/?fbid=10215390629475070&set=pb...",
    "profile": "genkosama",
    "profile_url": "https://www.facebook.com/genkosama/photos",
    "source": "dom",
    "status": "found",
    "index": 0,
    "width": 600,
    "height": 600,
    "bytes": 48213
  }
]
```

### Check trùng

Mỗi file có 3 lớp chống trùng:

1. **Theo tên file ảnh** — bỏ toàn bộ query `?stp=...&_nc_...`, nên các biến thể kích thước của cùng một ảnh chỉ lấy 1.
2. **Theo `fbid` / photo id trong `web_url`** — hai URL khác tên file nhưng cùng `fbid` cũng bị gộp.
3. **Khi resume** — đọc lại JSON cũ, record nào đã có thì bỏ qua; record trùng trong file cũ cũng tự bị loại.

Nếu cùng một ảnh có nhiều biến thể, script giữ URL chất lượng cao hơn. Với ảnh gốc, script **giữ nguyên `stp`** vì chữ ký `oh=` của Facebook được tính trên đúng query string.

> Dữ liệu cũ `script5/fb_user_images.json` (nếu có) sẽ tự được migrate sang
> `script5/data/<profile đầu tiên>/fb_user_images.json`. File cũ vẫn được giữ lại để backup.
> Muốn chỉ chạy migrate mà không crawl: `MIGRATE_ONLY=1 node script5/crawl.js`.

---

## 3. Lấy ảnh gốc chất lượng cao

```bash
node script5/fetch-originals.js
```

Script tự tìm **tất cả** `script5/data/*/fb_user_images.json` và chạy lần lượt từng profile.

Script mở lại từng `web_url`, tìm ảnh chính trong photo viewer và cập nhật lại record. Script **giữ nguyên URL gốc**, không xoá `stp`, vì Facebook ký chữ ký `oh=` trên đúng query string — xoá `stp` sẽ bị `403 URL signature mismatch`.

```json
{
  "url": "https://scontent...fbcdn.net/v/t39.30808-6/...jpg?...",
  "thumbnail_url": "https://scontent...fbcdn.net/v/...stp=dst-jpg_s600x600...",
  "is_original": true,
  "original_status": "success",
  "original_width": 1080,
  "original_height": 1350,
  "original_at": "2026-11-05T..."
}
```

- `url` bây giờ là **ảnh gốc**; `thumbnail_url` giữ lại bản grid để đối chiếu.
- Mặc định chạy **2 page song song**. Tăng bằng `ORIGINALS_CONCURRENCY=3` nếu mạng tốt.
- Record đã `original_status: "success"` sẽ được bỏ qua khi chạy lại.
- Nếu bị login/checkpoint, script tự dừng. Đăng nhập lại rồi chạy tiếp — resume sẽ làm phần còn lại.

Muốn lấy lại **tất cả** (kể cả ảnh đã success):

```bash
REFRESH_ORIGINALS=1 node script5/fetch-originals.js
```

Log: `script5/data/<profile>/fb_originals.log`, lỗi: `script5/data/<profile>/fb_originals_errors.json`.

### Record bị `skipped`

`fetch-originals.js` chỉ bỏ qua record `success`; record `skipped` và `failed` sẽ được thử lại.

Tuy nhiên `skipped` hiện tại nghĩa là **record không có `web_url`** — không có photo page để mở.
Chạy lại `fetch-originals.js` sẽ skip tiếp. Cần scan lại grid để bổ sung `web_url`:

```bash
FILL_WEB_URLS_ONLY=1 node script5/crawl.js
```

Mode này:

- Chỉ cập nhật `web_url` cho record đã có.
- **Không thêm ảnh mới**.
- Bỏ qua profile không có record nào thiếu `web_url`.
- Tự dừng sớm khi đã bổ sung đủ.

Sau đó chạy lại:

```bash
node script5/fetch-originals.js
node script5/download.js
```

Một số ảnh avatar / ảnh bìa / icon (ví dụ file `.webp`) sẽ không bao giờ có `web_url` vì không nằm trong grid ảnh. Chúng sẽ tiếp tục `skipped` — có thể xoá khỏi JSON nếu không cần.

---

## 4. Tải ảnh về máy

```bash
node script5/download.js
```

Ảnh được lưu vào `script5/data/<profile>/photo/`, tên dạng:

```
script5/data/genkosama/photo/00000_671720572_10215390629475070_..._n.jpg
script5/data/account2/photo/00000_...
```

- Tải song song 5 ảnh (đổi bằng `DOWNLOAD_CONCURRENCY=8`).
- Tự bỏ qua ảnh đã tải thành công.
- Trạng thái ghi vào `script5/data/<profile>/download_status.json`.
- Có retry + timeout.

> ⚠️ URL CDN của Facebook có hạn (`oe=` trong query). Nên tải ngay sau khi lấy ảnh gốc.
>
> `download.js` tự phát hiện URL cũ bị mất `stp` và tự thêm lại `stp=dst-jpg_tt6`
> để khôi phục chữ ký `oh=`. Nếu vẫn gặp `HTTP 403` / `HTTP 410`:
>
> ```bash
> REFRESH_INVALID_URLS=1 node script5/fetch-originals.js
> node script5/download.js
> ```

---

## 5. Config nâng cao (biến môi trường)

### crawl.js

| Biến | Mặc định | Ý nghĩa |
|------|----------|---------|
| `PHOTOS_URLS` | đọc `profiles.txt` | Nhiều link, cách nhau dấu phẩy hoặc xuống dòng |
| `PHOTOS_URL` | — | Một link duy nhất |
| `PROFILES_FILE` | `script5/profiles.txt` | File chứa danh sách link |
| `DATA_DIR` | `script5/data` | Thư mục gốc chứa file của từng profile |
| `OUTPUT_FILE` | `script5/data/<profile>/fb_user_images.json` | File JSON của từng profile |
| `HEADLESS` | `0` | `1` = ẩn browser |
| `SCROLL_PAUSE_MS` | `4000` | Chờ sau mỗi lần scroll |
| `SCROLL_STEP_RATIO` | `0.75` | Mỗi lần cuộn bao nhiêu phần viewport |
| `IMAGE_SETTLE_MS` | `1200` | Chờ thêm khi phát hiện ảnh mới (để ảnh tải xong) |
| `IMAGE_LOAD_TIMEOUT_MS` | `5000` | Chờ tối đa để ảnh trong viewport tải xong |
| `MAX_STUCK_ROUNDS` | `6` | Số vòng không ảnh mới thì dừng |
| `STUCK_EXTRA_WAIT_MS` | `8000` | Chờ thêm khi bị stuck |
| `MIN_IMAGE_SIZE` | `200` | Bỏ ảnh nhỏ hơn N px (avatar/icon) |
| `MIN_IMAGE_BYTES` | `15000` | Bỏ ảnh nhẹ hơn N byte |
| `INCLUDE_TAGGED` | `0` | `1` = lấy cả ảnh được gắn thẻ (`set=t.`) |
| `FILL_WEB_URLS_ONLY` | `0` | `1` = chỉ bổ sung `web_url`, không thêm ảnh mới |
| `FORCE_LOGIN` | `1` | `0` = bỏ qua login nếu profile đang public |
| `NO_PERSISTENT_PROFILE` | `0` | `1` = không lưu session |
| `PROFILE_DIR` | `script5/.fb-profile` | Nơi lưu session |
| `LOGIN_WAIT_MS` | `300000` | Thời gian chờ login tối đa |

### fetch-originals.js

| Biến | Mặc định | Ý nghĩa |
|------|----------|---------|
| `ORIGINALS_CONCURRENCY` | `2` | Số photo page mở song song |
| `VIEWER_WAIT_MS` | `1800` | Chờ ảnh viewer render |
| `VIEWER_PAUSE_MS` | `700` | Nghỉ giữa 2 ảnh trên mỗi page |
| `VIEWER_RETRIES` | `3` | Số lần thử lại mỗi ảnh |
| `RETRY_DELAY_MS` | `3000` | Chờ trước khi retry |
| `REFRESH_ORIGINALS` | `0` | `1` = lấy lại cả ảnh đã success |
| `REFRESH_INVALID_URLS` | `0` | `1` = chỉ lấy lại record có URL bị mất `stp` / chữ ký lỗi |
| `SKIP_LOGIN` | `0` | `1` = không chờ login (chỉ dùng cho nội dung public) |

### download.js

| Biến | Mặc định | Ý nghĩa |
|------|----------|---------|
| `DOWNLOAD_CONCURRENCY` | `5` | Số ảnh tải song song |
| `TIMEOUT_MS` | `30000` | Timeout mỗi ảnh |
| `MAX_RETRIES` | `3` | Số lần thử lại |
| `REPAIR_URLS` | `1` | Tự khôi phục URL cũ bị mất `stp` trước khi tải |
| `PHOTO_DIR` | `script5/data/<profile>/photo` | Thư mục lưu ảnh |
| `STATUS_FILE` | `script5/data/<profile>/download_status.json` | File trạng thái tải |

> Có thể đặt tất cả biến trên trong `script5/.env`.
> Xem file mẫu [`script5/.env.example`](.env.example).

Ví dụ crawl chậm và kỹ hơn khi mạng yếu:

```bash
SCROLL_PAUSE_MS=6000 IMAGE_SETTLE_MS=2000 MAX_STUCK_ROUNDS=12 node script5/crawl.js
```

---

## 6. Lưu ý

- Script dùng browser thật (không headless mặc định) để giảm bị Facebook chặn.
- Tất cả profile trong danh sách phải xem được bằng **cùng một tài khoản đang login**.
  Nếu mỗi tài khoản cần login riêng, chạy riêng với `PROFILE_DIR` khác nhau, ví dụ:
  `PROFILE_DIR=script5/.fb-profile-acc2 node script5/crawl.js "https://facebook.com/acc2/photos"`.
- Không nên chạy quá nhanh: `SCROLL_PAUSE_MS` / `ORIGINALS_CONCURRENCY` / `DOWNLOAD_CONCURRENCY` quá cao dễ bị checkpoint.
  Mặc định mới đã khá chậm (4s/lần scroll + đợi ảnh tải xong). Nếu mạng yếu, tăng thêm
  `SCROLL_PAUSE_MS` và `IMAGE_LOAD_TIMEOUT_MS`.
- Bước `fetch-originals.js` chậm hơn crawl grid vì phải mở từng photo viewer.
  Với ~1.000 ảnh và `ORIGINALS_CONCURRENCY=2`, thời gian thường khoảng 30–60 phút tuỳ mạng.
- Có thể lẫn vài ảnh avatar / ảnh bìa vì chúng cũng nằm trên CDN. Xoá vài record lạ trong JSON là được.
- Nếu ảnh bị thiếu:
  - tăng `MAX_STUCK_ROUNDS` và `STUCK_EXTRA_WAIT_MS`;
  - chạy lại `crawl.js` (resume sẽ bổ sung ảnh mới);
  - chạy lại `fetch-originals.js` (chỉ xử lý ảnh chưa success);
  - kiểm tra `fb_user_errors.json` và `fb_originals_errors.json`.
- Chỉ dùng cho ảnh của chính bạn hoặc khi được phép.
