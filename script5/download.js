/**
 * Download ảnh đã crawl về folder photo/
 *
 * - Đọc fb_user_images.json (output của crawl.js)
 * - Tải song song nhiều ảnh, có retry + timeout
 * - Resume: bỏ qua ảnh đã tải thành công
 * - Ghi trạng thái vào download_status.json
 *
 * Usage:
 *   node script5/download.js
 *   INPUT_FILE=fb_user_images.json CONCURRENCY=8 node script5/download.js
 *
 * Lưu ý: URL CDN của Facebook có hạn (tham số `oe=`), nên tải sớm sau khi crawl.
 * Nếu gặp HTTP 403/410, chạy lại crawl.js để lấy URL mới.
 */

import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
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
const PHOTO_DIR = process.env.PHOTO_DIR || path.join(BASE_DIR, "photo");
const STATUS_FILE =
  process.env.STATUS_FILE || path.join(BASE_DIR, "download_status.json");
const LOG_FILE = process.env.LOG_FILE || path.join(BASE_DIR, "download.log");
const CONCURRENCY = Number(
  process.env.DOWNLOAD_CONCURRENCY || process.env.CONCURRENCY || 5
);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 30_000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const MAX_REDIRECTS = 5;
const PHOTO_USE_PROFILE_DIR = process.env.PHOTO_USE_PROFILE_DIR === "1";
const REPAIR_URLS = process.env.REPAIR_URLS !== "0";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
// ─────────────────────────────────────────────────────────────────────────────

function ensureParent(file) {
  const dir = path.dirname(file);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
}

ensureParent(LOG_FILE);
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

let currentItems = null;
let itemsSaveTimer = null;
let repairHintLogged = false;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + "\n");
}

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    log(`[WARN] Không đọc được ${file}: ${e.message}`);
    return fallback;
  }
}

function saveStatus(status) {
  ensureParent(STATUS_FILE);
  const tmp = `${STATUS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2), "utf8");
  fs.renameSync(tmp, STATUS_FILE);
}

function hasStpParam(rawUrl) {
  try {
    return new URL(rawUrl).searchParams.has("stp");
  } catch {
    return false;
  }
}

// Chèn stp vào ĐẦU query, giữ nguyên toàn bộ query cũ.
// Facebook ký oh= trên đúng chuỗi query, nên chỉ thêm stp mới có thể khôi phục URL cũ.
function addStpParam(rawUrl, stp = "dst-jpg_tt6") {
  const qIndex = rawUrl.indexOf("?");
  if (qIndex === -1) return `${rawUrl}?stp=${stp}`;
  return `${rawUrl.slice(0, qIndex + 1)}stp=${stp}&${rawUrl.slice(qIndex + 1)}`;
}

function probeUrl(url) {
  return new Promise((resolve) => {
    let proto;
    try {
      proto = new URL(url).protocol === "http:" ? http : https;
    } catch {
      return resolve(false);
    }

    const req = proto.request(
      url,
      {
        method: "HEAD",
        headers: {
          "User-Agent": USER_AGENT,
          Referer: "https://www.facebook.com/",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
        },
      },
      (res) => {
        res.resume();
        resolve((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300);
      }
    );
    req.setTimeout(15_000, () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(false));
    req.end();
  });
}

function saveItemsNow() {
  if (!currentItems) return;
  ensureParent(INPUT_FILE);
  const tmp = `${INPUT_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(currentItems, null, 2), "utf8");
  fs.renameSync(tmp, INPUT_FILE);
}

function scheduleSaveItems() {
  if (itemsSaveTimer) return;
  itemsSaveTimer = setTimeout(() => {
    itemsSaveTimer = null;
    try {
      saveItemsNow();
    } catch (e) {
      log(`[WARN] Không ghi được ${INPUT_FILE}: ${e.message}`);
    }
  }, 1_000);
}

async function maybeRepairUrl(item) {
  if (!REPAIR_URLS || !item?.is_original || !item.url) return false;
  if (hasStpParam(item.url)) return false;

  const candidate = addStpParam(item.url);
  const ok = await probeUrl(candidate);
  if (!ok) {
    log(
      `[FIX] [${profileFolder(item)}] #${item.index} URL cũ vẫn lỗi, cần chạy: REFRESH_INVALID_URLS=1 node script5/fetch-originals.js`
    );
    return false;
  }

  const old = item.url;
  item.url = candidate;
  item.url_repaired = true;
  item.url_repaired_at = new Date().toISOString();
  item.url_before_repair = old;
  scheduleSaveItems();
  log(`[FIX] [${profileFolder(item)}] #${item.index} đã khôi phục chữ ký URL`);
  return true;
}

function sanitizeName(name) {
  return String(name || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function fileNameFor(item) {
  const index = String(item.index ?? 0).padStart(5, "0");
  let name = sanitizeName(item.name);

  if (!name) {
    try {
      name = path.posix.basename(new URL(item.url).pathname);
    } catch {
      name = `photo_${index}.jpg`;
    }
  }
  if (!path.extname(name)) name += ".jpg";

  return `${index}_${name}`;
}

function profileFolder(item) {
  return sanitizeName(item.profile || "default").replace(/\.+/g, "_") || "default";
}

// ── Tải 1 file, follow redirect ───────────────────────────────────────────────
function downloadFile(url, filePath, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(value);
    };

    let proto;
    try {
      proto = new URL(url).protocol === "http:" ? http : https;
    } catch (e) {
      return finish(e);
    }

    const req = proto.get(
      url,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Referer: "https://www.facebook.com/",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
        },
      },
      (res) => {
        const status = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          if (redirectsLeft <= 0) {
            return finish(new Error("Quá nhiều redirect"));
          }
          const location = res.headers.location;
          if (!location) return finish(new Error("Redirect thiếu Location"));
          const nextUrl = new URL(location, url).toString();
          return downloadFile(nextUrl, filePath, redirectsLeft - 1).then(
            (v) => finish(null, v),
            (e) => finish(e)
          );
        }

        if (status !== 200) {
          res.resume();
          return finish(new Error(`HTTP ${status}`));
        }

        ensureParent(filePath);
        const file = fs.createWriteStream(filePath);
        let bytes = 0;

        res.on("data", (chunk) => {
          bytes += chunk.length;
        });

        res.on("error", (e) => {
          file.destroy();
          fs.rm(filePath, { force: true }, () => finish(e));
        });

        file.on("error", (e) => {
          res.destroy();
          fs.rm(filePath, { force: true }, () => finish(e));
        });

        file.on("finish", () => {
          file.close(() => {
            if (bytes === 0) {
              fs.rm(filePath, { force: true }, () =>
                finish(new Error("File rỗng (0 byte)"))
              );
              return;
            }
            finish(null, bytes);
          });
        });

        res.pipe(file);
      }
    );

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error(`Timeout ${TIMEOUT_MS}ms`));
    });

    req.on("error", (e) => {
      fs.rm(filePath, { force: true }, () => finish(e));
    });
  });
}

async function downloadOne(item, status) {
  const profile = profileFolder(item);
  const subDir = PHOTO_USE_PROFILE_DIR ? profile : "";
  const key = `${profile}:${item.index ?? item.url}`;
  const filename = fileNameFor(item);
  const filePath = path.join(PHOTO_DIR, subDir, filename);

  if (status[key]?.result === "success" && fs.existsSync(filePath)) {
    log(`[SKIP] [${profile}] #${item.index} đã tải rồi`);
    return "skipped";
  }

  await maybeRepairUrl(item);

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const bytes = await downloadFile(item.url, filePath);
      status[key] = {
        result: "success",
        file: filePath,
        bytes,
        timestamp: new Date().toISOString(),
      };
      saveStatus(status);
      log(
        `[✓] [${profile}] #${item.index} ${filename} (${Math.round(bytes / 1024)} KB)`
      );
      return "success";
    } catch (e) {
      lastError = e;
      log(`[WARN] [${profile}] #${item.index} attempt ${attempt}/${MAX_RETRIES}: ${e.message}`);
      fs.rmSync(filePath, { force: true });
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }
  }

  status[key] = {
    result: "failed",
    file: filePath,
    error: lastError?.message || "unknown",
    url: item.url,
    timestamp: new Date().toISOString(),
  };
  saveStatus(status);
  log(`[✗] [${profile}] #${item.index} FAILED: ${status[key].error}`);

  if (!repairHintLogged && /HTTP (403|410)/.test(status[key].error)) {
    repairHintLogged = true;
    log(
      "[HINT] Gặp 403/410: URL có thể đã hết hạn hoặc không khôi phục được. " +
        "Chạy: REFRESH_INVALID_URLS=1 node script5/fetch-originals.js rồi download lại."
    );
  }

  return "failed";
}

async function runConcurrent(tasks, concurrency) {
  let cursor = 0;
  const results = { success: 0, failed: 0, skipped: 0 };

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      const result = await tasks[i]();
      results[result] = (results[result] || 0) + 1;
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
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
  console.log(`  Download Facebook Photos — ${files.length} profile`);
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
      PHOTO_DIR: path.join(dir, "photo"),
      STATUS_FILE: path.join(dir, "download_status.json"),
      LOG_FILE: path.join(dir, "download.log"),
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

  currentItems = loadJson(INPUT_FILE, []);
  const items = currentItems;
  if (!Array.isArray(items) || items.length === 0) {
    console.error(`${INPUT_FILE} rỗng hoặc sai định dạng.`);
    process.exit(1);
  }

  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const status = loadJson(STATUS_FILE, {});

  log("═".repeat(60));
  log(`  Download Facebook Photos`);
  log(`  Input:       ${INPUT_FILE} (${items.length} ảnh)`);
  log(`  Photo dir:   ${PHOTO_DIR}`);
  log(`  Concurrency: ${CONCURRENCY}`);
  log("═".repeat(60));

  const tasks = items.map((item) => () => downloadOne(item, status));
  const results = await runConcurrent(tasks, CONCURRENCY);

  log("─".repeat(60));
  log(
    `✅ Xong! success=${results.success}, skipped=${results.skipped}, failed=${results.failed}`
  );
  log(`   Ảnh nằm trong: ${PHOTO_DIR}/`);
  log(`   Trạng thái:    ${STATUS_FILE}`);

  if (itemsSaveTimer) {
    clearTimeout(itemsSaveTimer);
    itemsSaveTimer = null;
  }
  saveItemsNow();

  await new Promise((resolve) => logStream.end(resolve));
}

main().catch(async (e) => {
  console.error(e);
  log(`[FATAL] ${e?.stack || e}`);
  await new Promise((resolve) => logStream.end(resolve));
  process.exitCode = 1;
});
