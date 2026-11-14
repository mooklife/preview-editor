/* Preview Editor — TUI Image Editor 팝업 (크롭·필터·스티커·모자이크) */

(() => {
  const STICKERS = [
    { id: "blur-circle", label: "블러원", src: "/static/stickers/blur-circle.svg" },
    { id: "privacy-bar", label: "가림막", src: "/static/stickers/privacy-bar.svg" },
    { id: "emoji-smile", label: "웃음", src: "/static/stickers/emoji-smile.svg" },
    { id: "emoji-cool", label: "선글라스", src: "/static/stickers/emoji-cool.svg" },
    { id: "cat-face", label: "고양이", src: "/static/stickers/cat-face.svg" },
    { id: "bear-face", label: "곰", src: "/static/stickers/bear-face.svg" },
    { id: "star-badge", label: "별", src: "/static/stickers/star-badge.svg" },
    { id: "heart", label: "하트", src: "/static/stickers/heart.svg" },
  ];

  let dialog = null;
  let mountEl = null;
  let statusEl = null;
  let titleEl = null;
  let stickerPanel = null;
  let ie = null;
  let mosaicOn = false;
  let mosaicHandlers = null;
  let session = null;
  let saving = false;
  let wheelBound = false;
  let resizeBound = false;

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "photoEditorDialog";
    dialog.className = "photo-editor-dialog";
    dialog.innerHTML = `
      <div class="photo-editor-shell">
        <header class="photo-editor-head">
          <strong id="photoEditorTitle">사진 편집</strong>
          <span class="photo-editor-status" id="photoEditorStatus"></span>
          <div class="photo-editor-nav">
            <button type="button" class="btn" data-pe="prev" title="이전 이미지">←</button>
            <button type="button" class="btn" data-pe="next" title="다음 이미지">→</button>
          </div>
          <div class="photo-editor-zoom" role="group" aria-label="줌">
            <button type="button" class="btn" data-pe="zoom-out" title="축소 (⌘/Ctrl+휠)">−</button>
            <button type="button" class="btn" data-pe="zoom-fit" title="창에 맞춤">맞춤</button>
            <button type="button" class="btn" data-pe="zoom-in" title="확대 (⌘/Ctrl+휠)">+</button>
          </div>
          <button type="button" class="btn" data-pe="mosaic" title="드래그 부분 모자이크">모자이크</button>
          <button type="button" class="btn" data-pe="stickers" title="스티커">스티커</button>
          <button type="button" class="btn primary" data-pe="save">저장</button>
          <button type="button" class="btn" data-pe="close">닫기</button>
        </header>
        <div class="photo-editor-stickers" id="photoEditorStickers" hidden></div>
        <div class="photo-editor-mount" id="photoEditorMount"></div>
      </div>
    `;
    document.body.appendChild(dialog);
    mountEl = dialog.querySelector("#photoEditorMount");
    statusEl = dialog.querySelector("#photoEditorStatus");
    titleEl = dialog.querySelector("#photoEditorTitle");
    stickerPanel = dialog.querySelector("#photoEditorStickers");
    stickerPanel.innerHTML = STICKERS.map(
      (s) =>
        `<button type="button" class="pe-sticker" data-sticker="${s.id}" title="${s.label}">
          <img src="${s.src}" alt="${s.label}" />
        </button>`
    ).join("");

    dialog.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-pe]");
      if (!btn) return;
      const act = btn.getAttribute("data-pe");
      if (act === "close") closeEditor({ saveCurrent: true });
      else if (act === "save") saveCurrent({ quiet: false });
      else if (act === "prev") navigate(-1);
      else if (act === "next") navigate(1);
      else if (act === "stickers") stickerPanel.hidden = !stickerPanel.hidden;
      else if (act === "mosaic") toggleMosaic(btn);
      else if (act === "zoom-in") applyZoom(1);
      else if (act === "zoom-out") applyZoom(-1);
      else if (act === "zoom-fit") fitToWindow({ resetZoom: true });
    });
    stickerPanel.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sticker]");
      if (!b || !ie) return;
      const hit = STICKERS.find((s) => s.id === b.getAttribute("data-sticker"));
      if (!hit) return;
      ie.addImageObject(hit.src).catch((err) => setPeStatus(String(err.message || err), true));
      setPeStatus(`스티커 · ${hit.label}`, false);
    });
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      closeEditor({ saveCurrent: true });
    });
    if (!wheelBound) {
      wheelBound = true;
      dialog.addEventListener(
        "wheel",
        (e) => {
          if (!ie || !mountEl || !mountEl.contains(e.target)) return;
          if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
          e.preventDefault();
          applyZoom(e.deltaY < 0 ? 1 : -1);
        },
        { passive: false }
      );
    }
    if (!resizeBound) {
      resizeBound = true;
      window.addEventListener("resize", () => {
        if (dialog && dialog.open && ie) fitToWindow({ resetZoom: false });
      });
    }
    return dialog;
  }

  function setPeStatus(msg, err) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("is-err", !!err);
  }

  function collectBodyImages(root) {
    if (!root) return [];
    return [...root.querySelectorAll("img")].filter((img) => {
      if (img.classList.contains("ProseMirror-separator")) return false;
      const src = img.getAttribute("src") || "";
      return src && !src.startsWith("data:");
    });
  }

  function itemFromImg(img) {
    const mdFile = (img.dataset.mdFile || "").split("?")[0].split("#")[0];
    const src = (img.getAttribute("src") || "").split("#")[0];
    return { mdFile, src, el: img };
  }

  function destroyEditor() {
    disableMosaic();
    if (ie) {
      try {
        ie.destroy();
      } catch (_) {}
      ie = null;
    }
    if (mountEl) mountEl.innerHTML = "";
  }

  function getFabricCanvas() {
    if (!ie) return null;
    try {
      return ie._graphics && ie._graphics.getCanvas && ie._graphics.getCanvas();
    } catch (_) {
      return null;
    }
  }

  function mountFitSize() {
    if (!mountEl) {
      return {
        w: Math.min(960, window.innerWidth - 96),
        h: Math.min(560, window.innerHeight - 220),
      };
    }
    const rect = mountEl.getBoundingClientRect();
    const w = Math.max(280, Math.floor(rect.width || mountEl.clientWidth || 0));
    const h = Math.max(220, Math.floor(rect.height || mountEl.clientHeight || 0));
    // TUI 하단 메뉴(~64px) + 내부 패딩 여유 — 가로가 창을 넘지 않게
    return {
      w: Math.max(260, w - 24),
      h: Math.max(180, h - 72),
    };
  }

  function updateZoomLabel() {
    if (!ie) return;
    let z = 1;
    try {
      if (typeof ie.getZoom === "function") z = ie.getZoom() || 1;
    } catch (_) {}
    const pct = Math.round(Number(z) * 100);
    if (!Number.isFinite(pct)) return;
    setPeStatus(`줌 ${pct}% · +/− 또는 ⌘/Ctrl+휠 · 맞춤`, false);
  }

  function fitToWindow(opts) {
    if (!ie || !mountEl) return;
    const resetZoom = !opts || opts.resetZoom !== false;
    const fit = mountFitSize();
    const uiW = Math.max(320, Math.floor(mountEl.clientWidth || fit.w));
    const uiH = Math.max(240, Math.floor(mountEl.clientHeight || fit.h));
    try {
      if (ie.ui && typeof ie.ui.resizeEditor === "function") {
        ie.ui.resizeEditor({
          uiSize: { width: `${uiW}px`, height: `${uiH}px` },
        });
      }
    } catch (_) {}
    try {
      if (ie._graphics) {
        ie._graphics.cssMaxWidth = fit.w;
        ie._graphics.cssMaxHeight = fit.h;
        if (typeof ie._graphics.adjustCanvasDimension === "function") {
          ie._graphics.adjustCanvasDimension();
        }
      }
    } catch (_) {}
    if (resetZoom) {
      try {
        if (typeof ie.setZoom === "function") ie.setZoom(1);
        else if (typeof ie.resetZoom === "function") ie.resetZoom();
      } catch (_) {}
    }
    updateZoomLabel();
  }

  function applyZoom(dir) {
    if (!ie) {
      setPeStatus("편집기 준비 전", true);
      return;
    }
    try {
      let cur = 1;
      try {
        if (typeof ie.getZoom === "function") cur = ie.getZoom() || 1;
      } catch (_) {}
      if (dir > 0) {
        if (typeof ie.zoomIn === "function") ie.zoomIn();
        else if (typeof ie.setZoom === "function") ie.setZoom(Math.min(4, cur * 1.25));
      } else if (dir < 0) {
        if (typeof ie.zoomOut === "function") ie.zoomOut();
        else if (typeof ie.setZoom === "function") ie.setZoom(Math.max(0.2, cur / 1.25));
      }
      // zoomIn이 no-op인 경우 setZoom으로 보정
      setTimeout(() => {
        try {
          const after = typeof ie.getZoom === "function" ? ie.getZoom() || 1 : cur;
          if (dir !== 0 && Math.abs(after - cur) < 0.001 && typeof ie.setZoom === "function") {
            ie.setZoom(dir > 0 ? Math.min(4, cur * 1.25) : Math.max(0.2, cur / 1.25));
          }
        } catch (_) {}
        updateZoomLabel();
      }, 0);
      updateZoomLabel();
    } catch (e) {
      setPeStatus(String(e.message || e || "줌 실패"), true);
    }
  }

  function loadIntoEditor(item) {
    destroyEditor();
    if (!mountEl || !window.tui || !tui.ImageEditor) {
      setPeStatus("ImageEditor 로드 실패", true);
      return;
    }
    const url = item.src.includes("?") ? item.src : `${item.src}?t=${Date.now()}`;
    const name = (item.mdFile || "image").split("/").pop();
    const fit = mountFitSize();
    const uiW = Math.max(320, Math.floor(mountEl.clientWidth || fit.w));
    const uiH = Math.max(240, Math.floor(mountEl.clientHeight || fit.h));
    ie = new tui.ImageEditor(mountEl, {
      includeUI: {
        loadImage: { path: url, name },
        menu: ["crop", "flip", "rotate", "draw", "shape", "icon", "text", "filter"],
        initMenu: "filter",
        uiSize: { width: `${uiW}px`, height: `${uiH}px` },
        menuBarPosition: "bottom",
      },
      cssMaxWidth: fit.w,
      cssMaxHeight: fit.h,
      usageStatistics: false,
    });
    session.dirty = false;
    try {
      ie.on("undoStackChanged", () => {
        if (session) session.dirty = true;
      });
      ie.on("redoStackChanged", () => {
        if (session) session.dirty = true;
      });
    } catch (_) {}
    const afterLoad = () => {
      fitToWindow({ resetZoom: true });
      setPeStatus("창에 맞춤 · +/− 줌 · 스티커·모자이크 가능", false);
    };
    try {
      ie.on("loadImage", afterLoad);
    } catch (_) {}
    setTimeout(afterLoad, 150);
    setTimeout(afterLoad, 450);
    const n = session.items.length;
    const i = session.index + 1;
    titleEl.textContent = `사진 편집 · ${i}/${n} · ${name}`;
    setPeStatus("불러오는 중…", false);
  }

  async function toDataUrl() {
    if (!ie) throw new Error("editor not ready");
    const dataUrl = ie.toDataURL({ format: "jpeg", quality: 0.92 });
    if (!dataUrl || !dataUrl.startsWith("data:image/")) {
      throw new Error("export failed");
    }
    return dataUrl;
  }

  async function saveCurrent(opts) {
    const quiet = !!(opts && opts.quiet);
    if (!session || !ie || saving) return false;
    const item = session.items[session.index];
    if (!item || !item.mdFile) {
      setPeStatus("이미지 경로 없음", true);
      return false;
    }
    saving = true;
    setPeStatus("저장 중…", false);
    try {
      const dataUrl = await toDataUrl();
      const res = await fetch("/api/image-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: session.draftPath,
          md_path: item.mdFile,
          data_url: dataUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "save failed");
      const bust = `${data.media_url}?t=${Date.now()}`;
      item.src = data.media_url;
      if (item.el && item.el.isConnected) {
        const w = item.el.dataset.w || "100";
        item.el.setAttribute("src", bust);
        item.el.dataset.w = w;
      }
      session.dirty = false;
      setPeStatus(quiet ? "자동 저장됨" : "저장됨 · 파일에 반영", false);
      if (typeof session.onSaved === "function") {
        session.onSaved(item, data);
      }
      return true;
    } catch (e) {
      setPeStatus(String(e.message || e), true);
      return false;
    } finally {
      saving = false;
    }
  }

  async function navigate(delta) {
    if (!session) return;
    const next = session.index + delta;
    if (next < 0 || next >= session.items.length) {
      setPeStatus(delta < 0 ? "첫 이미지" : "마지막 이미지", false);
      return;
    }
    await saveCurrent({ quiet: true });
    session.index = next;
    requestAnimationFrame(() => loadIntoEditor(session.items[session.index]));
  }

  function pixelateAt(canvas, clientX, clientY, brush) {
    const el = canvas.upperCanvasEl || canvas.lowerCanvasEl || canvas.getElement();
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * canvas.getWidth();
    const y = ((clientY - rect.top) / rect.height) * canvas.getHeight();
    const ctx = canvas.getContext();
    if (!ctx) return;
    const half = brush / 2;
    const sx = Math.max(0, Math.floor(x - half));
    const sy = Math.max(0, Math.floor(y - half));
    const sw = Math.min(brush, canvas.getWidth() - sx);
    const sh = Math.min(brush, canvas.getHeight() - sy);
    if (sw < 2 || sh < 2) return;
    let imgData;
    try {
      imgData = ctx.getImageData(sx, sy, sw, sh);
    } catch (_) {
      return;
    }
    const block = Math.max(6, Math.floor(brush / 4));
    const d = imgData.data;
    for (let by = 0; by < sh; by += block) {
      for (let bx = 0; bx < sw; bx += block) {
        let r = 0,
          g = 0,
          b = 0,
          n = 0;
        const h = Math.min(block, sh - by);
        const w = Math.min(block, sw - bx);
        for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            const i = ((by + yy) * sw + (bx + xx)) * 4;
            r += d[i];
            g += d[i + 1];
            b += d[i + 2];
            n += 1;
          }
        }
        if (!n) continue;
        r = (r / n) | 0;
        g = (g / n) | 0;
        b = (b / n) | 0;
        for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            const i = ((by + yy) * sw + (bx + xx)) * 4;
            d[i] = r;
            d[i + 1] = g;
            d[i + 2] = b;
          }
        }
      }
    }
    ctx.putImageData(imgData, sx, sy);
    canvas.requestRenderAll();
    if (session) session.dirty = true;
  }

  function disableMosaic() {
    mosaicOn = false;
    const canvas = getFabricCanvas();
    if (canvas && mosaicHandlers) {
      canvas.off("mouse:down", mosaicHandlers.down);
      canvas.off("mouse:move", mosaicHandlers.move);
      canvas.off("mouse:up", mosaicHandlers.up);
    }
    mosaicHandlers = null;
    const btn = dialog && dialog.querySelector('[data-pe="mosaic"]');
    if (btn) btn.classList.remove("is-active");
  }

  function toggleMosaic(btn) {
    if (mosaicOn) {
      disableMosaic();
      setPeStatus("모자이크 끔", false);
      return;
    }
    const canvas = getFabricCanvas();
    if (!canvas) {
      setPeStatus("캔버스 준비 전 — 잠시 후 다시", true);
      return;
    }
    try {
      ie.stopDrawingMode();
    } catch (_) {}
    mosaicOn = true;
    btn.classList.add("is-active");
    let painting = false;
    const brush = 36;
    mosaicHandlers = {
      down(opt) {
        painting = true;
        const e = opt.e;
        if (e) pixelateAt(canvas, e.clientX, e.clientY, brush);
      },
      move(opt) {
        if (!painting) return;
        const e = opt.e;
        if (e) pixelateAt(canvas, e.clientX, e.clientY, brush);
      },
      up() {
        painting = false;
      },
    };
    canvas.on("mouse:down", mosaicHandlers.down);
    canvas.on("mouse:move", mosaicHandlers.move);
    canvas.on("mouse:up", mosaicHandlers.up);
    setPeStatus("모자이크: 가릴 부분을 드래그", false);
  }

  async function closeEditor(opts) {
    if (!session) {
      if (dialog && dialog.open) dialog.close();
      return;
    }
    if (opts && opts.saveCurrent) {
      await saveCurrent({ quiet: true });
    }
    destroyEditor();
    const onClose = session.onClose;
    session = null;
    if (dialog && dialog.open) dialog.close();
    if (typeof onClose === "function") onClose();
  }

  function open(opts) {
    ensureDialog();
    const root = opts.root;
    const imgs = collectBodyImages(root);
    let items = imgs.map(itemFromImg).filter((it) => it.mdFile);
    if (!items.length && opts.img) {
      const one = itemFromImg(opts.img);
      if (one.mdFile) items = [one];
    }
    if (!items.length) {
      setPeStatus("편집할 본문 이미지가 없습니다", true);
      return;
    }
    let index = items.findIndex((it) => it.el === opts.img);
    if (index < 0) {
      const md = (opts.img && opts.img.dataset.mdFile) || "";
      index = items.findIndex((it) => it.mdFile === md);
    }
    if (index < 0) index = 0;
    session = {
      draftPath: opts.draftPath,
      items,
      index,
      dirty: false,
      onSaved: opts.onSaved,
      onClose: opts.onClose,
    };
    stickerPanel.hidden = true;
    if (!dialog.open) dialog.showModal();
    // dialog 레이아웃 확정 후 마운트 폭 기준으로 로드
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!session) return;
        loadIntoEditor(session.items[session.index]);
      });
    });
  }

  window.StoryPhotoEditor = {
    open,
    close: () => closeEditor({ saveCurrent: true }),
    stickers: STICKERS,
  };
})();
