let selectedFiles = [];

/* ─── FILE INPUT ─────────────────────────────────────────── */
document.getElementById("fileInput").addEventListener("change", (e) => {
  addFiles([...e.target.files]);
  e.target.value = ""; // allow re-selecting same file
});

function addFiles(newFiles) {
  newFiles.forEach(file => {
    // Avoid exact duplicates (same name + size)
    if (!selectedFiles.find(f => f.name === file.name && f.size === file.size)) {
      selectedFiles.push(file);
    }
  });
  renderFileList();
}

/* ─── DRAG & DROP ────────────────────────────────────────── */
const dropZone = document.getElementById("dropZone");

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  addFiles([...e.dataTransfer.files]);
});

/* ─── RENDER FILE LIST ───────────────────────────────────── */
function renderFileList() {
  const list = document.getElementById("selectedFiles");
  list.innerHTML = "";

  selectedFiles.forEach((file, index) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span title="${file.name}">${truncate(file.name, 32)} <small style="color:#999">(${formatBytes(file.size)})</small></span>
      <span class="remove" onclick="removeFile(${index})" title="Remove">✕</span>
    `;
    list.appendChild(li);
  });
}

function removeFile(index) {
  selectedFiles.splice(index, 1);
  renderFileList();
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 3) + "..." : str;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/* ─── UPLOAD / GENERATE LINK ─────────────────────────────── */
async function uploadFiles() {
  if (selectedFiles.length === 0) {
    alert("Please add at least one file.");
    return;
  }

  const btn = document.getElementById("generateBtn");
  btn.disabled = true;
  btn.textContent = "Uploading...";

  const duration = document.getElementById("duration").value;
  const formData = new FormData();

  selectedFiles.forEach(file => formData.append("files", file));
  formData.append("duration", duration);

  try {
    const res  = await fetch("/upload", { method: "POST", body: formData });
    const data = await res.json();

    if (data.error) {
      alert("Error: " + data.error);
      return;
    }

    // Show result box
    const resultBox = document.getElementById("resultBox");
    document.getElementById("generatedUrl").textContent  = data.url;
    document.getElementById("generatedCode").textContent = data.code;
    resultBox.style.display = "flex";

  } catch (err) {
    alert("Upload failed. Please check your connection and try again.");
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "⚡ Generate Link";
  }
}

/* ─── COPY URL ───────────────────────────────────────────── */
function copyUrl() {
  const text = document.getElementById("generatedUrl").textContent;
  if (!text) return;

  const copyBtn = document.getElementById("copyBtn");

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => flashCopied(copyBtn));
  } else {
    // Fallback for non-HTTPS or older browsers
    const temp = document.createElement("input");
    temp.value = text;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand("copy");
    document.body.removeChild(temp);
    flashCopied(copyBtn);
  }
}

function flashCopied(btn) {
  const original = btn.textContent;
  btn.textContent = "Copied!";
  btn.style.background = "#16a34a";
  setTimeout(() => {
    btn.textContent = original;
    btn.style.background = "";
  }, 2000);
}

/* ─── ACCESS FILES ───────────────────────────────────────── */
async function accessFiles() {
  const raw   = document.getElementById("accessInput").value.trim();
  const list  = document.getElementById("fileList");
  list.innerHTML = "";

  if (!raw) {
    list.innerHTML = '<div class="error-msg">Please enter a link or code.</div>';
    return;
  }

  // Accept either a full URL ending in /access/XXXXXX  OR a bare 6-digit code
  let code;
  const urlMatch = raw.match(/\/access\/(\d{6})$/);
  if (urlMatch) {
    code = urlMatch[1];
  } else if (/^\d{6}$/.test(raw)) {
    code = raw;
  } else {
    list.innerHTML = '<div class="error-msg">Invalid input. Paste the full link or enter a 6-digit code.</div>';
    return;
  }

  list.innerHTML = '<p style="color:#555;font-size:0.85rem;text-align:center;">Loading files…</p>';

  try {
    const res  = await fetch(`/api/access/${code}`);
    const data = await res.json();

    list.innerHTML = "";

    if (data.error) {
      list.innerHTML = `<div class="error-msg">${data.error}</div>`;
      return;
    }

    data.files.forEach(file => {
      const item = document.createElement("div");
      item.className = "file-dl-item";
      item.innerHTML = `
        <span title="${file.name}">${file.name}</span>
        <a href="${file.url}" download="${file.name}">⬇ Download</a>
      `;
      list.appendChild(item);
    });

    if (data.files.length > 1) {
      const dlAll = document.createElement("button");
      dlAll.textContent = "⬇ Download All";
      dlAll.style.marginTop = "4px";
      dlAll.onclick = () => {
        data.files.forEach((file, i) => {
          setTimeout(() => {
            const a = document.createElement("a");
            a.href = file.url;
            a.download = file.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }, i * 400);
        });
      };
      list.appendChild(dlAll);
    }

  } catch (err) {
    list.innerHTML = '<div class="error-msg">Failed to reach the server. Please try again.</div>';
    console.error(err);
  }
}

/* ─── ENTER KEY ON ACCESS INPUT ──────────────────────────── */
document.getElementById("accessInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") accessFiles();
});
