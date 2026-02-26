const express = require("express");
const multer = require("multer");
const path = require("path");
const cors = require("cors");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- MIDDLEWARE ---------- */
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* ---------- ENSURE UPLOADS FOLDER ---------- */
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

/* ---------- MULTER ---------- */
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    // Sanitize filename to prevent path traversal
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "-" + safeName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB per file
});

/* ---------- IN-MEMORY STORE ---------- */
const sessions = {};

/* ---------- HELPERS ---------- */
function generate6DigitCode() {
  // Ensure uniqueness
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (sessions[code]);
  return code;
}

function cleanExpired() {
  const now = Date.now();
  for (const code in sessions) {
    const session = sessions[code];
    if (now > session.expiresAt) {
      // Delete files from disk
      session.files.forEach(file => {
        const filePath = path.join(uploadsDir, file.filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      });
      delete sessions[code];
    }
  }
}

// Run cleanup every hour
setInterval(cleanExpired, 60 * 60 * 1000);

/* ---------- UPLOAD API ---------- */
app.post("/upload", upload.array("files", 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }

  const durationMap = {
    "24h": 24 * 60 * 60 * 1000,
    "3d":   3 * 24 * 60 * 60 * 1000,
    "7d":   7 * 24 * 60 * 60 * 1000
  };

  const duration = durationMap[req.body.duration] || durationMap["24h"];
  const code = generate6DigitCode();
  const expiresAt = Date.now() + duration;

  sessions[code] = {
    files: req.files,
    expiresAt
  };

  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");

  res.json({
    url: `${protocol}://${host}/access/${code}`,
    code
  });
});

/* ---------- ACCESS PAGE (UI) ---------- */
app.get("/access/:code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "access.html"));
});

/* ---------- ACCESS API (JSON) ---------- */
app.get("/api/access/:code", (req, res) => {
  const code = req.params.code;

  // Validate code format
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: "Invalid code format" });
  }

  const session = sessions[code];

  if (!session) {
    return res.status(404).json({ error: "Invalid or expired link" });
  }

  if (Date.now() > session.expiresAt) {
    // Delete files from disk on expiry
    session.files.forEach(file => {
      const filePath = path.join(uploadsDir, file.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
    delete sessions[code];
    return res.status(410).json({ error: "Link expired" });
  }

  const files = session.files.map(file => ({
    name: file.originalname,
    url: `/uploads/${file.filename}`,
    size: file.size,
    mimetype: file.mimetype
  }));

  const expiresIn = session.expiresAt - Date.now();

  res.json({
    files,
    expiresAt: session.expiresAt,
    expiresIn
  });
});

/* ---------- 404 FALLBACK ---------- */
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
});

/* ---------- START SERVER ---------- */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Localshare running at http://localhost:${PORT}`);
  });
}

module.exports = app;
