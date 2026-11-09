/**
 * fetch-originals.js — Lấy URL ảnh GỐC từ từng photo viewer
 *
 * Crawl.js chỉ lấy ảnh trong grid (thường 600–960px).
 * Script này mở lại từng `web_url` trong JSON, đọc ảnh chính trong viewer,
 * bỏ tham số `stp` (resize) và ghi URL gốc trở lại record.
 *
 * - Resume: record có original_status = "success" sẽ được bỏ qua
 * - Chạy song song nhiều page (mặc định 2) để nhanh hơn
 * - Tự dừng nếu Facebook bắt login/checkpoint
 *
 * Usage:
 *   node script5/fetch-originals.js
 *   CONCURRENCY=3 node script5/fetch-originals.js
 *   REFRESH_ORIGINALS=1 node script5/fetch-originals.js   # lấy lại tất cả
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));

// Tự đọc script5/.env nếu có (Node 22+). Biến môi trường truyền từ shell vẫn ưu tiên hơn.
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(path.join(BASE_DIR, ".env"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.warn(`[ENV] Không đọc được .env: ${e.message}`);
    }
  }
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const INPUT_FILE =
  process.env.INPUT_FILE || path.join(BASE_DIR, "fb_user_images.json");
const DATA_DIR = process.env.DATA_DIR || path.join(BASE_DIR, "data");
const LOG_FILE =
  process.env.LOG_FILE || path.join(BASE_DIR, "fb_originals.log");
const ERROR_FILE =
  process.env.ERROR_FILE || path.join(BASE_DIR, "fb_originals_errors.json");
const PROFILE_DIR =
  process.env.PROFILE_DIR || path.join(BASE_DIR, ".fb-profile");
const USE_PERSISTENT_PROFILE = process.env.NO_PERSISTENT_PROFILE !== "1";

const HEADLESS = process.env.HEADLESS === "1";
const LOGIN_URL = process.env.LOGIN_URL || "https://www.facebook.com/";
const LOGIN_WAIT_MS = Number(process.env.LOGIN_WAIT_MS || 300_000);

const CONCURRENCY = Number(
  process.env.ORIGINALS_CONCURRENCY || process.env.CONCURRENCY || 2
);
const VIEWER_WAIT_MS = Number(process.env.VIEWER_WAIT_MS || 1_800);
const VIEWER_PAUSE_MS = Number(process.env.VIEWER_PAUSE_MS || 700);
const VIEWER_RETRIES = Number(process.env.VIEWER_RETRIES || 3);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 3_000);
const PAGE_TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS || 60_000);
const SAVE_DEBOUNCE_MS = Number(process.env.SAVE_DEBOUNCE_MS || 1_000);
const REFRESH_ORIGINALS = process.env.REFRESH_ORIGINALS === "1";
const REFRESH_INVALID_URLS = process.env.REFRESH_INVALID_URLS === "1";
const SKIP_LOGIN = process.env.SKIP_LOGIN === "1";
// ─────────────────────────────────────────────────────────────────────────────

// ── Logger ────────────────────────────────────────────────────────────────────
function ensureParent(file) {
  const dir = path.dirname(file);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
}

ensureParent(LOG_FILE);
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + "\n");
}

// ── State ─────────────────────────────────────────────────────────────────────
/** @type {object[]} */
let records = [];
let errorLog = [];
let saveTimer = null;
let cursor = 0;
let aborted = false;
const stats = { success: 0, failed: 0, skipped: 0, already: 0 };

// ── File helpers ──────────────────────────────────────────────────────────────
function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    logError("loadJson", e);
    return fallback;
  }
}

function saveAll() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  ensureParent(INPUT_FILE);
  const tmp = `${INPUT_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), "utf8");
  fs.renameSync(tmp, INPUT_FILE);
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      saveAll();
    } catch (e) {
      logError("saveAll", e);
    }
  }, SAVE_DEBOUNCE_MS);
}

function saveErrors() {
  ensureParent(ERROR_FILE);
  const tmp = `${ERROR_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(errorLog, null, 2), "utf8");
  fs.renameSync(tmp, ERROR_FILE);
}

function logError(context, err) {
  const entry = {
    timestamp: new Date().toISOString(),
    context,
    message: err?.message || String(err),
  };
  errorLog.push(entry);
  try {
    saveErrors();
  } catch (_) {}
  log(`[ERROR] ${context}: ${entry.message}`);
}

// ── URL helpers ───────────────────────────────────────────────────────────────
function fbidOf(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.searchParams.get("fbid") || u.searchParams.get("story_fbid") || null;
  } catch {
    return null;
  }
}

function canonicalPhotoUrl(rawUrl) {
  try {
    if (!isFacebookHost(new URL(rawUrl).hostname)) return null;
  } catch {
    return null;
  }
  const fbid = fbidOf(rawUrl);
  return fbid ? `https://www.facebook.com/photo/?fbid=${fbid}` : null;
}

function isAuthUrl(rawUrl) {
  return /\/(login|checkpoint|recover)/i.test(rawUrl);
}

function isFacebookHost(host) {
  const h = (host || "").toLowerCase();
  return h === "facebook.com" || h.endsWith(".facebook.com");
}

function hasStpParam(rawUrl) {
  try {
    return new URL(rawUrl).searchParams.has("stp");
  } catch {
    return false;
  }
}

function needsFetch(record) {
  if (REFRESH_ORIGINALS) return true;
  if (!record || record.original_status !== "success") return true;
  // URL cũ bị xoá stp -> chữ ký oh= không còn hợp lệ
  if (
    REFRESH_INVALID_URLS &&
    record.is_original &&
    record.url &&
    !hasStpParam(record.url)
  ) {
    return true;
  }
  return false;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
class AuthError extends Error {}

function waitForEnterOrTimeout(ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      process.stdin.removeListener("data", onData);
      resolve();
    };
    const onData = () => finish();
    process.stdin.once("data", onData);
    setTimeout(finish, ms).unref?.();
  });
}

async function needsLogin(page) {
  if (SKIP_LOGIN) return false;
  if (!isFacebookHost(new URL(page.url()).hostname)) return false;
  if (isAuthUrl(page.url())) return true;

  try {
    const cookies = await page.context().cookies();
    if (cookies.some((c) => c.name === "c_user" && c.value)) return false;
  } catch (_) {}

  try {
    return (await page.locator('input[name="email"]').count()) > 0;
  } catch {
    return false;
  }
}

async function ensureLogin(context) {
  if (SKIP_LOGIN) return;
  const page = await context.newPage();
  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    await page.waitForTimeout(2_000);

    if (await needsLogin(page)) {
      log("─".repeat(60));
      log("[LOGIN] Session Facebook chưa đăng nhập (hoặc đã hết hạn).");
      log("[LOGIN] Đăng nhập trong cửa sổ browser vừa mở.");
      log(`[LOGIN] Xong thì nhấn Enter (hoặc chờ tối đa ${LOGIN_WAIT_MS / 60_000} phút).`);
      log("─".repeat(60));
      await waitForEnterOrTimeout(LOGIN_WAIT_MS);
    }
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Extract ảnh gốc từ viewer ─────────────────────────────────────────────────
async function extractViewerImage(page) {
  return page.evaluate(() => {
    const mediaImgs = [
      ...document.querySelectorAll('img[data-visualcompletion="media-vc-image"]'),
    ];

    const allImgs = [...document.querySelectorAll("img")].filter((img) => {
      const src = img.currentSrc || img.src || "";
      return (
        (src.includes("scontent") || src.includes("fbcdn")) &&
        !src.includes("emoji") &&
        !src.includes("rsrc.php")
      );
    });

    const candidates = mediaImgs.length ? mediaImgs : allImgs;
    const usable = candidates.filter(
      (img) => (img.naturalWidth || 0) > 0 && (img.naturalHeight || 0) > 0
    );
    const list = usable.length ? usable : candidates;

    if (!list.length) {
      // Fallback: og:image thường trỏ đúng ảnh của photo page hiện tại
      const og = document.querySelector('meta[property="og:image"]')?.content || "";
      if (og.includes("fbcdn") || og.includes("scontent")) {
        return { url: og, width: 0, height: 0 };
      }
      return null;
    }

    list.sort(
      (a, b) =>
        (b.naturalWidth || 0) * (b.naturalHeight || 0) -
        (a.naturalWidth || 0) * (a.naturalHeight || 0)
    );

    const best = list[0];
    // Giữ nguyên URL gốc, KHÔNG xoá stp: chữ ký oh= của Facebook
    // được tính trên đúng query string này. Xoá stp sẽ bị 403
    // "URL signature mismatch".
    const url = best.currentSrc || best.src;

    return {
      url,
      width: best.naturalWidth || 0,
      height: best.naturalHeight || 0,
    };
  });
}

async function processRecord(page, rec) {
  const targetFbid = fbidOf(rec.web_url);
  const urls = [rec.web_url];
  const canonical = canonicalPhotoUrl(rec.web_url);
  if (canonical && canonical !== rec.web_url) urls.push(canonical);

  let lastError = null;

  for (let attempt = 1; attempt <= VIEWER_RETRIES; attempt++) {
    const targetUrl = urls[(attempt - 1) % urls.length];

    try {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT_MS,
      });

      if (isAuthUrl(page.url())) {
        throw new AuthError("Facebook yêu cầu đăng nhập/checkpoint");
      }

      await page.waitForTimeout(VIEWER_WAIT_MS);

      if (isAuthUrl(page.url())) {
        throw new AuthError("Facebook yêu cầu đăng nhập/checkpoint");
      }

      const currentFbid = fbidOf(page.url());
      if (targetFbid && currentFbid && targetFbid !== currentFbid) {
        throw new Error(`Mở nhầm ảnh: ${currentFbid} != ${targetFbid}`);
      }

      await page
        .waitForSelector('img[data-visualcompletion="media-vc-image"]', {
          timeout: 5_000,
        })
        .catch(() => {});

      const result = await extractViewerImage(page);
      if (!result?.url) throw new Error("Không tìm thấy ảnh trong viewer");

      return result;
    } catch (e) {
      if (e instanceof AuthError) throw e;
      lastError = e;
      log(
        `[WARN] [${rec.profile || "default"}] #${rec.index} attempt ${attempt}/${VIEWER_RETRIES}: ${e.message}`
      );
      if (attempt < VIEWER_RETRIES) {
        await page.waitForTimeout(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError || new Error("Không lấy được ảnh gốc");
}

// ── Update record ─────────────────────────────────────────────────────────────
function markSuccess(rec, result) {
  rec.thumbnail_url = rec.thumbnail_url || rec.url;
  rec.url = result.url;
  rec.is_original = true;
  rec.original_status = "success";
  rec.original_width = result.width || rec.original_width || null;
  rec.original_height = result.height || rec.original_height || null;
  rec.original_at = new Date().toISOString();
  delete rec.original_error;
  stats.success++;
}

function markFailed(rec, err) {
  rec.original_status = "failed";
  rec.original_error = err?.message || String(err);
  rec.original_at = new Date().toISOString();
  stats.failed++;
  logError(`original index=${rec.index}`, err);
}

function markSkipped(rec, reason) {
  rec.original_status = "skipped";
  rec.original_error = reason;
  rec.original_at = new Date().toISOString();
  stats.skipped++;
  log(`[SKIP] [${rec.profile || "default"}] #${rec.index}: ${reason}`);
}

// ── Worker ────────────────────────────────────────────────────────────────────
async function worker(context, workerId) {
  let page = await context.newPage();

  try {
    while (!aborted) {
      const i = cursor++;
      if (i >= records.length) break;

      const rec = records[i];
      if (!rec || !rec.url) continue;

      if (!needsFetch(rec)) {
        stats.already++;
        continue;
      }

      if (!rec.web_url) {
        markSkipped(rec, "Không có web_url — chỉ tải được thumbnail");
        scheduleSave();
        continue;
      }

      if (page.isClosed()) page = await context.newPage();

      try {
        const result = await processRecord(page, rec);
        markSuccess(rec, result);
        scheduleSave();
        log(
          `[✓] [${rec.profile || "default"}] #${rec.index} ${rec.name} (${result.width}x${result.height}) | worker=${workerId}`
        );
      } catch (e) {
        if (e instanceof AuthError) {
          aborted = true;
          logError("auth", e);
          log("[AUTH] Dừng. Đăng nhập lại rồi chạy lại script (resume sẽ tiếp tục).");
          break;
        }
        markFailed(rec, e);
        scheduleSave();
      }

      const processed = stats.success + stats.failed + stats.skipped;
      if (processed % 25 === 0) {
        log(
          `[ORIGINALS] success=${stats.success}, failed=${stats.failed}, skipped=${stats.skipped}, already=${stats.already}`
        );
      }

      await page.waitForTimeout(VIEWER_PAUSE_MS);
    }
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Orchestrator: chạy lần lượt từng profile trong data/ ─────────────────────
const SELF_FILE = fileURLToPath(import.meta.url);

function discoverDataFiles() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(DATA_DIR, entry.name, "fb_user_images.json"))
    .filter((file) => fs.existsSync(file))
    .sort();
}

function spawnNode(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env,
      stdio: "inherit",
    });
    child.on("error", (err) => {
      console.error(`[ORCH] Không chạy được ${script}: ${err.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function runAllFiles(files) {
  console.log("═".repeat(60));
  console.log(`  Fetch Originals — ${files.length} profile`);
  console.log(`  Data dir: ${DATA_DIR}`);
  console.log("═".repeat(60));

  let failed = 0;

  for (const file of files) {
    const dir = path.dirname(file);
    console.log("\n" + "─".repeat(60));
    console.log(`[ORCH] Profile: ${path.basename(dir)}`);
    console.log(`[ORCH] File: ${file}`);
    console.log("─".repeat(60));

    const code = await spawnNode(SELF_FILE, {
      ...process.env,
      SINGLE_FILE_RUN: "1",
      INPUT_FILE: file,
      LOG_FILE: path.join(dir, "fb_originals.log"),
      ERROR_FILE: path.join(dir, "fb_originals_errors.json"),
    });

    if (code !== 0) {
      failed++;
      console.error(`[ORCH] ${path.basename(dir)} lỗi exit ${code}`);
    }
  }

  console.log("\n" + "═".repeat(60));
  console.log(`[ORCH] Hoàn tất ${files.length - failed}/${files.length} profile.`);
  if (failed > 0) process.exitCode = 1;
  logStream.end();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Nếu không chỉ định INPUT_FILE, tự chạy tất cả profile trong data/
  if (process.env.SINGLE_FILE_RUN !== "1" && !process.env.INPUT_FILE) {
    const files = discoverDataFiles();
    if (files.length > 0) {
      await runAllFiles(files);
      return;
    }
  }

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`Không thấy ${INPUT_FILE}. Chạy crawl.js trước.`);
    process.exit(1);
  }

  records = loadJson(INPUT_FILE, null);
  if (!Array.isArray(records) || records.length === 0) {
    console.error(`${INPUT_FILE} rỗng hoặc sai định dạng.`);
    process.exit(1);
  }

  errorLog = loadJson(ERROR_FILE, []);
  if (!Array.isArray(errorLog)) errorLog = [];

  const pending = records.filter(needsFetch);
  const withWebUrl = pending.filter((r) => r.web_url).length;

  log("═".repeat(60));
  log("  Facebook Originals Fetcher");
  log(`  Input:       ${INPUT_FILE} (${records.length} ảnh)`);
  log(`  Cần xử lý:   ${pending.length} ảnh (${withWebUrl} có web_url)`);
  log(`  Concurrency: ${CONCURRENCY}`);
  log(`  Output:      ${INPUT_FILE} (cập nhật trực tiếp)`);
  log("═".repeat(60));

  let context;
  let browser = null;

  const launchOptions = {
    headless: HEADLESS,
    slowMo: 20,
    args: ["--disable-blink-features=AutomationControlled", "--start-maximized"],
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    locale: "vi-VN",
    viewport: null,
  };

  if (USE_PERSISTENT_PROFILE) {
    ensureParent(path.join(PROFILE_DIR, "x"));
    context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
  } else {
    browser = await chromium.launch({ headless: HEADLESS, slowMo: 20, args: launchOptions.args });
    context = await browser.newContext({
      userAgent: launchOptions.userAgent,
      locale: launchOptions.locale,
      viewport: { width: 1280, height: 900 },
    });
  }

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  try {
    await ensureLogin(context);

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, Math.max(1, pending.length)) },
      (_, i) => worker(context, i + 1)
    );
    await Promise.all(workers);
  } catch (e) {
    logError("main", e);
  } finally {
    saveAll();
    log("─".repeat(60));
    log(
      `✅ Xong! success=${stats.success}, failed=${stats.failed}, skipped=${stats.skipped}, already=${stats.already}`
    );
    if (aborted) {
      log("⚠️  Bị dừng giữa chừng do login/checkpoint. Chạy lại script sau khi đăng nhập.");
    }
    if (errorLog.length > 0) {
      log(`⚠️  ${errorLog.length} lỗi trong ${ERROR_FILE}`);
    }

    await context.close();
    if (browser) await browser.close();
    await new Promise((resolve) => logStream.end(resolve));
  }
}

main().catch(async (e) => {
  console.error(e);
  try {
    logError("fatal", e);
    saveAll();
  } catch (_) {}
  await new Promise((resolve) => logStream.end(resolve));
  process.exitCode = 1;
});
