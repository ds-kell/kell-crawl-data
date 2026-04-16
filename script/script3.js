/**
 * script3.js — Crawl lại các ảnh bị lỗi trong fb_errors.json
 *
 * - Đọc fb_errors.json, lọc các entry có web_url (context "no image after retries")
 * - Mở từng URL, extract ảnh, insert vào đúng vị trí trong fb_images_v2.json
 * - Đánh dấu "retried": true / "retry_status": "success"|"failed" trong fb_errors.json
 * - Dừng khi hết danh sách
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const OUTPUT_FILE     = "fb_images_v2.json";
const ERROR_FILE      = "fb_errors.json";
const LOG_FILE        = "fb_crawl3.log";
const HEADLESS        = false;
const LOGIN_WAIT_MS   = 300000;
const PHOTO_WAIT_MS   = 2000;
const MAX_PAGE_RETRIES       = 3;
const NETWORK_RETRY_LIMIT    = 3;
const NETWORK_RETRY_DELAY_MS = 5000;
// ─────────────────────────────────────────────────────────────────────────────

const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + "\n");
}

let collected   = {};  // imgUrl → record
let errorLog    = [];
let globalIndex = 0;

function saveAll() {
  const arr = Object.values(collected).sort((a, b) => a.index - b.index);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(arr, null, 2), "utf8");
}

function saveErrors() {
  fs.writeFileSync(ERROR_FILE, JSON.stringify(errorLog, null, 2), "utf8");
}

function logError(context, err) {
  const entry = { timestamp: new Date().toISOString(), context, message: err?.message || String(err) };
  errorLog.push(entry);
  saveErrors();
  log(`[ERROR] ${context}: ${entry.message}`);
}

function loadExisting() {
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));
      for (const item of arr) {
        collected[item.url] = item;
        if (item.index >= globalIndex) globalIndex = item.index + 1;
      }
      log(`[LOAD] Loaded ${arr.length} existing records.`);
    } catch (e) { logError("loadExisting", e); }
  }
  if (fs.existsSync(ERROR_FILE)) {
    try { errorLog = JSON.parse(fs.readFileSync(ERROR_FILE, "utf8")); }
    catch (e) { logError("loadExisting errorLog", e); }
  }
}

// Lấy index phù hợp để insert: dựa vào web_url của ảnh trước/sau trong collected
function findInsertIndex(webUrl) {
  // Tìm trong collected xem có ảnh nào có web_url gần nhất không
  // Fallback: append cuối
  const arr = Object.values(collected).sort((a, b) => a.index - b.index);
  // Tìm ảnh liền trước theo thứ tự album (không có cách chắc chắn nếu không biết thứ tự)
  // → dùng globalIndex (append cuối), caller có thể sort lại sau
  return globalIndex;
}

function ingestAtUrl(imgUrl, webUrl) {
  if (collected[imgUrl]) {
    log(`[SKIP-DUP] imgUrl đã tồn tại | web_url=${webUrl}`);
    return false;
  }
  const insertIdx = findInsertIndex(webUrl);
  const name = path.basename(imgUrl.split("?")[0]) || `photo_${insertIdx}`;
  collected[imgUrl] = { id: uuidv4(), name, url: imgUrl, web_url: webUrl, status: "found", index: insertIdx };
  globalIndex = Math.max(globalIndex, insertIdx + 1);
  try { saveAll(); } catch (e) { logError(`saveAll index=${insertIdx}`, e); }
  log(`[+] Inserted index=${insertIdx} | ${name}`);
  return true;
}

async function extractViewerImage(page) {
  return page.evaluate(() => {
    const mediaImgs = [...document.querySelectorAll('img[data-visualcompletion="media-vc-image"]')];
    const allImgs = [...document.querySelectorAll("img")].filter((img) => {
      const src = img.src || "";
      return (
        (src.includes("scontent") || src.includes("fbcdn")) &&
        !src.includes("emoji") &&
        !src.includes("rsrc.php") &&
        !/stp=.*p\d{2,3}x\d{2,3}/.test(src)
      );
    });
    const candidates = mediaImgs.length ? mediaImgs : allImgs;
    if (!candidates.length) return null;
    candidates.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
    try {
      const u = new URL(candidates[0].src);
      u.searchParams.delete("stp");
      return u.toString();
    } catch (e) {
      console.error("[extractViewerImage] Failed to parse URL:", candidates[0].src, e?.message);
      return candidates[0].src;
    }
  });
}

async function withRetry(fn, label, retries = NETWORK_RETRY_LIMIT) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try { return await fn(); } catch (e) {
      logError(`${label} attempt ${attempt}`, e);
      if (attempt < retries) {
        log(`[RETRY] Waiting ${NETWORK_RETRY_DELAY_MS / 1000}s...`);
        await new Promise((r) => setTimeout(r, NETWORK_RETRY_DELAY_MS));
      } else { throw e; }
    }
  }
}

// Lấy danh sách web_url cần retry từ errorLog (chưa retry thành công)
function getPendingUrls() {
  const seen = new Set();
  const pending = [];
  for (const entry of errorLog) {
    if (entry.retried === true && entry.retry_status === "success") continue;
    // Parse web_url từ message "url=https://..."
    const match = entry.message && entry.message.match(/url=(https?:\/\/\S+)/);
    if (!match) continue;
    const webUrl = match[1];
    if (seen.has(webUrl)) continue;
    seen.add(webUrl);
    pending.push({ webUrl, entry });
  }
  log(`[LOAD] ${pending.length} URL cần retry từ ${ERROR_FILE}`);
  return pending;
}

async function retryOne(page, webUrl) {
  log(`[RETRY-URL] Navigating to ${webUrl}`);
  try {
    await page.goto(webUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    logError(`goto ${webUrl}`, e);
    return false;
  }
  await page.waitForTimeout(PHOTO_WAIT_MS);

  let imgUrl = null;
  for (let attempt = 1; attempt <= MAX_PAGE_RETRIES + 1; attempt++) {
    try { imgUrl = await extractViewerImage(page); } catch (e) {
      logError(`extractViewerImage attempt=${attempt} url=${webUrl}`, e);
    }
    if (imgUrl) break;
    if (attempt <= MAX_PAGE_RETRIES) {
      log(`[RETRY] Không tìm thấy ảnh, reload lần ${attempt} | url=${webUrl}`);
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForTimeout(PHOTO_WAIT_MS);
      } catch (e) { logError(`reload attempt=${attempt} url=${webUrl}`, e); }
    }
  }

  if (imgUrl) {
    ingestAtUrl(imgUrl, webUrl);
    return true;
  } else {
    log(`[FAIL] Vẫn không lấy được ảnh sau ${MAX_PAGE_RETRIES} lần | url=${webUrl}`);
    return false;
  }
}

(async () => {
  loadExisting();

  const pending = getPendingUrls();
  if (!pending.length) {
    log("✅ Không có URL nào cần retry. Thoát.");
    process.exit(0);
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: 50,
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: null,
    locale: "vi-VN",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();

  log(`\n${"═".repeat(60)}`);
  log(`  Facebook Photo Crawler — script3 (retry errors)`);
  log(`  Pending: ${pending.length} URLs`);
  log(`  Output:  ${OUTPUT_FILE}`);
  log(`${"═".repeat(60)}`);

  await withRetry(
    () => page.goto("https://www.facebook.com/login", { waitUntil: "domcontentloaded", timeout: 60000 }),
    "page.goto login"
  );

  log("⚠️  ĐĂNG NHẬP: Điền email/password trong cửa sổ trình duyệt.");
  log(`   Script chờ tối đa ${LOGIN_WAIT_MS / 60000} phút. Nhấn Enter khi xong.`);

  await Promise.race([
    new Promise((resolve) => process.stdin.once("data", resolve)),
    page.waitForTimeout(LOGIN_WAIT_MS),
  ]);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < pending.length; i++) {
    const { webUrl, entry } = pending[i];
    log(`[${i + 1}/${pending.length}] ${webUrl}`);

    const ok = await retryOne(page, webUrl);

    // Đánh dấu tất cả entries có cùng web_url này
    for (const e of errorLog) {
      const match = e.message && e.message.match(/url=(https?:\/\/\S+)/);
      if (match && match[1] === webUrl) {
        e.retried = true;
        e.retry_status = ok ? "success" : "failed";
        e.retried_at = new Date().toISOString();
      }
    }
    saveErrors();

    if (ok) successCount++; else failCount++;
  }

  try { await browser.close(); } catch (e) { logError("browser.close", e); }

  log(`✅ Done! Success: ${successCount} | Failed: ${failCount}`);
  log(`   Kết quả lưu vào ${OUTPUT_FILE} và ${ERROR_FILE}`);
})();
