const express      = require("express");
const multer       = require("multer");
const path         = require("path");
const cors         = require("cors");
const cloudinary   = require("cloudinary").v2;
const streamifier  = require("streamifier");

const app  = express();
const PORT = process.env.PORT || 3000;

/* ─── CLOUDINARY CONFIG (from environment variables) ─────── */
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

/* ─── MULTER (memory storage — files go to Cloudinary, not disk) */
const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 100 * 1024 * 1024 }  // 100 MB per file
});

/* ─── IN-MEMORY SESSION STORE ────────────────────────────── */
// Sessions store Cloudinary URLs (not local paths), so restarts
// don't break download links — files are safe on Cloudinary
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

/* Upload a single buffer to Cloudinary as raw file */
function uploadToCloudinary(buffer, originalName) {
  return new Promise((resolve, reject) => {
    // Use 'raw' resource type so ANY file type is accepted
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type : "raw",
        folder        : "localshare",
        public_id     : Date.now() + "_" + originalName.replace(/[^a-zA-Z0-9._-]/g, "_"),
        use_filename  : false
      },
      (error, result) => {
        if (error) reject(error);
        else       resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

/* Delete a file from Cloudinary */
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
      console.log(`Cleaning expired session: ${code}`);
      // Delete each file from Cloudinary
      for (const file of sessions[code].files) {
        await deleteFromCloudinary(file.publicId);
      }
      delete sessions[code];
    }
  }
}, 30 * 60 * 1000); // Run every 30 minutes

/* ─── KEEP-ALIVE (prevents Render free tier from sleeping) ── */
// Pings itself every 10 minutes to stay awake
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL + "/ping";
    require("https").get(url, () => {
      console.log("Keep-alive ping sent →", url);
    }).on("error", (e) => {
      console.error("Keep-alive ping failed:", e.message);
    });
  }, 10 * 60 * 1000); // every 10 minutes
}

/* ─── PING ENDPOINT ──────────────────────────────────────── */
app.get("/ping", (req, res) => res.json({ status: "alive", time: new Date().toISOString() }));

/* ─── UPLOAD API ─────────────────────────────────────────── */
app.post("/upload", upload.array("files", 20), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }

  const duration = durationMap[req.body.duration] || durationMap["24h"];
  const code     = generateCode();

  try {
    // Upload ALL files to Cloudinary in parallel
    const uploadedFiles = await Promise.all(
      req.files.map(async (file) => {
        const result = await uploadToCloudinary(file.buffer, file.originalname);
        return {
          name    : file.originalname,
          url     : result.secure_url,   // permanent HTTPS Cloudinary URL
          publicId: result.public_id,    // needed for deletion
          size    : file.size,
          mimetype: file.mimetype
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
    // Clean up Cloudinary files async
    (async () => {
      for (const file of session.files) {
        await deleteFromCloudinary(file.publicId);
      }
    })();
    delete sessions[code];
    return res.status(410).json({ error: "This link has expired" });
  }

  res.json({
    files    : session.files.map(f => ({
      name    : f.name,
      url     : f.url,    // direct Cloudinary download URL
      size    : f.size,
      mimetype: f.mimetype
    })),
    expiresAt: session.expiresAt,
    expiresIn: session.expiresAt - Date.now()
  });
});

/* ─── 404 ────────────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
});

/* ─── START ──────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`✅  Localshare → http://localhost:${PORT}`);
  console.log(`☁️   Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME || "NOT SET - add env vars!"}`);
});

module.exports = app;
