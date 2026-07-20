const express      = require("express");
const multer       = require("multer");
const path         = require("path");
const cors         = require("cors");
const https        = require("https");
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
  if (err) return res.status(400).json({ error: "Upload error: " + err.message });
  next();
}

/* ═══════════════════════════════════════════════════════════
   SESSION STORAGE — THE ACTUAL FIX
   ═══════════════════════════════════════════════════════════
   OLD BEHAVIOUR: sessions lived only in a plain JS object in
   server memory. Any restart (Render free-tier sleep, redeploy,
   crash) wiped it instantly — the uploaded files were still
   sitting safely in Cloudinary, but the server no longer knew
   which 6-digit code pointed to which files, so every existing
   link broke with "Invalid or expired code".

   NEW BEHAVIOUR: the session manifest (list of files + expiry)
   is itself saved as a tiny JSON file in Cloudinary, under a
   predictable public_id (localshare_manifests/<code>.json).
   The server keeps an in-memory cache purely as a speed
   optimisation, but if a code isn't cached (fresh restart, or
   a second server instance) it just re-fetches the manifest
   from Cloudinary. Nothing is ever lost on restart.
   ═══════════════════════════════════════════════════════════ */

const cache = {}; // code -> session (fast path only, not source of truth)

function generateCode() {
  let code;
  do { code = Math.floor(100000 + Math.random() * 900000).toString(); }
  while (cache[code]);
  return code;
}

const durationMap = {
  "24h": 24 * 60 * 60 * 1000,
  "3d" :  3 * 24 * 60 * 60 * 1000,
  "7d" :  7 * 24 * 60 * 60 * 1000
};

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
        public_id    : Date.now() + "_" + originalName.replace(/[^a-zA-Z0-9._-]/g, "_"),
        use_filename : false,
        overwrite    : false
      },
      (error, result) => {
        if (error) { console.error("Cloudinary upload error:", error); reject(error); }
        else resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

async function deleteFromCloudinary(publicId, resourceType) {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType || "raw" });
  } catch (e) {
    console.error("Cloudinary delete error:", e.message);
  }
}

function manifestPublicId(code) {
  return `localshare_manifests/${code}`;
}

function manifestUrl(code) {
  return cloudinary.url(manifestPublicId(code), {
    resource_type: "raw",
    type: "upload",
    format: "json",
    secure: true
  });
}

async function saveSession(code, session) {
  cache[code] = session;
  const buffer = Buffer.from(JSON.stringify(session));
  await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "raw",
        public_id    : manifestPublicId(code),
        format       : "json",
        overwrite    : true
      },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

// Reads from the local cache first; falls back to Cloudinary so a
// fresh server instance (after any restart) can still resolve a code.
async function loadSession(code) {
  if (cache[code]) return cache[code];
  try {
    const res = await fetch(manifestUrl(code));
    if (!res.ok) return null;
    const session = await res.json();
    cache[code] = session;
    return session;
  } catch {
    return null;
  }
}

async function deleteSession(code, session) {
  delete cache[code];
  for (const f of session.files) await deleteFromCloudinary(f.publicId, f.resourceType);
  await deleteFromCloudinary(manifestPublicId(code), "raw");
}

/* ─── PERIODIC CLEANUP OF EXPIRED SESSIONS ───────────────────
   Scans Cloudinary directly (not just the local cache) so
   cleanup works correctly even after a restart. */
setInterval(async () => {
  try {
    const list = await cloudinary.api.resources({
      resource_type: "raw",
      type: "upload",
      prefix: "localshare_manifests/",
      max_results: 500
    });
    const now = Date.now();
    for (const res of list.resources || []) {
      const code = res.public_id.replace("localshare_manifests/", "");
      const session = await loadSession(code);
      if (session && now > session.expiresAt) {
        console.log(`🗑️  Cleaning expired session: ${code}`);
        await deleteSession(code, session);
      }
    }
  } catch (e) {
    console.error("Cleanup scan failed:", e.message);
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

/* ─── UPLOAD API ─────────────────────────────────────────── */
app.post("/upload", (req, res, next) => {
  upload.array("files", 20)(req, res, (err) => {
    if (err) return handleMulterError(err, req, res, next);
    next();
  });
}, async (req, res) => {

  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return res.status(500).json({ error: "Server storage is not configured. Please contact the administrator." });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files received. Please try again." });
  }

  console.log(`📤 Upload request: ${req.files.length} file(s), duration: ${req.body.duration}`);

  const duration = durationMap[req.body.duration] || durationMap["24h"];
  const code     = generateCode();

  try {
    const uploadedFiles = [];
    for (const file of req.files) {
      console.log(`  → Uploading: ${file.originalname} (${file.size} bytes)`);
      const result = await uploadFileToCloudinary(file.buffer, file.originalname, file.mimetype);
      uploadedFiles.push({
        name        : file.originalname,
        publicId    : result.public_id,
        resourceType: result.resource_type,
        cloudUrl    : result.secure_url,
        size        : file.size,
        mimetype    : file.mimetype
      });
      console.log(`  ✅ Uploaded: ${file.originalname}`);
    }

    const session = {
      files    : uploadedFiles,
      expiresAt: Date.now() + duration,
      createdAt: Date.now()
    };

    await saveSession(code, session);

    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host  = req.headers["x-forwarded-host"]  || req.get("host");

    console.log(`✅ Session created: ${code} (${uploadedFiles.length} files)`);

    res.json({ url: `${proto}://${host}/access/${code}`, code });

  } catch (err) {
    console.error("❌ Upload processing error:", err.message);
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

/* ─── DOWNLOAD PROXY ─────────────────────────────────────── */
app.get("/download/:code/:index", async (req, res) => {
  const { code, index } = req.params;
  const idx = parseInt(index, 10);

  if (!/^\d{6}$/.test(code)) return res.status(400).send("Invalid code");

  const session = await loadSession(code);
  if (!session) return res.status(404).send("Invalid or expired code");
  if (Date.now() > session.expiresAt) { deleteSession(code, session); return res.status(410).send("Link has expired"); }
  if (isNaN(idx) || idx < 0 || idx >= session.files.length) return res.status(404).send("File not found");

  const file = session.files[idx];

  let downloadUrl;
  try {
    downloadUrl = cloudinary.url(file.publicId, {
      resource_type : file.resourceType || "raw",
      type          : "upload",
      secure        : true,
      flags         : "attachment"
    });
  } catch (e) {
    console.warn("Cloudinary URL generation failed, using raw URL:", e.message);
    const sep = file.cloudUrl.includes("?") ? "&" : "?";
    downloadUrl = file.cloudUrl + sep + "fl_attachment=true";
  }

  console.log(`📥 Download redirect: ${file.name} → ${downloadUrl}`);

  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.redirect(302, downloadUrl);
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
  console.log(`☁️   Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME || "⚠️  NOT SET — uploads will fail!"}`);
});

module.exports = app;
