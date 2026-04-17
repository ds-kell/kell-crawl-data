/**
 * E-Hentai Gallery Crawler
 *
 * Strategy: Mở từng trang ảnh, click nút #next để sang trang kế, lưu URL ảnh gốc (#img).
 * - Lưu web_url để detect vòng lặp (khi next về ảnh đầu tiên thì dừng)
 * - Resume được nếu chạy lại
 * - Lưu realtime từng ảnh
 *
 * Usage:
 *   node script.js
 *
 * Requirements:
 *   npm install playwright uuid
 *   npx playwright install chromium
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TARGET_URL        = "https://e-hentai.org/s/14cef5ae9a/2917545-1";
const FIRST_PHOTO_URL   = "https://e-hentai.org/s/14cef5ae9a/2917545-1";
const LAST_PHOTO_URL    = "https://e-hentai.org/s/e0f25470eb/2917545-1348";
const OUTPUT_FILE       = "fb_images_v2.json";
const ERROR_FILE        = "fb_errors.json";
const HEADLESS          = false;
const PHOTO_WAIT_MS     = 1500;     // Chờ sau mỗi lần next ảnh
const LOG_FILE          = "fb_crawl.log";
const MAX_PAGE_RETRIES  = 5;        // Số lần reload nếu không tìm thấy ảnh
const NETWORK_RETRY_LIMIT      = 5;
const NETWORK_RETRY_DELAY_MS   = 5000;
// ─────────────────────────────────────────────────────────────────────────────

// ── Logger ghi ra file + console ─────────────────────────────────────────────
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + "\n");
}

// ── State ─────────────────────────────────────────────────────────────────────
let collected    = {};        // imgUrl → record
let seenWebUrls  = new Set(); // web_url đã thấy để detect vòng lặp
let errorLog     = [];
let globalIndex  = 0;

// ── File helpers ──────────────────────────────────────────────────────────────
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
      console.log(`[RESUME] Loaded ${arr.length} existing records.`);
    } catch (e) { logError("loadExisting", e); }
  }
  if (fs.existsSync(ERROR_FILE)) {
    try { errorLog = JSON.parse(fs.readFileSync(ERROR_FILE, "utf8")); } catch (e) { logError("loadExisting errorLog", e); }
  }
}

// ── Ingest một ảnh ────────────────────────────────────────────────────────────
function ingestOne(imgUrl, webUrl) {
  if (collected[imgUrl]) {
    log(`[SKIP-DUP] imgUrl đã tồn tại | web_url=${webUrl} | img=${imgUrl.slice(0, 80)}...`);
    return false;
  }
  const name = path.basename(imgUrl.split("?")[0]) || `photo_${globalIndex}`;
  collected[imgUrl] = { id: uuidv4(), name, url: imgUrl, web_url: webUrl, status: "found", index: globalIndex++ };
  try { saveAll(); } catch (e) { logError(`saveAll index=${globalIndex}`, e); }
  log(`[+] #${globalIndex} | ${name}`);
  return true;
}

// ── Lấy URL ảnh gốc từ #img ──────────────────────────────────────────────────
async function extractViewerImage(page) {
  return page.evaluate(() => {
    const img = document.querySelector("img#img");
    return img ? img.src : null;
  });
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

// ── Viewer crawl: bắt đầu từ URL ảnh đầu tiên, click #next từng bước ─────────
async function viewerCrawl(page) {
  log("[VIEWER] Bắt đầu crawl từ ảnh đầu tiên...");
  await page.waitForTimeout(2000);

  let round = 0;
  let lastCollectedCount = 0;
  let stuckSinceRound = 0;
  const MAX_STUCK_ROUNDS = 100;

  while (true) {
    round++;
    const webUrl = page.url();

    // Chờ ảnh render xong
    await page.waitForTimeout(PHOTO_WAIT_MS);

    // Lấy ảnh, nếu thất bại thì reload tối đa MAX_PAGE_RETRIES lần
    if (seenWebUrls.has(webUrl)) {
      log(`[SKIP-SEEN] round=${round} url=${webUrl}`);
    } else {
      seenWebUrls.add(webUrl);

      let imgUrl = null;
      for (let attempt = 1; attempt <= MAX_PAGE_RETRIES + 1; attempt++) {
        try { imgUrl = await extractViewerImage(page); } catch (e) {
          logError(`extractViewerImage round=${round} attempt=${attempt} url=${webUrl}`, e);
        }
        if (imgUrl) break;

        if (attempt <= MAX_PAGE_RETRIES) {
          log(`[RETRY] Không tìm thấy ảnh, reload lần ${attempt} | url=${webUrl}`);
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.waitForTimeout(PHOTO_WAIT_MS);
        }
      }

      if (imgUrl) {
        ingestOne(imgUrl, webUrl);
      } else {
        log(`[SKIP] Bỏ qua sau ${MAX_PAGE_RETRIES} lần reload | round=${round} | url=${webUrl}`);
        logError(`no image after retries round=${round}`, new Error(`url=${webUrl}`));
      }
    }

    // Dừng nếu đây là trang cuối
    if (webUrl === LAST_PHOTO_URL) {
      log(`[VIEWER] Đã đến ảnh cuối cùng — dừng. Total: ${Object.keys(collected).length}`);
      break;
    }

    // Next ảnh: click nút #next
    try {
      await page.click("a#next");
    } catch (e) {
      logError(`click #next round=${round} url=${webUrl}`, e);
      break;
    }

    // Chờ URL thực sự thay đổi (tối đa 5s), nếu không đổi thì tự reload
    const prevUrl = webUrl;
    let nextUrl = prevUrl;
    const urlChangeDeadline = Date.now() + 5000;
    while (nextUrl === prevUrl && Date.now() < urlChangeDeadline) {
      await page.waitForTimeout(200);
      nextUrl = page.url();
    }

    if (nextUrl === prevUrl) {
      log(`[STUCK] URL không đổi sau click #next round=${round}, tự reload...`);
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForTimeout(PHOTO_WAIT_MS);
        seenWebUrls.delete(prevUrl);
      } catch (e) {
        logError(`reload after stuck round=${round}`, e);
      }
      continue;
    }

    if (round % 20 === 0) {
      log(`[VIEWER] Round ${round} | Collected: ${Object.keys(collected).length}`);
    }

    // Detect loop: nếu quá nhiều round không collect được ảnh mới thì dừng
    const currentCount = Object.keys(collected).length;
    if (currentCount > lastCollectedCount) {
      lastCollectedCount = currentCount;
      stuckSinceRound = round;
    } else if (round - stuckSinceRound >= MAX_STUCK_ROUNDS) {
      log(`[VIEWER] Không collect được ảnh mới trong ${MAX_STUCK_ROUNDS} round liên tiếp (từ round ${stuckSinceRound}). Dừng.`);
      break;
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  loadExisting();

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
  log(`  E-Hentai Gallery Crawler`);
  log(`  Target: ${TARGET_URL}`);
  log(`  Output: ${OUTPUT_FILE}`);
  log(`  Log:    ${LOG_FILE}`);
  log(`${"═".repeat(60)}`);

  // ── STEP 1: Vào trang ảnh đầu tiên (không cần login) ───────────────────────
  log(`[NAV] Chuyển đến ${TARGET_URL} ...`);
  await withRetry(
    () => page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 }),
    "page.goto target"
  );
  await page.waitForTimeout(4000);

  // ── STEP 2: Crawl từng ảnh ─────────────────────────────────────────────────
  try {
    await viewerCrawl(page);
  } catch (e) {
    logError("viewerCrawl fatal", e);
  }

  // ── STEP 3: Done ────────────────────────────────────────────────────────────
  try { await browser.close(); } catch (e) { logError("browser.close", e); }

  const total = Object.keys(collected).length;
  log(`✅ Done! ${total} ảnh đã lưu vào ${OUTPUT_FILE}`);
  if (errorLog.length > 0) log(`⚠️  ${errorLog.length} lỗi trong ${ERROR_FILE}`);
})();
