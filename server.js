const express      = require("express");
const multer       = require("multer");
const path         = require("path");
const fs           = require("fs");
const cors         = require("cors");
const https        = require("https");
const { Readable } = require("stream");
const cloudinary   = require("cloudinary").v2;
const streamifier  = require("streamifier");

const app  = express();
const PORT = process.env.PORT || 3000;

/* ─── CLOUDINARY CONFIG ──────────────────────────────────── */
cloudinary.config({
  cloud_name : process.env.CLOUDINARY_CLOUD_NAME,
  api_key    : process.env.CLOUDINARY_API_KEY,
  api_secret : process.env.CLOUDINARY_API_SECRET,
  secure     : true
});

const CLOUDINARY_CONFIGURED = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

/* ─── MIDDLEWARE ─────────────────────────────────────────── */
app.use(cors());
app.use(express.json({ limit: "150mb" }));
app.use(express.urlencoded({ extended: true, limit: "150mb" }));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".xml")) res.setHeader("Content-Type", "application/xml");
    if (filePath.endsWith(".svg")) res.setHeader("Content-Type", "image/svg+xml");
  }
}));

/* ─── MULTER ─────────────────────────────────────────────── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 100 * 1024 * 1024 }  // 100 MB per file
});

function handleMulterError(err, req, res, next) {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large. Maximum size is 100MB per file." });
  }
  if (err && err.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({ error: "Too many files. Maximum is 20 files per send." });
  }
  if (err) return res.status(400).json({ error: "Upload error: " + err.message });
  next();
}

/* ═══════════════════════════════════════════════════════════
   SESSION STORAGE
   ═══════════════════════════════════════════════════════════
   v1 (memory-only) lost every session on restart.
   v2 (Cloudinary-only manifest) broke because Cloudinary blocks
   public/unsigned delivery of raw files by default for security
   (this includes JSON manifests AND real PDFs/ZIPs users send —
   that's exactly why downloads were failing).

   v3 (this version): the manifest lives in a local JSON file on
   disk — instant, no external dependency, survives sleeps/restarts
   on the same instance. It's also mirrored to Cloudinary as a
   best-effort backup for full redeploys, using a SIGNED url
   (sign_url: true) which bypasses Cloudinary's raw-delivery block.
   The same signing is applied to every actual file download below,
   which is what actually fixes "unable to fetch/retrieve".
   ═══════════════════════════════════════════════════════════ */

const DATA_DIR      = path.join(__dirname, "data");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, "{}");

const cache = {}; // fast in-memory read-through cache, disk is the source of truth

function readStore() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8") || "{}"); }
  catch (e) { console.error("Session store read failed, resetting:", e.message); return {}; }
}
function writeStore(store) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(store));
}

// Simple write queue so concurrent uploads can't clobber each other's writes
let writeQueue = Promise.resolve();
function withLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

function generateCode() {
  const store = readStore();
  let code;
  do { code = Math.floor(100000 + Math.random() * 900000).toString(); }
  while (store[code] || cache[code]);
  return code;
}

const durationMap = {
  "24h": 24 * 60 * 60 * 1000,
  "3d" :  3 * 24 * 60 * 60 * 1000,
  "7d" :  7 * 24 * 60 * 60 * 1000
};

function manifestPublicId(code) { return `localshare_manifests/${code}`; }

async function mirrorSessionToCloudinary(code, session) {
  if (!CLOUDINARY_CONFIGURED) return;
  try {
    const buffer = Buffer.from(JSON.stringify(session));
    await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: "raw", public_id: manifestPublicId(code), format: "json", overwrite: true },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      streamifier.createReadStream(buffer).pipe(stream);
    });
  } catch (e) {
    console.warn(`⚠️  Cloudinary manifest mirror failed for ${code} (non-fatal):`, e.message);
  }
}

async function fetchSessionFromCloudinary(code) {
  if (!CLOUDINARY_CONFIGURED) return null;
  try {
    const url = cloudinary.url(manifestPublicId(code), {
      resource_type: "raw", type: "upload", format: "json", secure: true, sign_url: true
    });
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function saveSession(code, session) {
  cache[code] = session;
  await withLock(() => {
    const store = readStore();
    store[code] = session;
    writeStore(store);
  });
  mirrorSessionToCloudinary(code, session); // fire-and-forget, non-blocking
}

async function loadSession(code) {
  if (cache[code]) return cache[code];

  const store = readStore();
  if (store[code]) { cache[code] = store[code]; return store[code]; }

  // Local file has no record (e.g. after a full redeploy) — try the Cloudinary mirror
  const fromCloud = await fetchSessionFromCloudinary(code);
  if (fromCloud) {
    cache[code] = fromCloud;
    withLock(() => { const s = readStore(); s[code] = fromCloud; writeStore(s); });
    return fromCloud;
  }
  return null;
}

async function deleteSession(code, session) {
  delete cache[code];
  await withLock(() => {
    const store = readStore();
    delete store[code];
    writeStore(store);
  });
  for (const f of session.files) await deleteFromCloudinary(f.publicId, f.resourceType);
  if (CLOUDINARY_CONFIGURED) {
    try { await cloudinary.uploader.destroy(manifestPublicId(code), { resource_type: "raw" }); }
    catch { /* non-fatal */ }
  }
}

/* ─── CLOUDINARY FILE HELPERS ────────────────────────────── */
function getResourceType(mimetype) {
  if (!mimetype) return "raw";
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/") || mimetype.startsWith("audio/")) return "video";
  return "raw";
}

function uploadFileToCloudinary(buffer, originalName, mimetype) {
  return new Promise((resolve, reject) => {
    const resourceType = getResourceType(mimetype);
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: resourceType,
        folder       : "localshare",
        public_id    : Date.now() + "_" + Math.random().toString(36).slice(2, 8),
        use_filename : false,
        overwrite    : false
      },
      (error, result) => {
        if (error) { console.error(`Cloudinary upload error for "${originalName}":`, error.message); reject(error); }
        else resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

async function deleteFromCloudinary(publicId, resourceType) {
  try { await cloudinary.uploader.destroy(publicId, { resource_type: resourceType || "raw" }); }
  catch (e) { console.error("Cloudinary delete error:", e.message); }
}

// Concurrency-limited map so a batch of files uploads in parallel
// (faster + less likely to hit a platform request timeout) without
// hammering Cloudinary with unlimited simultaneous connections.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/* ─── PERIODIC CLEANUP OF EXPIRED SESSIONS (scans local disk) ─── */
setInterval(async () => {
  const store = readStore();
  const now = Date.now();
  for (const [code, session] of Object.entries(store)) {
    if (now > session.expiresAt) {
      console.log(`🗑️  Cleaning expired session: ${code}`);
      await deleteSession(code, session);
    }
  }
}, 30 * 60 * 1000);

/* ─── KEEP-ALIVE PING ────────────────────────────────────── */
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    https.get(process.env.RENDER_EXTERNAL_URL + "/ping", (res) => {
      console.log("💓 Keep-alive ping →", res.statusCode);
    }).on("error", (e) => console.error("Ping failed:", e.message));
  }, 10 * 60 * 1000);
}

app.get("/ping", (req, res) => {
  res.json({ status: "alive", time: new Date().toISOString() });
});

/* ─── HEALTH / DIAGNOSTICS ───────────────────────────────── */
app.get("/api/health", async (req, res) => {
  let cloudinaryReachable = false, cloudinaryError = null;
  if (CLOUDINARY_CONFIGURED) {
    try { await cloudinary.api.ping(); cloudinaryReachable = true; }
    catch (e) { cloudinaryError = e.message; }
  }
  res.json({
    server: "ok",
    cloudinaryEnvConfigured: CLOUDINARY_CONFIGURED,
    cloudinaryReachable,
    cloudinaryError,
    activeSessionsOnDisk: Object.keys(readStore()).length,
    time: new Date().toISOString()
  });
});

/* ─── UPLOAD API ─────────────────────────────────────────── */
app.post("/upload", (req, res, next) => {
  upload.array("files", 20)(req, res, (err) => {
    if (err) return handleMulterError(err, req, res, next);
    next();
  });
}, async (req, res) => {

  if (!CLOUDINARY_CONFIGURED) {
    return res.status(500).json({ error: "Server storage is not configured (missing Cloudinary credentials). Check /api/health for details." });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files received. Please try again." });
  }

  console.log(`📤 Upload request: ${req.files.length} file(s), duration: ${req.body.duration}`);

  const duration = durationMap[req.body.duration] || durationMap["24h"];
  const code     = generateCode();
  const succeeded = [];

  try {
    await mapWithConcurrency(req.files, 4, async (file) => {
      console.log(`  → Uploading: ${file.originalname} (${file.size} bytes)`);
      const result = await uploadFileToCloudinary(file.buffer, file.originalname, file.mimetype);
      const descriptor = {
        name        : file.originalname,
        publicId    : result.public_id,
        resourceType: result.resource_type,
        size        : file.size,
        mimetype    : file.mimetype
      };
      succeeded.push(descriptor);
      console.log(`  ✅ Uploaded: ${file.originalname}`);
      return descriptor;
    });

    const session = {
      files    : succeeded,
      expiresAt: Date.now() + duration,
      createdAt: Date.now()
    };

    await saveSession(code, session);

    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host  = req.headers["x-forwarded-host"]  || req.get("host");

    console.log(`✅ Session created: ${code} (${succeeded.length} files)`);

    res.json({ url: `${proto}://${host}/access/${code}`, code });

  } catch (err) {
    console.error("❌ Upload processing error:", err.message);
    // Clean up anything that did make it to Cloudinary before the failure,
    // since no session was ever saved to point at it.
    for (const f of succeeded) await deleteFromCloudinary(f.publicId, f.resourceType);
    res.status(500).json({ error: "Upload failed: " + (err.message || "Unknown error. Please try again.") });
  }
});

/* ─── ACCESS PAGE ────────────────────────────────────────── */
app.get("/access/:code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "access.html"));
});

/* ─── ACCESS API ─────────────────────────────────────────── */
app.get("/api/access/:code", async (req, res) => {
  const code = req.params.code;
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: "Invalid code format" });
  }

  const session = await loadSession(code);
  if (!session) {
    return res.status(404).json({ error: "Invalid or expired code" });
  }
  if (Date.now() > session.expiresAt) {
    deleteSession(code, session); // fire and forget
    return res.status(410).json({ error: "This link has expired" });
  }

  res.json({
    files: session.files.map((f, idx) => ({
      name: f.name, url: `/download/${code}/${idx}`, size: f.size, mimetype: f.mimetype
    })),
    expiresAt: session.expiresAt,
    expiresIn: session.expiresAt - Date.now()
  });
});

/* ─── DOWNLOAD — proxied through our server ──────────────────
   Why: a 302 redirect to Cloudinary discards our headers, so the
   browser ends up naming the file after Cloudinary's internal
   storage key instead of the real filename. Streaming the bytes
   ourselves means WE set Content-Disposition with the exact
   original filename, every time, for every file type. The
   upstream Cloudinary URL is signed (sign_url: true) so raw
   PDF/ZIP files — blocked by Cloudinary's delivery security
   default — actually come through instead of 401ing. ─────────── */
app.get("/download/:code/:index", async (req, res) => {
  const { code, index } = req.params;
  const idx = parseInt(index, 10);

  if (!/^\d{6}$/.test(code)) return res.status(400).send("Invalid code");

  const session = await loadSession(code);
  if (!session) return res.status(404).send("Invalid or expired code");
  if (Date.now() > session.expiresAt) { deleteSession(code, session); return res.status(410).send("Link has expired"); }
  if (isNaN(idx) || idx < 0 || idx >= session.files.length) return res.status(404).send("File not found");

  const file = session.files[idx];

  try {
    const sourceUrl = cloudinary.url(file.publicId, {
      resource_type: file.resourceType || "raw",
      type         : "upload",
      secure       : true,
      sign_url     : true
    });

    const upstream = await fetch(sourceUrl);
    if (!upstream.ok || !upstream.body) {
      console.error(`Cloudinary fetch failed for ${file.name}: ${upstream.status}`);
      return res.status(502).send("Could not retrieve file from storage. Please try again.");
    }

    res.setHeader("Content-Type", file.mimetype || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    const len = upstream.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);

    Readable.fromWeb(upstream.body).pipe(res).on("error", (e) => {
      console.error("Stream error while sending", file.name, e.message);
      if (!res.headersSent) res.status(500).end();
    });

  } catch (err) {
    console.error(`Download failed for ${file.name}:`, err.message);
    if (!res.headersSent) res.status(500).send("Download failed. Please try again.");
  }
});

/* ─── 404 ────────────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
});

/* ─── GLOBAL ERROR HANDLER ───────────────────────────────── */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

/* ─── START ──────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`✅  Localshare → http://localhost:${PORT}`);
  console.log(`☁️   Cloudinary configured: ${CLOUDINARY_CONFIGURED ? "yes" : "⚠️  NO — set CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET"}`);
  console.log(`💾  Session store: ${SESSIONS_FILE}`);
});

module.exports = app;
