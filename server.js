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
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".xml")) res.setHeader("Content-Type", "application/xml");
    if (filePath.endsWith(".svg")) res.setHeader("Content-Type", "image/svg+xml");
  }
}));

/* ─── MULTER (memory — files go straight to Cloudinary) ──── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 100 * 1024 * 1024 }  // 100 MB
});

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

function uploadToCloudinary(buffer, originalName) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "raw",
        folder       : "localshare",
        public_id    : Date.now() + "_" + originalName.replace(/[^a-zA-Z0-9._-]/g, "_"),
        use_filename : false
      },
      (error, result) => error ? reject(error) : resolve(result)
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

async function deleteFromCloudinary(publicId) {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "raw" });
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
        await deleteFromCloudinary(file.publicId);
      }
      delete sessions[code];
    }
  }
}, 30 * 60 * 1000);

/* ─── KEEP-ALIVE PING ────────────────────────────────────── */
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    https.get(process.env.RENDER_EXTERNAL_URL + "/ping", () => {
      console.log("💓 Keep-alive ping sent");
    }).on("error", (e) => console.error("Ping failed:", e.message));
  }, 10 * 60 * 1000);
}

/* ─── PING ENDPOINT ──────────────────────────────────────── */
app.get("/ping", (req, res) => {
  res.json({ status: "alive", time: new Date().toISOString() });
});

/* ─── UPLOAD API ─────────────────────────────────────────── */
app.post("/upload", upload.array("files", 20), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }

  const duration = durationMap[req.body.duration] || durationMap["24h"];
  const code     = generateCode();

  try {
    const uploadedFiles = await Promise.all(
      req.files.map(async (file) => {
        const result = await uploadToCloudinary(file.buffer, file.originalname);
        return {
          name     : file.originalname,
          publicId : result.public_id,
          cloudUrl : result.secure_url,  // stored internally only
          size     : file.size,
          mimetype : file.mimetype
        };
      })
    );

    sessions[code] = {
      files    : uploadedFiles,
      expiresAt: Date.now() + duration,
      createdAt: Date.now()
    };

    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host  = req.headers["x-forwarded-host"]  || req.get("host");

    res.json({
      url : `${proto}://${host}/access/${code}`,
      code: code
    });

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed. Please try again." });
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
      for (const f of session.files) await deleteFromCloudinary(f.publicId);
    })();
    delete sessions[code];
    return res.status(410).json({ error: "This link has expired" });
  }

  // Return /download proxy URLs — NOT raw Cloudinary URLs
  // This forces actual file download instead of browser preview
  res.json({
    files: session.files.map((f, idx) => ({
      name    : f.name,
      url     : `/download/${code}/${idx}`,  // ← proxy route
      size    : f.size,
      mimetype: f.mimetype
    })),
    expiresAt: session.expiresAt,
    expiresIn: session.expiresAt - Date.now()
  });
});

/* ─── DOWNLOAD PROXY ─────────────────────────────────────── */
// This route fetches file from Cloudinary and streams it to the
// browser with Content-Disposition: attachment — forcing download
app.get("/download/:code/:index", (req, res) => {
  const { code, index } = req.params;
  const idx = parseInt(index, 10);

  if (!/^\d{6}$/.test(code)) {
    return res.status(400).send("Invalid code");
  }

  const session = sessions[code];
  if (!session) {
    return res.status(404).send("Invalid or expired code");
  }

  if (Date.now() > session.expiresAt) {
    return res.status(410).send("Link has expired");
  }

  if (isNaN(idx) || idx < 0 || idx >= session.files.length) {
    return res.status(404).send("File not found");
  }

  const file = session.files[idx];

  // Set headers that FORCE download (not preview)
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(file.name)}"`
  );
  res.setHeader("Content-Type", file.mimetype || "application/octet-stream");
  if (file.size) res.setHeader("Content-Length", file.size);

  // Stream the file from Cloudinary through our server to the user
  https.get(file.cloudUrl, (cloudRes) => {
    cloudRes.pipe(res);
  }).on("error", (err) => {
    console.error("Download proxy error:", err);
    res.status(500).send("Download failed");
  });
});

/* ─── 404 ────────────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
});

/* ─── START ──────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`✅  Localshare → http://localhost:${PORT}`);
  console.log(`☁️   Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME || "⚠️  NOT SET!"}`);
});

module.exports = app;
