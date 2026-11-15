/* Preview Editor — WYSIWYG (Toast UI) → md SSOT */

(() => {
  // Toast UI 표·인용 선택 버그 (ProseMirror CellSelection / TextSelection)
  // — 표 셀 드래그·인용 경계에서 콘솔 스팸·스크립트 중단을 막음
  function isToastSelectionNoise(msg, err) {
    const s = String(msg || "") + " " + String((err && err.message) || "");
    return (
      s.includes("cannot be invoked without 'new'") ||
      s.includes("TextSelection endpoint not pointing") ||
      (s.includes("blockQuote") && s.includes("inline content")) ||
      (s.includes("Class constructor") && s.includes("without 'new'"))
    );
  }
  window.addEventListener(
    "error",
    (ev) => {
      if (isToastSelectionNoise(ev && ev.message, ev && ev.error)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        return true;
      }
    },
    true
  );
  window.addEventListener(
    "unhandledrejection",
    (ev) => {
      const reason = ev && ev.reason;
      const msg =
        typeof reason === "string"
          ? reason
          : reason && reason.message
            ? reason.message
            : "";
      if (isToastSelectionNoise(msg, reason)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    },
    true
  );

  // /api/config 로 채움 (부팅 시)
  let csrfToken = "";
  let FEATURES = { tistory_summary: false, tistory_skip_topics: [] };
  const nativeFetch = window.fetch.bind(window);
  // 변경 요청(PUT/POST/DELETE)에 CSRF 토큰 자동 첨부 — photo-editor.js 포함
  window.fetch = (input, init = {}) => {
    const method = String((init && init.method) || "GET").toUpperCase();
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const sameOrigin = url.startsWith("/") || url.startsWith(location.origin);
    if (sameOrigin && method !== "GET" && method !== "HEAD" && csrfToken) {
      const headers = new Headers((init && init.headers) || {});
      headers.set("X-CSRF-Token", csrfToken);
      init = { ...init, headers };
    }
    return nativeFetch(input, init);
  };

  const $ = (id) => document.getElementById(id);
  const draftList = $("draftList");
  const statusEl = $("status");
  const pathEl = $("currentPath");
  const filterEl = $("filter");
  const fileImage = $("fileImage");
  const fileVideo = $("fileVideo");
  const editorMount = $("editorMount");
  let lastVideoLightbox = null; // { mediaUrl, mdFile, label }
  const mdDialog = $("mdDialog");
  const mdSource = $("mdSource");

  let drafts = [];
  let currentPath = null;
  let currentWpStatus = null; // publish|draft|none|unknown — 목록 배지와 동기
  let frontmatter = "";
  let savedFull = "";
  let editor = null;
  let suppressChange = false;
  let dirty = false; // Toast 라운드트립 오탐 방지 · 실제 수정만 true
  let selectedImg = null;
  let resizeDrag = null; // { startX, startW, parentW }
  let publishing = false; // WP draft/publish 연타 방지

  const imgToolbar = document.createElement("div");
  imgToolbar.className = "img-toolbar";
  imgToolbar.innerHTML = `
    <span class="img-w-label" id="imgWidthLabel">100%</span>
    <span class="sep"></span>
    <button type="button" class="btn" data-w="100" title="본문 폭에 꽉 채움(작은 원본도 확대)">맥스</button>
    <button type="button" class="btn" data-w="75">75%</button>
    <button type="button" class="btn" data-w="50">50%</button>
    <button type="button" class="btn" data-w="33">33%</button>
    <span class="sep"></span>
    <button type="button" class="btn" data-rot="-90" title="반시계 90°">↺</button>
    <button type="button" class="btn" data-rot="90" title="시계 90°">↻</button>
    <span class="sep"></span>
    <button type="button" class="btn" data-feat="1" title="이 이미지를 대표 썸네일로">대표</button>
    <span class="sep"></span>
    <button type="button" class="btn" data-edit="1" title="사진 편집 (크롭·필터·스티커·모자이크)">편집</button>
    <button type="button" class="btn" data-row="1" title="위아래 연속 사진 가로로 · 또는 사진을 다른 사진 옆으로 드래그">↔ 가로묶기</button>
    <button type="button" class="btn" data-move="up" title="위로 이동">↑</button>
    <button type="button" class="btn" data-move="down" title="아래로 이동">↓</button>
    <span class="sep"></span>
    <button type="button" class="btn danger icon-btn" data-del="1" title="이미지 삭제 (Delete)" aria-label="이미지 삭제"></button>
  `;
  document.body.appendChild(imgToolbar);

  const ICO = {
    rowUp:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14h16M4 18h16M12 4v8M8 8l4-4 4 4"/></svg>',
    rowDown:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 10h16M12 20v-8M8 16l4 4 4-4"/></svg>',
    rowDel:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16M4 12h16M4 16h10M17 14v6M14 17h6"/></svg>',
    colLeft:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4v16M14 4v16M18 4v16M4 12h6M8 8l-4 4 4 4"/></svg>',
    colRight:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v16M10 4v16M14 4v16M14 12h6M16 8l4 4-4 4"/></svg>',
    colDel:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4v16M12 4v16M16 4v10M14 17h6M17 14v6"/></svg>',
    merge:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="7" height="12" rx="1"/><rect x="14" y="6" width="7" height="12" rx="1"/><path d="M10 12h4"/></svg>',
    split:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="1"/><path d="M12 6v12"/></svg>',
    alignL:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h14"/></svg>',
    alignC:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M5 18h14"/></svg>',
    alignR:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M10 12h10M6 18h14"/></svg>',
    tableL:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="10" height="14" rx="1"/><path d="M7 9h4M7 12h4M7 15h4"/></svg>',
    tableC:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="10" height="14" rx="1"/><path d="M10 9h4M10 12h4M10 15h4"/></svg>',
    tableR:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="10" y="5" width="10" height="14" rx="1"/><path d="M13 9h4M13 12h4M13 15h4"/></svg>',
    trash:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12"/></svg>',
  };

  {
    const delBtn = imgToolbar.querySelector("[data-del]");
    if (delBtn) delBtn.innerHTML = ICO.trash;
  }

  function tblIconBtn(attrs, title, svg) {
    return `<button type="button" class="btn icon-btn" ${attrs} title="${title}" aria-label="${title}">${svg}</button>`;
  }

  const tableToolbar = document.createElement("div");
  tableToolbar.className = "table-toolbar";
  tableToolbar.innerHTML = `
    <span class="tbl-label">표</span>
    ${tblIconBtn('data-tbl="addRowToUp"', "위에 행 추가", ICO.rowUp)}
    ${tblIconBtn('data-tbl="addRowToDown"', "아래 행 추가", ICO.rowDown)}
    ${tblIconBtn('data-tbl="removeRow"', "행 삭제", ICO.rowDel)}
    <span class="sep"></span>
    ${tblIconBtn('data-tbl="addColumnToLeft"', "왼쪽 열 추가", ICO.colLeft)}
    ${tblIconBtn('data-tbl="addColumnToRight"', "오른쪽 열 추가", ICO.colRight)}
    ${tblIconBtn('data-tbl="removeColumn"', "열 삭제", ICO.colDel)}
    <span class="sep"></span>
    ${tblIconBtn('data-tbl="mergeCells"', "셀 병합 (여러 칸 선택)", ICO.merge)}
    ${tblIconBtn('data-tbl="splitCells"', "병합 해제", ICO.split)}
    <span class="sep"></span>
    <span class="tbl-label tbl-label-sub" title="칸 안 글자 정렬">칸</span>
    ${tblIconBtn('data-col-align="left"', "칸 글자 왼쪽", ICO.alignL)}
    ${tblIconBtn('data-col-align="center"', "칸 글자 가운데", ICO.alignC)}
    ${tblIconBtn('data-col-align="right"', "칸 글자 오른쪽", ICO.alignR)}
    <span class="sep"></span>
    <span class="tbl-label tbl-label-sub" title="표 전체 위치 (사진 배치와 같음)">배치</span>
    ${tblIconBtn('data-table-align="left"', "표 전체 왼쪽", ICO.tableL)}
    ${tblIconBtn('data-table-align="center"', "표 전체 가운데", ICO.tableC)}
    ${tblIconBtn('data-table-align="right"', "표 전체 오른쪽", ICO.tableR)}
    <span class="sep"></span>
    ${tblIconBtn('data-tbl="removeTable"', "표 삭제", ICO.trash)}
  `;
  document.body.appendChild(tableToolbar);
  let selectedTable = null;
  let liveTableColWidths = null; // table index → "30,40,30" (편집 중 유지)
  let colResizeDrag = null; // { table, colIndex, startX, startWidths, tableWidth }

  const colResizeLayer = document.createElement("div");
  colResizeLayer.className = "table-col-resize-layer";
  document.body.appendChild(colResizeLayer);

  const featuredDialog = $("featuredDialog");
  const featuredGrid = $("featuredGrid");
  const featuredEmpty = $("featuredEmpty");
  const featuredChip = $("featuredChip");
  const featuredChipImg = $("featuredChipImg");
  const featuredChipLabel = $("featuredChipLabel");
  const metaBar = $("metaBar");
  const titleBar = $("titleBar");
  const titleInput = $("titleInput");
  const categorySelect = $("categorySelect");
  const categoryHint = $("categoryHint");
  const blockGapGroup = $("blockGapGroup");
  const blockGapValue = $("blockGapValue");
  const newDraftDialog = $("newDraftDialog");
  const newDraftForm = $("newDraftForm");
  const newCategory = $("newCategory");
  let lastBodyForGaps = "";
  let suppressTitleInput = false;

  // WP 카테고리 — 서버 설정(categories)에서 받음 · {value,label,topic}
  let CATEGORY_OPTIONS = [];
  // topic → 기본 wp_category (topic별 첫 카테고리 + 설정 topic_defaults)
  let TOPIC_DEFAULT_WP = {};
  let DRAFTS_PREFIX = "drafts/";
  // drafts 밖 workspace 공용 미디어 접두 (예: assets/)
  let SHARED_MEDIA_PREFIXES = [];

  function isSharedMedia(file) {
    return SHARED_MEDIA_PREFIXES.some((p) => String(file || "").startsWith(p));
  }

  function applyConfig(cfg) {
    DRAFTS_PREFIX = cfg.drafts_prefix || "drafts/";
    SHARED_MEDIA_PREFIXES = (cfg.media_allow || []).filter(
      (p) => p && !String(p).startsWith(DRAFTS_PREFIX)
    );
    csrfToken = cfg.csrf_token || "";
    window.__PE_CSRF = csrfToken;
    FEATURES = Object.assign({ tistory_summary: false, tistory_skip_topics: [] }, cfg.features || {});
    CATEGORY_OPTIONS = Array.isArray(cfg.categories) ? cfg.categories : [];
    const derived = {};
    for (const c of CATEGORY_OPTIONS) {
      const t = c.topic || "general";
      if (!(t in derived)) derived[t] = c.value;
    }
    TOPIC_DEFAULT_WP = Object.assign(derived, cfg.topic_defaults || {});
    if (cfg.title) {
      document.title = cfg.title;
      const h1 = document.querySelector(".topbar h1");
      if (h1) h1.textContent = cfg.title;
    }
    document.body.classList.toggle("no-tistory", !FEATURES.tistory_summary);
    // boot 전 ensureCategoryOptions()가 빈 목록으로 ready=1 잠그는 레이스 방지
    if (categorySelect) delete categorySelect.dataset.ready;
    if (newCategory) delete newCategory.dataset.ready;
    ensureCategoryOptions();
    ensureNewCategoryOptions();
  }


  const imgFrame = document.createElement("div");
  imgFrame.className = "img-frame";
  imgFrame.innerHTML = `
    <div class="img-handle img-handle-nw" data-handle="nw" title="모서리 드래그"></div>
    <div class="img-handle img-handle-ne" data-handle="ne" title="모서리 드래그"></div>
    <div class="img-handle img-handle-sw" data-handle="sw" title="모서리 드래그"></div>
    <div class="img-handle img-handle-se" data-handle="se" title="모서리 드래그"></div>
    <div class="img-handle img-handle-w" data-handle="w" title="가로 드래그"></div>
    <div class="img-handle img-handle-e" data-handle="e" title="가로 드래그"></div>
  `;
  document.body.appendChild(imgFrame);

  const imgDropHint = document.createElement("div");
  imgDropHint.className = "pe-drop-hint";
  imgDropHint.hidden = true;
  document.body.appendChild(imgDropHint);
  let imgDrag = null; // { srcImg, startX, startY, active, targetImg, place }


  function setStatus(msg, kind) {
    statusEl.textContent = msg || "";
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  function isSummaryPath(path) {
    return /\/tistory-summary\.md$/.test(path || "");
  }

  function parentPostPath(path) {
    if (isSummaryPath(path)) {
      return String(path).replace(/\/tistory-summary\.md$/, "/post.md");
    }
    return path;
  }

  function draftDir(path) {
    return String(path || "").replace(/\/(post|tistory-summary)\.md$/, "");
  }

  function mediaBase(path) {
    return "/media/" + draftDir(path) + "/";
  }

  /** md 이미지 src → /media/... 미리보기 URL */
  function mdSrcToMediaUrl(src, draftPath) {
    const meta = parseSrcMeta(src.replace(/^\.\//, ""));
    let file = meta.file;
    let url;
    if (file.startsWith("images/")) {
      url = mediaBase(draftPath) + file;
    } else if (isSharedMedia(file)) {
      // workspace 루트 기준 공용 자산 (media_allow)
      url = "/media/" + file;
    } else if (file.startsWith(DRAFTS_PREFIX)) {
      url = "/media/" + file;
    } else {
      // 기본: draft 폴더 상대 (images 없이 파일명만 있는 경우 등)
      url = mediaBase(draftPath) + file;
    }
    if (meta.w !== 100) url += `#w=${meta.w}`;
    return url;
  }

  /** /media/... → md에 넣을 상대경로 */
  function mediaUrlToMdSrc(url, draftPath) {
    const meta = parseSrcMeta(url);
    let file = meta.file;
    const draftPrefix = mediaBase(draftPath);
    if (file.startsWith(draftPrefix)) {
      file = file.slice(draftPrefix.length);
    } else if (file.startsWith("/media/")) {
      file = file.slice("/media/".length);
    }
    let out = file;
    if (meta.w !== 100) out += `#w=${meta.w}`;
    return out;
  }

  function splitFrontmatter(text) {
    if (!text.startsWith("---")) return { fm: "", body: text };
    const end = text.indexOf("\n---", 3);
    if (end === -1) return { fm: "", body: text };
    const fm = text.slice(0, end + 4);
    let body = text.slice(end + 4);
    if (body.startsWith("\n")) body = body.slice(1);
    return { fm, body };
  }

  function getFmField(fm, key) {
    if (!fm) return "";
    const re = new RegExp(`^${key}:\\s*(.*)$`, "m");
    const m = fm.match(re);
    if (!m) return "";
    return m[1].trim().replace(/^["']|["']$/g, "");
  }

  function yamlQuote(value) {
    const s = String(value ?? "");
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  function setFmField(fm, key, value) {
    const hasWrap = fm.startsWith("---");
    let inner = fm;
    if (hasWrap) {
      const end = fm.indexOf("\n---", 3);
      inner = end === -1 ? fm.slice(3) : fm.slice(3, end);
      if (inner.startsWith("\n")) inner = inner.slice(1);
    }
    const lines = inner.split("\n").filter((ln, i, arr) => !(i === arr.length - 1 && ln === ""));
    let found = false;
    const next = lines.map((line) => {
      if (!line.includes(":")) return line;
      const k = line.split(":", 1)[0].trim();
      if (k !== key) return line;
      found = true;
      if (value === null || value === "") return null;
      return `${key}: ${value}`;
    }).filter((x) => x !== null);
    if (!found && value !== null && value !== "") next.push(`${key}: ${value}`);
    const body = next.join("\n");
    return `---\n${body}${body.endsWith("\n") ? "" : "\n"}---`;
  }

  function setFmString(fm, key, value) {
    const t = String(value ?? "").trim();
    return setFmField(fm, key, t ? yamlQuote(t) : null);
  }

  function getFeaturedPath() {
    return getFmField(frontmatter, "featured_image");
  }

  function setFeaturedPath(mdPath, altText) {
    frontmatter = setFmField(frontmatter, "featured_image", mdPath || null);
    if (mdPath) {
      const alt = (altText || PathBasename(mdPath)).replace(/\.[^.]+$/, "");
      frontmatter = setFmField(frontmatter, "featured_alt", alt || "featured");
    } else {
      frontmatter = setFmField(frontmatter, "featured_alt", null);
    }
    refreshFeaturedChip();
    markDirty();
    setStatus(mdPath ? `대표 썸네일 · ${mdPath}` : "대표 썸네일 해제", "dirty");
  }

  function PathBasename(p) {
    const parts = String(p || "").split("/");
    return parts[parts.length - 1] || p;
  }

  function refreshFeaturedChip() {
    const feat = getFeaturedPath();
    if (!currentPath || !feat) {
      featuredChip.hidden = true;
      $("btnFeaturedClear").hidden = true;
      return;
    }
    featuredChip.hidden = false;
    $("btnFeaturedClear").hidden = false;
    featuredChipImg.src = mdSrcToMediaUrl(feat, currentPath).split("#")[0];
    featuredChipLabel.textContent = PathBasename(feat);
  }

  async function openFeaturedPicker() {
    if (!currentPath) return;
    featuredGrid.innerHTML = "";
    featuredEmpty.hidden = true;
    const res = await fetch("/api/images?path=" + encodeURIComponent(currentPath));
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "이미지 목록 실패", "dirty");
      return;
    }
    const images = data.images || [];
    if (!images.length) {
      featuredEmpty.hidden = false;
      featuredDialog.showModal();
      return;
    }
    const current = getFeaturedPath();
    for (const img of images) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "featured-pick" + (img.md_path === current ? " is-active" : "");
      btn.innerHTML = `<img src="${img.media_url}" alt="" /><span>${img.name}</span>`;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        setFeaturedPath(img.md_path, img.name);
        featuredDialog.close();
      });
      featuredGrid.appendChild(btn);
    }
    featuredDialog.showModal();
  }

  function parseSrcMeta(src) {
    const noHash = src.split("#");
    const filePart = noHash[0].split("?")[0];
    let w = 100;
    const frag = noHash[1] || "";
    const m = /^w=(\d+)/.exec(frag);
    if (m) w = Math.min(100, Math.max(1, parseInt(m[1], 10)));
    return { file: filePart, w };
  }

  const VIDEO_EXT_RE = /\.(mp4|mov|m4v|webm)$/i;

  function isVideoSrc(src) {
    const file = String(src || "")
      .split("#")[0]
      .split("?")[0];
    return VIDEO_EXT_RE.test(file);
  }

  function mdFileFromSrc(src) {
    const meta = parseSrcMeta(String(src || "").replace(/^\.\//, ""));
    let mdFile = meta.file;
    if (
      !mdFile.startsWith("images/") &&
      !mdFile.startsWith("agent/") &&
      !mdFile.startsWith("drafts/") &&
      !mdFile.startsWith("http")
    ) {
      mdFile = `images/${mdFile}`;
    }
    return mdFile.split("?")[0].split("#")[0];
  }

  const PE_VIDEO_POSTER = "/static/pe-video-poster.png";

  /** Toast WW는 <video>/<iframe>을 곧 지움. 포스터 img만 유지. */
  function peSanitizeHtml(html) {
    return String(html || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  }

  function PathBasenameNoExt(p) {
    const name = String(p || "").split("/").pop() || "";
    return name.replace(/\.[^.]+$/, "");
  }

  function peVideoAlt(label, mediaUrl, mdFile) {
    const safe = String(label || "영상").replace(/@@/g, "");
    return `${safe}@@pe:${mediaUrl}@@${mdFile}@@`;
  }

  function videoFramePosterUrl(mdFile, path) {
    // images/foo.mp4 → /media/.../images/.poster-foo.jpg
    const base = String(mdFile || "").replace(/^images\//, "");
    const stem = base.replace(/\.[^.]+$/, "");
    if (!stem) return PE_VIDEO_POSTER;
    return `${mediaBase(path)}images/.poster-${stem}.jpg`;
  }

  /** Toast가 유지하는 포스터 이미지 마크다운 (프레임 썸네일 우선) */
  function videoPosterMarkdown(alt, src, path) {
    const mediaUrl = mdSrcToMediaUrl(src, path).split("#")[0].split("?")[0];
    const mdFile = mdFileFromSrc(src);
    const label = String(alt || "영상");
    const poster = videoFramePosterUrl(mdFile, path);
    return `![${peVideoAlt(label, mediaUrl, mdFile)}](${poster})`;
  }

  function videoHtmlToMarkdown(html, path) {
    let out = String(html || "");
    out = out.replace(/<iframe\b[^>]*>\s*<\/iframe>/gi, (block) => {
      if (!/pe-video-frame|pe-video-player\.html/i.test(block)) return block;
      const mdM = /\bdata-md-file\s*=\s*"([^"]+)"/i.exec(block);
      const titleM = /\btitle\s*=\s*"([^"]*)"/i.exec(block);
      const srcM = /\bsrc\s*=\s*"([^"]+)"/i.exec(block);
      let mdSrc = mdM ? mdM[1] : "";
      if (!mdSrc && srcM) {
        try {
          const u = new URL(srcM[1], "http://127.0.0.1:3013");
          mdSrc = u.searchParams.get("md") || "";
        } catch (_) {}
      }
      if (!mdSrc) return "";
      const alt = (titleM && titleM[1]) || PathBasenameNoExt(mdSrc);
      return `![${alt}](${mdSrc})`;
    });
    out = out.replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, (block) => {
      const srcM = /\bsrc\s*=\s*"([^"]+)"/i.exec(block);
      const titleM = /\btitle\s*=\s*"([^"]*)"/i.exec(block);
      const mdM = /\bdata-md-file\s*=\s*"([^"]+)"/i.exec(block);
      let mdSrc = mdM ? mdM[1] : srcM ? mediaUrlToMdSrc(srcM[1], path) : "";
      mdSrc = String(mdSrc || "")
        .split("#")[0]
        .split("?")[0];
      if (!mdSrc) return "";
      const alt = (titleM && titleM[1]) || PathBasenameNoExt(mdSrc);
      return `![${alt}](${mdSrc})`;
    });
    return out;
  }

  /** md 상대 이미지 → 에디터용 /media/... URL. 영상은 포스터 img. */
  function bodyToEditor(body, path) {
    const withMedia = body.replace(
      /!\[([^\]]*)\]\((?!https?:|data:|\/)([^)]+)\)/g,
      (_, alt, src) => {
        if (isVideoSrc(src)) return videoPosterMarkdown(alt, src, path);
        return `![${alt}](${mdSrcToMediaUrl(src, path)})`;
      }
    );
    return stripImageRowComments(captionsForEditor(withMedia));
  }

  function makeVideoPosterImg(mediaUrl, mdFile, alt) {
    const img = document.createElement("img");
    const framePoster = videoFramePosterUrl(mdFile, currentPath);
    img.src = framePoster;
    img.alt = peVideoAlt(alt || "영상", mediaUrl, mdFile);
    img.className = "pe-video-poster";
    img.dataset.mdFile = mdFile;
    img.dataset.mediaUrl = mediaUrl;
    img.title = `${alt || PathBasenameNoExt(mdFile)} · 클릭하여 재생`;
    img.setAttribute(
      "style",
      "display:block;width:100%;max-width:100%;height:auto;object-fit:cover;background:#111;cursor:pointer;"
    );
    img.addEventListener(
      "error",
      () => {
        // 프레임 없으면 생성 요청 후 폴백
        if (img.dataset.posterTried === "1") {
          img.src = PE_VIDEO_POSTER;
          return;
        }
        img.dataset.posterTried = "1";
        fetch("/api/video-poster", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: currentPath, md_path: mdFile }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (d && d.poster_url) img.src = d.poster_url + "?t=" + Date.now();
            else img.src = PE_VIDEO_POSTER;
          })
          .catch(() => {
            img.src = PE_VIDEO_POSTER;
          });
      },
      { once: true }
    );
    return img;
  }

  function hasVideoPosterFor(root, mdFile) {
    return [...root.querySelectorAll("img.pe-video-poster, img[alt*='@@pe:']")].some((img) => {
      const pe = parsePeVideoAlt(img.getAttribute("alt") || "");
      return (img.dataset.mdFile || (pe && pe.mdFile) || "") === mdFile;
    });
  }

  /** Toast WW가 mp4를 버린 뒤, 원본 md 기준으로 포스터를 캡션 앞에 삽입 */
  function injectVideosFromSourceMd(sourceBody) {
    const root = wwContentsRoot();
    if (!root || !currentPath || !sourceBody) return;
    const lines = String(sourceBody).split("\n");
    const pairs = [];
    for (let i = 0; i < lines.length; i++) {
      const im = /^!\[([^\]]*)\]\(([^)]+\.(?:mp4|mov|m4v|webm)[^)]*)\)\s*$/i.exec(
        lines[i].trim()
      );
      if (!im) continue;
      let caption = null;
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j += 1;
      if (j < lines.length && parseCaptionJsonLine(lines[j]) != null) {
        caption = parseCaptionJsonLine(lines[j]);
        j += 1;
        while (j < lines.length && !lines[j].trim()) j += 1;
      } else if (
        j < lines.length &&
        /^<!--/.test(lines[j].trim()) &&
        /"caption"/.test(lines[j])
      ) {
        j += 1;
        while (j < lines.length && !lines[j].trim()) j += 1;
      }
      if (j < lines.length && isItalicCaptionLine(lines[j])) {
        caption = lines[j].trim().slice(1, -1);
      }
      pairs.push({ alt: im[1], src: im[2], caption });
    }
    pairs.forEach((p) => {
      const mdFile = mdFileFromSrc(p.src);
      if (hasVideoPosterFor(root, mdFile)) return;
      const mediaUrl = mdSrcToMediaUrl(p.src, currentPath).split("#")[0].split("?")[0];
      const img = makeVideoPosterImg(mediaUrl, mdFile, p.alt);
      const holder = document.createElement("p");
      holder.className = "pe-video-p";
      holder.appendChild(img);
      let capEl = null;
      if (p.caption) {
        const want = p.caption.trim();
        capEl = [...root.querySelectorAll("p")].find((el) => {
          const t = (el.textContent || "").trim();
          return t === want || t.replace(/\s+/g, " ") === want;
        });
      }
      if (capEl && capEl.parentNode) {
        capEl.parentNode.insertBefore(holder, capEl);
      } else {
        root.appendChild(holder);
      }
    });
  }

  function openVideoLightbox(mediaUrl, label, mdFile) {
    const dlg = document.getElementById("videoDialog");
    const player = document.getElementById("videoDialogPlayer");
    const titleEl = document.getElementById("videoDialogTitle");
    if (!dlg || !player) return;
    lastVideoLightbox = { mediaUrl, label: label || "영상", mdFile: mdFile || "" };
    if (titleEl) titleEl.textContent = label || "영상";
    player.src = mediaUrl;
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    try {
      player.play();
    } catch (_) {}
  }

  function openVideoEditorFor(opts) {
    if (!currentPath) return;
    if (!window.StoryVideoEditor) {
      setStatus("영상 편집기 스크립트 없음", "dirty");
      return;
    }
    const mediaUrl = opts.mediaUrl;
    const mdFile = opts.mdFile;
    const label = opts.label || PathBasenameNoExt(mdFile);
    closeVideoLightbox();
    StoryVideoEditor.open({
      draftPath: currentPath,
      mdPath: mdFile,
      mediaUrl,
      onSaved: () => {
        markDirty();
        setStatus("영상 잘림 저장됨 · 미리보기 갱신", "dirty");
        // 포스터 클릭 URL 캐시 bust
        decorateAllImages();
        setTimeout(() => decorateAllImages(), 200);
      },
    });
  }

  function stopVideoLightboxPlayer() {
    const player = document.getElementById("videoDialogPlayer");
    if (!player) return;
    try {
      player.pause();
    } catch (_) {}
    player.removeAttribute("src");
    try {
      player.load();
    } catch (_) {}
  }

  function closeVideoLightbox() {
    const dlg = document.getElementById("videoDialog");
    stopVideoLightboxPlayer();
    if (dlg && dlg.open) {
      try {
        dlg.close();
      } catch (_) {
        dlg.removeAttribute("open");
      }
    }
  }

  /** 하위 호환: 예전에 표로 저장된 가로묶기 → image-row 주석+이미지 */
    /** 저장 시: 이미지만 있는 2~3열 표 → <!-- image-row:N --> + 이미지 줄 */
  function editorTablesToImageRows(md) {
    const lines = String(md || "").split("\n");
    const out = [];
    let i = 0;
    const cellImg = function (cell) {
      const t = String(cell || "").trim();
      let cm = t.match(/^(!\[[^\]]*\]\([^)]+\))$/);
      if (!cm) cm = t.match(/^(\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\))$/);
      return cm ? cm[1] : null;
    };
    const isSep = function (line) {
      return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line || "").trim());
    };
    while (i < lines.length) {
      if (!_looksLikeTableRow(lines[i])) {
        out.push(lines[i]);
        i += 1;
        continue;
      }
      const block = [];
      while (i < lines.length && (_looksLikeTableRow(lines[i]) || isSep(lines[i]))) {
        block.push(lines[i]);
        i += 1;
      }
      const rows = [];
      for (let bi = 0; bi < block.length; bi++) {
        const bl = block[bi];
        if (isSep(bl)) continue;
        const raw = bl.trim().replace(/^\|/, "").replace(/\|$/, "");
        rows.push(raw.split("|").map(function (c) { return c.trim(); }));
      }
      let imgs = null;
      for (let ri = 0; ri < rows.length; ri++) {
        const cells = rows[ri];
        if (cells.length < 2 || cells.length > 3) continue;
        const parsed = cells.map(cellImg);
        if (parsed.length && parsed.every(Boolean)) {
          imgs = parsed;
          break;
        }
      }
      if (imgs) {
        if (out.length && out[out.length - 1].trim() !== "") out.push("");
        out.push("<!-- image-row:" + imgs.length + " -->");
        out.push("");
        out.push.apply(out, imgs);
        out.push("");
        continue;
      }
      out.push.apply(out, block);
    }
    return out.join("\n");
  }

  /** Toast WYSIWYG 불필요 이스케이프: 1\. → 1. , \( → ( , \~ → ~ (코드펜스 제외) */
  function unescapeToastMarkdown(md) {
    const chunks = String(md || "").split(/(```[\s\S]*?```)/g);
    return chunks
      .map((chunk, i) => {
        if (i % 2 === 1 && chunk.startsWith("```")) return chunk;
        return chunk
          .replace(/(\d)\\(\.)/g, "$1$2")
          .replace(/\\([()\[\]~])/g, "$1");
      })
      .join("");
  }

  function isMdImageLine(s) {
    const t = String(s || "").trim();
    return /^!\[[^\]]*\]\([^)]+\)$/.test(t) || /^\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)$/.test(t);
  }

  function parseCaptionJsonLine(s) {
    const m = String(s || "")
      .trim()
      .match(/^<!--\s*(\{[\s\S]*?"caption"[\s\S]*?\})\s*-->$/);
    if (!m) return null;
    try {
      return String(JSON.parse(m[1]).caption || "").trim() || null;
    } catch (_) {
      return null;
    }
  }

  function isItalicCaptionLine(s) {
    return /^\*[^*]+\*$/.test(String(s || "").trim());
  }

  /** Toast가 `![...](...)*캡션*`으로 붙인 줄 분리 */
  function splitGluedImageCaption(line) {
    const s = String(line || "").trim();
    let m = s.match(/^(!\[[^\]]*\]\([^)]+\))\*([^*]+)\*$/);
    if (!m) m = s.match(/^(\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\))\*([^*]+)\*$/);
    if (!m) return null;
    return { image: m[1], caption: m[2] };
  }

  /**
   * 에디터 표시용: caption JSON 주석만 제거. *캡션*은 이미지 바로 아래에 유지.
   */
  function captionsForEditor(md) {
    const lines = String(md || "").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      const glued = splitGluedImageCaption(raw);
      if (glued) {
        out.push(glued.image);
        out.push(`*${glued.caption}*`);
        i += 1;
        continue;
      }
      if (isMdImageLine(raw)) {
        out.push(raw.trim());
        i += 1;
        let j = i;
        while (j < lines.length && !lines[j].trim()) j += 1;
        let fromJson = null;
        if (j < lines.length && parseCaptionJsonLine(lines[j]) != null) {
          fromJson = parseCaptionJsonLine(lines[j]);
          j += 1;
          while (j < lines.length && !lines[j].trim()) j += 1;
        } else if (j < lines.length && /^<!--/.test(lines[j].trim()) && /"caption"/.test(lines[j])) {
          j += 1;
          while (j < lines.length && !lines[j].trim()) j += 1;
        }
        if (j < lines.length && isItalicCaptionLine(lines[j])) {
          out.push(lines[j].trim());
          i = j + 1;
        } else if (fromJson) {
          out.push(`*${fromJson}*`);
          i = j;
        }
        continue;
      }
      if (parseCaptionJsonLine(raw) != null) {
        i += 1;
        continue;
      }
      out.push(raw);
      i += 1;
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n");
  }

  function paraNodeHasImage(node) {
    if (!node) return false;
    let found = false;
    node.descendants((n) => {
      if (n.type && n.type.name === "image") {
        found = true;
        return false;
      }
      return undefined;
    });
    return found;
  }

  function isEmphMarkName(name) {
    return (
      name === "emph" ||
      name === "em" ||
      name === "italic" ||
      name === "emphasis"
    );
  }

  function paraNodeIsEmCaption(node) {
    if (!node || node.type.name !== "paragraph") return false;
    if (paraNodeHasImage(node)) return false;
    const text = (node.textContent || "").trim();
    if (!text) return false;
    // Toast: text + emph 마크 · 또는 emphasis 노드
    if (node.childCount === 1) {
      const c = node.firstChild;
      if (c && (c.type.name === "emphasis" || c.type.name === "em")) return true;
    }
    let allItalic = true;
    let sawText = false;
    node.forEach((child) => {
      if (child.type && child.type.name === "hardBreak") return;
      if (child.isText) {
        sawText = true;
        const marks = child.marks || [];
        const hasEm = marks.some((m) => isEmphMarkName(m.type.name));
        if (!hasEm) allItalic = false;
      } else if (child.type && (child.type.name === "emphasis" || child.type.name === "em")) {
        sawText = true;
      } else {
        allItalic = false;
      }
    });
    return sawText && allItalic;
  }

  function isEmptyParagraphNode(node) {
    if (!node || node.type.name !== "paragraph") return false;
    if (paraNodeHasImage(node)) return false;
    if ((node.textContent || "").trim()) return false;
    return true;
  }

  /**
   * 이미지↔이탤릭 캡션 사이 Toast 빈 <p><br></p> 제거.
   * (드래그하면 잡히는 유령 줄바꿈 — 캡션 메타 아님)
   */
  function collapseEmptyCaptionGaps() {
    const view = getWwView();
    if (!view) return;
    const blocks = [];
    view.state.doc.forEach((node, pos) => {
      blocks.push({ node, pos });
    });
    const toDelete = [];
    for (let i = 0; i < blocks.length; i++) {
      const cur = blocks[i];
      if (!isEmptyParagraphNode(cur.node)) continue;
      const prev = blocks[i - 1];
      const next = blocks[i + 1];
      if (!prev || !next) continue;
      const prevImg = paraNodeHasImage(prev.node);
      const nextImg = paraNodeHasImage(next.node);
      const prevCap = paraNodeIsEmCaption(prev.node);
      const nextCap = paraNodeIsEmCaption(next.node);
      if ((prevImg && nextCap) || (prevCap && nextImg) || (prevImg && nextImg)) {
        toDelete.push(cur);
      }
    }
    if (!toDelete.length) return;
    let tr = view.state.tr;
    for (let i = toDelete.length - 1; i >= 0; i--) {
      const { pos, node } = toDelete[i];
      tr = tr.delete(pos, pos + node.nodeSize);
    }
    const prevSuppress = suppressChange;
    suppressChange = true;
    view.dispatch(tr);
    suppressChange = prevSuppress;
  }

  /**
   * 저장용: 이미지 다음 *캡션* → JSON 주석 + *캡션* 쌍으로 복원.
   */
  function captionsForStorage(md) {
    const lines = String(md || "").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      const glued = splitGluedImageCaption(raw);
      const imageLine = glued ? glued.image : raw;
      if (glued || isMdImageLine(imageLine)) {
        out.push(imageLine.trim());
        i += 1;
        while (i < lines.length && !lines[i].trim()) i += 1;
        let fromJson = null;
        if (i < lines.length && parseCaptionJsonLine(lines[i]) != null) {
          fromJson = parseCaptionJsonLine(lines[i]);
          i += 1;
          while (i < lines.length && !lines[i].trim()) i += 1;
        } else if (i < lines.length && /^<!--/.test(lines[i].trim()) && /"caption"/.test(lines[i])) {
          i += 1;
          while (i < lines.length && !lines[i].trim()) i += 1;
        }
        let fromItalic = glued ? glued.caption : null;
        if (i < lines.length && isItalicCaptionLine(lines[i])) {
          fromItalic = lines[i].trim().slice(1, -1);
          i += 1;
        }
        const cap = (fromItalic || fromJson || "").trim();
        if (cap) {
          out.push("");
          out.push(`<!-- ${JSON.stringify({ caption: cap })} -->`);
          out.push("");
          out.push(`*${cap}*`);
          out.push("");
        } else {
          out.push("");
        }
        continue;
      }
      if (parseCaptionJsonLine(raw) != null) {
        i += 1;
        continue;
      }
      out.push(raw);
      i += 1;
    }
    return out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "")
      .replace(/\n+$/, "\n");
  }

  /** 에디터 md → 저장용 상대경로 (#w= 유지, ?t= 제거) */
  function bodyFromEditor(body, path) {
    const draftPrefix = mediaBase(path);
    const escDraft = draftPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 0) <video> HTML → ![…](….mp4)
    let out = videoHtmlToMarkdown(body, path);
    // 0b) 포스터 ![label@@pe:url@@mdFile@@](/static/pe-video-poster…) → ![label](mdFile)
    out = out.replace(
      /!\[([^\]]*@@pe:([^@]+)@@([^@]+)@@[^\]]*)\]\([^)]+\)/g,
      (_, fullAlt, _url, mdFile) => {
        const label = String(fullAlt)
          .replace(/@@pe:[^@]+@@[^@]+@@/, "")
          .trim();
        return `![${label || PathBasenameNoExt(mdFile)}](${mdFile})`;
      }
    );
    // 0c) 구형 {|pe-video:…|} 포스터 (마커 없으면 그대로 둠 → applyDomVideosToMd가 보완)
    out = out.replace(
      /!\[([^\]]*)\]\([^)]*pe-video-poster[^)]*\)/g,
      (whole, alt) => {
        const pe = parsePeVideoAlt(alt);
        if (!pe || !pe.mdFile) return whole;
        const label =
          pe.label ||
          String(alt)
            .replace(/\{\|pe-video:[^}]+\|\}/, "")
            .replace(/@@pe:[^@]+@@[^@]+@@/, "")
            .trim() ||
          PathBasenameNoExt(pe.mdFile);
        return `![${label}](${pe.mdFile})`;
      }
    );
    // 1) draft 미디어
    out = out.replace(
      new RegExp("!\\[([^\\]]*)\\]\\(" + escDraft + "([^)]+)\\)", "g"),
      (_, alt, rest) => `![${alt}](${mediaUrlToMdSrc(draftPrefix + rest, path)})`
    );
    // 2) writer 루트 미디어 (/media/agent/...)
    out = out.replace(
      /!\[([^\]]*)\]\(\/media\/(agent\/style\/assets\/[^)]+)\)/g,
      (_, alt, rest) => {
        const meta = parseSrcMeta(rest);
        let src = meta.file;
        if (meta.w !== 100) src += `#w=${meta.w}`;
        return `![${alt}](${src})`;
      }
    );
    return unescapeToastMarkdown(out);
  }

  /** WYSIWYG 본문만 (md-preview 숨김 pane 제외) */
  function wwContentsRoot() {
    return (
      document.querySelector(".toastui-editor-ww-container .toastui-editor-contents") ||
      document.querySelector(".toastui-editor.ww-mode .toastui-editor-contents") ||
      document.querySelector(".ProseMirror.toastui-editor-contents") ||
      null
    );
  }

  /** DOM에 남은 폭을 md에 다시 심기 (Toast가 #w= 를 버릴 수 있음) */
  function applyDomWidthsToMd(md, path) {
    const root = wwContentsRoot();
    if (!root) return md;
    let out = md;
    root.querySelectorAll("img").forEach((img) => {
      const mdFile = img.dataset.mdFile;
      if (!mdFile) return;
      const w = parseInt(img.dataset.w || "100", 10) || 100;
      const want = w === 100 ? mdFile : `${mdFile}#w=${w}`;
      const esc = mdFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(!\\[[^\\]]*\\]\\()${esc}(?:#w=\\d+)?(\\))`, "g");
      out = out.replace(re, `$1${want}$2`);
    });
    return out;
  }

  function clearTableSelectionChrome() {
    document
      .querySelectorAll(".toastui-editor-contents table.table-selected")
      .forEach((t) => t.classList.remove("table-selected"));
  }

  function hideTableToolbar() {
    clearTableSelectionChrome();
    selectedTable = null;
    tableToolbar.classList.remove("is-open");
    hideColResizeHandles();
  }

  function positionTableToolbar(table) {
    const rect = table.getBoundingClientRect();
    const tw = tableToolbar.offsetWidth || 520;
    let left = rect.left + (rect.width - tw) / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    let top = rect.top - 44;
    if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - 52);
    tableToolbar.style.left = `${left}px`;
    tableToolbar.style.top = `${top}px`;
  }

  function normalizeColWidths(parts) {
    const nums = parts.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
    if (!nums.length) return [];
    const sum = nums.reduce((a, b) => a + b, 0) || 1;
    return nums.map((n) => (n / sum) * 100);
  }

  function parseColWidthsAttr(raw) {
    if (!raw) return [];
    return normalizeColWidths(String(raw).split(","));
  }

  function formatColWidths(widths) {
    return widths.map((w) => Math.round(w * 10) / 10).join(",");
  }

  function readTableColWidths(table) {
    if (!table) return [];
    const fromAttr = parseColWidthsAttr(table.getAttribute("data-col-widths"));
    if (fromAttr.length) return fromAttr;
    const firstRow = table.querySelector("tr");
    if (!firstRow) return [];
    const cells = [...firstRow.children].filter((c) => /^(TD|TH)$/i.test(c.tagName));
    if (!cells.length) return [];
    const total = cells.reduce((s, c) => s + c.getBoundingClientRect().width, 0) || 1;
    return normalizeColWidths(cells.map((c) => (c.getBoundingClientRect().width / total) * 100));
  }

  function paintTableColWidths(table, widths) {
    if (!table || !widths || !widths.length) return;
    const w = normalizeColWidths(widths);
    const formatted = formatColWidths(w);
    table.setAttribute("data-col-widths", formatted);
    table.classList.add("has-col-widths");
    table.style.tableLayout = "fixed";
    table.style.width = "100%";
    let cg = table.querySelector(":scope > colgroup");
    if (!cg) {
      cg = document.createElement("colgroup");
      table.insertBefore(cg, table.firstChild);
    }
    // 타이핑 중 remove/recreate 금지 — 기존 col만 갱신해 caret 유지
    while (cg.children.length > w.length) cg.removeChild(cg.lastChild);
    w.forEach((pct, i) => {
      let col = cg.children[i];
      if (!col) {
        col = document.createElement("col");
        cg.appendChild(col);
      }
      const next = `${pct}%`;
      if (col.style.width !== next) col.style.width = next;
    });
  }

  function rememberTableColWidths(table, widths) {
    const root = wwContentsRoot();
    if (!root || !table) return;
    const tables = [...root.querySelectorAll("table")];
    const idx = tables.indexOf(table);
    if (idx < 0) return;
    if (!liveTableColWidths) {
      liveTableColWidths = tables.map((t) => t.getAttribute("data-col-widths") || "");
    }
    while (liveTableColWidths.length < tables.length) liveTableColWidths.push("");
    liveTableColWidths[idx] = formatColWidths(widths);
  }

  function paintAllTableColWidths() {
    const root = wwContentsRoot();
    if (!root) return;
    const tables = [...root.querySelectorAll("table")];
    const fromBody = parseTableColsPlan(lastBodyForGaps);
    tables.forEach((t, i) => {
      const raw =
        (liveTableColWidths && liveTableColWidths[i]) ||
        t.getAttribute("data-col-widths") ||
        fromBody[i] ||
        "";
      const widths = parseColWidthsAttr(raw);
      if (widths.length) paintTableColWidths(t, widths);
    });
  }

  function hideColResizeHandles() {
    colResizeLayer.classList.remove("is-open");
    colResizeLayer.innerHTML = "";
  }

  function positionColResizeHandles(table) {
    if (!table || !table.isConnected) {
      hideColResizeHandles();
      return;
    }
    const firstRow = table.querySelector("tr");
    if (!firstRow) {
      hideColResizeHandles();
      return;
    }
    const cells = [...firstRow.children].filter((c) => /^(TD|TH)$/i.test(c.tagName));
    if (cells.length < 2) {
      hideColResizeHandles();
      return;
    }
    const tableRect = table.getBoundingClientRect();
    colResizeLayer.style.left = `${tableRect.left}px`;
    colResizeLayer.style.top = `${tableRect.top}px`;
    colResizeLayer.style.width = `${tableRect.width}px`;
    colResizeLayer.style.height = `${tableRect.height}px`;
    colResizeLayer.innerHTML = "";
    // 열 사이 경계(마지막 열 오른쪽 제외) — 좌우 폭 조절
    for (let i = 0; i < cells.length - 1; i += 1) {
      const cellRect = cells[i].getBoundingClientRect();
      const handle = document.createElement("div");
      handle.className = "table-col-resizer";
      handle.dataset.colIndex = String(i);
      handle.title = "열 폭 조절";
      handle.style.left = `${cellRect.right - tableRect.left - 3}px`;
      handle.style.top = "0";
      handle.style.height = "100%";
      colResizeLayer.appendChild(handle);
    }
    colResizeLayer.classList.add("is-open");
  }

  function showColResizeHandles(table) {
    if (!table) {
      hideColResizeHandles();
      return;
    }
    // 저장된 폭이 있으면 먼저 칠하고 핸들 배치
    const widths = readTableColWidths(table);
    if (widths.length) paintTableColWidths(table, widths);
    positionColResizeHandles(table);
  }

  function setTableAlignClass(table, align) {
    table.classList.remove("table-align-left", "table-align-center", "table-align-right");
    if (align === "left" || align === "center" || align === "right") {
      table.classList.add(`table-align-${align}`);
      table.setAttribute("data-table-align", align);
    } else {
      table.removeAttribute("data-table-align");
    }
    tableToolbar.querySelectorAll("[data-table-align]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-table-align") === align);
    });
  }

  function showTableToolbar(table) {
    if (!table) {
      hideTableToolbar();
      return;
    }
    clearTableSelectionChrome();
    selectedTable = table;
    table.classList.add("table-selected");
    tableToolbar.classList.add("is-open");
    setTableAlignClass(table, table.getAttribute("data-table-align") || "");
    positionTableToolbar(table);
    showColResizeHandles(table);
  }

  function findTableFromSelection() {
    const root = wwContentsRoot();
    if (!root) return null;
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode) return null;
    let n = sel.anchorNode;
    if (n.nodeType === 3) n = n.parentElement;
    const cell = n && n.closest && n.closest("td, th");
    if (!cell || !root.contains(cell)) return null;
    return cell.closest("table");
  }

  function refreshTableToolbar() {
    const table = findTableFromSelection();
    if (table) showTableToolbar(table);
    else hideTableToolbar();
  }

  function stripTableAlignComments(md) {
    return String(md || "")
      .replace(/(?:^|\n)<!--\s*table-align:(?:left|center|right)\s*-->\s*(?=\n|$)/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "");
  }

  function stripTableColsComments(md) {
    return String(md || "")
      .replace(/(?:^|\n)<!--\s*table-cols:[\d.,\s]+\s*-->\s*(?=\n|$)/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "");
  }

  function applyDomTableAlignToMd(md) {
    let clean = stripTableAlignComments(md);
    const root = wwContentsRoot();
    if (!root) return clean;
    const wwTables = [...root.querySelectorAll("table")];
    const aligns = wwTables.map((t) => t.getAttribute("data-table-align") || "");
    if (!aligns.some((a) => a)) return clean;

    const lines = clean.split("\n");
    const out = [];
    let ti = 0;
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      const s = raw.trim();
      if (_looksLikeTableRow(s)) {
        const align = aligns[ti] || "";
        ti += 1;
        if (align) {
          if (out.length && out[out.length - 1].trim() !== "") out.push("");
          out.push(`<!-- table-align:${align} -->`);
          out.push("");
        }
        while (i < lines.length && _looksLikeTableRow(lines[i].trim())) {
          out.push(lines[i]);
          i += 1;
        }
        continue;
      }
      out.push(raw);
      i += 1;
    }
    return out.join("\n");
  }

  function applyDomTableColsToMd(md) {
    let clean = stripTableColsComments(md);
    const root = wwContentsRoot();
    if (!root) return clean;
    const wwTables = [...root.querySelectorAll("table")];
    const cols = wwTables.map((t, i) => {
      const live = liveTableColWidths && liveTableColWidths[i];
      return live || t.getAttribute("data-col-widths") || "";
    });
    if (!cols.some((c) => c && parseColWidthsAttr(c).length)) return clean;

    const lines = clean.split("\n");
    const out = [];
    let ti = 0;
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      const s = raw.trim();
      if (_looksLikeTableRow(s)) {
        const col = cols[ti] || "";
        ti += 1;
        if (col && parseColWidthsAttr(col).length) {
          if (out.length && out[out.length - 1].trim() !== "") out.push("");
          out.push(`<!-- table-cols:${formatColWidths(parseColWidthsAttr(col))} -->`);
          out.push("");
        }
        while (i < lines.length && _looksLikeTableRow(lines[i].trim())) {
          out.push(lines[i]);
          i += 1;
        }
        continue;
      }
      out.push(raw);
      i += 1;
    }
    return out.join("\n");
  }

  function _looksLikeTableRow(s) {
    if (!s || s[0] !== "|") return false;
    return (s.match(/\|/g) || []).length >= 2;
  }

  function _isTableMetaComment(s) {
    return (
      /^<!--\s*table-align:(left|center|right)\s*-->$/.test(s) ||
      /^<!--\s*table-cols:[\d.,\s]+\s*-->$/.test(s)
    );
  }

  function parseTableAlignPlan(body) {
    const plan = [];
    const lines = String(body || "").split("\n");
    let pending = "";
    let i = 0;
    while (i < lines.length) {
      const s = lines[i].trim();
      if (!s) {
        i += 1;
        continue;
      }
      const m = s.match(/^<!--\s*table-align:(left|center|right)\s*-->$/);
      if (m) {
        pending = m[1];
        i += 1;
        continue;
      }
      if (/^<!--\s*table-cols:[\d.,\s]+\s*-->$/.test(s)) {
        i += 1;
        continue;
      }
      if (_looksLikeTableRow(s)) {
        plan.push(pending);
        pending = "";
        while (i < lines.length && _looksLikeTableRow(lines[i].trim())) i += 1;
        continue;
      }
      if (!_isTableMetaComment(s)) pending = "";
      i += 1;
    }
    return plan;
  }

  function parseTableColsPlan(body) {
    const plan = [];
    const lines = String(body || "").split("\n");
    let pending = "";
    let i = 0;
    while (i < lines.length) {
      const s = lines[i].trim();
      if (!s) {
        i += 1;
        continue;
      }
      const m = s.match(/^<!--\s*table-cols:([\d.,\s]+)\s*-->$/);
      if (m) {
        pending = m[1].trim();
        i += 1;
        continue;
      }
      if (/^<!--\s*table-align:(left|center|right)\s*-->$/.test(s)) {
        i += 1;
        continue;
      }
      if (_looksLikeTableRow(s)) {
        plan.push(pending);
        pending = "";
        while (i < lines.length && _looksLikeTableRow(lines[i].trim())) i += 1;
        continue;
      }
      if (!_isTableMetaComment(s)) pending = "";
      i += 1;
    }
    return plan;
  }

  function decorateTableAlignFromBody(body) {
    const plan = parseTableAlignPlan(body || lastBodyForGaps);
    const root = wwContentsRoot();
    if (!root) return;
    const tables = [...root.querySelectorAll("table")];
    tables.forEach((t, idx) => setTableAlignClass(t, plan[idx] || ""));
  }

  function decorateTableColsFromBody(body) {
    const plan = parseTableColsPlan(body || lastBodyForGaps);
    liveTableColWidths = plan.map((p) => p || "");
    const root = wwContentsRoot();
    if (!root) return;
    const tables = [...root.querySelectorAll("table")];
    tables.forEach((t, idx) => {
      const widths = parseColWidthsAttr(plan[idx] || "");
      if (widths.length) paintTableColWidths(t, widths);
    });
    if (selectedTable) positionColResizeHandles(selectedTable);
  }

  /** 문단·제목·인용·목록 등 WYSIWYG 최상위 정렬 대상 */
  function wwTextAlignBlocks(root) {
    return [...(root || wwContentsRoot() || { children: [] }).children].filter((el) =>
      /^(P|H[1-6]|BLOCKQUOTE|UL|OL)$/i.test(el.tagName)
    );
  }

  const TEXT_ALIGN_NODE_TYPES = new Set([
    "paragraph",
    "heading",
    "blockQuote",
    "bulletList",
    "orderedList",
  ]);

  function getWwView() {
    return (editor && editor.wwEditor && editor.wwEditor.view) || null;
  }

  function readElTextAlign(el) {
    if (!el) return "";
    const data = el.getAttribute("data-text-align");
    if (data === "left" || data === "center" || data === "right") return data;
    const cls = [...el.classList].find((c) => /^pe-text-align-(left|center|right)$/.test(c));
    if (cls) return cls.replace("pe-text-align-", "");
    const m = /text-align:\s*(left|center|right)/i.exec(el.getAttribute("style") || "");
    return m ? m[1] : "";
  }

  function attrsWithTextAlign(attrs, align) {
    const next = { ...(attrs || {}) };
    const htmlAttrs = { ...(next.htmlAttrs || {}) };
    const classNames = [...(next.classNames || [])].filter(
      (c) => !/^pe-text-align-/.test(c)
    );
    const style = String(htmlAttrs.style || "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s && !/^text-align\s*:/i.test(s));
    if (align && align !== "left") {
      style.push(`text-align:${align}`);
      classNames.push(`pe-text-align-${align}`);
    }
    if (style.length) htmlAttrs.style = style.join(";");
    else delete htmlAttrs.style;
    next.htmlAttrs = Object.keys(htmlAttrs).length ? htmlAttrs : null;
    next.classNames = classNames.length ? classNames : null;
    return next;
  }

  function collectAlignBlockPositions(view) {
    const { state } = view;
    const { selection, doc } = state;
    const found = [];
    const seen = new Set();
    const push = (pos, node) => {
      if (!node || !TEXT_ALIGN_NODE_TYPES.has(node.type.name) || seen.has(pos)) return;
      seen.add(pos);
      found.push({ pos, node });
    };
    if (selection.empty) {
      const $from = selection.$from;
      for (let d = $from.depth; d > 0; d -= 1) {
        const node = $from.node(d);
        if (TEXT_ALIGN_NODE_TYPES.has(node.type.name)) {
          push($from.before(d), node);
          break;
        }
      }
      return found;
    }
    doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (TEXT_ALIGN_NODE_TYPES.has(node.type.name)) {
        push(pos, node);
        return false;
      }
      return true;
    });
    return found;
  }

  function applyParagraphAlign(align) {
    if (!editor) return;
    const view = getWwView();
    if (!view) {
      setStatus("에디터 준비 전입니다", "dirty");
      return;
    }
    const blocks = collectAlignBlockPositions(view);
    if (!blocks.length) {
      setStatus("정렬할 문장을 드래그하거나 커서를 두세요", "dirty");
      return;
    }
    let tr = view.state.tr;
    blocks.forEach(({ pos, node }) => {
      tr = tr.setNodeMarkup(pos, null, attrsWithTextAlign(node.attrs, align));
    });
    view.dispatch(tr);
    markDirty();
    const label = align === "center" ? "가운데" : align === "right" ? "오른쪽" : "왼쪽";
    setStatus(`문장 ${label} 정렬 · 저장 시 md에 반영`, "dirty");
  }

  function makeAlignToolbarItem(align, tooltip) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toastui-editor-toolbar-icons pe-align-btn";
    button.style.backgroundImage = "none";
    button.style.margin = "0";
    button.setAttribute("aria-label", tooltip);
    button.innerHTML =
      align === "center" ? ICO.alignC : align === "right" ? ICO.alignR : ICO.alignL;
    // 툴바 mousedown이 에디터 선택을 지우지 않게
    button.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
    button.addEventListener("click", (e) => {
      e.preventDefault();
      applyParagraphAlign(align);
    });
    return { name: `peAlign${align}`, tooltip, el: button };
  }

  function makeVideoToolbarItem() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toastui-editor-toolbar-icons pe-video-btn";
    button.style.backgroundImage = "none";
    button.style.margin = "0";
    button.setAttribute("aria-label", "동영상 삽입");
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M17 10.5V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3.5l4 4v-11l-4 4z"/></svg>';
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", (e) => {
      e.preventDefault();
      if (fileVideo) fileVideo.click();
    });
    return { name: "peVideo", tooltip: "동영상 삽입", el: button };
  }

  function stripTextAlignComments(md) {
    return String(md || "")
      .replace(/(?:^|\n)<!--\s*text-align:(?:left|center|right)\s*-->\s*(?=\n|$)/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "");
  }

  function parseMdAlignableBlocks(md) {
    const lines = String(md || "").split("\n");
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      const s = raw.trim();
      if (!s) {
        i += 1;
        continue;
      }
      if (s.startsWith("```")) {
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith("```")) i += 1;
        if (i < lines.length) i += 1;
        continue;
      }
      if (_looksLikeTableRow(s)) {
        while (i < lines.length && _looksLikeTableRow(lines[i].trim())) i += 1;
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(s)) {
        i += 1;
        continue;
      }
      if (/^#{1,6}\s/.test(s)) {
        blocks.push({ start: i, end: i + 1 });
        i += 1;
        continue;
      }
      if (s.startsWith(">")) {
        const start = i;
        i += 1;
        while (i < lines.length) {
          const t = lines[i].trim();
          if (!t) break;
          if (!t.startsWith(">")) break;
          i += 1;
        }
        blocks.push({ start, end: i });
        continue;
      }
      if (/^([-*+]|\d+\.)\s/.test(s) || /^[-*+]\s\[[ xX]\]\s/.test(s)) {
        const start = i;
        i += 1;
        while (i < lines.length) {
          const t = lines[i];
          const tr = t.trim();
          if (!tr) break;
          if (/^([-*+]|\d+\.)\s/.test(tr) || /^[-*+]\s\[[ xX]\]\s/.test(tr) || /^\s+/.test(t)) {
            i += 1;
            continue;
          }
          break;
        }
        blocks.push({ start, end: i });
        continue;
      }
      const start = i;
      i += 1;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (!t) break;
        if (
          t.startsWith("```") ||
          _looksLikeTableRow(t) ||
          /^#{1,6}\s/.test(t) ||
          t.startsWith(">") ||
          /^([-*+]|\d+\.)\s/.test(t) ||
          /^[-*+]\s\[[ xX]\]\s/.test(t) ||
          /^(-{3,}|\*{3,}|_{3,})$/.test(t)
        ) {
          break;
        }
        i += 1;
      }
      blocks.push({ start, end: i });
    }
    return blocks;
  }

  function applyDomTextAlignToMd(md) {
    let clean = stripTextAlignComments(md);
    const root = wwContentsRoot();
    if (!root) return clean;
    const wwBlocks = wwTextAlignBlocks(root);
    const aligns = wwBlocks.map((el) => readElTextAlign(el));
    if (!aligns.some((a) => a && a !== "left")) return clean;

    const mdBlocks = parseMdAlignableBlocks(clean);
    const lines = clean.split("\n");
    const insertAt = new Map();
    const n = Math.min(wwBlocks.length, mdBlocks.length);
    for (let i = 0; i < n; i += 1) {
      const align = aligns[i];
      if (!align || align === "left") continue;
      insertAt.set(mdBlocks[i].start, align);
    }
    if (!insertAt.size) return clean;

    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (insertAt.has(i)) {
        if (out.length && out[out.length - 1].trim() !== "") out.push("");
        out.push(`<!-- text-align:${insertAt.get(i)} -->`);
        out.push("");
      }
      out.push(lines[i]);
    }
    return out.join("\n");
  }

  function parseTextAlignPlan(body) {
    const lines = String(body || "").split("\n");
    const plan = [];
    let pending = "";
    let i = 0;
    while (i < lines.length) {
      const s = lines[i].trim();
      if (!s) {
        i += 1;
        continue;
      }
      const cm = s.match(/^<!--\s*text-align:(left|center|right)\s*-->$/);
      if (cm) {
        pending = cm[1];
        i += 1;
        continue;
      }
      if (/^<!--\s*table-align:/.test(s) || /^<!--/.test(s)) {
        i += 1;
        continue;
      }
      if (s.startsWith("```")) {
        pending = "";
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith("```")) i += 1;
        if (i < lines.length) i += 1;
        continue;
      }
      if (_looksLikeTableRow(s)) {
        pending = "";
        while (i < lines.length && _looksLikeTableRow(lines[i].trim())) i += 1;
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(s)) {
        pending = "";
        i += 1;
        continue;
      }
      if (/^#{1,6}\s/.test(s)) {
        plan.push(pending);
        pending = "";
        i += 1;
        continue;
      }
      if (s.startsWith(">")) {
        plan.push(pending);
        pending = "";
        i += 1;
        while (i < lines.length && lines[i].trim().startsWith(">")) i += 1;
        continue;
      }
      if (/^([-*+]|\d+\.)\s/.test(s) || /^[-*+]\s\[[ xX]\]\s/.test(s)) {
        plan.push(pending);
        pending = "";
        i += 1;
        while (i < lines.length) {
          const t = lines[i];
          const tr = t.trim();
          if (!tr) break;
          if (/^([-*+]|\d+\.)\s/.test(tr) || /^[-*+]\s\[[ xX]\]\s/.test(tr) || /^\s+/.test(t)) {
            i += 1;
            continue;
          }
          break;
        }
        continue;
      }
      plan.push(pending);
      pending = "";
      i += 1;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (!t) break;
        if (
          t.startsWith("```") ||
          _looksLikeTableRow(t) ||
          /^#{1,6}\s/.test(t) ||
          t.startsWith(">") ||
          /^([-*+]|\d+\.)\s/.test(t) ||
          /^[-*+]\s\[[ xX]\]\s/.test(t) ||
          /^(-{3,}|\*{3,}|_{3,})$/.test(t) ||
          /^<!--/.test(t)
        ) {
          break;
        }
        i += 1;
      }
    }
    return plan;
  }

  function decorateTextAlignFromBody(body) {
    const plan = parseTextAlignPlan(body || lastBodyForGaps);
    const view = getWwView();
    if (!view) return;
    const { doc } = view.state;
    let tr = view.state.tr;
    let changed = false;
    let idx = 0;
    doc.forEach((node, pos) => {
      if (!TEXT_ALIGN_NODE_TYPES.has(node.type.name)) return;
      const align = plan[idx] || "";
      idx += 1;
      const next = attrsWithTextAlign(node.attrs, align);
      const prevStyle = (node.attrs.htmlAttrs && node.attrs.htmlAttrs.style) || "";
      const nextStyle = (next.htmlAttrs && next.htmlAttrs.style) || "";
      const prevCls = (node.attrs.classNames || []).join(" ");
      const nextCls = (next.classNames || []).join(" ");
      if (prevStyle === nextStyle && prevCls === nextCls) return;
      tr = tr.setNodeMarkup(pos, null, next);
      changed = true;
    });
    if (changed) {
      const prev = suppressChange;
      suppressChange = true;
      view.dispatch(tr);
      suppressChange = prev;
    }
  }

  function runTableCommand(cmd, payload) {
    if (!editor) return;
    try {
      if (payload !== undefined) editor.exec(cmd, payload);
      else editor.exec(cmd);
      markDirty();
      setTimeout(() => {
        refreshTableToolbar();
        decorateTableAlignFromBody(lastBodyForGaps);
        paintAllTableColWidths();
        // keep current table align class if still selected
        const t = findTableFromSelection();
        if (t && selectedTable && selectedTable.getAttribute("data-table-align")) {
          setTableAlignClass(t, selectedTable.getAttribute("data-table-align"));
        }
        if (t) showColResizeHandles(t);
      }, 40);
    } catch (e) {
      setStatus(String(e.message || e || "표 명령 실패"), "dirty");
    }
  }

  function fullMarkdown() {
    if (!editor || !currentPath) return savedFull;
    // video DOM → img(mp4) 직렬화 → md 추출 → 다시 video로 복구
    videosToImgsForMarkdown();
    let body = bodyFromEditor(editor.getMarkdown(), currentPath);
    body = applyDomVideosToMd(body);
    upgradeVideoImages();
    body = editorTablesToImageRows(body);
    body = applyDomWidthsToMd(body, currentPath);
    body = applyDomGapsToMd(body);
    body = applyDomTableAlignToMd(body);
    body = applyDomTableColsToMd(body);
    body = applyDomImageRowsToMd(body);
    body = applyDomTextAlignToMd(body);
    // WYSIWYG에는 *캡션*만 · 저장 시 JSON 주석 복원 (publish-wp figcaption)
    body = captionsForStorage(body);
    if (!frontmatter) return body;
    return frontmatter.endsWith("\n") ? frontmatter + body : frontmatter + "\n" + body;
  }

  function isDirty() {
    return !!dirty;
  }

  function markDirty() {
    if (!currentPath || suppressChange) return;
    dirty = true;
    setStatus("수정됨 · ⌘S 저장", "dirty");
  }

  function clearDirty() {
    dirty = false;
    if (currentPath) setStatus("저장됨", "ok");
    else setStatus("");
  }

  function refreshPublishButtons() {
    const summaryMode = isSummaryPath(currentPath);
    const on = !!currentPath && !publishing && !summaryMode;
    $("btnSave").disabled = !currentPath || publishing;
    $("btnDelete").disabled = !currentPath || publishing;
    $("btnPublish").disabled = !on;
    $("btnImage").disabled = !currentPath || publishing;
    if ($("btnVideo")) $("btnVideo").disabled = !currentPath || publishing;
    $("btnFeatured").disabled = !on;
    $("btnFeaturedClear").disabled = !on;
    $("btnMd").disabled = !currentPath || publishing;
    categorySelect.disabled = !on;
    // P(publish) 글은 WP draft 비활성 — 실수로 비공개 전환 방지
    const isPublished = currentWpStatus === "publish";
    $("btnDraft").disabled = !on || isPublished;
    $("btnDraft").title = publishing
      ? "발행 처리 중…"
      : summaryMode
        ? "티스토리 요약 파일 · WP 발행은 원글(post.md)에서"
        : isPublished
          ? "이미 publish(P)된 글 · draft로 내리려면 WP 관리자에서 처리"
          : "WordPress draft로 저장/갱신";
    $("btnPublish").title = publishing
      ? "발행 처리 중… 끝날 때까지 기다리세요"
      : summaryMode
        ? "티스토리 요약 파일 · WP 발행은 원글(post.md)에서"
        : isPublished
          ? "이미 공개됨 · 내용만 다시 업로드"
          : "WordPress에 공개(publish)";
    $("btnPublish").textContent = publishing
      ? "처리 중…"
      : isPublished
        ? "WP 재발행"
        : "WP publish";
    if (!currentPath || summaryMode) {
      featuredChip.hidden = true;
      $("btnFeaturedClear").hidden = true;
      metaBar.hidden = true;
    }
    refreshTitleUi();
  }

  function setButtonsEnabled(on) {
    if (!on) {
      $("btnSave").disabled = true;
      $("btnDelete").disabled = true;
      $("btnDraft").disabled = true;
      $("btnPublish").disabled = true;
      $("btnImage").disabled = true;
      $("btnFeatured").disabled = true;
      $("btnFeaturedClear").disabled = true;
      $("btnMd").disabled = true;
      categorySelect.disabled = true;
      featuredChip.hidden = true;
      $("btnFeaturedClear").hidden = true;
      metaBar.hidden = true;
      if (titleBar) titleBar.hidden = true;
      if (titleInput) {
        suppressTitleInput = true;
        titleInput.value = "";
        titleInput.disabled = true;
        suppressTitleInput = false;
      }
      return;
    }
    refreshPublishButtons();
  }

  function clearEditorWorkspace() {
    hideImgToolbar();
    hideTableToolbar();
    liveTableColWidths = null;
    colResizeDrag = null;
    document.body.classList.remove("is-col-resizing");
    if (editor) {
      try {
        editor.destroy();
      } catch (_) {
        /* ignore */
      }
      editor = null;
    }
    editorMount.innerHTML =
      '<p class="empty" id="editorEmpty">왼쪽에서 글을 고르면 여기에서 편집합니다. 이미지는 드래그·드롭하거나「이미지」로 넣으세요.</p>';
    currentPath = null;
    currentWpStatus = null;
    frontmatter = "";
    savedFull = "";
    lastBodyForGaps = "";
    dirty = false;
    pathEl.textContent = "글을 선택하세요";
    featuredChip.hidden = true;
    $("btnFeaturedClear").hidden = true;
    metaBar.hidden = true;
    if (titleBar) titleBar.hidden = true;
    if (titleInput) {
      suppressTitleInput = true;
      titleInput.value = "";
      titleInput.disabled = true;
      suppressTitleInput = false;
    }
    setButtonsEnabled(false);
  }

  async function deleteDraftCompletely() {
    if (!currentPath || publishing) return;
    const folder = draftDir(currentPath);
    const titleHint =
      (drafts.find((d) => d.path === parentPostPath(currentPath)) || {}).title ||
      folder;
    const ok = confirm(
      `「${titleHint}」를 완전 삭제할까요?\n\n` +
        `삭제 대상:\n- ${folder}/post.md\n- ${folder}/tistory-summary.md\n- ${folder}/images/ (있으면)\n\n` +
        `디스크에서 폴더 전체가 지워지며 되돌릴 수 없습니다.`
    );
    if (!ok) return;
    const again = confirm("정말 삭제할까요? 이 작업은 취소할 수 없습니다.");
    if (!again) return;
    try {
      const res = await fetch(
        "/api/draft?path=" + encodeURIComponent(currentPath),
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setStatus(data.error || "삭제 실패", "dirty");
        return;
      }
      const deleted = data.deleted || folder;
      clearEditorWorkspace();
      await loadDrafts();
      setStatus(`완전 삭제됨 · ${deleted}`, "ok");
    } catch (e) {
      setStatus(String(e.message || e), "dirty");
    }
  }

  function syncCurrentWpStatus(path) {
    const postPath = parentPostPath(path);
    const hit = drafts.find((d) => d.path === postPath);
    const fromList = hit && hit.status;
    const fromFm = isSummaryPath(path) ? null : getFmField(frontmatter, "status");
    currentWpStatus = fromList || fromFm || "none";
    refreshPublishButtons();
  }

  function ensureCategoryOptions() {
    // 옵션이 이미 채워졌고 개수가 맞으면 스킵 (설정 로드 전 빈 ready 잠금 방지)
    const want = 1 + CATEGORY_OPTIONS.length;
    if (
      categorySelect.dataset.ready === "1" &&
      categorySelect.options.length === want &&
      want > 1
    ) {
      return;
    }
    const prev = categorySelect.value;
    categorySelect.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "선택…";
    categorySelect.appendChild(blank);
    for (const opt of CATEGORY_OPTIONS) {
      const el = document.createElement("option");
      el.value = opt.value;
      el.textContent = opt.label;
      categorySelect.appendChild(el);
    }
    if (prev && [...categorySelect.options].some((o) => o.value === prev)) {
      categorySelect.value = prev;
    }
    categorySelect.dataset.ready = CATEGORY_OPTIONS.length ? "1" : "0";
  }

  function ensureNewCategoryOptions() {
    if (!newCategory) return;
    const want = 1 + CATEGORY_OPTIONS.length;
    if (
      newCategory.dataset.ready === "1" &&
      newCategory.options.length === want &&
      want > 1
    ) {
      return;
    }
    const prev = newCategory.value;
    newCategory.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "선택…";
    newCategory.appendChild(blank);
    for (const opt of CATEGORY_OPTIONS) {
      const el = document.createElement("option");
      el.value = opt.value;
      el.textContent = opt.label;
      newCategory.appendChild(el);
    }
    if (prev && [...newCategory.options].some((o) => o.value === prev)) {
      newCategory.value = prev;
    }
    newCategory.dataset.ready = CATEGORY_OPTIONS.length ? "1" : "0";
  }

  function isSpacerPara(el) {
    if (!el || el.tagName !== "P") return false;
    const t = (el.textContent || "").replace(/\u00a0/g, "").trim();
    if (t) return false;
    return true;
  }

  function setBlockGapClass(el, n) {
    const gap = Math.max(0, Math.min(3, parseInt(n, 10) || 0));
    el.classList.remove("ml-gap-1", "ml-gap-2", "ml-gap-3");
    if (gap <= 0) {
      el.removeAttribute("data-ml-gap");
    } else {
      el.setAttribute("data-ml-gap", String(gap));
      el.classList.add(`ml-gap-${gap}`);
    }
  }

  function wwTopBlocks() {
    const root = wwContentsRoot();
    if (!root) return [];
    return [...root.children].filter((el) => {
      if (el.nodeType !== 1) return false;
      const tag = el.tagName;
      if (!["P", "H1", "H2", "H3", "BLOCKQUOTE", "UL", "OL", "TABLE", "PRE", "HR"].includes(tag)) {
        return false;
      }
      return !isSpacerPara(el);
    });
  }

  function selectedGapBlocks() {
    const root = wwContentsRoot();
    if (!root) return [];
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return [];
    const range = sel.getRangeAt(0);
    const hit = [];
    const candidates = [
      ...root.querySelectorAll("p, h1, h2, h3, blockquote, li"),
    ];
    for (const el of candidates) {
      if (isSpacerPara(el)) continue;
      try {
        if (range.intersectsNode(el)) hit.push(el);
      } catch (_) {
        /* ignore */
      }
    }
    if (hit.length) return hit;
    let n = sel.anchorNode;
    if (n && n.nodeType === 3) n = n.parentElement;
    const one = n && n.closest && n.closest("p, h1, h2, h3, blockquote, li");
    if (one && root.contains(one) && !isSpacerPara(one)) return [one];
    return [];
  }

  function syncGapButtonsFromSelection() {
    const blocks = selectedGapBlocks();
    if (!blockGapGroup) return;
    if (!blocks.length) {
      if (blockGapValue) blockGapValue.textContent = "선택";
      blockGapGroup.querySelectorAll("[data-gap]").forEach((b) => b.classList.remove("is-active"));
      return;
    }
    const gaps = blocks.map((el) => parseInt(el.getAttribute("data-ml-gap") || "0", 10) || 0);
    const same = gaps.every((g) => g === gaps[0]);
    const v = same ? String(gaps[0]) : "";
    if (blockGapValue) blockGapValue.textContent = same ? (v === "0" ? "기본" : `+${v}줄`) : "혼합";
    blockGapGroup.querySelectorAll("[data-gap]").forEach((btn) => {
      btn.classList.toggle("is-active", same && btn.getAttribute("data-gap") === v);
    });
  }

  function applyGapToSelection(n) {
    const blocks = selectedGapBlocks();
    if (!blocks.length) {
      setStatus("여백을 줄 문단을 선택(또는 클릭)하세요", "dirty");
      return;
    }
    blocks.forEach((el) => setBlockGapClass(el, n));
    markDirty();
    syncGapButtonsFromSelection();
    const label = String(n) === "0" ? "기본(행간만)" : `+${n}줄`;
    setStatus(`여백 ${label} · 저장 시 md에 반영`, "dirty");
  }

  /** md 본문에서 블록 앞에 붙은 <!-- ml-gap:N --> 계획 추출 */
  function parseGapPlan(body) {
    const plan = [];
    const lines = String(body || "").split("\n");
    let pending = 0;
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      const s = raw.trim();
      if (!s) {
        i += 1;
        continue;
      }
      const gm = s.match(/^<!--\s*ml-gap:([123])\s*-->$/);
      if (gm) {
        pending = parseInt(gm[1], 10);
        i += 1;
        continue;
      }
      // caption JSON 등 메타 주석은 DOM 블록이 아님 (Toast에 안 넣음)
      if (s.startsWith("<!--")) {
        i += 1;
        continue;
      }
      plan.push(pending);
      pending = 0;
      // 한 블록 소비
      if (
        s.startsWith("#") ||
        s.startsWith("![") ||
        s.startsWith("---") ||
        s.startsWith("***") ||
        s.startsWith("___")
      ) {
        i += 1;
        continue;
      }
      if (s.startsWith("|") || s.startsWith("- ") || s.startsWith("* ") || s.startsWith("> ") || /^\d+\.\s/.test(s)) {
        const kind =
          s.startsWith("|") ? "table" : s.startsWith("> ") ? "quote" : "list";
        i += 1;
        while (i < lines.length) {
          const t = lines[i].trim();
          if (!t) break;
          if (kind === "table" && !t.startsWith("|")) break;
          if (kind === "quote" && !t.startsWith(">")) break;
          if (kind === "list" && !(t.startsWith("- ") || t.startsWith("* ") || /^\d+\.\s/.test(t))) break;
          i += 1;
        }
        continue;
      }
      // 일반 문단: 빈 줄까지
      i += 1;
      while (i < lines.length && lines[i].trim()) i += 1;
    }
    return plan;
  }

  function decorateGapsFromBody(body) {
    lastBodyForGaps = body || "";
    const plan = parseGapPlan(lastBodyForGaps);
    const blocks = wwTopBlocks();
    blocks.forEach((el, idx) => setBlockGapClass(el, plan[idx] || 0));
    syncGapButtonsFromSelection();
  }

  function stripGapComments(md) {
    return String(md || "")
      .replace(/(?:^|\n)<!--\s*ml-gap:[123]\s*-->\s*(?=\n|$)/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "");
  }

  /** DOM data-ml-gap → md 블록 앞 <!-- ml-gap:N --> */
  function applyDomGapsToMd(md) {
    let clean = stripGapComments(md);
    const blocks = wwTopBlocks();
    const gaps = blocks.map((el) => parseInt(el.getAttribute("data-ml-gap") || "0", 10) || 0);
    if (!gaps.some((g) => g > 0)) return clean;

    const lines = clean.split("\n");
    const out = [];
    let bi = 0;
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      const s = raw.trim();
      if (!s) {
        out.push(raw);
        i += 1;
        continue;
      }
      // caption JSON 주석은 DOM 블록이 아니므로 gap 인덱스에 넣지 않음
      if (parseCaptionJsonLine(s) != null || (s.startsWith("<!--") && !/^<!--\s*ml-gap:/.test(s) && !/^<!--\s*table-align:/.test(s) && !/^<!--\s*text-align:/.test(s))) {
        out.push(raw);
        i += 1;
        continue;
      }
      const gap = gaps[bi] || 0;
      if (gap >= 1 && gap <= 3) {
        if (out.length && out[out.length - 1].trim() !== "") out.push("");
        out.push(`<!-- ml-gap:${gap} -->`);
        out.push("");
      }
      bi += 1;
      out.push(raw);
      i += 1;
      if (
        s.startsWith("#") ||
        s.startsWith("![") ||
        s.startsWith("---") ||
        s.startsWith("***") ||
        s.startsWith("___")
      ) {
        continue;
      }
      if (s.startsWith("|") || s.startsWith("- ") || s.startsWith("* ") || s.startsWith("> ") || /^\d+\.\s/.test(s)) {
        const kind =
          s.startsWith("|") ? "table" : s.startsWith("> ") ? "quote" : "list";
        while (i < lines.length) {
          const t = lines[i].trim();
          if (!t) break;
          if (kind === "table" && !t.startsWith("|")) break;
          if (kind === "quote" && !t.startsWith(">")) break;
          if (kind === "list" && !(t.startsWith("- ") || t.startsWith("* ") || /^\d+\.\s/.test(t))) break;
          out.push(lines[i]);
          i += 1;
        }
        continue;
      }
      while (i < lines.length && lines[i].trim()) {
        out.push(lines[i]);
        i += 1;
      }
    }
    return out.join("\n");
  }

  function openNewDraftDialog() {
    if (isDirty() && !confirm("저장하지 않은 변경이 있습니다. 버릴까요?")) return;
    dirty = false;
    ensureNewCategoryOptions();
    newDraftForm.reset();
    // 현재 카테고리 있으면 기본값
    if (currentPath) {
      const cur = effectiveWpCategory();
      if (cur && CATEGORY_OPTIONS.some((o) => o.value === cur)) {
        newCategory.value = cur;
      }
    }
    newDraftDialog.showModal();
    $("newTitle").focus();
  }

  async function createNewDraft(ev) {
    ev.preventDefault();
    const title = ($("newTitle").value || "").trim();
    const wp_category = (newCategory.value || "").trim();
    const slug = ($("newSlug").value || "").trim();
    if (!title || !wp_category) {
      setStatus("제목·카테고리를 입력하세요", "dirty");
      return;
    }
    setStatus("초안 만드는 중…");
    try {
      const res = await fetch("/api/new-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, wp_category, slug }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "생성 실패");
      newDraftDialog.close();
      dirty = false;
      await loadDrafts();
      await openDraft(data.path);
      setStatus(`새 초안 · ${data.path}`, "ok");
    } catch (e) {
      setStatus(String(e.message || e), "dirty");
    }
  }

  function effectiveWpCategory() {
    const override = getFmField(frontmatter, "wp_category");
    if (override) return override;
    const topic = getFmField(frontmatter, "topic");
    return TOPIC_DEFAULT_WP[topic] || "";
  }

  function categoryLabel(slug) {
    const hit = CATEGORY_OPTIONS.find((o) => o.value === slug);
    return hit ? hit.label : slug || "—";
  }

  function refreshTitleUi() {
    if (!titleBar || !titleInput) return;
    if (!currentPath) {
      titleBar.hidden = true;
      suppressTitleInput = true;
      titleInput.value = "";
      titleInput.disabled = true;
      suppressTitleInput = false;
      return;
    }
    titleBar.hidden = false;
    titleInput.disabled = false;
    const t = getFmField(frontmatter, "title");
    if (suppressTitleInput) return;
    if (document.activeElement !== titleInput) {
      suppressTitleInput = true;
      titleInput.value = t;
      suppressTitleInput = false;
    }
  }

  function applyTitle(raw) {
    if (!currentPath) return;
    const t = String(raw ?? "").trim();
    frontmatter = setFmString(frontmatter, "title", t);
    const listPath = parentPostPath(currentPath);
    const hit = drafts.find((d) => d.path === listPath);
    if (hit && !isSummaryPath(currentPath)) {
      hit.title = t || hit.slug;
      const active = draftList.querySelector(
        `.draft-main.active .t, .draft-summary.active .t`
      );
      if (active && draftList.querySelector(".draft-main.active")) {
        const mainT = draftList.querySelector(".draft-main.active .t");
        if (mainT) mainT.textContent = hit.title;
      }
    }
    markDirty();
  }

  function refreshCategoryUi() {
    ensureCategoryOptions();
    refreshTitleUi();
    if (!currentPath) {
      metaBar.hidden = true;
      categorySelect.value = "";
      categoryHint.textContent = "";
      return;
    }
    if (isSummaryPath(currentPath)) {
      metaBar.hidden = true;
      return;
    }
    metaBar.hidden = false;
    const topic = getFmField(frontmatter, "topic");
    const wpCat = effectiveWpCategory();
    const known = CATEGORY_OPTIONS.some((o) => o.value === wpCat);
    if (wpCat && !known) {
      // 알 수 없는 슬러그도 선택 가능하게 임시 옵션
      let extra = Array.from(categorySelect.options).find((o) => o.value === wpCat);
      if (!extra) {
        extra = document.createElement("option");
        extra.value = wpCat;
        extra.textContent = wpCat;
        categorySelect.appendChild(extra);
      }
    }
    categorySelect.value = wpCat || "";
    const topicBit = topic ? `topic: ${topic}` : "topic 없음";
    categoryHint.textContent = wpCat
      ? `${topicBit} · WP ${categoryLabel(wpCat)} (${wpCat})`
      : `${topicBit} · WP 카테고리 미지정`;
  }

  function applyCategory(wpSlug) {
    if (!currentPath || !wpSlug) return;
    const opt = CATEGORY_OPTIONS.find((o) => o.value === wpSlug);
    frontmatter = setFmField(frontmatter, "wp_category", wpSlug);
    if (opt) {
      const curTopic = getFmField(frontmatter, "topic");
      // vibe-coding: go 유지, 그 외는 매핑 topic
      if (wpSlug === "vibe-coding" && curTopic === "go") {
        /* keep go */
      } else {
        frontmatter = setFmField(frontmatter, "topic", opt.topic);
      }
    }
    refreshCategoryUi();
    markDirty();
    setStatus(`카테고리 · ${categoryLabel(wpSlug)}`, "dirty");
  }

  function stripImageRowComments(md) {
    return String(md || "")
      .replace(/(?:^|\n)<!--\s*image-row:([23])\s*-->\s*(?=\n|$)/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "");
  }

  function _looksLikeImageOnlyLine(s) {
    const t = String(s || "").trim();
    if (!t) return false;
    if (/^!\[[^\]]*\]\([^)]+\)(?:\s*\*[^*]+\*)?$/.test(t)) return true;
    if (/^\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)(?:\s*\*[^*]+\*)?$/.test(t)) return true;
    return false;
  }

  function applyDomImageRowsToMd(md) {
    let clean = stripImageRowComments(md);
    const root = wwContentsRoot();
    if (!root) return clean;
    // pe-ir-item 연속 그룹 → image-row 주석
    const blocks = [...root.children];
    const flags = blocks.map((el) => {
      if (el.tagName !== "P") return 0;
      const m = /pe-ir-cols-([23])/.exec(el.className || "");
      if (!m) return 0;
      const imgs = [...el.querySelectorAll("img")].filter(isContentImg);
      return imgs.length === 1 ? parseInt(m[1], 10) : 0;
    });
    // Build set of md files that belong to rows
    const rowFiles = [];
    let i = 0;
    while (i < flags.length) {
      if (!flags[i]) {
        i += 1;
        continue;
      }
      const cols = flags[i];
      const group = [];
      while (i < flags.length && flags[i] === cols && group.length < cols) {
        const img = blocks[i].querySelector("img");
        if (img && isContentImg(img)) {
          const f = img.dataset.mdFile || (img.getAttribute("src") || "").split("/").pop().split("#")[0];
          group.push(f);
        }
        i += 1;
      }
      if (group.length >= 2) rowFiles.push(group);
    }
    if (!rowFiles.length) return clean;

    const lines = clean.split("\n");
    const out = [];
    let li = 0;
    let gi = 0;
    while (li < lines.length) {
      const s = lines[li].trim();
      if (_looksLikeImageOnlyLine(s)) {
        const run = [];
        while (li < lines.length && _looksLikeImageOnlyLine(lines[li].trim())) {
          run.push(lines[li]);
          li += 1;
        }
        const files = run.map((ln) => {
          const mm = ln.trim().match(/!\[[^\]]*\]\(([^)]+)\)/);
          if (!mm) return "";
          return mm[1].split("#")[0].split("?")[0].replace(/^\.\//, "");
        });
        const base = (f) => f.split("/").pop();
        let matched = null;
        if (gi < rowFiles.length) {
          const want = rowFiles[gi];
          if (
            files.length === want.length &&
            files.every((f, idx) => {
              const w = want[idx];
              return f === w || base(f) === base(w) || f.endsWith("/" + base(w));
            })
          ) {
            matched = want.length;
            gi += 1;
          }
        }
        if (matched) {
          if (out.length && out[out.length - 1].trim() !== "") out.push("");
          out.push("<!-- image-row:" + matched + " -->");
          out.push("");
        }
        out.push.apply(out, run);
        continue;
      }
      out.push(lines[li]);
      li += 1;
    }
    return out.join("\n");
  }

    function parseImageRowPlan(body) {
    const plan = [];
    const lines = String(body || "").split("\n");
    let pending = 0;
    let i = 0;
    let imgOrdinal = 0;
    while (i < lines.length) {
      const s = lines[i].trim();
      const rowM = /^<!--\s*image-row:([23])\s*-->$/.exec(s);
      if (rowM) {
        pending = parseInt(rowM[1], 10);
        i += 1;
        continue;
      }
      if (pending && _looksLikeImageOnlyLine(s)) {
        const run = [];
        const startOrd = imgOrdinal;
        while (i < lines.length && run.length < pending) {
          const t = lines[i].trim();
          if (!t) {
            i += 1;
            continue;
          }
          if (_looksLikeImageOnlyLine(t)) {
            run.push(i);
            imgOrdinal += 1;
            i += 1;
            continue;
          }
          break;
        }
        if (run.length === pending) {
          plan.push({ count: pending, startImgOrdinal: startOrd });
        }
        pending = 0;
        continue;
      }
      if (_looksLikeImageOnlyLine(s)) {
        imgOrdinal += 1;
        i += 1;
        continue;
      }
      if (s && !s.startsWith("<!--")) pending = 0;
      i += 1;
    }
    return plan;
  }

  function decorateImageRowsFromBody(body) {
    const root = wwContentsRoot();
    if (!root) return;
    // 예전 div / 표 가로묶기 해제 → 일반 문단으로
    unwrapImageRowTables(root);
    root.querySelectorAll("div.pe-image-row").forEach((row) => {
      const parent = row.parentNode;
      while (row.firstChild) parent.insertBefore(row.firstChild, row);
      row.remove();
    });
    [...root.children].forEach((el) => {
      const t = (el.textContent || "").trim();
      if (/^<!--\s*image-row:[23]\s*-->$/.test(t)) el.remove();
    });
    clearAllImageRowClasses(root);
    const groups = parseImageRowImageGroups(body || lastBodyForGaps);
    groups.forEach((files) => applyImageRowClassesByFiles(files));
  }

  function unwrapImageRowTables(root) {
    [...root.querySelectorAll("table")].forEach((table) => {
      const imgs = [...table.querySelectorAll("img")].filter(isContentImg);
      if (imgs.length < 2 || imgs.length > 3) return;
      // 이미지만 있는 표만 해제
      const tds = [...table.querySelectorAll("td, th")];
      const imgCells = tds.filter((td) => [...td.querySelectorAll("img")].some(isContentImg));
      if (imgCells.length < 2) return;
      const foreign = tds.some((td) => {
        const img = [...td.querySelectorAll("img")].find(isContentImg);
        const t = (td.textContent || "").replace(/\u200b/g, "").trim();
        if (!img) return !!t;
        return t && t !== (img.alt || "");
      });
      if (foreign) return;
      const parent = table.parentNode;
      const paras = imgs.map((img) => {
        const p = document.createElement("p");
        p.appendChild(img.cloneNode(true));
        return p;
      });
      paras.forEach((p) => parent.insertBefore(p, table));
      table.remove();
    });
  }

  function clearAllImageRowClasses(root) {
    root.querySelectorAll("p.pe-ir-item, p[class*='pe-ir-cols-']").forEach((p) => {
      p.classList.remove("pe-ir-item", "pe-ir-cols-2", "pe-ir-cols-3");
    });
    // PM attrs 도 가능하면 정리
    const view = getWwView();
    if (!view) return;
    let tr = view.state.tr;
    let changed = false;
    view.state.doc.forEach((node, pos) => {
      if (node.type.name !== "paragraph") return;
      const cls = node.attrs.classNames || [];
      if (!cls.some((c) => /^pe-ir-/.test(c))) return;
      const next = attrsWithImageRow(node.attrs, 0);
      tr = tr.setNodeMarkup(pos, null, next);
      changed = true;
    });
    if (changed) {
      const prev = suppressChange;
      suppressChange = true;
      view.dispatch(tr);
      suppressChange = prev;
    }
  }

  function attrsWithImageRow(attrs, cols) {
    const next = Object.assign({}, attrs || {});
    const classNames = (next.classNames || []).filter((c) => !/^pe-ir-/.test(c));
    if (cols === 2 || cols === 3) {
      classNames.push("pe-ir-item", "pe-ir-cols-" + cols);
    }
    next.classNames = classNames.length ? classNames : null;
    return next;
  }

  function applyImageRowClassesByFiles(files) {
    const root = wwContentsRoot();
    const view = getWwView();
    if (!root || !files || files.length < 2) return;
    const cols = files.length;
    const paras = files.map((f) => {
      const base = f.split("/").pop();
      const img = [...root.querySelectorAll("img")].find((el) => {
        if (!isContentImg(el)) return false;
        const src = (el.getAttribute("src") || "").split("#")[0];
        const md = el.dataset.mdFile || "";
        return src.endsWith("/" + base) || src.endsWith(base) || md.endsWith(base) || md === f;
      });
      return img ? img.closest("p") : null;
    });
    if (paras.some((p) => !p)) return;

    // 문단이 서로 떨어져 있으면 insertHTML 로 한곳에 모음(표 아님)
    const kids = [...root.children];
    const idxs = paras.map((p) => kids.indexOf(p));
    const consecutive =
      idxs.every((n) => n >= 0) &&
      Math.max.apply(null, idxs) - Math.min.apply(null, idxs) === cols - 1 &&
      idxs.slice().sort((a, b) => a - b).every((n, i, arr) => i === 0 || n === arr[i - 1] + 1);

    if (!consecutive) {
      insertImageRowFromImgs(
        paras.map((p) => p.querySelector("img")).filter(isContentImg)
      );
      return;
    }

    if (view) {
      let tr = view.state.tr;
      let changed = false;
      paras.forEach((p) => {
        try {
          const pos = view.posAtDOM(p, 0);
          const $pos = view.state.doc.resolve(pos);
          let depth = $pos.depth;
          while (depth > 0 && $pos.node(depth).type.name !== "paragraph") depth -= 1;
          if (depth <= 0) return;
          const node = $pos.node(depth);
          const before = $pos.before(depth);
          const next = attrsWithImageRow(node.attrs, cols);
          tr = tr.setNodeMarkup(before, null, next);
          changed = true;
        } catch (_) {}
      });
      if (changed) {
        const prev = suppressChange;
        suppressChange = true;
        view.dispatch(tr);
        suppressChange = prev;
      }
    }
    // DOM 클래스도 즉시 반영(트랜잭션 전/후 보강)
    paras.forEach((p) => {
      p.classList.add("pe-ir-item", "pe-ir-cols-" + cols);
    });
  }

    function parseImageRowImageGroups(body) {
    const lines = String(body || "").split("\n");
    const groups = [];
    let pending = 0;
    let i = 0;
    while (i < lines.length) {
      const s = lines[i].trim();
      const rowM = /^<!--\s*image-row:([23])\s*-->$/.exec(s);
      if (rowM) {
        pending = parseInt(rowM[1], 10);
        i += 1;
        continue;
      }
      if (pending && _looksLikeImageOnlyLine(s)) {
        const files = [];
        while (i < lines.length && files.length < pending) {
          const t = lines[i].trim();
          if (!t) {
            i += 1;
            continue;
          }
          if (_looksLikeImageOnlyLine(t)) {
            const mm = t.match(/!\[[^\]]*\]\(([^)]+)\)/);
            if (mm) files.push(mm[1].split("#")[0].split("?")[0].replace(/^\.\//, ""));
            i += 1;
            continue;
          }
          break;
        }
        if (files.length === pending) groups.push(files);
        pending = 0;
        continue;
      }
      if (s && !s.startsWith("<!--")) pending = 0;
      i += 1;
    }
    return groups;
  }

  function isContentImg(img) {
    if (!img || img.tagName !== "IMG") return false;
    if (img.classList.contains("ProseMirror-separator")) return false;
    if (img.classList.contains("pe-video-poster")) return false;
    if (parsePeVideoAlt(img.getAttribute("alt") || "")) return false;
    return true;
  }

  function syncImageRowBody() {
    try {
      if (editor && currentPath) {
        let body = bodyFromEditor(editor.getMarkdown(), currentPath);
        body = editorTablesToImageRows(body);
        body = applyDomImageRowsToMd(body);
        lastBodyForGaps = body;
      }
    } catch (_) {}
  }

  function detachImgPara(img) {
    let p = img.closest("p");
    if (!p) {
      p = document.createElement("p");
      if (img.parentNode) {
        img.parentNode.insertBefore(p, img);
        p.appendChild(img);
      }
    }
    const row = p.closest(".pe-image-row");
    if (row) {
      row.parentNode.insertBefore(p, row);
      const left = [...row.querySelectorAll("img")].filter(isContentImg);
      if (left.length < 2) {
        while (row.firstChild) row.parentNode.insertBefore(row.firstChild, row);
        row.remove();
      } else {
        row.className = `pe-image-row cols-${left.length}`;
        row.setAttribute("data-image-row", String(left.length));
      }
    }
    return p;
  }

  function buildImageRowParasHtml(imgs) {
    const cols = imgs.length;
    return imgs
      .map((img) => {
        const src = img.getAttribute("src") || "";
        const alt = (img.getAttribute("alt") || "").replace(/"/g, "&quot;");
        return (
          '<p class="pe-ir-item pe-ir-cols-' +
          cols +
          '"><img src="' +
          src +
          '" alt="' +
          alt +
          '"></p>'
        );
      })
      .join("");
  }

  function insertImageRowFromImgs(imgs) {
    if (!imgs || imgs.length < 2) return false;
    const root = wwContentsRoot();
    if (!root) return false;
    const blocks = imgs.map((img) => {
      const row = img.closest("table");
      if (row && root.contains(row)) return row;
      return img.closest("p") || img.parentElement;
    });
    const first = blocks[0];
    const last = blocks[blocks.length - 1];
    if (!first || !last || !root.contains(first) || !root.contains(last)) return false;
    try {
      const range = document.createRange();
      range.setStartBefore(first);
      range.setEndAfter(last);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = document.execCommand(
        "insertHTML",
        false,
        buildImageRowParasHtml(imgs)
      );
      if (ok) {
        setTimeout(function () {
          const root2 = wwContentsRoot();
          if (root2) unwrapImageRowTables(root2);
          const files = imgs.map((img) => {
            return (
              img.dataset.mdFile ||
              (img.getAttribute("src") || "").split("/").pop().split("#")[0]
            );
          });
          applyImageRowClassesByFiles(files);
          // Toast가 표 UI를 남기면 다시 문단으로
          if (root2) unwrapImageRowTables(root2);
          applyImageRowClassesByFiles(files);
        }, 60);
      }
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  function decorateImageRowTables() {
    // 하위 호환 이름 · 표는 더 이상 쓰지 않음
    const root = wwContentsRoot();
    if (!root) return;
    unwrapImageRowTables(root);
  }

    /** 앵커 사진 왼쪽/오른쪽에 moving을 붙여 2~3열 image-row 생성 */
  function mergeImagesIntoRow(anchorImg, movingImg, place) {
    if (!isContentImg(anchorImg) || !isContentImg(movingImg) || anchorImg === movingImg) {
      return;
    }
    const root = wwContentsRoot();
    if (!root || !root.contains(anchorImg) || !root.contains(movingImg)) return;

    const anchorRow = anchorImg.closest("p.pe-ir-item");
    let imgs = [];
    if (anchorRow) {
      const cols = parseInt((/pe-ir-cols-([23])/.exec(anchorRow.className) || [])[1] || "0", 10);
      // 같은 가로묶기 문단들 수집
      const root = wwContentsRoot();
      const kids = [...root.children];
      const idx = kids.indexOf(anchorRow);
      let start = idx;
      let end = idx;
      while (start > 0 && kids[start - 1].classList && kids[start - 1].classList.contains("pe-ir-item")) start -= 1;
      while (end + 1 < kids.length && kids[end + 1].classList && kids[end + 1].classList.contains("pe-ir-item")) end += 1;
      imgs = kids
        .slice(start, end + 1)
        .map((p) => p.querySelector("img"))
        .filter(isContentImg);
      if (cols && imgs.length > cols) imgs = imgs.slice(0, cols);
    } else {
      imgs = [anchorImg];
    }
    imgs = imgs.filter((i) => i !== movingImg);
    if (imgs.length >= 3) {
      setStatus("가로묶기는 최대 3장입니다", "dirty");
      return;
    }
    const aidx = Math.max(0, imgs.indexOf(anchorImg));
    const insertAt = place === "before" ? aidx : aidx + 1;
    imgs.splice(insertAt, 0, movingImg);
    imgs = imgs.slice(0, 3);
    if (imgs.length < 2) return;

    if (!insertImageRowFromImgs(imgs)) {
      setStatus("가로묶기 실패 · 다시 드래그해 보세요", "dirty");
      return;
    }
    syncImageRowBody();
    markDirty();
    hideImgToolbar();
    setTimeout(function () {
      const root2 = wwContentsRoot();
      const src = movingImg.getAttribute("src");
      const hit = root2 && [...root2.querySelectorAll("img")].find((i) => i.getAttribute("src") === src);
      if (hit) showImgToolbar(hit);
    }, 50);
    setStatus("가로묶기 " + imgs.length + "장 · 드래그로 붙임 · 저장 시 md 반영", "dirty");
  }

  function wrapSelectedImagesAsRow() {
    if (!selectedImg) return;
    const p = selectedImg.closest("p") || selectedImg.parentElement;
    if (!p) return;
    const root = wwContentsRoot();
    if (!root || !root.contains(p)) return;
    if (selectedImg.closest("p.pe-ir-item")) {
      setStatus("이미 가로묶기된 사진입니다", "ok");
      return;
    }
    const kids = [...root.children];
    let baseIdx = kids.indexOf(p);
    if (baseIdx < 0) {
      const row = p.closest("p.pe-ir-item, .pe-image-row");
      baseIdx = row ? kids.indexOf(row) : -1;
    }
    if (baseIdx < 0) return;
    const isImgPara = function (el) {
      if (!el) return false;
      if (el.classList && el.classList.contains("pe-image-row")) return false;
      if (el.tagName === "TABLE") return false;
      if (el.tagName !== "P") return false;
      const imgs = [...el.querySelectorAll("img")].filter(isContentImg);
      if (imgs.length !== 1) return false;
      const text = el.textContent.replace(imgs[0].alt || "", "").trim();
      return text === "";
    };
    const isEmptyPara = function (el) {
      return !!(
        el &&
        el.tagName === "P" &&
        !el.querySelector("img") &&
        !(el.textContent || "").trim()
      );
    };
    let start = baseIdx;
    let end = baseIdx;
    while (start > 0) {
      const prev = kids[start - 1];
      if (isImgPara(prev) || isEmptyPara(prev)) start -= 1;
      else break;
    }
    while (end + 1 < kids.length) {
      const next = kids[end + 1];
      if (isImgPara(next) || isEmptyPara(next)) end += 1;
      else break;
    }
    const group = kids.slice(start, end + 1).filter(isImgPara);
    if (group.length < 2) {
      setStatus(
        "가로묶기: 사진을 위아래로 연속 배치한 뒤 누르거나, 다른 사진 옆으로 드래그하세요",
        "dirty"
      );
      return;
    }
    const take = group.slice(0, Math.min(3, group.length));
    const imgs = take.map((el) => el.querySelector("img")).filter(isContentImg);
    if (!insertImageRowFromImgs(imgs)) {
      setStatus("가로묶기 실패 · 사진을 다시 선택한 뒤 눌러 보세요", "dirty");
      return;
    }
    syncImageRowBody();
    markDirty();
    setStatus("가로묶기 " + imgs.length + "장 · 저장 시 md에 image-row", "dirty");
  }

  let imgDragGhost = null;

  function ensureImgDragGhost(img) {
    if (imgDragGhost) return;
    const g = document.createElement("img");
    g.className = "pe-img-drag-ghost";
    g.src = img.getAttribute("src") || "";
    g.alt = "";
    document.body.appendChild(g);
    imgDragGhost = g;
  }

  function moveImgDragGhost(x, y) {
    if (!imgDragGhost) return;
    imgDragGhost.style.left = Math.round(x + 12) + "px";
    imgDragGhost.style.top = Math.round(y + 12) + "px";
  }

  function clearImgDragGhost() {
    if (imgDragGhost && imgDragGhost.parentNode) imgDragGhost.parentNode.removeChild(imgDragGhost);
    imgDragGhost = null;
  }

    function clearImgDropHint() {
    imgDropHint.hidden = true;
    if (imgDrag) {
      imgDrag.targetImg = null;
      imgDrag.place = null;
    }
  }

  function updateImgDropHint(clientX, clientY) {
    if (!imgDrag || !imgDrag.active) return;
    const root = wwContentsRoot();
    if (!root) return;
    imgDropHint.hidden = true;
    imgDrag.targetImg = null;
    imgDrag.place = null;
    // elementsFromPoint 는 오버레이/고스트에 가려 실패하는 경우가 있어 좌표로 직접 판정
    let hit = null;
    let hitRect = null;
    let best = Infinity;
    root.querySelectorAll("img").forEach((el) => {
      if (!isContentImg(el) || el === imgDrag.srcImg) return;
      // 같은 표 안의 다른 칸은 허용
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;
      const pad = 12;
      if (
        clientX < rect.left - pad ||
        clientX > rect.right + pad ||
        clientY < rect.top - pad ||
        clientY > rect.bottom + pad
      ) {
        return;
      }
      const cx = (rect.left + rect.right) / 2;
      const cy = (rect.top + rect.bottom) / 2;
      const d = Math.hypot(clientX - cx, clientY - cy);
      if (d < best) {
        best = d;
        hit = el;
        hitRect = rect;
      }
    });
    if (!hit || !hitRect) return;
    const place = clientX < hitRect.left + hitRect.width / 2 ? "before" : "after";
    const x = place === "before" ? hitRect.left - 3 : hitRect.right - 3;
    imgDropHint.style.left = Math.max(0, x) + "px";
    imgDropHint.style.top = hitRect.top + "px";
    imgDropHint.style.height = hitRect.height + "px";
    imgDropHint.hidden = false;
    imgDrag.targetImg = hit;
    imgDrag.place = place;
  }

  function endImgDrag(e) {
    if (!imgDrag) return;
    const drag = imgDrag;
    imgDrag = null;
    document.body.classList.remove("pe-img-dragging");
    clearImgDropHint();
    clearImgDragGhost();
    if (!drag.active) return;
    if (drag.targetImg && drag.place) {
      mergeImagesIntoRow(drag.targetImg, drag.srcImg, drag.place);
    } else {
      setStatus("실패 · 다른 사진 위(왼쪽/오른쪽)에 놓고 놓으세요. 또는 사진 클릭 → ↔ 가로묶기", "dirty");
    }
  }

  function moveImageBlock(dir) {
    if (!selectedImg) return;
    const view = getWwView();
    if (!view) return;
    const row = selectedImg.closest(".pe-image-row");
    let blockEl = row || selectedImg.closest("p") || selectedImg.parentElement;
    if (!blockEl) return;
    // Find PM position of block
    let pos = null;
    try {
      pos = view.posAtDOM(blockEl, 0);
    } catch (_) {
      pos = null;
    }
    if (pos == null) {
      // DOM fallback
      const parent = blockEl.parentNode;
      if (!parent) return;
      if (dir < 0 && blockEl.previousElementSibling) {
        parent.insertBefore(blockEl, blockEl.previousElementSibling);
        markDirty();
        setStatus("이미지 블록 위로 이동", "dirty");
        positionImgChrome(selectedImg);
        return;
      }
      if (dir > 0 && blockEl.nextElementSibling) {
        parent.insertBefore(blockEl.nextElementSibling, blockEl);
        markDirty();
        setStatus("이미지 블록 아래로 이동", "dirty");
        positionImgChrome(selectedImg);
        return;
      }
      return;
    }
    const $pos = view.state.doc.resolve(pos);
    let depth = $pos.depth;
    while (depth > 0 && !$pos.node(depth).type.isBlock) depth -= 1;
    // Prefer top-level block inside doc
    const blockDepth = Math.min(depth, 1) === 0 ? depth : 1;
    // find the direct child of doc
    let d = $pos.depth;
    while (d > 0 && $pos.node(d - 1).type.name !== "doc") d -= 1;
    if (d <= 0) {
      setStatus("이동할 블록을 찾지 못함", "dirty");
      return;
    }
    const blockPos = $pos.before(d);
    const node = view.state.doc.nodeAt(blockPos);
    if (!node) return;
    const size = node.nodeSize;
    let tr = view.state.tr;
    if (dir < 0) {
      if (blockPos === 0) {
        setStatus("이미 맨 위", "dirty");
        return;
      }
      const $before = view.state.doc.resolve(blockPos);
      const prev = $before.nodeBefore;
      if (!prev) {
        setStatus("이미 맨 위", "dirty");
        return;
      }
      const prevPos = blockPos - prev.nodeSize;
      const sliced = node.copy(node.content);
      tr = tr.delete(blockPos, blockPos + size);
      tr = tr.insert(prevPos, sliced);
      view.dispatch(tr);
    } else {
      const after = blockPos + size;
      const $after = view.state.doc.resolve(after);
      const next = $after.nodeAfter;
      if (!next) {
        setStatus("이미 맨 아래", "dirty");
        return;
      }
      const sliced = node.copy(node.content);
      tr = tr.delete(blockPos, blockPos + size);
      // after delete, next shifts left by size; insert after the next node which is now at blockPos
      const insertAt = blockPos + next.nodeSize;
      tr = tr.insert(insertAt, sliced);
      view.dispatch(tr);
    }
    markDirty();
    setStatus(dir < 0 ? "이미지 블록 위로 이동" : "이미지 블록 아래로 이동", "dirty");
    setTimeout(() => {
      if (selectedImg) positionImgChrome(selectedImg);
    }, 40);
  }

  function openPhotoEditorFor(img) {
    if (!currentPath || !img) return;
    if (!window.StoryPhotoEditor) {
      setStatus("사진 편집기 스크립트 없음", "dirty");
      return;
    }
    hideImgToolbar();
    StoryPhotoEditor.open({
      draftPath: currentPath,
      img,
      root: wwContentsRoot(),
      onSaved: () => {
        markDirty();
        setStatus("사진 파일 저장됨 · md 저장은 ⌘S", "dirty");
        decorateAllImages();
      },
      onClose: () => {
        decorateAllImages();
        bindImageUi();
      },
    });
  }

  function contentWidthFor(img) {

    const box = img.closest(".toastui-editor-contents") || img.parentElement;
    return (box && box.clientWidth) || 870;
  }

  function hideImgToolbar() {
    if (selectedImg) selectedImg.classList.remove("img-selected");
    selectedImg = null;
    resizeDrag = null;
    imgToolbar.classList.remove("is-open");
    imgFrame.classList.remove("is-open");
    document.body.classList.remove("img-resizing");
  }

  function syncWidthChrome(w) {
    const label = $("imgWidthLabel");
    if (label) label.textContent = w >= 100 ? "맥스" : `${w}%`;
    imgToolbar.querySelectorAll("[data-w]").forEach((btn) => {
      btn.classList.toggle("is-active", parseInt(btn.getAttribute("data-w"), 10) === w);
    });
  }

  function positionImgChrome(img) {
    // fixed — 스크롤 컨테이너(편집 pane)에서도 핸들이 이미지에 붙음
    const rect = img.getBoundingClientRect();

    imgFrame.style.left = `${rect.left}px`;
    imgFrame.style.top = `${rect.top}px`;
    imgFrame.style.width = `${rect.width}px`;
    imgFrame.style.height = `${rect.height}px`;

    const tw = imgToolbar.offsetWidth || 320;
    let left = rect.left + (rect.width - tw) / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    let top = rect.top - 44;
    if (top < 8) top = rect.bottom + 8;
    imgToolbar.style.left = `${left}px`;
    imgToolbar.style.top = `${top}px`;
  }

  function showImgToolbar(img) {
    if (selectedImg) selectedImg.classList.remove("img-selected");
    selectedImg = img;
    img.classList.add("img-selected");
    const w = parseInt(img.dataset.w || "100", 10) || 100;
    syncWidthChrome(w);
    imgToolbar.classList.add("is-open");
    imgFrame.classList.add("is-open");
    positionImgChrome(img);
    if (!document.body.classList.contains("pe-img-dragging")) {
      setStatus("↔ 가로묶기 클릭, 또는 사진을 다른 사진 왼쪽/오른쪽으로 드래그", "ok");
    }
  }

  function decorateImage(img, path) {
    const src = img.getAttribute("src") || "";
    let raw = src;
    const base = mediaBase(path);
    if (raw.startsWith(base)) {
      raw = raw.slice(base.length);
    } else if (raw.startsWith("/media/")) {
      raw = raw.slice("/media/".length);
    }
    const meta = parseSrcMeta(raw.replace(/^\.\//, ""));
    let mdFile = meta.file;
    // draft 폴더 안 파일명만 있으면 images/ 로
    if (
      !mdFile.startsWith("images/") &&
      !mdFile.startsWith("agent/") &&
      !mdFile.startsWith("drafts/") &&
      !mdFile.startsWith("http")
    ) {
      mdFile = `images/${mdFile}`;
    }
    img.dataset.mdFile = mdFile.split("?")[0].split("#")[0];

    // src에 #w= 가 없으면(저장 전 라이브 조절) dataset.w 유지 — 클릭/change 시 100%로 되돌리지 않음
    const srcHasW = /#w=\d+/.test(src);
    const prev = parseInt(img.dataset.w || "", 10);
    let w = meta.w;
    if (!srcHasW && img.dataset.decorated === "1" && prev >= 15 && prev <= 100) {
      w = prev;
    } else if (srcHasW) {
      w = meta.w;
    } else if (prev >= 15 && prev <= 100) {
      w = prev;
    }

    img.dataset.decorated = "1";
    applyWidthStyle(img, w, { chrome: false, syncHash: true });
  }

  /** img src 에 #w=N 을 맞춰 두어 재파싱·재클릭에도 폭 유지 */
  function syncImgWidthHash(img, pct) {
    const src = img.getAttribute("src") || "";
    if (!src || src.startsWith("data:")) return;
    const hashIdx = src.indexOf("#");
    const beforeHash = hashIdx >= 0 ? src.slice(0, hashIdx) : src;
    const next = pct >= 100 ? beforeHash : `${beforeHash}#w=${pct}`;
    if (next !== src) img.setAttribute("src", next);
  }

  function applyWidthStyle(img, w, opts) {
    const pct = Math.max(15, Math.min(100, Math.round(w)));
    img.dataset.w = String(pct);
    img.style.height = "auto";
    img.style.maxWidth = "100%";
    // 100% = 본문 폭에 강제 맞춤(원본이 작아도 확대). width 비우면 원본 픽셀로 줄어듦
    img.style.width = `${pct}%`;
    if (!opts || opts.syncHash !== false) {
      syncImgWidthHash(img, pct);
    }
    if (!opts || opts.chrome !== false) {
      syncWidthChrome(pct);
      if (img === selectedImg) positionImgChrome(img);
    }
    return pct;
  }

  function beginResize(e, handle) {
    if (!selectedImg) return;
    e.preventDefault();
    e.stopPropagation();
    const parentW = Math.max(1, contentWidthFor(selectedImg));
    const startW = selectedImg.getBoundingClientRect().width;
    const startH = selectedImg.getBoundingClientRect().height;
    // 화면상 실제 비율 기준(원본 작아 width 비어 있어도 드래그→맥스까지 키울 수 있음)
    const visualPct = Math.max(15, Math.min(100, (startW / parentW) * 100));
    // 왼쪽 핸들(w/nw/sw): 왼쪽으로 끌면 커짐 → dx 부호 반전
    const fromLeft = handle === "w" || handle === "nw" || handle === "sw";
    resizeDrag = {
      handle,
      fromLeft,
      startX: e.clientX,
      startY: e.clientY,
      startW,
      startH,
      parentW,
      startPct: visualPct,
    };
    document.body.classList.add("img-resizing");
    document.body.dataset.resizeHandle = handle;
    setStatus("모서리 드래그로 크기 조절 · 맥스=본문 꽉 채움");
  }

  function resizeDeltaPx(e, drag) {
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const signedDx = drag.fromLeft ? -dx : dx;
    // 모서리: 세로도 반영 (height:auto라 비율 유지 · 체감은 반응형)
    let signedDy = 0;
    if (drag.handle === "se" || drag.handle === "sw") signedDy = dy;
    else if (drag.handle === "ne" || drag.handle === "nw") signedDy = -dy;
    if (!signedDy) return signedDx;
    return Math.abs(signedDy) > Math.abs(signedDx) ? signedDy : signedDx;
  }

  imgFrame.addEventListener("mousedown", (e) => {
    const handle = e.target.closest("[data-handle]");
    if (!handle) return;
    beginResize(e, handle.getAttribute("data-handle"));
  });
  imgFrame.addEventListener(
    "touchstart",
    (e) => {
      const handle = e.target.closest("[data-handle]");
      if (!handle || !e.touches || !e.touches[0]) return;
      const t = e.touches[0];
      beginResize(
        { preventDefault() {}, stopPropagation() {}, clientX: t.clientX, clientY: t.clientY },
        handle.getAttribute("data-handle")
      );
    },
    { passive: false }
  );

  window.addEventListener("mousemove", (e) => {
    if (!resizeDrag || !selectedImg) return;
    e.preventDefault();
    const delta = resizeDeltaPx(e, resizeDrag);
    const nextPx = Math.max(48, resizeDrag.startW + delta);
    const pct = (nextPx / resizeDrag.parentW) * 100;
    // 드래그 중엔 src 해시 건드리지 않음(깜빡임 방지)
    applyWidthStyle(selectedImg, pct, { syncHash: false });
  });
  window.addEventListener(
    "touchmove",
    (e) => {
      if (!resizeDrag || !selectedImg || !e.touches || !e.touches[0]) return;
      e.preventDefault();
      const t = e.touches[0];
      const delta = resizeDeltaPx(
        { clientX: t.clientX, clientY: t.clientY },
        resizeDrag
      );
      const nextPx = Math.max(48, resizeDrag.startW + delta);
      const pct = (nextPx / resizeDrag.parentW) * 100;
      applyWidthStyle(selectedImg, pct, { syncHash: false });
    },
    { passive: false }
  );

  function endResize() {
    if (!resizeDrag || !selectedImg) return;
    resizeDrag = null;
    document.body.classList.remove("img-resizing");
    delete document.body.dataset.resizeHandle;
    const w = parseInt(selectedImg.dataset.w || "100", 10) || 100;
    applyWidthStyle(selectedImg, w); // dataset + #w= 확정
    markDirty();
    setStatus(`이미지 폭 ${w}% · 바로 유지 · 저장 시 md 반영`, "dirty");
    positionImgChrome(selectedImg);
  }
  window.addEventListener("mouseup", endResize);
  window.addEventListener("touchend", endResize);
  window.addEventListener("touchcancel", endResize);

  function parsePeVideoAlt(alt) {
    const raw = String(alt || "");
    const m = /@@pe:([^@]+)@@([^@]+)@@/.exec(raw);
    if (!m) {
      // 구형 마커
      const old = /\{\|pe-video:([^|]+)\|([^|]+)\|\}/.exec(raw);
      if (!old) return null;
      return {
        mediaUrl: old[1],
        mdFile: old[2],
        label: raw.replace(/\{\|pe-video:[^}]+\|\}/, "").trim(),
      };
    }
    return {
      mediaUrl: m[1],
      mdFile: m[2],
      label: raw.replace(/@@pe:[^@]+@@[^@]+@@/, "").trim(),
    };
  }

  /** 포스터/깨진 mp4 img → 클릭 재생용 포스터로 통일 (Toast가 video를 지우므로 img 유지) */
  function upgradeVideoImages() {
    if (!currentPath) return;
    const root = wwContentsRoot();
    if (!root) return;
    root.querySelectorAll("img").forEach((img) => {
      if (img.closest && img.closest(".pe-video-wrap")) return;
      const src = img.getAttribute("src") || "";
      const altRaw = img.getAttribute("alt") || "";
      let pe = parsePeVideoAlt(altRaw);
      const fromMp4 = isVideoSrc(src) || isVideoSrc(img.dataset.mdFile || "");
      if (!pe && !fromMp4) return;
      const mediaUrl = pe
        ? pe.mediaUrl
        : isVideoSrc(src)
          ? src.split("#")[0].split("?")[0]
          : mdSrcToMediaUrl(img.dataset.mdFile || src, currentPath).split("#")[0].split("?")[0];
      const mdFile = pe
        ? pe.mdFile
        : img.dataset.mdFile || mdFileFromSrc(src);
      const alt = (pe && pe.label) || PathBasenameNoExt(mdFile);
      const framePoster = videoFramePosterUrl(mdFile, currentPath);
      const usingGeneric =
        String(src).includes("pe-video-poster.png") || !src || src.endsWith("/");
      if (!pe || usingGeneric || isVideoSrc(src)) {
        img.src = framePoster;
        img.alt = peVideoAlt(alt, mediaUrl, mdFile);
      }
      img.classList.add("pe-video-poster");
      img.dataset.mdFile = mdFile;
      img.dataset.mediaUrl = mediaUrl;
      img.title = `${alt} · 클릭하여 재생`;
      img.style.cursor = "pointer";
      img.style.objectFit = img.style.objectFit || "cover";
      img.style.background = img.style.background || "#111";
      if (!img.dataset.posterBound) {
        img.dataset.posterBound = "1";
        img.addEventListener("error", () => {
          if (img.dataset.posterTried === "1") {
            img.src = PE_VIDEO_POSTER;
            return;
          }
          img.dataset.posterTried = "1";
          fetch("/api/video-poster", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: currentPath, md_path: mdFile }),
          })
            .then((r) => r.json())
            .then((d) => {
              if (d && d.poster_url) img.src = d.poster_url + "?t=" + Date.now();
              else img.src = PE_VIDEO_POSTER;
            })
            .catch(() => {
              img.src = PE_VIDEO_POSTER;
            });
        });
      }
    });
  }

  /** getMarkdown 직전: video → 포스터 img(title=pe-video) 로 직렬화 힌트.
   *  실제 저장 md는 bodyFromEditor / applyDomVideosToMd 가 ![…](….mp4) 로 복원.
   */
  function videosToImgsForMarkdown() {
    const root = wwContentsRoot();
    if (!root) return;
    root.querySelectorAll(".pe-video-wrap, video.pe-video").forEach((el) => {
      const video = el.tagName === "VIDEO" ? el : el.querySelector("video");
      if (!video) return;
      const mdFile = video.dataset.mdFile || mdFileFromSrc(video.src);
      const mediaUrl = (video.currentSrc || video.src || "").split("#")[0].split("?")[0];
      const alt = video.title || PathBasenameNoExt(mdFile);
      const img = document.createElement("img");
      img.alt = `${alt}@@pe:${mediaUrl}@@${mdFile}@@`;
      img.dataset.mdFile = mdFile;
      img.src = "/static/pe-video-poster.png";
      el.replaceWith(img);
    });
  }

  /** 저장 md에 영상 줄이 빠졌으면 caption 앞에 ![…](mp4) 를 다시 넣음 */
  function applyDomVideosToMd(md) {
    const root = wwContentsRoot();
    if (!root) return md;
    const nodes = [
      ...root.querySelectorAll(
        "iframe.pe-video-frame, img[alt*='@@pe:'], img[alt*='{|pe-video:'], video.pe-video, .pe-video-wrap video"
      ),
    ];
    let out = md;
    nodes.forEach((el) => {
      let pe = null;
      if (el.tagName === "IFRAME") {
        let mdFile = el.dataset.mdFile || "";
        if (!mdFile && el.src) {
          try {
            mdFile = new URL(el.src, location.origin).searchParams.get("md") || "";
          } catch (_) {}
        }
        pe = {
          mdFile,
          label: el.getAttribute("title") || PathBasenameNoExt(mdFile),
        };
      } else {
        const video = el.tagName === "VIDEO" ? el : el.querySelector ? el.querySelector("video") : null;
        pe =
          parsePeVideoAlt(el.getAttribute("alt") || "") ||
          (video
            ? {
                mediaUrl: video.src,
                mdFile: video.dataset.mdFile || mdFileFromSrc(video.src),
                label: video.title || PathBasenameNoExt(video.dataset.mdFile || ""),
              }
            : null);
      }
      if (!pe || !pe.mdFile) return;
      if (out.includes(pe.mdFile)) return;
      const alt = pe.label || PathBasenameNoExt(pe.mdFile);
      const line = `![${alt}](${pe.mdFile})`;
      const esc = alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const capRe = new RegExp(`(^|\\n)(\\*[^\\n]*${esc}[^\\n]*\\*)`, "m");
      if (capRe.test(out)) {
        out = out.replace(capRe, `$1${line}\n\n$2`);
      } else {
        out = out.trimEnd() + `\n\n${line}\n`;
      }
    });
    return out;
  }

  function decorateAllImages() {
    if (!currentPath) return;
    const root = wwContentsRoot();
    if (!root) return;
    // Toast WW가 mp4를 버려도 원본 md에서 포스터를 다시 심음
    injectVideosFromSourceMd(lastBodyForGaps);
    root.querySelectorAll("img").forEach((img) => {
      const alt = img.getAttribute("alt") || "";
      if (
        img.classList.contains("pe-video-poster") ||
        parsePeVideoAlt(alt) ||
        isVideoSrc(img.getAttribute("src") || "")
      ) {
        return;
      }
      decorateImage(img, currentPath);
    });
    upgradeVideoImages();
  }

  function bindImageUi() {
    const root = wwContentsRoot();
    if (!root || root.dataset.imgUi === "1") return;
    root.dataset.imgUi = "1";
    root.addEventListener("click", (e) => {
      if (document.body.classList.contains("pe-img-dragging")) return;
      const img = e.target.closest("img");
      if (!img || !root.contains(img)) return;
      e.preventDefault();
      e.stopPropagation();
      const pe =
        parsePeVideoAlt(img.getAttribute("alt") || "") ||
        (img.classList.contains("pe-video-poster")
          ? {
              mediaUrl: img.dataset.mediaUrl || "",
              mdFile: img.dataset.mdFile || "",
              label: img.title || PathBasenameNoExt(img.dataset.mdFile || ""),
            }
          : null);
      if (pe && pe.mediaUrl) {
        openVideoLightbox(
          pe.mediaUrl,
          pe.label || PathBasenameNoExt(pe.mdFile),
          pe.mdFile || img.dataset.mdFile || ""
        );
        return;
      }
      if (!isContentImg(img)) return;
      decorateImage(img, currentPath);
      showImgToolbar(img);
    });
    root.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest(".img-toolbar, .img-frame, .img-handle")) return;
      const img = e.target.closest("img");
      if (!img || !root.contains(img) || !isContentImg(img)) return;
      try {
        img.setAttribute("draggable", "false");
      } catch (_) {}
      e.preventDefault();
      imgDrag = {
        srcImg: img,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        targetImg: null,
        place: null,
      };
    });
  }

  window.addEventListener(
    "mousemove",
    (e) => {
      if (!imgDrag) return;
      const dx = e.clientX - imgDrag.startX;
      const dy = e.clientY - imgDrag.startY;
      if (!imgDrag.active) {
        if (Math.hypot(dx, dy) < 6) return;
        imgDrag.active = true;
        document.body.classList.add("pe-img-dragging");
        hideImgToolbar();
        ensureImgDragGhost(imgDrag.srcImg);
        setStatus("다른 사진의 왼쪽 또는 오른쪽 위에 놓으세요", "dirty");
      }
      moveImgDragGhost(e.clientX, e.clientY);
      updateImgDropHint(e.clientX, e.clientY);
    },
    true
  );
  window.addEventListener("mouseup", endImgDrag, true);
  window.addEventListener("blur", () => {
    if (imgDrag) endImgDrag({ type: "blur" });
  });

  imgToolbar.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn || !selectedImg || !currentPath) return;
    const wAttr = btn.getAttribute("data-w");
    const rot = btn.getAttribute("data-rot");
    if (wAttr) {
      const w = parseInt(wAttr, 10);
      applyWidthStyle(selectedImg, w);
      markDirty();
      setStatus(`이미지 폭 ${w}% · 저장 시 md에 #w=${w}`, "dirty");
      return;
    }
    if (rot) {
      const degrees = parseInt(rot, 10);
      const mdFile = selectedImg.dataset.mdFile;
      if (!mdFile) return;
      const imgEl = selectedImg;
      const w = parseInt(imgEl.dataset.w || "100", 10) || 100;
      setStatus("회전 중…");
      try {
        const res = await fetch("/api/image-rotate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: currentPath,
            md_path: mdFile,
            degrees,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "rotate failed");
        const bust = `${data.media_url}?t=${Date.now()}`;
        // ProseMirror가 옛 src로 되돌리지 않도록 노드 교체 느낌으로 강제 로드
        imgEl.setAttribute("src", bust);
        imgEl.dataset.w = String(w);
        imgEl.dataset.decorated = "1";
        applyWidthStyle(imgEl, w);
        // 한 번 더: 디코드 완료 후 프레임 맞춤
        const done = () => {
          if (selectedImg === imgEl) {
            applyWidthStyle(imgEl, w);
            positionImgChrome(imgEl);
          }
        };
        if (imgEl.complete) done();
        else imgEl.addEventListener("load", done, { once: true });
        markDirty();
        setStatus("이미지 회전 · 파일에 바로 반영됨", "dirty");
      } catch (err) {
        setStatus(String(err.message || err), "dirty");
      }
      return;
    }
    if (btn.getAttribute("data-feat")) {
      let md =
        selectedImg.dataset.mdFile ||
        mediaUrlToMdSrc(selectedImg.getAttribute("src") || "", currentPath);
      md = String(md || "").split("#")[0].split("?")[0];
      if (!md) {
        setStatus("이 이미지 경로를 알 수 없습니다", "dirty");
        return;
      }
      if (!md.startsWith("images/") && !md.includes("/")) {
        md = `images/${md}`;
      }
      setFeaturedPath(md, selectedImg.getAttribute("alt") || PathBasename(md));
      return;
    }
    if (btn.getAttribute("data-edit")) {
      openPhotoEditorFor(selectedImg);
      return;
    }
    if (btn.getAttribute("data-row")) {
      wrapSelectedImagesAsRow();
      return;
    }
    if (btn.getAttribute("data-move")) {
      const dir = btn.getAttribute("data-move") === "up" ? -1 : 1;
      moveImageBlock(dir);
      return;
    }
    if (btn.getAttribute("data-del")) {
      deleteSelectedImage();
    }
  });

  function normalizeImgSrc(src) {
    return String(src || "").split("?")[0].split("#")[0];
  }

  function deleteSelectedImage() {
    if (!selectedImg || !editor) return false;
    const view = getWwView();
    if (!view) {
      setStatus("에디터 준비 전입니다", "dirty");
      return false;
    }
    const target = selectedImg;
    const targetSrc = normalizeImgSrc(target.getAttribute("src"));
    let imgPos = null;
    let imgNode = null;
    view.state.doc.descendants((node, pos) => {
      if (imgPos != null) return false;
      if (node.type.name !== "image") return true;
      let dom = null;
      try {
        dom = view.nodeDOM(pos);
      } catch (_) {
        dom = null;
      }
      const attrs = node.attrs || {};
      const nodeSrc = normalizeImgSrc(attrs.imageUrl || attrs.src || "");
      if (
        dom === target ||
        (dom && dom.nodeType === 1 && (dom === target || dom.contains(target))) ||
        (targetSrc && nodeSrc && targetSrc === nodeSrc)
      ) {
        imgPos = pos;
        imgNode = node;
        return false;
      }
      return true;
    });
    if (imgPos == null || !imgNode) {
      setStatus("이미지 노드를 찾지 못했습니다", "dirty");
      return false;
    }
    hideImgToolbar();
    const prev = suppressChange;
    suppressChange = true;
    view.dispatch(view.state.tr.delete(imgPos, imgPos + imgNode.nodeSize));
    suppressChange = prev;
    markDirty();
    setStatus("이미지 삭제 · 저장 시 md 반영", "dirty");
    setTimeout(() => {
      decorateAllImages();
      collapseEmptyCaptionGaps();
    }, 40);
    return true;
  }

  document.addEventListener("click", (e) => {
    if (tableToolbar.contains(e.target)) return;
    if (colResizeLayer.contains(e.target)) return;
    if (e.target.closest && e.target.closest(".toastui-editor-contents table")) {
      setTimeout(refreshTableToolbar, 0);
    } else if (!findTableFromSelection() && !colResizeDrag) {
      hideTableToolbar();
    }
    if (!selectedImg || resizeDrag) return;
    if (imgToolbar.contains(e.target) || imgFrame.contains(e.target)) return;
    if (e.target.closest && e.target.closest(".toastui-editor-contents img") === selectedImg) return;
    hideImgToolbar();
  });

  colResizeLayer.addEventListener("mousedown", (e) => {
    const handle = e.target.closest(".table-col-resizer");
    if (!handle || !selectedTable) return;
    e.preventDefault();
    e.stopPropagation();
    const colIndex = parseInt(handle.dataset.colIndex || "0", 10);
    const widths = readTableColWidths(selectedTable);
    if (widths.length < 2 || colIndex >= widths.length - 1) return;
    colResizeDrag = {
      table: selectedTable,
      colIndex,
      startX: e.clientX,
      startWidths: widths,
      tableWidth: selectedTable.getBoundingClientRect().width || 1,
    };
    document.body.classList.add("is-col-resizing");
  });

  window.addEventListener("mousemove", (e) => {
    if (!colResizeDrag || !colResizeDrag.table) return;
    const { colIndex, startX, startWidths, tableWidth, table } = colResizeDrag;
    const deltaPct = ((e.clientX - startX) / tableWidth) * 100;
    const next = startWidths.slice();
    const min = 8;
    let left = startWidths[colIndex] + deltaPct;
    let right = startWidths[colIndex + 1] - deltaPct;
    if (left < min) {
      right -= min - left;
      left = min;
    }
    if (right < min) {
      left -= min - right;
      right = min;
    }
    next[colIndex] = left;
    next[colIndex + 1] = right;
    const normalized = normalizeColWidths(next);
    paintTableColWidths(table, normalized);
    positionColResizeHandles(table);
  });

  window.addEventListener("mouseup", () => {
    if (!colResizeDrag) return;
    const { table } = colResizeDrag;
    const widths = readTableColWidths(table);
    rememberTableColWidths(table, widths);
    colResizeDrag = null;
    document.body.classList.remove("is-col-resizing");
    markDirty();
    setStatus("표 열 폭 조절 · 저장 시 md에 반영", "dirty");
    if (table && table.isConnected) {
      positionTableToolbar(table);
      positionColResizeHandles(table);
    }
  });

  tableToolbar.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) e.preventDefault();
  });

  tableToolbar.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || !editor) return;
    const tbl = btn.getAttribute("data-tbl");
    const colAlign = btn.getAttribute("data-col-align");
    const tableAlign = btn.getAttribute("data-table-align");
    if (tbl) {
      runTableCommand(tbl);
      return;
    }
    if (colAlign) {
      runTableCommand("alignColumn", { align: colAlign });
      return;
    }
    if (tableAlign) {
      const table = findTableFromSelection() || selectedTable;
      if (!table) {
        setStatus("표 안을 클릭한 뒤 정렬하세요", "dirty");
        return;
      }
      setTableAlignClass(table, tableAlign);
      markDirty();
      positionTableToolbar(table);
      const place =
        tableAlign === "center" ? "가운데" : tableAlign === "right" ? "오른쪽" : "왼쪽";
      setStatus(`표 전체 ${place} 배치 · 저장 시 md에 반영`, "dirty");
    }
  });

  window.addEventListener(
    "scroll",
    () => {
      if (selectedImg) positionImgChrome(selectedImg);
      if (selectedTable) {
        positionTableToolbar(selectedTable);
        positionColResizeHandles(selectedTable);
      }
    },
    true
  );
  window.addEventListener("resize", () => {
    if (selectedImg) positionImgChrome(selectedImg);
    if (selectedTable) {
      positionTableToolbar(selectedTable);
      positionColResizeHandles(selectedTable);
    }
  });

  async function fileToBase64(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  async function uploadFile(file) {
    if (!currentPath || !file) throw new Error("no draft");
    const b64 = await fileToBase64(file);
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: currentPath,
        filename: file.name,
        content_base64: b64,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "업로드 실패");
    return data;
  }

  function createEditor(initialMd, gapSourceBody) {
    hideImgToolbar();
    hideTableToolbar();
    editorMount.innerHTML = "";
    const el = document.createElement("div");
    el.id = "toastEditor";
    editorMount.appendChild(el);
    lastBodyForGaps = gapSourceBody != null ? gapSourceBody : initialMd;

    const mergePlugin =
      (window.toastui &&
        window.toastui.Editor &&
        window.toastui.Editor.plugin &&
        window.toastui.Editor.plugin.tableMergedCell) ||
      window.toastuiTableMergedCell;

    editor = new toastui.Editor({
      el,
      height: "100%",
      initialEditType: "wysiwyg",
      previewStyle: "vertical",
      hideModeSwitch: true,
      usageStatistics: false,
      autofocus: true,
      initialValue: initialMd,
      plugins: mergePlugin ? [mergePlugin] : [],
      customHTMLSanitizer: peSanitizeHtml,
      toolbarItems: [
        ["heading", "bold", "italic", "strike"],
        ["hr", "quote"],
        ["ul", "ol", "task", "indent", "outdent"],
        [
          "table",
          "image",
          makeVideoToolbarItem(),
          "link",
          makeAlignToolbarItem("left", "왼쪽 정렬"),
          makeAlignToolbarItem("center", "가운데 정렬"),
          makeAlignToolbarItem("right", "오른쪽 정렬"),
        ],
        ["code", "codeblock"],
      ],
      hooks: {
        addImageBlobHook: (blob, callback) => {
          const file =
            blob instanceof File
              ? blob
              : new File([blob], blob.name || `paste-${Date.now()}.png`, {
                  type: blob.type || "image/png",
                });
          uploadFile(file)
            .then((data) => {
              const url = mediaBase(currentPath) + data.md_path;
              const alt = file.name.replace(/\.[^.]+$/, "");
              callback(url, alt);
              setStatus(`이미지 추가 · ${data.md_path}`, "ok");
              setTimeout(() => {
                decorateAllImages();
                bindImageUi();
                markDirty();
              }, 50);
            })
            .catch((e) => {
              setStatus(String(e.message || e), "dirty");
            });
        },
      },
      events: {
        change: () => {
          if (!suppressChange) {
            markDirty();
            setTimeout(() => {
              decorateAllImages();
              bindImageUi();
              decorateImageRowTables();
              // 셀 타이핑 중에는 표 DOM을 건드리지 않음 (caret 유지)
              if (findTableFromSelection()) {
                if (selectedTable) positionColResizeHandles(selectedTable);
              } else {
                paintAllTableColWidths();
              }
            }, 30);
          }
        },
        load: () => {
          decorateAllImages();
          bindImageUi();
          collapseEmptyCaptionGaps();
          decorateGapsFromBody(lastBodyForGaps);
          decorateTableAlignFromBody(lastBodyForGaps);
          decorateTableColsFromBody(lastBodyForGaps);
          decorateTextAlignFromBody(lastBodyForGaps);
          decorateImageRowsFromBody(lastBodyForGaps);
        },
      },
    });

    setTimeout(() => {
      decorateAllImages();
      bindImageUi();
      collapseEmptyCaptionGaps();
      decorateGapsFromBody(lastBodyForGaps);
      decorateTableAlignFromBody(lastBodyForGaps);
      decorateTableColsFromBody(lastBodyForGaps);
      decorateTextAlignFromBody(lastBodyForGaps);
      decorateImageRowsFromBody(lastBodyForGaps);
    }, 80);
  }

  function renderList() {
    const scrollTop = draftList.scrollTop;
    const q = (filterEl.value || "").trim().toLowerCase();
    draftList.innerHTML = "";
    const filtered = drafts.filter((d) => {
      if (!q) return true;
      const hay = [
        d.title,
        d.slug,
        d.topic,
        d.path,
        d.has_tistory_summary ? "요약 tistory-summary" : "요약없음",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
    if (!filtered.length) {
      draftList.innerHTML = '<li class="empty">글 없음</li>';
      return;
    }
    for (const d of filtered) {
      const li = document.createElement("li");
      const st = d.status || "none";
      li.className = "draft-item";
      li.dataset.status = st;
      if (d.has_tistory_summary) li.dataset.hasSummary = "1";
      else li.dataset.hasSummary = "0";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "draft-main";
      if (d.path === currentPath) btn.classList.add("active");
      const code =
        st === "publish" ? "P" : st === "draft" ? "D" : st === "unknown" ? "?" : "·";
      const label =
        st === "publish"
          ? "publish"
          : st === "draft"
            ? "draft"
            : st === "unknown"
              ? "WP 상태 미확인"
              : "미발행";
      btn.innerHTML =
        `<span class="st-badge" title="${label}">${code}</span>` +
        `<div class="meta"><div class="t"></div><div class="m"></div></div>`;
      btn.querySelector(".t").textContent = d.title || d.slug;
      const catHint = d.wp_category || TOPIC_DEFAULT_WP[d.topic] || "";
      const catLabel = catHint ? categoryLabel(catHint) : "";
      const sumHint = d.has_tistory_summary ? " · 요약있음" : " · 요약없음";
      btn.querySelector(".m").textContent = catLabel
        ? `${catLabel} · ${d.topic}/${d.slug}${sumHint}`
        : `${d.topic}/${d.slug}${sumHint}`;
      btn.addEventListener("click", () => openDraft(d.path));
      li.appendChild(btn);

      const child = document.createElement("div");
      child.className = "draft-child";
      if (d.has_tistory_summary && d.tistory_summary_path) {
        const sumBtn = document.createElement("button");
        sumBtn.type = "button";
        sumBtn.className = "draft-summary";
        if (st === "publish") sumBtn.classList.add("is-parent-publish");
        else if (st === "draft") sumBtn.classList.add("is-parent-draft");
        if (d.tistory_summary_path === currentPath) sumBtn.classList.add("active");
        // 원글 WP 상태와 같이 보이게 — publish면 P, draft면 D, 그 외 S
        const sumCode = st === "publish" ? "P" : st === "draft" ? "D" : "S";
        const sumLabel =
          st === "publish"
            ? "원글 WP publish · 티스토리 요약 업로드"
            : st === "draft"
              ? "원글 WP draft · 요약 초안"
              : "티스토리 요약";
        const sumMeta =
          st === "publish"
            ? "tistory-summary.md · 원글 P · 티스토리에 올리면 됨"
            : "tistory-summary.md · 원글 하위 · Cursor 요약 요청 가능";
        sumBtn.innerHTML =
          `<span class="st-badge st-badge-sum" title="${sumLabel}">${sumCode}</span>` +
          `<div class="meta"><div class="t"></div><div class="m"></div></div>`;
        sumBtn.querySelector(".t").textContent = "티스토리 요약";
        sumBtn.querySelector(".m").textContent = sumMeta;
        sumBtn.addEventListener("click", async () => {
          // 원글 제목·WP URL을 요약에 맞춘 뒤 연다
          try {
            await fetch("/api/ensure-tistory-summary", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: d.path }),
            });
          } catch (_) {}
          await openDraft(d.tistory_summary_path);
        });
        child.appendChild(sumBtn);
      } else {
        const miss = document.createElement("button");
        miss.type = "button";
        miss.className = "draft-summary-missing";
        miss.title = "클릭하면 tistory-summary.md 스텁 생성";
        miss.innerHTML =
          `<span class="st-badge st-badge-miss" title="요약 없음">–</span>` +
          `<div class="meta"><div class="t">요약 만들기</div>` +
          `<div class="m">클릭 → 스텁 생성 · 이후 Cursor/직접 작성</div></div>`;
        miss.addEventListener("click", () => ensureSummaryAndOpen(d.path));
        child.appendChild(miss);
      }
      li.appendChild(child);
      draftList.appendChild(li);
    }
    // 글 클릭·재렌더 때 스크롤이 맨 위로 튀지 않게
    draftList.scrollTop = scrollTop;
  }

  async function ensureSummaryAndOpen(postPath) {
    if (isDirty() && !confirm("저장하지 않은 변경이 있습니다. 버릴까요?")) return;
    try {
      const res = await fetch("/api/ensure-tistory-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: postPath }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setStatus(data.error || "요약 스텁 생성 실패", "dirty");
        return;
      }
      await loadDrafts();
      if (data.tistory_summary_path) {
        await openDraft(data.tistory_summary_path);
      }
    } catch (e) {
      setStatus(String(e.message || e), "dirty");
    }
  }

  async function loadDrafts() {
    const res = await fetch("/api/drafts");
    const data = await res.json();
    drafts = data.drafts || [];
    renderList();
    if (currentPath) syncCurrentWpStatus(currentPath);
  }

  async function openDraft(path) {
    if (isDirty() && !confirm("저장하지 않은 변경이 있습니다. 버릴까요?")) return;
    const res = await fetch("/api/draft?path=" + encodeURIComponent(path));
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "열기 실패", "dirty");
      return;
    }
    currentPath = path;
    dirty = false;
    savedFull = data.content || "";
    const parts = splitFrontmatter(savedFull);
    frontmatter = parts.fm;
    const editorMd = bodyToEditor(parts.body, path);
    pathEl.textContent = isSummaryPath(path)
      ? `${path} · 티스토리 요약`
      : path;
    syncCurrentWpStatus(path);
    setButtonsEnabled(true);
    renderList();
    suppressChange = true;
    if (editor) {
      editor.destroy();
      editor = null;
    }
    createEditor(editorMd, parts.body);
    // Toast 초기 로드·이미지 데코가 change를 내도 dirty로 치지 않음
    const summaryMode = isSummaryPath(path);
    setTimeout(() => {
      collapseEmptyCaptionGaps();
      decorateGapsFromBody(parts.body);
      decorateTableAlignFromBody(parts.body);
      decorateTableColsFromBody(parts.body);
      decorateTextAlignFromBody(parts.body);
      decorateImageRowsFromBody(parts.body);
      hideTableToolbar();
      suppressChange = false;
      clearDirty();
      if (summaryMode) {
        setStatus("티스토리 요약 편집 · ⌘S 저장 (WP 발행은 원글에서)", "ok");
      }
    }, 200);
    if (summaryMode) {
      featuredChip.hidden = true;
      $("btnFeaturedClear").hidden = true;
      metaBar.hidden = true;
      refreshTitleUi();
    } else {
      refreshFeaturedChip();
      refreshCategoryUi();
    }
    clearDirty();
  }

  async function saveDraft() {
    if (!currentPath || !editor) return;
    const content = fullMarkdown();
    const res = await fetch("/api/draft?path=" + encodeURIComponent(currentPath), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "저장 실패", "dirty");
      return;
    }
    savedFull = content;
    try {
      lastBodyForGaps = splitFrontmatter(content).body;
    } catch (_) {}
    clearDirty();
  }

  async function reloadFrontmatterFromDisk() {
    if (!currentPath) return;
    try {
      const res = await fetch("/api/draft?path=" + encodeURIComponent(currentPath));
      const data = await res.json();
      if (!res.ok) return;
      savedFull = data.content || savedFull;
      const parts = splitFrontmatter(savedFull);
      frontmatter = parts.fm;
      refreshFeaturedChip();
      refreshCategoryUi();
      refreshTitleUi();
    } catch (_) {
      /* ignore */
    }
  }

  async function publish(mode) {
    if (!currentPath) return;
    if (publishing) {
      setStatus("이미 발행 처리 중… 끝날 때까지 기다려 주세요", "dirty");
      return;
    }
    publishing = true;
    refreshPublishButtons();
    const started = Date.now();
    const tick = setInterval(() => {
      const sec = Math.round((Date.now() - started) / 1000);
      setStatus(`${mode} 올리는 중… ${sec}s (이미지 있으면 길어질 수 있음)`);
    }, 1000);
    try {
      if (isDirty()) await saveDraft();
      setStatus(`${mode} 올리는 중… 0s`);
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: currentPath, mode }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        const msg =
          (data.result && data.result.error) ||
          data.error ||
          data.stderr ||
          data.stdout ||
          "발행 실패";
        setStatus(String(msg).slice(0, 200), "dirty");
        console.error(data);
        return;
      }
      const result = data.result || {};
      const url = result.wp_url || result.url || "";
      const st = result.status || mode;
      // 서버가 md frontmatter에 쓴 wp_id/status/url 을 다시 읽어 UI 동기화
      await reloadFrontmatterFromDisk();
      currentWpStatus = st;
      // 목록 배지 즉시 반영 (loadDrafts 전)
      const hit = drafts.find((d) => d.path === currentPath);
      if (hit) {
        hit.status = st;
        if (result.wp_id) hit.wp_id = String(result.wp_id);
      }
      renderList();
      refreshPublishButtons();
      const sec = Math.round((Date.now() - started) / 1000);
      const sumPath = data.tistory_summary_path || "";
      if (hit) {
        hit.has_tistory_summary = true;
        if (sumPath) hit.tistory_summary_path = sumPath;
      }
      setStatus(
        url
          ? `${st === "publish" ? "P" : "D"} 반영 (${sec}s) · ${url}` +
              (st === "publish"
                ? " · 하위「티스토리 요약」확인 후 티스토리 업로드"
                : "")
          : `${st} 반영됨 (${sec}s)`,
        "ok"
      );
      // WP 목록 status 재확인 (배지 최종 · 요약 P 동기)
      await loadDrafts().catch(() => {});
      if (currentPath) syncCurrentWpStatus(currentPath);
    } finally {
      clearInterval(tick);
      publishing = false;
      refreshPublishButtons();
    }
  }

  async function insertImageFromPicker(file) {
    if (!editor || !file) return;
    try {
      const data = await uploadFile(file);
      const url = mediaBase(currentPath) + data.md_path;
      const alt = file.name.replace(/\.[^.]+$/, "");
      editor.exec("addImage", { imageUrl: url, altText: alt });
      setStatus(`이미지 추가 · ${data.md_path}`, "ok");
      setTimeout(() => {
        decorateAllImages();
        bindImageUi();
        markDirty();
      }, 50);
    } catch (e) {
      setStatus(String(e.message || e), "dirty");
    }
  }

  async function insertVideoFromPicker(file) {
    if (!editor || !file || !currentPath) return;
    if (!/\.(mp4|mov|m4v|webm)$/i.test(file.name)) {
      setStatus("지원 형식: mp4 · mov · m4v · webm", "dirty");
      return;
    }
    try {
      setStatus("동영상 업로드 중…");
      const data = await uploadFile(file);
      const alt = file.name.replace(/\.[^.]+$/, "") || "영상";
      const mdLine = `\n\n![${alt}](${data.md_path})\n\n`;
      // Toast WW는 mp4를 버리므로 원본 body에 넣고 포스터로 다시 그림
      let body = bodyFromEditor(editor.getMarkdown(), currentPath);
      body = (body || "").replace(/\s*$/, "") + mdLine;
      lastBodyForGaps = body;
      const editorMd = bodyToEditor(body, currentPath);
      suppressChange = true;
      editor.setMarkdown(editorMd);
      suppressChange = false;
      markDirty();
      setStatus(`동영상 추가 · ${data.md_path} · ⌘S 저장`, "dirty");
      setTimeout(() => {
        decorateAllImages();
        bindImageUi();
      }, 80);
    } catch (e) {
      setStatus(String(e.message || e), "dirty");
    }
  }

  $("btnReload").addEventListener("click", () => loadDrafts());
  $("btnNew").addEventListener("click", () => openNewDraftDialog());
  $("btnNewClose").addEventListener("click", () => newDraftDialog.close());
  $("btnNewCancel").addEventListener("click", () => newDraftDialog.close());
  newDraftForm.addEventListener("submit", (e) => createNewDraft(e));
  $("btnSave").addEventListener("click", () => saveDraft());
  $("btnDelete").addEventListener("click", () => deleteDraftCompletely());
  $("btnDraft").addEventListener("click", () => {
    if (publishing) {
      setStatus("이미 발행 처리 중…", "dirty");
      return;
    }
    if (currentWpStatus === "publish") {
      setStatus("publish(P) 글은 WP draft로 내릴 수 없습니다", "dirty");
      return;
    }
    publish("draft");
  });
  $("btnPublish").addEventListener("click", () => {
    if (publishing) {
      setStatus("이미 발행 처리 중… 끝날 때까지 기다려 주세요", "dirty");
      return;
    }
    const msg =
      currentWpStatus === "publish"
        ? "이미 공개(P)된 글입니다. 내용을 다시 올릴까요?\n(연타해도 한 번만 처리됩니다)"
        : "WP에 publish 할까요? (공개)\n이미지 있으면 수십 초 걸릴 수 있습니다.";
    if (confirm(msg)) publish("publish");
  });
  $("btnImage").addEventListener("click", () => fileImage.click());
  if ($("btnVideo")) $("btnVideo").addEventListener("click", () => fileVideo && fileVideo.click());
  $("btnFeatured").addEventListener("click", () => openFeaturedPicker());
  $("btnFeaturedClear").addEventListener("click", () => setFeaturedPath(null));
  $("btnMd").addEventListener("click", () => {
    mdSource.textContent = fullMarkdown();
    mdDialog.showModal();
  });
  const videoDialog = $("videoDialog");
  const btnVideoClose = $("btnVideoClose");
  const btnVideoEdit = $("btnVideoEdit");
  if (btnVideoClose) {
    btnVideoClose.addEventListener("click", () => closeVideoLightbox());
  }
  if (btnVideoEdit) {
    btnVideoEdit.addEventListener("click", () => {
      if (!lastVideoLightbox || !lastVideoLightbox.mdFile) {
        setStatus("편집할 영상 정보가 없습니다", "dirty");
        return;
      }
      openVideoEditorFor(lastVideoLightbox);
    });
  }
  if (videoDialog) {
    videoDialog.addEventListener("close", () => stopVideoLightboxPlayer());
  }
  categorySelect.addEventListener("change", () => {
    const v = categorySelect.value;
    if (v) applyCategory(v);
    else refreshCategoryUi();
  });
  blockGapGroup.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-gap]");
    if (!btn) return;
    applyGapToSelection(btn.getAttribute("data-gap"));
  });
  document.addEventListener("selectionchange", () => {
    if (!currentPath) return;
    syncGapButtonsFromSelection();
    refreshTableToolbar();
  });
  fileImage.addEventListener("change", () => {
    const f = fileImage.files && fileImage.files[0];
    if (f) insertImageFromPicker(f);
    fileImage.value = "";
  });
  if (fileVideo) {
    fileVideo.addEventListener("change", () => {
      const f = fileVideo.files && fileVideo.files[0];
      if (f) insertVideoFromPicker(f);
      fileVideo.value = "";
    });
  }
  filterEl.addEventListener("input", renderList);
  ensureCategoryOptions();
  ensureNewCategoryOptions();

  if (titleInput) {
    titleInput.addEventListener("input", () => {
      if (suppressTitleInput) return;
      applyTitle(titleInput.value);
    });
    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        titleInput.blur();
        if (editor && editor.focus) editor.focus();
      }
    });
  }

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      saveDraft();
      return;
    }
    if (
      selectedImg &&
      !resizeDrag &&
      (e.key === "Delete" || e.key === "Backspace")
    ) {
      if (
        e.target &&
        e.target.closest &&
        e.target.closest("input, textarea, select, .title-field")
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      deleteSelectedImage();
    }
  });

  (async function boot() {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error("설정 로드 실패 (/api/config " + res.status + ")");
    applyConfig(await res.json());
    await loadDrafts();
  })().catch((e) => setStatus(String(e), "dirty"));

  // 파일 드래그로 이미지 삽입 (Finder → 본문)
  (function bindFileDrop() {
    const mount = editorMount;
    if (!mount || mount.dataset.fileDrop === "1") return;
    mount.dataset.fileDrop = "1";
    const isFileDrag = (e) => {
      const types = e.dataTransfer && e.dataTransfer.types;
      if (!types) return false;
      return [...types].includes("Files");
    };
    mount.addEventListener("dragover", (e) => {
      if (!isFileDrag(e) || !currentPath) return;
      e.preventDefault();
      e.stopPropagation();
      mount.classList.add("pe-file-drop");
    });
    mount.addEventListener("dragleave", (e) => {
      if (!mount.contains(e.relatedTarget)) mount.classList.remove("pe-file-drop");
    });
    mount.addEventListener("drop", async (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      mount.classList.remove("pe-file-drop");
      if (!currentPath || !editor) {
        setStatus("글을 먼저 여세요", "dirty");
        return;
      }
      const files = [...(e.dataTransfer.files || [])].filter((f) =>
        /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name)
      );
      if (!files.length) {
        setStatus("이미지 파일만 넣을 수 있습니다", "dirty");
        return;
      }
      setStatus("이미지 업로드 중…");
      for (const f of files) {
        await insertImageFromPicker(f);
      }
    }, true);
  })();
})();
