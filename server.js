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

// ✅ FIX: Increase body size limit for large file uploads
app.use(express.json({ limit: "150mb" }));
app.use(express.urlencoded({ extended: true, limit: "150mb" }));

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".xml")) res.setHeader("Content-Type", "application/xml");
    if (filePath.endsWith(".svg")) res.setHeader("Content-Type", "image/svg+xml");
  }
}));

/* ─── MULTER ─────────────────────────────────────────────── */
// ✅ FIX: memoryStorage is correct for Cloudinary,
//    but we need proper error handling for oversized files
const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 100 * 1024 * 1024 }  // 100 MB per file
});

// ✅ FIX: Multer error handler middleware
function handleMulterError(err, req, res, next) {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large. Maximum size is 100MB per file." });
  }
  if (err) {
    return res.status(400).json({ error: "Upload error: " + err.message });
  }
  next();
}

/* ─── SESSION STORE ──────────────────────────────────────── */
const sessions = {};

/* ─── HELPERS ────────────────────────────────────────────── */
function generateCode() {
  let code;
  do { code = Math.floor(100000 + Math.random() * 900000).toString(); }
  while (sessions[code]);
  return code;
}

const durationMap = {
  "24h": 24 * 60 * 60 * 1000,
  "3d" :  3 * 24 * 60 * 60 * 1000,
  "7d" :  7 * 24 * 60 * 60 * 1000
};

// Detect correct Cloudinary resource_type from mimetype
function getResourceType(mimetype) {
  if (!mimetype) return "raw";
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/") || mimetype.startsWith("audio/")) return "video";
  return "raw";
}

function uploadToCloudinary(buffer, originalName, mimetype) {
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
        if (error) {
          console.error("Cloudinary upload error:", error);
          reject(error);
        } else {
          resolve(result);
        }
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

/* ─── AUTO-CLEANUP EXPIRED SESSIONS ─────────────────────── */
setInterval(async () => {
  const now = Date.now();
  for (const code in sessions) {
    if (now > sessions[code].expiresAt) {
      console.log(`🗑️  Cleaning expired session: ${code}`);
      for (const file of sessions[code].files) {
        await deleteFromCloudinary(file.publicId, file.resourceType);
      }
      delete sessions[code];
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

/* ─── PING ENDPOINT ──────────────────────────────────────── */
app.get("/ping", (req, res) => {
  res.json({ status: "alive", time: new Date().toISOString() });
});

/* ─── UPLOAD API ─────────────────────────────────────────── */
// ✅ FIX: added handleMulterError middleware after upload
app.post("/upload", (req, res, next) => {
  upload.array("files", 20)(req, res, (err) => {
    if (err) return handleMulterError(err, req, res, next);
    next();
  });
}, async (req, res) => {

  // ✅ FIX: Check Cloudinary is configured before trying to upload
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return res.status(500).json({
      error: "Server storage is not configured. Please contact the administrator."
    });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files received. Please try again." });
  }

  console.log(`📤 Upload request: ${req.files.length} file(s), duration: ${req.body.duration}`);

  const duration = durationMap[req.body.duration] || durationMap["24h"];
  const code     = generateCode();

  try {
    // ✅ FIX: Upload files one by one (not all parallel) to avoid memory spike
    const uploadedFiles = [];
    for (const file of req.files) {
      console.log(`  → Uploading: ${file.originalname} (${file.size} bytes)`);
      const result = await uploadToCloudinary(file.buffer, file.originalname, file.mimetype);
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

    sessions[code] = {
      files    : uploadedFiles,
      expiresAt: Date.now() + duration,
      createdAt: Date.now()
    };

    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host  = req.headers["x-forwarded-host"]  || req.get("host");

    console.log(`✅ Session created: ${code} (${uploadedFiles.length} files)`);

    res.json({
      url : `${proto}://${host}/access/${code}`,
      code: code
    });

  } catch (err) {
    console.error("❌ Upload processing error:", err.message);
    res.status(500).json({
      error: "Upload failed: " + (err.message || "Unknown error. Please try again.")
    });
  }
});

/* ─── ACCESS PAGE ────────────────────────────────────────── */
app.get("/access/:code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "access.html"));
});

/* ─── ACCESS API ─────────────────────────────────────────── */
app.get("/api/access/:code", (req, res) => {
  const code = req.params.code;

  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: "Invalid code format" });
  }

  const session = sessions[code];
  if (!session) {
    return res.status(404).json({ error: "Invalid or expired code" });
  }

  if (Date.now() > session.expiresAt) {
    (async () => {
      for (const f of session.files) await deleteFromCloudinary(f.publicId, f.resourceType);
    })();
    delete sessions[code];
    return res.status(410).json({ error: "This link has expired" });
  }

  res.json({
    files: session.files.map((f, idx) => ({
      name    : f.name,
      url     : `/download/${code}/${idx}`,
      size    : f.size,
      mimetype: f.mimetype
    })),
    expiresAt: session.expiresAt,
    expiresIn: session.expiresAt - Date.now()
  });
});

/* ─── DOWNLOAD PROXY ─────────────────────────────────────── */
// https.get does NOT follow redirects — Cloudinary CDN sometimes redirects.
// This helper follows up to 5 redirects before giving up.
function httpsGetFollowRedirects(url, res, redirectCount) {
  if (redirectCount > 5) {
    if (!res.headersSent) res.status(502).send("Too many redirects from storage");
    return;
  }
  https.get(url, (cloudRes) => {
    if (cloudRes.statusCode >= 300 && cloudRes.statusCode < 400 && cloudRes.headers.location) {
      // Drain the redirect response body so the socket can be reused
      cloudRes.resume();
      return httpsGetFollowRedirects(cloudRes.headers.location, res, redirectCount + 1);
    }
    if (cloudRes.statusCode !== 200) {
      cloudRes.resume();
      if (!res.headersSent) res.status(502).send("Storage returned " + cloudRes.statusCode);
      return;
    }
    cloudRes.pipe(res);
  }).on("error", (err) => {
    console.error("Download proxy error:", err.message);
    if (!res.headersSent) res.status(500).send("Download failed: " + err.message);
  });
}

app.get("/download/:code/:index", (req, res) => {
  const { code, index } = req.params;
  const idx = parseInt(index, 10);

  if (!/^\d{6}$/.test(code)) return res.status(400).send("Invalid code");

  const session = sessions[code];
  if (!session)              return res.status(404).send("Invalid or expired code");
  if (Date.now() > session.expiresAt) return res.status(410).send("Link has expired");
  if (isNaN(idx) || idx < 0 || idx >= session.files.length) return res.status(404).send("File not found");

  const file = session.files[idx];

  // Use Cloudinary's signed download URL when possible to avoid redirect chains
  let downloadUrl = file.cloudUrl;
  try {
    downloadUrl = cloudinary.url(file.publicId, {
      resource_type: file.resourceType || "raw",
      type         : "upload",
      secure       : true,
      flags        : "attachment:" + encodeURIComponent(file.name)
    });
  } catch (e) {
    // Fall back to stored URL
    console.warn("Cloudinary URL generation failed, using stored URL:", e.message);
  }

  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.name)}"`);
  res.setHeader("Content-Type", file.mimetype || "application/octet-stream");
  // Do NOT set Content-Length here — if there's a redirect the length would be wrong
  // and the stream would be cut short or the browser would show a corrupt download.

  httpsGetFollowRedirects(downloadUrl, res, 0);
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
