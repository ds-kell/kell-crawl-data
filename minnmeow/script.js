/**
 * E-Hentai Gallery Crawler
 *
 * Strategy: Mở từng trang ảnh, click nút #next để sang trang kế,
 * tải trực tiếp ảnh gốc (#img) và lưu vào folder.
 * - Lưu web_url để detect vòng lặp
 * - Resume được nếu chạy lại
 * - Lưu realtime từng ảnh
 * - Thử 5 lần mỗi URL, nếu không tìm được ảnh thì log và next
 *
 * Usage:
 *   node crawler.mjs
 *
 * Requirements:
 *   npm install playwright uuid
 *   npx playwright install chromium
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import https from 'https';

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TARGET_URL             = "https://e-hentai.org/s/ac70a18e9a/2583740-1";
const LAST_PHOTO_URL         = "https://e-hentai.org/s/f153aba71f/2583740-12";

const PHOTO_FOLDER           = "Mashu";
const OUTPUT_FILE            = "Mashu.json";
const ERROR_FILE             = "Mashu-error.json";

const HEADLESS               = false;
const PHOTO_WAIT_MS          = 1500;
const LOG_FILE               = "log.log";
const MAX_PAGE_RETRIES       = 5;   // Số lần thử lấy ảnh trước khi log và next
const NETWORK_RETRY_LIMIT    = 5;
const NETWORK_RETRY_DELAY_MS = 5000;
// ─────────────────────────────────────────────────────────────────────────────

if (!fs.existsSync(PHOTO_FOLDER)) {
  fs.mkdirSync(PHOTO_FOLDER, { recursive: true });
}

// ── Logger ────────────────────────────────────────────────────────────────────
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + "\n");
}

// ── State ─────────────────────────────────────────────────────────────────────
let collected   = {};
let seenWebUrls = new Set();
let errorLog    = [];
let globalIndex = 0;

// ── File helpers ──────────────────────────────────────────────────────────────
function saveAll() {
  const arr = Object.values(collected).sort((a, b) => a.index - b.index);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(arr, null, 2), "utf8");
}

function saveErrors() {
  fs.writeFileSync(ERROR_FILE, JSON.stringify(errorLog, null, 2), "utf8");
}

function logError(context, err) {
  const entry = {
    timestamp: new Date().toISOString(),
    context,
    message: err?.message || String(err),
  };
  errorLog.push(entry);
  saveErrors();
  log(`[ERROR] ${context}: ${entry.message}`);
}

// ── Resume support ────────────────────────────────────────────────────────────
function loadExisting() {
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));
      for (const item of arr) {
        collected[item.url] = item;
        if (item.web_url) seenWebUrls.add(item.web_url);
        if (item.index >= globalIndex) globalIndex = item.index + 1;
      }
      log(`[RESUME] Loaded ${arr.length} existing records.`);
    } catch (e) { logError("loadExisting", e); }
  }
  if (fs.existsSync(ERROR_FILE)) {
    try { errorLog = JSON.parse(fs.readFileSync(ERROR_FILE, "utf8")); }
    catch (e) { logError("loadExisting errorLog", e); }
  }
}

// ── Download ảnh ──────────────────────────────────────────────────────────────
async function downloadImage(imgUrl, webUrl) {
  const name     = path.basename(imgUrl.split("?")[0]) || `photo_${globalIndex}.jpg`;
  const filepath = path.join(PHOTO_FOLDER, name);

  if (fs.existsSync(filepath)) {
    log(`[SKIP-DOWNLOAD] File đã tồn tại: ${name}`);
    return name;
  }

  return new Promise((resolve, reject) => {
    https.get(imgUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const fileStream = fs.createWriteStream(filepath);
      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        log(`[DOWNLOADED] ${name} | ${webUrl}`);
        resolve(name);
      });
      fileStream.on('error', (err) => {
        fs.unlink(filepath, () => {});
        reject(err);
      });
    }).on('error', reject);
  });
}

// ── Ingest một ảnh ────────────────────────────────────────────────────────────
async function ingestOne(imgUrl, webUrl) {
  if (collected[imgUrl]) {
    log(`[SKIP-DUP] imgUrl đã tồn tại | web_url=${webUrl}`);
    return false;
  }
  try {
    const filename = await downloadImage(imgUrl, webUrl);
    collected[imgUrl] = {
      id:      uuidv4(),
      name:    filename,
      url:     imgUrl,
      web_url: webUrl,
      status:  "downloaded",
      index:   globalIndex++,
    };
    try { saveAll(); } catch (e) { logError(`saveAll index=${globalIndex}`, e); }
    log(`[+] #${globalIndex} | ${filename}`);
    return true;
  } catch (err) {
    logError(`downloadImage ${imgUrl}`, err);
    return false;
  }
}

// ── Lấy URL ảnh gốc từ #img ──────────────────────────────────────────────────
async function extractViewerImage(page) {
  return page.evaluate(() => {
    const img = document.querySelector("img#img");
    return img ? img.src : null;
  });
}

// ── Thử lấy ảnh: reload tối đa MAX_PAGE_RETRIES lần, trả null nếu thất bại ──
async function tryGetImage(page, webUrl) {
  for (let attempt = 1; attempt <= MAX_PAGE_RETRIES; attempt++) {
    let imgUrl = null;
    try { imgUrl = await extractViewerImage(page); } catch (e) {
      logError(`extractViewerImage attempt=${attempt} url=${webUrl}`, e);
    }
    if (imgUrl) return imgUrl;

    log(`[RETRY] Không tìm thấy ảnh, reload lần ${attempt}/${MAX_PAGE_RETRIES} | url=${webUrl}`);
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(PHOTO_WAIT_MS);
    } catch (e) {
      logError(`reload attempt=${attempt} url=${webUrl}`, e);
    }
  }

  // Hết lượt — log và trả null để caller next sang trang tiếp
  log(`[SKIP] Bỏ qua sau ${MAX_PAGE_RETRIES} lần thử | url=${webUrl}`);
  logError(`no image after ${MAX_PAGE_RETRIES} retries`, new Error(`url=${webUrl}`));
  return null;
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────
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

// ── Viewer crawl ──────────────────────────────────────────────────────────────
async function viewerCrawl(page) {
  log("[VIEWER] Bắt đầu crawl từ ảnh đầu tiên...");

  let round              = 0;
  let lastCollectedCount = 0;
  let stuckSinceRound    = 0;
  const MAX_STUCK_ROUNDS = 100;

  while (true) {
    round++;
    const webUrl = page.url();
    await page.waitForTimeout(PHOTO_WAIT_MS);

    if (seenWebUrls.has(webUrl)) {
      log(`[SKIP-SEEN] round=${round} url=${webUrl}`);
    } else {
      seenWebUrls.add(webUrl);

      // Thử lấy ảnh, tối đa MAX_PAGE_RETRIES lần reload; nếu vẫn null → next
      const imgUrl = await tryGetImage(page, webUrl);
      if (imgUrl) {
        await ingestOne(imgUrl, webUrl);
      }
      // Nếu imgUrl === null: đã log trong tryGetImage, tiếp tục next bình thường
    }

    // Kiểm tra ảnh cuối
    if (webUrl === LAST_PHOTO_URL) {
      log(`[VIEWER] Đã đến ảnh cuối cùng — dừng. Total: ${Object.keys(collected).length}`);
      break;
    }

    // Click next
    try {
      await page.click("a#next");
    } catch (e) {
      logError(`click #next round=${round}`, e);
      break;
    }

    // Chờ URL đổi
    const prevUrl        = webUrl;
    let   nextUrl        = prevUrl;
    const urlChangeDeadline = Date.now() + 5000;
    while (nextUrl === prevUrl && Date.now() < urlChangeDeadline) {
      await page.waitForTimeout(200);
      nextUrl = page.url();
    }

    if (nextUrl === prevUrl) {
      log(`[STUCK] URL không đổi sau click #next, tự reload...`);
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForTimeout(PHOTO_WAIT_MS);
        seenWebUrls.delete(prevUrl);
      } catch (e) { logError(`reload after stuck`, e); }
      continue;
    }

    if (round % 20 === 0) {
      log(`[VIEWER] Round ${round} | Collected: ${Object.keys(collected).length}`);
    }

    // Anti-stuck toàn cục
    const currentCount = Object.keys(collected).length;
    if (currentCount > lastCollectedCount) {
      lastCollectedCount = currentCount;
      stuckSinceRound    = round;
    } else if (round - stuckSinceRound >= MAX_STUCK_ROUNDS) {
      log(`[VIEWER] Không collect được ảnh mới trong ${MAX_STUCK_ROUNDS} round. Dừng.`);
      break;
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  loadExisting();

  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo:   50,
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport:  null,
    locale:    "vi-VN",
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();

  log(`\n${"═".repeat(60)}`);
  log(`  E-Hentai Gallery Crawler`);
  log(`  Target: ${TARGET_URL}`);
  log(`  Photo folder: ${PHOTO_FOLDER}`);
  log(`  Output: ${OUTPUT_FILE}`);
  log(`  Log:    ${LOG_FILE}`);
  log(`${"═".repeat(60)}`);

  log(`[NAV] Chuyển đến ${TARGET_URL} ...`);
  await withRetry(
    () => page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 }),
    "page.goto target"
  );
  await page.waitForTimeout(4000);

  try {
    await viewerCrawl(page);
  } catch (e) {
    logError("viewerCrawl fatal", e);
  }

  try { await browser.close(); } catch (e) { logError("browser.close", e); }

  const total = Object.keys(collected).length;
  log(`✅ Done! ${total} ảnh đã tải và lưu vào folder "${PHOTO_FOLDER}"`);
  if (errorLog.length > 0) log(`⚠️  ${errorLog.length} lỗi trong ${ERROR_FILE}`);
})();