/**
 * Facebook User Photos Crawler (scroll-based)
 *
 * Mục tiêu: crawl toàn bộ URL ảnh trên tab Photos của một user Facebook.
 *
 * Cơ chế (giống mô tả trong README cũ):
 *   1. Network intercept — bắt ảnh ngay khi browser tải từ CDN
 *   2. DOM scan — quét <img> + background-image sau mỗi lần scroll
 *   3. Scroll loop — cuộn từng bước, dừng khi hết ảnh mới
 *
 * Đặc điểm:
 *   - Lưu realtime vào JSON (debounce 1s, ghi atomic)
 *   - Resume được nếu crash / tắt giữa chừng
 *   - Dùng persistent profile để chỉ cần login Facebook một lần
 *
 * Usage:
 *   node script5/crawl.js
 *   node script5/crawl.js <url1> <url2> ...
 *   PHOTOS_URLS="url1,url2" node script5/crawl.js
 *   # hoặc thêm từng dòng vào script5/profiles.txt
 *
 * Requirements (đã có ở package.json gốc):
 *   npm install playwright uuid
 *   npx playwright install chromium
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

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
// Có thể nhập nhiều link theo 1 trong các cách:
//   node script5/crawl.js <url1> <url2> ...
//   PHOTOS_URLS="url1,url2" node script5/crawl.js
//   thêm từng dòng vào script5/profiles.txt
//
// Nếu không truyền gì, dùng DEFAULT_PHOTOS_URL bên dưới.
const DEFAULT_PHOTOS_URL = "https://www.facebook.com/genkosama/photos";
const PROFILES_FILE =
  process.env.PROFILES_FILE || path.join(BASE_DIR, "profiles.txt");

const OUTPUT_FILE =
  process.env.OUTPUT_FILE || path.join(BASE_DIR, "fb_user_images.json");
const ERROR_FILE =
  process.env.ERROR_FILE || path.join(BASE_DIR, "fb_user_errors.json");
const LOG_FILE =
  process.env.LOG_FILE || path.join(BASE_DIR, "fb_user_crawl.log");
const PROFILE_DIR =
  process.env.PROFILE_DIR || path.join(BASE_DIR, ".fb-profile");
const DATA_DIR = process.env.DATA_DIR || path.join(BASE_DIR, "data");
const USE_PERSISTENT_PROFILE = process.env.NO_PERSISTENT_PROFILE !== "1";

const HEADLESS = process.env.HEADLESS === "1";
const LOGIN_WAIT_MS = Number(process.env.LOGIN_WAIT_MS || 300_000); // 5 phút
const SCROLL_PAUSE_MS = Number(process.env.SCROLL_PAUSE_MS || 4_000);
const SCROLL_STEP_RATIO = Number(process.env.SCROLL_STEP_RATIO || 0.75);
const IMAGE_SETTLE_MS = Number(process.env.IMAGE_SETTLE_MS || 1_200);
const IMAGE_LOAD_TIMEOUT_MS = Number(process.env.IMAGE_LOAD_TIMEOUT_MS || 5_000);
const STUCK_EXTRA_WAIT_MS = Number(process.env.STUCK_EXTRA_WAIT_MS || 8_000);
const MAX_STUCK_ROUNDS = Number(process.env.MAX_STUCK_ROUNDS || 6);
const MAX_SCROLL_ROUNDS = Number(process.env.MAX_SCROLL_ROUNDS || 3_000);
const SAVE_DEBOUNCE_MS = Number(process.env.SAVE_DEBOUNCE_MS || 1_000);

// Mặc định chỉ lấy ảnh do acc đăng, bỏ ảnh "được gắn thẻ" (set=t.<uid>).
const INCLUDE_TAGGED = process.env.INCLUDE_TAGGED === "1";

// Chỉ scan grid để bổ sung web_url cho record đã có, không thêm ảnh mới.
const FILL_WEB_URLS_ONLY = process.env.FILL_WEB_URLS_ONLY === "1";

// Mặc định chờ login để lấy đủ ảnh. Đặt FORCE_LOGIN=0 để bỏ qua nếu profile public.
const FORCE_LOGIN = process.env.FORCE_LOGIN !== "0";

// Ảnh nhỏ hơn (px) hoặc nhẹ hơn (byte) thường là avatar/icon, không phải ảnh album.
// Đặt 0 để tắt filter (hữu ích khi test).
const MIN_IMAGE_SIZE = Number(process.env.MIN_IMAGE_SIZE || 200);
const MIN_IMAGE_BYTES = Number(process.env.MIN_IMAGE_BYTES || 15_000);

// Thêm host CDN khác nếu Facebook đổi domain (cách nhau bởi dấu phẩy).
const EXTRA_IMAGE_HOSTS = (process.env.EXTRA_IMAGE_HOSTS || "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

// Chỉ dùng cho test / host khác Facebook (cách nhau bởi dấu phẩy).
const EXTRA_PAGE_HOSTS = (process.env.EXTRA_PAGE_HOSTS || "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
// ─────────────────────────────────────────────────────────────────────────────

// ── Logger ────────────────────────────────────────────────────────────────────
ensureParent(LOG_FILE);
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + "\n");
}

function ensureParent(file) {
  const dir = path.dirname(file);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
}

// ── State ─────────────────────────────────────────────────────────────────────
/** @type {Map<string, object>} key = tên file ảnh (đã bỏ query) */
const collected = new Map();
/** @type {Map<string, string>} web_key (fbid/photo id) -> key trong collected */
const webUrlToKey = new Map();
/** @type {Map<string, number>} đếm số ảnh theo profile slug */
const profileCounts = new Map();
let errorLog = [];
let nextIndex = 0;
let saveTimer = null;
/** @type {Set<string> | null} key các ảnh đang thiếu web_url khi FILL_WEB_URLS_ONLY */
let fillTargets = null;
let filledCount = 0;
/** @type {{slug: string, url: string} | null} */
let currentProfile = null;

// ── File helpers ──────────────────────────────────────────────────────────────
function saveAll() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const arr = [...collected.values()].sort((a, b) => a.index - b.index);
  ensureParent(OUTPUT_FILE);
  const tmp = `${OUTPUT_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), "utf8");
  fs.renameSync(tmp, OUTPUT_FILE);
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

// ── Resume ────────────────────────────────────────────────────────────────────
function mergeDuplicate(target, incoming) {
  if (!target.web_url && incoming.web_url) target.web_url = incoming.web_url;

  const targetArea = (target.width || 0) * (target.height || 0);
  const incomingArea = (incoming.width || 0) * (incoming.height || 0);
  if (incomingArea > targetArea) {
    target.width = incoming.width;
    target.height = incoming.height;
  }

  if (incoming.is_original && !target.is_original) {
    target.url = incoming.url;
    target.name = incoming.name || target.name;
    target.is_original = true;
    target.original_status = incoming.original_status;
    target.original_width = incoming.original_width;
    target.original_height = incoming.original_height;
    target.original_at = incoming.original_at;
    target.thumbnail_url = incoming.thumbnail_url;
  }

  if (
    typeof incoming.index === "number" &&
    (typeof target.index !== "number" || incoming.index < target.index)
  ) {
    target.index = incoming.index;
  }
}

function loadExisting(profiles = []) {
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));
      const shouldMigrate =
        arr.length > 0 && arr.every((item) => item && !item.profile) && profiles.length > 0;

      if (shouldMigrate) {
        const first = profiles[0];
        log(`[MIGRATE] Gán ${arr.length} record cũ cho profile "${first.slug}"`);
      }

      let duplicates = 0;

      for (const item of arr) {
        if (!item || !item.url) continue;

        if (typeof item.index === "number" && item.index >= nextIndex) {
          nextIndex = item.index + 1;
        }

        if (shouldMigrate) {
          item.profile = profiles[0].slug;
          item.profile_url = profiles[0].url;
        }
        if (!item.profile) item.profile = "default";

        const key = keyOf(item.url);
        const webKey = webKeyOf(item.web_url);
        const existingKey =
          (collected.has(key) && key) ||
          (webKey && webUrlToKey.has(webKey) && webUrlToKey.get(webKey)) ||
          null;

        if (existingKey) {
          mergeDuplicate(collected.get(existingKey), item);
          duplicates++;
          continue;
        }

        collected.set(key, item);
        if (webKey) webUrlToKey.set(webKey, key);
        profileCounts.set(
          item.profile,
          (profileCounts.get(item.profile) || 0) + 1
        );
      }
      log(
        `[RESUME] Đã nạp ${collected.size} ảnh từ ${OUTPUT_FILE}` +
          (duplicates ? ` (bỏ qua ${duplicates} record trùng)` : "")
      );

      if (FILL_WEB_URLS_ONLY) {
        fillTargets = new Set(
          [...collected.values()]
            .filter((record) => !record.web_url)
            .map((record) => keyOf(record.url))
        );
        log(
          `[FILL] Cần bổ sung web_url cho ${fillTargets.size} ảnh (không thêm ảnh mới).`
        );
      }
    } catch (e) {
      logError("loadExisting", e);
    }
  }

  if (fs.existsSync(ERROR_FILE)) {
    try {
      errorLog = JSON.parse(fs.readFileSync(ERROR_FILE, "utf8"));
      if (!Array.isArray(errorLog)) errorLog = [];
    } catch (e) {
      logError("loadExisting errors", e);
    }
  }
}

// ── URL helpers ───────────────────────────────────────────────────────────────
function isFacebookHost(host) {
  const h = host.toLowerCase();
  return h === "facebook.com" || h.endsWith(".facebook.com");
}

function normalizeProfileUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.hostname === "m.facebook.com" || u.hostname === "web.facebook.com") {
    u.hostname = "www.facebook.com";
  }

  const isExtraHost = EXTRA_PAGE_HOSTS.some(
    (h) => u.hostname.toLowerCase() === h || u.hostname.toLowerCase().endsWith(`.${h}`)
  );

  if (!isFacebookHost(u.hostname)) {
    if (!isExtraHost) return null;
    u.hash = "";
    return u.toString();
  }

  if (/\/(photo|photo\.php|permalink\.php|watch|reel|story\.php)\b/i.test(u.pathname)) {
    return null;
  }
  if (u.pathname === "/" || u.pathname === "") return null;

  u.hash = "";
  const lastSegment = u.pathname.split("/").filter(Boolean).pop() || "";
  const hasPhotosTab =
    /^photos(_by|_of)?$/i.test(lastSegment) ||
    (u.searchParams.get("sk") || "").startsWith("photos");

  if (hasPhotosTab) return u.toString();

  if (u.pathname === "/profile.php") {
    u.searchParams.set("sk", "photos");
    return u.toString();
  }

  u.pathname = u.pathname.replace(/\/+$/, "") + "/photos";
  return u.toString();
}

function sanitizeSlug(value) {
  return (
    String(value || "")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "profile"
  );
}

function profileSlug(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.pathname === "/profile.php") {
      return sanitizeSlug(`id_${u.searchParams.get("id") || "unknown"}`);
    }
    const parts = u.pathname
      .split("/")
      .filter(Boolean)
      .filter((p) => !/^photos(_by|_of)?$/i.test(p));
    return sanitizeSlug(parts[parts.length - 1] || "profile");
  } catch {
    return "profile";
  }
}

function readProfilesFile(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function resolveProfiles() {
  // Chế độ do orchestrator spawn: chỉ xử lý đúng 1 link
  if (process.env.SINGLE_PROFILE_RUN === "1" && process.env.PHOTOS_URL) {
    const url = normalizeProfileUrl(process.env.PHOTOS_URL);
    if (!url) return [];
    return [
      {
        url,
        slug: sanitizeSlug(process.env.PROFILE_SLUG || profileSlug(url)),
      },
    ];
  }

  const cliUrls = process.argv.slice(2).filter((arg) => /^https?:\/\//i.test(arg));
  const envUrls = (process.env.PHOTOS_URLS || "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const singleEnv = process.env.PHOTOS_URL ? [process.env.PHOTOS_URL] : [];

  let raw = [...cliUrls, ...envUrls, ...singleEnv];
  if (raw.length === 0) raw = readProfilesFile(PROFILES_FILE);
  if (raw.length === 0) raw = [DEFAULT_PHOTOS_URL];

  const seenUrls = new Set();
  const usedSlugs = new Map();
  const profiles = [];

  for (const item of raw) {
    const url = normalizeProfileUrl(item);
    if (!url) {
      log(`[WARN] Bỏ qua link không hợp lệ (không phải profile Photos): ${item}`);
      continue;
    }
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    let slug = profileSlug(url);
    const count = (usedSlugs.get(slug) || 0) + 1;
    usedSlugs.set(slug, count);
    if (count > 1) slug = `${slug}_${count}`;

    profiles.push({ url, slug });
  }

  return profiles;
}

function isAllowedImageHost(host) {
  const h = host.toLowerCase();
  if (h === "fbcdn.net" || h.endsWith(".fbcdn.net")) return true;
  return EXTRA_IMAGE_HOSTS.some((extra) => h === extra || h.endsWith(`.${extra}`));
}

function isPhotoUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (!isAllowedImageHost(u.hostname)) return false;

  // Bỏ icon/emoji/asset của Facebook
  if (/\/rsrc\.php$/i.test(u.pathname)) return false;
  if (/\/(static|images)\//i.test(u.pathname)) return false;

  // Ảnh CDN thường có đuôi file rõ ràng
  if (!/\.(jpe?g|png|webp|gif|heic)$/i.test(u.pathname)) return false;

  return true;
}

function keyOf(rawUrl) {
  const u = new URL(rawUrl);
  const base = u.pathname.split("/").filter(Boolean).pop();
  try {
    return decodeURIComponent(base || u.pathname);
  } catch {
    return base || u.pathname;
  }
}

function nameOf(rawUrl) {
  const key = keyOf(rawUrl);
  return key.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").slice(0, 180);
}

function webKeyOf(rawUrl) {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    const fbid = u.searchParams.get("fbid") || u.searchParams.get("story_fbid");
    if (fbid) return `fbid:${fbid}`;

    const byPath = u.pathname.match(/\/photos\/(?:[^/]+\/)?(\d+)/);
    if (byPath) return `pid:${byPath[1]}`;

    return `url:${u.hostname}${u.pathname}`;
  } catch {
    return null;
  }
}

function qualityScore(rawUrl, meta = {}) {
  let score = 0;
  try {
    const u = new URL(rawUrl);
    const stp = u.searchParams.get("stp") || "";
    const match = stp.match(/_s(\d+)x(\d+)/);
    if (match) {
      // URL có kích thước cố định, ví dụ stp=dst-jpg_s600x600_tt6
      score += Math.min(Number(match[1]), Number(match[2]));
    } else {
      // Không có stp thường là ảnh gốc / bản lớn hơn
      score += 2000;
    }
    if (/\/v\/t39\.\d+-[4-9]\//.test(u.pathname)) score += 100;
  } catch (_) {}
  if (meta.width) score += meta.width;
  return score;
}

function recordScore(record) {
  if (!record) return -Infinity;
  let score = qualityScore(record.url, { width: record.width });
  if (record.is_original) score += 10_000;
  return score;
}

// ── Ingest ────────────────────────────────────────────────────────────────────
function ingest(rawUrl, meta = {}) {
  if (!isPhotoUrl(rawUrl)) return false;

  const profile = currentProfile?.slug || "default";
  const key = keyOf(rawUrl);
  const webKey = webKeyOf(meta.webUrl);

  const byKey = collected.get(key);
  const byWebKey = webKey ? collected.get(webUrlToKey.get(webKey)) : null;

  // Hai record khác tên file nhưng cùng fbid -> gộp lại
  if (byKey && byWebKey && byKey !== byWebKey) {
    const keep = recordScore(byKey) >= recordScore(byWebKey) ? byKey : byWebKey;
    const drop = keep === byKey ? byWebKey : byKey;
    const keepKey = keep === byKey ? key : webUrlToKey.get(webKey);
    const dropKey = drop === byKey ? key : webUrlToKey.get(webKey);

    mergeDuplicate(keep, drop);
    collected.delete(dropKey);
    if (webKey) webUrlToKey.set(webKey, keepKey);
    profileCounts.set(
      profile,
      Math.max(0, (profileCounts.get(profile) || 0) - 1)
    );
    scheduleSave();
  }

  const existing = collected.get(key) || (webKey ? collected.get(webUrlToKey.get(webKey)) : null);

  // Chế độ chỉ bổ sung web_url: không thêm ảnh mới
  if (FILL_WEB_URLS_ONLY && !existing) return false;

  if (existing) {
    // Cùng một ảnh có thể xuất hiện nhiều biến thể kích thước.
    // Giữ lại URL chất lượng cao hơn (ảnh gốc / bản lớn hơn).
    let changed = false;
    const newScore = qualityScore(rawUrl, meta);
    const oldScore = qualityScore(existing.url, { width: existing.width });

    if (!existing.is_original && newScore > oldScore + 50) {
      existing.url = rawUrl;
      existing.name = nameOf(rawUrl);
      existing.source = meta.source || existing.source;
      if (meta.bytes) existing.bytes = meta.bytes;
      changed = true;
    }

    // Bổ sung metadata nếu lần trước chỉ bắt được qua network
    if (!existing.width && meta.width) {
      existing.width = meta.width;
      changed = true;
    }
    if (!existing.height && meta.height) {
      existing.height = meta.height;
      changed = true;
    }
    if (!existing.alt && meta.alt) {
      existing.alt = meta.alt.slice(0, 200);
      changed = true;
    }
    if (!existing.web_url && meta.webUrl) {
      existing.web_url = meta.webUrl;
      if (webKey && !webUrlToKey.has(webKey)) webUrlToKey.set(webKey, key);
      if (FILL_WEB_URLS_ONLY && fillTargets) {
        if (fillTargets.delete(keyOf(existing.url))) {
          filledCount++;
          log(
            `[FILL] +web_url #${existing.index} ${existing.name} -> ${meta.webUrl}`
          );
        }
      }
      changed = true;
    }
    if (changed) scheduleSave();
    return false;
  }

  const record = {
    id: uuidv4(),
    name: nameOf(rawUrl),
    url: rawUrl,
    profile,
    profile_url: currentProfile?.url || null,
    source: meta.source || "unknown",
    status: "found",
    index: nextIndex++,
  };
  if (meta.width) record.width = meta.width;
  if (meta.height) record.height = meta.height;
  if (meta.bytes) record.bytes = meta.bytes;
  if (meta.alt) record.alt = meta.alt.slice(0, 200);
  if (meta.webUrl) record.web_url = meta.webUrl;

  collected.set(key, record);
  if (webKey) webUrlToKey.set(webKey, key);
  profileCounts.set(profile, (profileCounts.get(profile) || 0) + 1);
  scheduleSave();
  log(`[+] [${profile}] #${record.index} ${record.name} (${record.source})`);
  return true;
}

// ── Network intercept ─────────────────────────────────────────────────────────
function attachNetworkCapture(page) {
  page.on("response", (res) => {
    try {
      const req = res.request();
      if (req.resourceType() !== "image") return;

      const url = res.url();
      if (!isPhotoUrl(url)) return;

      const headers = res.headers();
      const contentType = headers["content-type"] || "";
      if (contentType && !contentType.startsWith("image/")) return;

      const bytes = Number(headers["content-length"] || 0);
      if (MIN_IMAGE_BYTES > 0 && bytes > 0 && bytes < MIN_IMAGE_BYTES) return;

      ingest(url, { source: "network", bytes });
    } catch (e) {
      logError("network response", e);
    }
  });

  page.on("crash", () => logError("page crash", new Error("page crashed")));
}

// ── DOM scan ──────────────────────────────────────────────────────────────────
async function scanDom(page) {
  let items;
  try {
    items = await page.evaluate((includeTagged) => {
      const out = [];
      const seen = new Set();
      const linkBySrc = new Map();

      const rememberLink = (src, href) => {
        if (src && href && !linkBySrc.has(src)) linkBySrc.set(src, href);
      };

      // Tìm link photo page đi kèm từng ảnh trong grid.
      // Link này dùng cho bước lấy ảnh gốc (fetch-originals.js).
      for (const a of document.querySelectorAll("a[href]")) {
        if (!a.hostname || !/(^|\.)facebook\.com$/i.test(a.hostname)) continue;
        if (!/(?:[?&]fbid=|\/photos\/)/.test(a.href)) continue;
        if (/\/photos_(by|of)\b/.test(a.href)) continue;
        // Bỏ ảnh "được gắn thẻ" (set=t.<uid>) — đó không phải ảnh do acc đăng.
        if (!includeTagged && /[?&]set=t\./.test(a.href)) continue;

        const img = a.querySelector("img");
        if (img) rememberLink(img.currentSrc || img.src, a.href);

        const bgEl = a.querySelector('[style*="background-image"]');
        if (bgEl) {
          const bg = getComputedStyle(bgEl).backgroundImage;
          const match = bg && bg.match(/url\(["']?(.*?)["']?\)/);
          if (match) rememberLink(match[1], a.href);
        }
      }

      const push = (src, width, height, alt) => {
        if (!src || seen.has(src)) return;
        seen.add(src);
        out.push({
          src,
          width,
          height,
          alt: alt || "",
          webUrl: linkBySrc.get(src) || "",
        });
      };

      for (const img of document.querySelectorAll("img")) {
        const src = img.currentSrc || img.src;
        push(
          src,
          img.naturalWidth || img.width || 0,
          img.naturalHeight || img.height || 0,
          img.alt
        );
      }

      for (const el of document.querySelectorAll('[style*="background-image"]')) {
        const bg = getComputedStyle(el).backgroundImage;
        const match = bg && bg.match(/url\(["']?(.*?)["']?\)/);
        if (match) {
          push(
            match[1],
            el.clientWidth || 0,
            el.clientHeight || 0,
            el.getAttribute("aria-label") || ""
          );
        }
      }

      return out;
    }, INCLUDE_TAGGED);
  } catch (e) {
    logError("scanDom", e);
    return 0;
  }

  let added = 0;
  for (const item of items) {
    if (!item.width || !item.height) continue;
    if (MIN_IMAGE_SIZE > 0 && (item.width < MIN_IMAGE_SIZE || item.height < MIN_IMAGE_SIZE)) {
      continue;
    }
    if (ingest(item.src, {
      source: "dom",
      width: item.width,
      height: item.height,
      alt: item.alt,
      webUrl: item.webUrl,
    })) {
      added++;
    }
  }
  return added;
}

// ── Scroll ────────────────────────────────────────────────────────────────────
// Facebook không scroll bằng window mà bằng một div nội bộ.
// Tìm container cuộn lớn nhất đang hiển thị, có cache lại để đỡ quét DOM mỗi vòng.
async function getScrollState(page) {
  return page.evaluate(() => {
    const findScroller = () => {
      const cached = window.__fbScrollEl;
      if (
        cached &&
        cached.isConnected &&
        cached.scrollHeight > cached.clientHeight + 50
      ) {
        return cached;
      }

      const els = [...document.querySelectorAll("*")].filter((el) => {
        if (el.clientHeight < 200) return false;
        if (!el.getClientRects().length) return false;
        const style = getComputedStyle(el);
        return (
          /(auto|scroll)/.test(style.overflowY) &&
          el.scrollHeight > el.clientHeight + 50
        );
      });

      els.sort(
        (a, b) =>
          b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight)
      );
      const found = els[0] || null;
      window.__fbScrollEl = found;
      return found;
    };

    const el = findScroller();
    const doc = document.documentElement;
    const body = document.body;
    const height = el
      ? el.scrollHeight
      : Math.max(doc.scrollHeight, body ? body.scrollHeight : 0);
    const y = el ? el.scrollTop : window.scrollY;
    const viewport = el ? el.clientHeight : window.innerHeight;

    return {
      height,
      y,
      viewport,
      atBottom: y + viewport >= height - 5,
      kind: el ? "element" : "window",
    };
  });
}

async function scrollStep(page) {
  return page.evaluate((ratio) => {
    const findScroller = () => {
      const cached = window.__fbScrollEl;
      if (
        cached &&
        cached.isConnected &&
        cached.scrollHeight > cached.clientHeight + 50
      ) {
        return cached;
      }
      const els = [...document.querySelectorAll("*")].filter((el) => {
        if (el.clientHeight < 200) return false;
        if (!el.getClientRects().length) return false;
        const style = getComputedStyle(el);
        return (
          /(auto|scroll)/.test(style.overflowY) &&
          el.scrollHeight > el.clientHeight + 50
        );
      });
      els.sort(
        (a, b) =>
          b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight)
      );
      const found = els[0] || null;
      window.__fbScrollEl = found;
      return found;
    };

    const el = findScroller();
    const before = el ? el.scrollTop : window.scrollY;
    const amount = Math.round((el ? el.clientHeight : window.innerHeight) * ratio);

    if (el) {
      el.scrollTop = Math.min(el.scrollHeight, before + amount);
    } else {
      window.scrollBy(0, amount);
    }

    const after = el ? el.scrollTop : window.scrollY;
    return {
      moved: after > before,
      before,
      after,
      atBottom: el
        ? after + el.clientHeight >= el.scrollHeight - 5
        : after + window.innerHeight >=
          Math.max(
            document.documentElement.scrollHeight,
            document.body ? document.body.scrollHeight : 0
          ) - 5,
    };
  }, SCROLL_STEP_RATIO);
}

async function scrollToBottom(page) {
  return page.evaluate(() => {
    const el = window.__fbScrollEl;
    if (el && el.isConnected) {
      el.scrollTop = el.scrollHeight;
      return { kind: "element", y: el.scrollTop, height: el.scrollHeight };
    }
    window.scrollTo(
      0,
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
    );
    return {
      kind: "window",
      y: window.scrollY,
      height: Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight
      ),
    };
  });
}

async function scrollToTop(page) {
  return page.evaluate(() => {
    const el = window.__fbScrollEl;
    if (el && el.isConnected) {
      el.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  });
}

// Đợi các ảnh đang nằm trong vùng nhìn thấy tải xong (tối đa timeoutMs)
async function waitForVisibleImages(page, timeoutMs) {
  if (timeoutMs <= 0) return true;
  return page.evaluate(async (timeout) => {
    const scroller = window.__fbScrollEl;
    const bounds = scroller
      ? scroller.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight };

    const imgs = [...document.querySelectorAll("img")].filter((img) => {
      const src = img.currentSrc || img.src || "";
      if (!src.includes("fbcdn") && !src.includes("scontent")) return false;
      const rect = img.getBoundingClientRect();
      return rect.bottom > bounds.top - 200 && rect.top < bounds.bottom + 200;
    });

    if (imgs.length === 0) return true;

    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (imgs.every((img) => img.complete)) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }, timeoutMs);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
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
  let host = "";
  try {
    host = new URL(page.url()).hostname;
  } catch {
    return false;
  }
  if (!isFacebookHost(host)) return false;
  if (/\/(login|checkpoint)/i.test(page.url())) return true;

  // Cookie c_user tồn tại = session Facebook còn hiệu lực
  try {
    const cookies = await page.context().cookies();
    if (cookies.some((c) => c.name === "c_user" && c.value)) return false;
  } catch (_) {}

  if (!FORCE_LOGIN) {
    try {
      const hasPublicContent = await page.evaluate(() => {
        const hasPhotoLink = [...document.querySelectorAll("a[href]")].some((a) =>
          /(?:[?&]fbid=|\/photos\/)/.test(a.href)
        );
        const hasCdnImage = [...document.querySelectorAll("img")].some((img) => {
          const src = img.currentSrc || img.src || "";
          return src.includes("fbcdn") || src.includes("scontent");
        });
        return hasPhotoLink || hasCdnImage;
      });
      // Profile đang public → không cần chặn để login
      if (hasPublicContent) return false;
    } catch (_) {}
  }

  try {
    const emailInputs = await page.locator('input[name="email"]').count();
    return emailInputs > 0;
  } catch {
    return false;
  }
}

async function waitForLogin(page, targetUrl) {
  const MAX_LOGIN_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    if (!(await needsLogin(page))) return true;

    log("─".repeat(60));
    log(`[LOGIN] Chưa đăng nhập Facebook (lần ${attempt}/${MAX_LOGIN_ATTEMPTS}).`);
    log("[LOGIN] Đăng nhập trong cửa sổ browser vừa mở.");
    log(`[LOGIN] Xong thì nhấn Enter (hoặc chờ tối đa ${LOGIN_WAIT_MS / 60_000} phút).`);
    log("─".repeat(60));

    await waitForEnterOrTimeout(LOGIN_WAIT_MS);

    await withRetry(
      () => page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }),
      "goto after login"
    );
    await page.waitForTimeout(3_000);
  }

  return !(await needsLogin(page));
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────
async function withRetry(fn, label, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      logError(`${label} attempt ${attempt}`, e);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 5_000));
      } else {
        throw e;
      }
    }
  }
}

// ── Crawl loop ────────────────────────────────────────────────────────────────
async function crawl(page, profile) {
  log(`[CRAWL] [${profile.slug}] Bắt đầu quét ảnh...`);

  await getScrollState(page); // xác định container cuộn của Facebook
  await scrollToTop(page);
  await scanDom(page);
  await page.waitForTimeout(1_000);

  let round = 0;
  let stuck = 0;
  let lastHeight = 0;
  let lastCount = profileCounts.get(profile.slug) || 0;
  let lastY = 0;

  while (round < MAX_SCROLL_ROUNDS) {
    round++;

    await scanDom(page);
    const state = await getScrollState(page);
    const count = profileCounts.get(profile.slug) || 0;

    if (FILL_WEB_URLS_ONLY && fillTargets && fillTargets.size === 0) {
      log(`[FILL] [${profile.slug}] Đã bổ sung đủ web_url, dừng sớm.`);
      break;
    }

    const grewHeight = state.height > lastHeight;
    const grewCount = count > lastCount;
    const moved = state.y > lastY;

    if (grewHeight || grewCount) {
      stuck = 0;
    } else if (moved) {
      // Vẫn còn cuộn được thì chưa coi là stuck
      stuck = Math.max(0, stuck - 1);
    } else {
      stuck++;
      log(
        `[STUCK] [${profile.slug}] ${stuck}/${MAX_STUCK_ROUNDS} | round=${round} | ảnh=${count} | height=${state.height}`
      );

      // Thử cuộn cưỡng bức xuống đáy và đợi lâu hơn
      await scrollToBottom(page);
      await page.waitForTimeout(STUCK_EXTRA_WAIT_MS);
      await scanDom(page);

      if ((profileCounts.get(profile.slug) || 0) > count) {
        stuck = 0;
      }
    }

    // Ảnh vừa xuất hiện: đợi thêm để browser tải xong trước khi scroll tiếp
    if (grewCount && IMAGE_SETTLE_MS > 0) {
      log(
        `[SETTLE] [${profile.slug}] +${count - lastCount} ảnh mới, đợi ${IMAGE_SETTLE_MS}ms...`
      );
      await page.waitForTimeout(IMAGE_SETTLE_MS);
    }

    lastHeight = Math.max(lastHeight, state.height);
    lastCount = Math.max(lastCount, count);
    lastY = state.y;

    if (round % 20 === 0) {
      log(
        `[CRAWL] [${profile.slug}] round=${round} | ảnh=${profileCounts.get(profile.slug) || 0} | height=${state.height}`
      );
    }

    if (stuck >= MAX_STUCK_ROUNDS) {
      log(
        `[CRAWL] [${profile.slug}] Không có ảnh mới sau ${MAX_STUCK_ROUNDS} lần thử. Dừng scroll.`
      );
      break;
    }

    const didScroll = await scrollStep(page);
    await page.waitForTimeout(SCROLL_PAUSE_MS);

    const imagesLoaded = await waitForVisibleImages(page, IMAGE_LOAD_TIMEOUT_MS);
    if (!imagesLoaded) {
      log(
        `[WAIT] [${profile.slug}] Một số ảnh chưa tải xong sau ${IMAGE_LOAD_TIMEOUT_MS}ms, vẫn tiếp tục.`
      );
    }

    if (!didScroll.moved && didScroll.atBottom) {
      log(
        `[CRAWL] [${profile.slug}] Đã tới cuối danh sách (${didScroll.before}/${didScroll.after}).`
      );
    }
  }

  // Quét lần cuối + chờ network đang tải dở
  await page.waitForTimeout(2_000);
  await scanDom(page);

  const profileTotal = profileCounts.get(profile.slug) || 0;
  const profileRecords = [...collected.values()].filter(
    (r) => r.profile === profile.slug
  );
  const withWebUrl = profileRecords.filter((r) => r.web_url).length;

  log(
    `[CRAWL] [${profile.slug}] Kết thúc sau ${round} round. Ảnh của profile: ${profileTotal}`
  );
  log(
    `[CRAWL] [${profile.slug}] Có ${withWebUrl}/${profileTotal} ảnh kèm web_url (dùng được cho fetch-originals.js).`
  );
  if (withWebUrl < profileTotal) {
    log(
      `[CRAWL] [${profile.slug}] Một số ảnh không có web_url sẽ chỉ tải được bản thumbnail.`
    );
  }

  if (FILL_WEB_URLS_ONLY && fillTargets) {
    log(
      `[FILL] [${profile.slug}] Đã bổ sung ${filledCount} web_url, còn ${fillTargets.size} ảnh thiếu.`
    );
  }
}

// ── Orchestrator: mỗi profile một thư mục/file riêng ─────────────────────────
const SELF_FILE = fileURLToPath(import.meta.url);

function profileDataDir(slug) {
  return path.join(DATA_DIR, sanitizeSlug(slug));
}

function migrateLegacyData(profiles) {
  const legacy = path.join(BASE_DIR, "fb_user_images.json");
  if (!fs.existsSync(legacy)) return;
  if (profiles.length === 0) return;

  // Chỉ migrate vào thư mục data mặc định của script5.
  const defaultDataDir = path.join(BASE_DIR, "data");
  if (path.resolve(DATA_DIR) !== path.resolve(defaultDataDir)) return;

  const hasDataFiles =
    fs.existsSync(DATA_DIR) &&
    fs
      .readdirSync(DATA_DIR, { withFileTypes: true })
      .some(
        (entry) =>
          entry.isDirectory() &&
          fs.existsSync(path.join(DATA_DIR, entry.name, "fb_user_images.json"))
      );
  if (hasDataFiles) return;

  const first = profiles[0];
  const dir = profileDataDir(first.slug);
  const target = path.join(dir, "fb_user_images.json");
  if (fs.existsSync(target)) return;

  try {
    const arr = JSON.parse(fs.readFileSync(legacy, "utf8"));
    for (const item of arr) {
      if (!item.profile) item.profile = first.slug;
      if (!item.profile_url) item.profile_url = first.url;
    }
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), "utf8");
    fs.renameSync(tmp, target);
    console.log(`[MIGRATE] Đã chuyển ${arr.length} ảnh cũ sang ${target}`);
    console.log(`[MIGRATE] File cũ vẫn giữ tại ${legacy} (có thể xoá sau khi kiểm tra).`);
  } catch (e) {
    console.error(`[MIGRATE] Không migrate được file cũ: ${e.message}`);
  }
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

async function runOrchestrator(profiles) {
  if (profiles.length === 0) {
    console.error(
      "Không có link profile hợp lệ. Thêm link vào script5/profiles.txt hoặc truyền qua CLI."
    );
    process.exitCode = 1;
    return;
  }

  migrateLegacyData(profiles);

  if (process.env.MIGRATE_ONLY === "1") {
    console.log("[ORCH] MIGRATE_ONLY=1 — chỉ migrate dữ liệu cũ, không crawl.");
    logStream.end();
    return;
  }

  console.log("═".repeat(60));
  console.log(`  Facebook User Photos Crawler — ${profiles.length} profile`);
  console.log(`  Data dir: ${DATA_DIR}`);
  for (const profile of profiles) {
    console.log(
      `    - [${profile.slug}] ${profile.url} -> ${profileDataDir(profile.slug)}`
    );
  }
  console.log("═".repeat(60));

  let failed = 0;
  let skipped = 0;

  for (const profile of profiles) {
    const dir = profileDataDir(profile.slug);
    fs.mkdirSync(dir, { recursive: true });

    if (FILL_WEB_URLS_ONLY) {
      const outputFile = path.join(dir, "fb_user_images.json");
      if (!fs.existsSync(outputFile)) {
        console.log(
          `[ORCH] ${profile.slug}: chưa có ${outputFile}, bỏ qua (chạy crawl thường trước).`
        );
        skipped++;
        continue;
      }
      try {
        const arr = JSON.parse(fs.readFileSync(outputFile, "utf8"));
        const missing = arr.filter((item) => item && item.url && !item.web_url).length;
        if (missing === 0) {
          console.log(
            `[ORCH] ${profile.slug}: không có ảnh nào thiếu web_url, bỏ qua.`
          );
          skipped++;
          continue;
        }
        console.log(`[ORCH] ${profile.slug}: ${missing} ảnh thiếu web_url cần bổ sung.`);
      } catch (e) {
        console.error(`[ORCH] ${profile.slug}: không đọc được JSON: ${e.message}`);
      }
    }

    console.log("\n" + "─".repeat(60));
    console.log(`[ORCH] Bắt đầu profile: ${profile.slug}`);
    console.log(`[ORCH] Thư mục: ${dir}`);
    console.log("─".repeat(60));

    const code = await spawnNode(SELF_FILE, {
      ...process.env,
      SINGLE_PROFILE_RUN: "1",
      PHOTOS_URL: profile.url,
      PHOTOS_URLS: "",
      PROFILES_FILE: "",
      PROFILE_SLUG: profile.slug,
      OUTPUT_FILE: path.join(dir, "fb_user_images.json"),
      ERROR_FILE: path.join(dir, "fb_user_errors.json"),
      LOG_FILE: path.join(dir, "fb_user_crawl.log"),
    });

    if (code !== 0) {
      failed++;
      console.error(`[ORCH] Profile ${profile.slug} kết thúc với mã lỗi ${code}`);
    } else {
      console.log(
        `[ORCH] Profile ${profile.slug} xong: ${path.join(
          dir,
          "fb_user_images.json"
        )}`
      );
    }
  }

  console.log("\n" + "═".repeat(60));
  console.log(
    `[ORCH] Hoàn tất ${profiles.length - failed - skipped}/${profiles.length} profile` +
      (skipped ? `, bỏ qua ${skipped}` : "") +
      (failed ? `, lỗi ${failed}` : "") +
      "."
  );
  if (failed > 0) process.exitCode = 1;
  logStream.end();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const profiles = resolveProfiles();

  // Mặc định: chạy orchestrator, mỗi profile một file riêng.
  // Child process do orchestrator spawn sẽ có SINGLE_PROFILE_RUN=1.
  if (process.env.SINGLE_PROFILE_RUN !== "1") {
    await runOrchestrator(profiles);
    return;
  }

  if (profiles.length === 0) {
    console.error("Không có link profile hợp lệ.");
    process.exit(1);
  }

  loadExisting(profiles);

  let context;
  let browser = null;

  const launchOptions = {
    headless: HEADLESS,
    slowMo: 30,
    args: ["--disable-blink-features=AutomationControlled", "--start-maximized"],
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    locale: "vi-VN",
    viewport: null,
  };

  if (USE_PERSISTENT_PROFILE) {
    ensureParent(path.join(PROFILE_DIR, "x"));
    log(`[INIT] Dùng persistent profile: ${PROFILE_DIR} (login 1 lần là đủ)`);
    context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
  } else {
    browser = await chromium.launch({ headless: HEADLESS, slowMo: 30, args: launchOptions.args });
    context = await browser.newContext({
      userAgent: launchOptions.userAgent,
      locale: launchOptions.locale,
      viewport: { width: 1280, height: 900 },
    });
  }

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = context.pages()[0] || (await context.newPage());
  attachNetworkCapture(page);

  log("═".repeat(60));
  log("  Facebook User Photos Crawler");
  log(`  Profiles:   ${profiles.length}`);
  for (const profile of profiles) {
    log(`    - [${profile.slug}] ${profile.url}`);
  }
  log(`  Output:     ${OUTPUT_FILE}`);
  log(`  Log:        ${LOG_FILE}`);
  log("═".repeat(60));

  try {
    let loginChecked = false;

    for (const profile of profiles) {
      currentProfile = profile;
      log("─".repeat(60));
      log(`[PROFILE] ${profile.slug}`);
      log(`[PROFILE] ${profile.url}`);
      log("─".repeat(60));

      try {
        await withRetry(
          () =>
            page.goto(profile.url, {
              waitUntil: "domcontentloaded",
              timeout: 60_000,
            }),
          `goto ${profile.slug}`
        );
        await page.waitForTimeout(3_000);

        if (!loginChecked) {
          await waitForLogin(page, profile.url);
          loginChecked = true;
        } else if (/\/(login|checkpoint)/i.test(page.url())) {
          throw new Error("Facebook yêu cầu đăng nhập/checkpoint");
        }

        await page.waitForTimeout(2_000);
        await crawl(page, profile);
        saveAll();
      } catch (e) {
        logError(`profile ${profile.slug}`, e);
      }
    }
  } catch (e) {
    logError("main", e);
  } finally {
    currentProfile = null;
    saveAll();
    log(`✅ Xong! Tổng ${collected.size} ảnh đã lưu vào ${OUTPUT_FILE}`);
    for (const profile of profiles) {
      log(`   - [${profile.slug}] ${profileCounts.get(profile.slug) || 0} ảnh`);
    }
    if (collected.size === 0) {
      log("⚠️  Không tìm thấy ảnh nào. Kiểm tra lại profiles, đăng nhập, hoặc MIN_IMAGE_SIZE.");
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
