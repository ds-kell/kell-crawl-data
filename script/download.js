/**
 * download.js — Tải ảnh từ fb_images_v2.json về folder photo/
 *
 * - Đọc tất cả record trong fb_images_v2.json
 * - Tải từng ảnh từ CDN URL (field "url") về photo/<index>_<name>
 * - Resume: bỏ qua ảnh đã tải rồi
 * - Ghi trạng thái vào download_status.json (success/failed)
 * - Concurrency: tải song song N ảnh cùng lúc
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const INPUT_FILE    = "fb_images_v2.json";
const PHOTO_DIR     = "photo";
const STATUS_FILE   = "download_status.json";
const LOG_FILE      = "download.log";
const CONCURRENCY   = 5;    // Số ảnh tải song song
const TIMEOUT_MS    = 30000; // 30s timeout mỗi ảnh
const MAX_RETRIES   = 3;
// ─────────────────────────────────────────────────────────────────────────────

const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + "\n");
}

// Load trạng thái đã tải
function loadStatus() {
  if (fs.existsSync(STATUS_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")); }
    catch (_) {}
  }
  return {};
}

function saveStatus(status) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), "utf8");
}

// Tải một URL về filePath
function downloadFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file  = fs.createWriteStream(filePath);
    const timer = setTimeout(() => {
      file.destroy();
      reject(new Error(`Timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    proto.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        clearTimeout(timer);
        file.destroy();
        // Follow redirect
        downloadFile(res.headers.location, filePath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        file.destroy();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => { clearTimeout(timer); file.close(); resolve(); });
      file.on("error", (e) => { clearTimeout(timer); reject(e); });
    }).on("error", (e) => { clearTimeout(timer); file.destroy(); reject(e); });
  });
}

async function downloadOne(item, status) {
  const { index, url, name } = item;
  const key = String(index);

  if (status[key] === "success") {
    // Kiểm tra file thực sự tồn tại
    const ext = path.extname(name) || ".jpg";
    const filename = `${String(index).padStart(5, "0")}_${name}`;
    const filePath = path.join(PHOTO_DIR, filename);
    if (fs.existsSync(filePath)) {
      log(`[SKIP] #${index} đã tải rồi`);
      return;
    }
  }

  const ext      = path.extname(name) || ".jpg";
  const filename = `${String(index).padStart(5, "0")}_${name}`;
  const filePath = path.join(PHOTO_DIR, filename);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await downloadFile(url, filePath);
      status[key] = "success";
      saveStatus(status);
      log(`[✓] #${index} ${filename}`);
      return;
    } catch (e) {
      log(`[WARN] #${index} attempt ${attempt}/${MAX_RETRIES} failed: ${e.message}`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath); // xóa file dở
      if (attempt === MAX_RETRIES) {
        status[key] = { result: "failed", error: e.message, url };
        saveStatus(status);
        log(`[✗] #${index} FAILED: ${e.message}`);
      } else {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
}

// Chạy tasks với concurrency giới hạn
async function runConcurrent(tasks, concurrency) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const task = tasks[i++];
      await task();
    }
  }
  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);
}

(async () => {
  if (!fs.existsSync(INPUT_FILE)) {
    log(`[ERROR] Không tìm thấy ${INPUT_FILE}`);
    process.exit(1);
  }

  const records = JSON.parse(fs.readFileSync(INPUT_FILE, "utf8"));
  log(`[LOAD] ${records.length} ảnh từ ${INPUT_FILE}`);

  if (!fs.existsSync(PHOTO_DIR)) {
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
    log(`[MKDIR] Tạo folder ${PHOTO_DIR}/`);
  }

  const status = loadStatus();

  const alreadyDone = Object.values(status).filter((v) => v === "success").length;
  log(`[RESUME] Đã tải trước đó: ${alreadyDone}/${records.length}`);

  const tasks = records.map((item) => () => downloadOne(item, status));

  log(`[START] Bắt đầu tải với concurrency=${CONCURRENCY}...`);
  await runConcurrent(tasks, CONCURRENCY);

  const successCount = Object.values(status).filter((v) => v === "success").length;
  const failCount    = Object.values(status).filter((v) => v?.result === "failed").length;

  log(`\n✅ Hoàn thành! Success: ${successCount} | Failed: ${failCount}`);
  if (failCount > 0) log(`   Xem chi tiết lỗi trong ${STATUS_FILE}`);
})();
