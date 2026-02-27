let selectedFiles = [];

/* ─── WAIT FOR DOM ───────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {

  const fileInput   = document.getElementById("fileInput");
  const dropZone    = document.getElementById("dropZone");
  const generateBtn = document.getElementById("generateBtn");
  const copyBtn     = document.getElementById("copyBtn");
  const accessInput = document.getElementById("accessInput");

  /* ── FILE INPUT CHANGE ────────────────────────────────── */
  fileInput.addEventListener("change", (e) => {
    addFiles([...e.target.files]);
    e.target.value = ""; // allow re-selecting same file
  });

  /* ── CLICK ON DROP ZONE → open file picker ─────────────── */
  dropZone.addEventListener("click", (e) => {
    if (e.target.tagName !== "LABEL" && e.target.tagName !== "INPUT") {
      fileInput.click();
    }
  });

  /* ── DRAG OVER ──────────────────────────────────────────── */
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add("drag-over");
  });

  dropZone.addEventListener("dragleave", (e) => {
    e.stopPropagation();
    dropZone.classList.remove("drag-over");
  });

  /* ── DROP ───────────────────────────────────────────────── */
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles([...e.dataTransfer.files]);
    }
  });

  /* ── BUTTONS ────────────────────────────────────────────── */
  generateBtn.addEventListener("click", uploadFiles);
  copyBtn.addEventListener("click", copyUrl);

  /* ── ENTER KEY ON ACCESS INPUT ──────────────────────────── */
  if (accessInput) {
    accessInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") accessFiles();
    });
  }

});

/* ─── ADD FILES (no duplicates) ──────────────────────────── */
function addFiles(newFiles) {
  newFiles.forEach(file => {
    const isDup = selectedFiles.some(
      f => f.name === file.name && f.size === file.size
    );
    if (!isDup) selectedFiles.push(file);
  });
  renderFileList();
}

/* ─── RENDER FILE LIST ───────────────────────────────────── */
function renderFileList() {
  const list = document.getElementById("selectedFiles");
  list.innerHTML = "";

  selectedFiles.forEach((file, index) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="fname" title="${escHtml(file.name)}">
        ${getIcon(file.name)} ${truncate(escHtml(file.name), 34)}
        <small style="color:#aaa">(${formatBytes(file.size)})</small>
      </span>
      <span class="remove" title="Remove">✕</span>
    `;
    // Use addEventListener instead of onclick to avoid index issues
    li.querySelector(".remove").addEventListener("click", () => removeFile(index));
    list.appendChild(li);
  });
}

/* ─── REMOVE A FILE ──────────────────────────────────────── */
function removeFile(index) {
  selectedFiles.splice(index, 1);
  renderFileList();
}

/* ─── UPLOAD ─────────────────────────────────────────────── */
async function uploadFiles() {
  if (selectedFiles.length === 0) {
    const dz = document.getElementById("dropZone");
    dz.classList.add("shake");
    setTimeout(() => dz.classList.remove("shake"), 600);
    showToast("Please add at least one file!", "error");
    return;
  }

  const btn       = document.getElementById("generateBtn");
  const resultBox = document.getElementById("resultBox");

  btn.disabled    = true;
  btn.textContent = "Uploading…";
  if (resultBox) resultBox.style.display = "none";

  const formData = new FormData();

  // ✅ Correct way — loop and append each file
  for (let i = 0; i < selectedFiles.length; i++) {
    formData.append("files", selectedFiles[i]);
  }
  formData.append("duration", document.getElementById("duration").value);

  // ✅ NEVER manually set Content-Type for FormData — browser adds boundary
  try {
    const res = await fetch("/upload", {
      method: "POST",
      body: formData
    });

    if (!res.ok) throw new Error("Server responded with " + res.status);

    const data = await res.json();

    if (data.error) {
      showToast("❌ " + data.error, "error");
      return;
    }

    // Populate result
    document.getElementById("generatedUrl").textContent = data.url;
    const codeEl = document.getElementById("generatedCode");
    if (codeEl) codeEl.textContent = data.code;
    if (resultBox) resultBox.style.display = "flex";

    showToast("✅ Link generated successfully!", "success");

  } catch (err) {
    console.error("Upload error:", err);
    showToast("❌ Upload failed. Check your connection.", "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "⚡ Generate Link";
  }
}

/* ─── COPY URL ───────────────────────────────────────────── */
function copyUrl() {
  const text = (document.getElementById("generatedUrl").textContent || "").trim();

  if (!text) {
    showToast("Generate a link first!", "error");
    return;
  }

  const btn = document.getElementById("copyBtn");

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => flashCopied(btn));
  } else {
    // Fallback for HTTP
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try   { document.execCommand("copy"); flashCopied(btn); }
    catch { showToast("Copy failed — please copy manually", "error"); }
    document.body.removeChild(ta);
  }
}

function flashCopied(btn) {
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent    = "Copied ✓";
  btn.style.background = "#16a34a";
  setTimeout(() => {
    btn.textContent    = orig;
    btn.style.background = "";
  }, 2000);
}

/* ─── ACCESS FILES ───────────────────────────────────────── */
async function accessFiles() {
  const raw  = (document.getElementById("accessInput").value || "").trim();
  const list = document.getElementById("fileList");
  list.innerHTML = "";

  if (!raw) {
    list.innerHTML = '<div class="error-msg">Please enter a link or 6-digit code.</div>';
    return;
  }

  // Accept full URL OR bare 6-digit code
  let code;
  const urlMatch = raw.match(/\/access\/(\d{6})/);
  if (urlMatch)        code = urlMatch[1];
  else if (/^\d{6}$/.test(raw)) code = raw;
  else {
    list.innerHTML = '<div class="error-msg">Enter the full share link or a 6-digit code.</div>';
    return;
  }

  list.innerHTML = '<p style="color:#888;font-size:0.85rem;text-align:center;padding:10px">Fetching files…</p>';

  try {
    const res  = await fetch(`/api/access/${code}`);
    const data = await res.json();
    list.innerHTML = "";

    if (data.error) {
      list.innerHTML = `<div class="error-msg">${escHtml(data.error)}</div>`;
      return;
    }

    data.files.forEach(file => {
      const item = document.createElement("div");
      item.className = "file-dl-item";
      item.innerHTML = `
        <span title="${escHtml(file.name)}">
          ${getIcon(file.name)} ${escHtml(file.name)}
          ${file.size ? `<small style="color:#999"> (${formatBytes(file.size)})</small>` : ""}
        </span>
        <a href="${file.url}" download="${escHtml(file.name)}">⬇ Download</a>
      `;
      list.appendChild(item);
    });

    if (data.files.length > 1) {
      const dlAll = document.createElement("button");
      dlAll.textContent = "⬇ Download All";
      dlAll.style.marginTop = "8px";
      dlAll.addEventListener("click", () => {
        data.files.forEach((f, i) => {
          setTimeout(() => {
            const a = document.createElement("a");
            a.href = f.url; a.download = f.name;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
          }, i * 500);
        });
      });
      list.appendChild(dlAll);
    }

  } catch (err) {
    list.innerHTML = '<div class="error-msg">Could not reach server. Please try again.</div>';
    console.error(err);
  }
}

/* ─── UTILITIES ──────────────────────────────────────────── */
function getIcon(name) {
  const ext = (name || "").split(".").pop().toLowerCase();
  const m = {
    pdf:"📄", jpg:"🖼️", jpeg:"🖼️", png:"🖼️", gif:"🖼️", webp:"🖼️",
    mp4:"🎬", mov:"🎬", avi:"🎬", mp3:"🎵", wav:"🎵",
    zip:"🗜️", rar:"🗜️", "7z":"🗜️",
    doc:"📝", docx:"📝", xls:"📊", xlsx:"📊", ppt:"📑", pptx:"📑",
    txt:"📃", js:"💻", ts:"💻", html:"🌐", css:"🎨", py:"🐍"
  };
  return m[ext] || "📁";
}

function formatBytes(b) {
  if (!b) return "0 B";
  if (b < 1024)    return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function showToast(msg, type) {
  const old = document.getElementById("ls-toast");
  if (old) old.remove();
  const t = document.createElement("div");
  t.id = "ls-toast";
  t.textContent = msg;
  t.style.cssText = `
    position:fixed;bottom:28px;left:50%;transform:translateX(-50%);
    background:${type === "error" ? "#dc2626" : "#16a34a"};
    color:#fff;padding:12px 26px;border-radius:10px;
    font-size:0.9rem;font-weight:600;z-index:9999;
    box-shadow:0 4px 24px rgba(0,0,0,0.22);
    white-space:nowrap;
  `;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
