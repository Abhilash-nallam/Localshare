# 📁 Localshare

> **Fast & Temporary File Sharing — No login. No account. Just share.**

Built with **Node.js + Express + Multer + Cloudinary**, hosted on **Render**.

![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=flat&logo=express&logoColor=white)
![Cloudinary](https://img.shields.io/badge/Cloudinary-3448C5?style=flat&logo=cloudinary&logoColor=white)
![Render](https://img.shields.io/badge/Render-46E3B7?style=flat&logo=render&logoColor=black)

---

## 🔍 What is Localshare?

Localshare is a lightweight file-sharing web app. Upload files, get a **6-digit code or shareable link**, share it — the recipient downloads without any account or login.

Files are stored on **Cloudinary** and automatically deleted when the session expires. Sessions are held in **server memory** (no database required).

---

## ⚙️ How It Works

### Step 1 — User Uploads Files
- User selects up to **20 files** (drag & drop or browse)
- Chooses an expiry duration: `24h`, `3d`, or `7d`
- Clicks **Generate Link**
- A `FormData` POST request is sent to `/upload`

### Step 2 — Server Receives & Uploads to Cloudinary
- **Multer** (`memoryStorage`) receives files into RAM — no disk writes on Render
- Files are uploaded to Cloudinary **one by one** (sequential, avoids memory spikes)
- Stored under the `localshare/` folder as `resource_type: raw`
- Filenames are sanitized + timestamped to prevent conflicts

### Step 3 — Session is Created
```js
sessions[code] = {
  files: [...],
  expiresAt: Date.now() + duration,
  createdAt: Date.now()
}
```
A random unique **6-digit code** is generated and returned to the frontend along with the shareable URL.

### Step 4 — Recipient Accesses the Link
- Opens the URL (e.g. `/access/482910`) or enters the 6-digit code
- Frontend calls `GET /api/access/:code`
- Returns file list with name, size, MIME type, and download URLs
- Expired sessions return `410 Gone`

### Step 5 — File Download via Proxy
- Downloads go through `GET /download/:code/:index`
- Server fetches the file from Cloudinary and **pipes it to the browser**
- `Content-Disposition` header forces download with the original filename

### Step 6 — Auto Expiry & Cleanup
- A background interval runs **every 30 minutes**
- Sessions past `expiresAt` are deleted from memory
- Files are removed from Cloudinary via `cloudinary.uploader.destroy()`

---

## 📊 Upload & Storage Limits

| Setting | Value |
|---|---|
| Max file size per file | **100 MB** |
| Max files per session | **20 files** |
| Express body size limit | 150 MB |
| Session durations | 24h / 3 days / 7 days |
| Cloudinary free storage | **25 GB** total |
| Cloudinary free bandwidth | **25 GB / month** |
| Cloudinary per-file hard limit | **100 MB** (free plan) |

---

## 🛠️ Tech Stack

| Layer | Technology | Role |
|---|---|---|
| Backend | Node.js + Express | HTTP server & API routes |
| File Handling | Multer (memoryStorage) | Receives multipart/form-data |
| Cloud Storage | Cloudinary | Stores all files, 25 GB free |
| Hosting | Render (Free) | Runs the Node server |
| Frontend | Vanilla HTML / CSS / JS | Drag & drop UI, progress bar |

---

## 🔗 API Endpoints

### `POST /upload`
Accepts `multipart/form-data` with files and duration. Uploads to Cloudinary, creates a session, returns the URL and code.

```
Body:     files[] (array), duration ("24h" | "3d" | "7d")
Response: { url: "https://.../access/482910", code: "482910" }
```

### `GET /api/access/:code`
Returns file metadata for a valid, non-expired session.

```
Response: { files: [{ name, url, size, mimetype }], expiresAt, expiresIn }
```

### `GET /download/:code/:index`
Proxies the file download from Cloudinary to the browser with proper `Content-Disposition` headers.

### `GET /ping`
Health check endpoint. Used by the keep-alive interval to prevent Render free instance from sleeping.

```
Response: { status: "alive", time: "2025-..." }
```

---

## 🔐 Environment Variables

Set these in your **Render dashboard → Environment**:

| Variable | Description |
|---|---|
| `CLOUDINARY_CLOUD_NAME` | Your Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Your Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Your Cloudinary API secret |
| `RENDER_EXTERNAL_URL` | Your Render app's public URL (enables keep-alive) |

---

## 💓 Keep-Alive System

Render's free tier sleeps instances after **15 minutes of inactivity**. Localshare self-pings every 10 minutes to stay awake:

```js
setInterval(() => {
  https.get(process.env.RENDER_EXTERNAL_URL + "/ping", ...)
}, 10 * 60 * 1000);
```

Only activates when `RENDER_EXTERNAL_URL` is set — won't fire in local development.

---

## 🚀 Local Development

```bash
# Clone the repo
git clone https://github.com/yourname/localshare.git
cd localshare

# Install dependencies
npm install

# Create .env file
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# Start the server
node server.js
```

Visit `http://localhost:3000`

---

## 📁 Project Structure

```
localshare/
├── public/
│   ├── index.html      # Main upload page
│   ├── access.html     # File access/download page
│   ├── script.js       # Frontend logic
│   └── ...
├── server.js           # Express server + all API routes
├── package.json
└── .gitignore
```

---

## ⚠️ Limitations (Free Tier)

- **100 MB** max per file (Cloudinary free plan hard limit)
- **Sessions stored in RAM** — restarting Render clears all active sessions
- **Render cold start** — first request after inactivity may take ~10–15 seconds
- No persistent database — sessions don't survive server restarts

---

*Built by BITS DEVLOPER — Balaji Institute of Technology & Science, Warangal*
