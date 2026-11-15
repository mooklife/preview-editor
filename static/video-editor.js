/* Preview Editor — 간단 영상 트림 (ffmpeg /api/video-trim) */
(function (global) {
  "use strict";

  let dialog = null;
  let player = null;
  let startInput = null;
  let endInput = null;
  let statusEl = null;
  let current = null; // { draftPath, mdPath, mediaUrl, onSaved }

  function ensureDom() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.className = "pe-video-edit-dialog";
    dialog.innerHTML = `
      <div class="pe-video-edit-inner">
        <header>
          <strong>영상 편집 (앞·뒤 자르기)</strong>
          <button type="button" class="btn" data-close="1">닫기</button>
        </header>
        <video id="peVideoEditPlayer" controls playsinline preload="metadata"></video>
        <div class="pe-video-edit-controls">
          <label>시작(초) <input type="number" id="peVideoEditStart" min="0" step="0.1" value="0" /></label>
          <label>끝(초) <input type="number" id="peVideoEditEnd" min="0" step="0.1" /></label>
          <button type="button" class="btn" data-mark-start="1">지금→시작</button>
          <button type="button" class="btn" data-mark-end="1">지금→끝</button>
          <button type="button" class="btn" data-preview="1">구간 미리보기</button>
          <button type="button" class="btn primary" data-apply="1">적용·저장</button>
        </div>
        <p class="pe-video-edit-status" id="peVideoEditStatus"></p>
      </div>
    `;
    document.body.appendChild(dialog);
    player = dialog.querySelector("#peVideoEditPlayer");
    startInput = dialog.querySelector("#peVideoEditStart");
    endInput = dialog.querySelector("#peVideoEditEnd");
    statusEl = dialog.querySelector("#peVideoEditStatus");
    dialog.addEventListener("click", (e) => {
      const t = e.target.closest("[data-close],[data-mark-start],[data-mark-end],[data-preview],[data-apply]");
      if (!t) return;
      if (t.hasAttribute("data-close")) close();
      else if (t.hasAttribute("data-mark-start")) {
        startInput.value = (player.currentTime || 0).toFixed(1);
      } else if (t.hasAttribute("data-mark-end")) {
        endInput.value = (player.currentTime || 0).toFixed(1);
      } else if (t.hasAttribute("data-preview")) previewRange();
      else if (t.hasAttribute("data-apply")) applyTrim();
    });
    dialog.addEventListener("close", () => {
      if (player) {
        try {
          player.pause();
        } catch (_) {}
        player.removeAttribute("src");
      }
      current = null;
    });
    player.addEventListener("loadedmetadata", () => {
      if (!endInput.value && player.duration && isFinite(player.duration)) {
        endInput.value = player.duration.toFixed(1);
      }
      setStatus(`길이 ${player.duration ? player.duration.toFixed(1) : "?"}s`);
    });
  }

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }

  function previewRange() {
    const s = parseFloat(startInput.value || "0") || 0;
    const e = parseFloat(endInput.value || "0") || 0;
    if (e > s) {
      player.currentTime = s;
      player.play();
      const stop = () => {
        if (player.currentTime >= e) {
          player.pause();
          player.removeEventListener("timeupdate", stop);
        }
      };
      player.addEventListener("timeupdate", stop);
    }
  }

  async function applyTrim() {
    if (!current) return;
    const s = parseFloat(startInput.value || "0") || 0;
    const eRaw = endInput.value;
    const e = eRaw === "" ? null : parseFloat(eRaw);
    if (e != null && e <= s) {
      setStatus("끝 시각은 시작보다 커야 합니다");
      return;
    }
    setStatus("자르는 중… (ffmpeg)");
    try {
      const res = await fetch("/api/video-trim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: current.draftPath,
          md_path: current.mdPath,
          start: s,
          end: e,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "trim failed");
      setStatus("저장됨");
      const bust = (data.media_url || current.mediaUrl) + "?t=" + Date.now();
      player.src = bust;
      if (current.onSaved) current.onSaved({ md_path: data.md_path, media_url: bust });
      setTimeout(close, 400);
    } catch (err) {
      setStatus(String(err.message || err));
    }
  }

  function open(opts) {
    ensureDom();
    current = opts || {};
    startInput.value = "0";
    endInput.value = "";
    setStatus("로딩…");
    player.src = current.mediaUrl;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function close() {
    if (!dialog) return;
    try {
      dialog.close();
    } catch (_) {
      dialog.removeAttribute("open");
    }
  }

  global.StoryVideoEditor = { open, close };
})(window);
