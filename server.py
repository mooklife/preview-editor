#!/usr/bin/env python3
"""Preview Editor — 로컬 Markdown WYSIWYG 편집기 (기본 http://127.0.0.1:3013).

원본(SSOT): <workspace>/<drafts_dir>/<topic>/<slug>/post.md
설정: config.py (CLI > env PE_* > --config JSON > 기본값)
"""

from __future__ import annotations

import base64
import hmac
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import LOOPBACK_HOSTS, AppConfig, load_config  # noqa: E402
from publishers import wp_rest  # noqa: E402

STATIC_ROOT = Path(__file__).resolve().parent / "static"

# main()/configure() 에서 채움
CFG: AppConfig = AppConfig()
WORKSPACE: Path = CFG.workspace
DRAFTS_ROOT: Path = CFG.drafts_root
MEDIA_ROOT_PREFIXES: tuple[str, ...] = tuple(CFG.media_allow)

TITLE_RE = re.compile(r'^title:\s*["\']?(.*?)["\']?\s*$', re.M)
STATUS_RE = re.compile(r'^status:\s*["\']?(draft|publish)["\']?\s*$', re.M | re.I)
WP_ID_RE = re.compile(r'^wp_id:\s*["\']?(\d+)["\']?\s*$', re.M)
TOPIC_RE = re.compile(r'^topic:\s*["\']?([A-Za-z0-9_-]+)["\']?\s*$', re.M)
WP_CATEGORY_RE = re.compile(r'^wp_category:\s*["\']?([A-Za-z0-9_-]+)["\']?\s*$', re.M)
ALLOWED_IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
SLUG_SAFE_RE = re.compile(r"[^a-z0-9\-]+")
SUMMARY_NAME = "tistory-summary.md"

FAVICON_SVG = (
    b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    b'<rect width="32" height="32" fill="#0B6B72"/>'
    b'<text x="16" y="22" text-anchor="middle" font-size="14" fill="#fff" '
    b'font-family="system-ui,sans-serif">P</text></svg>'
)


def configure(cfg: AppConfig) -> None:
    global CFG, WORKSPACE, DRAFTS_ROOT, MEDIA_ROOT_PREFIXES
    CFG = cfg
    WORKSPACE = cfg.workspace
    DRAFTS_ROOT = cfg.drafts_root
    MEDIA_ROOT_PREFIXES = tuple(p.lstrip("/") for p in cfg.media_allow)


def editable_names() -> tuple[str, ...]:
    return ("post.md", SUMMARY_NAME) if CFG.tistory_summary else ("post.md",)


def _json_bytes(obj: object, status: int = 200) -> tuple[int, bytes, str]:
    return status, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8"


def rel_to_workspace(p: Path) -> str:
    return p.relative_to(WORKSPACE).as_posix()


def resolve_draft_path(rel: str) -> Path:
    """workspace 기준 상대경로 → drafts 하위 Path. escape 거부."""
    if not rel or ".." in rel.split("/"):
        raise ValueError("invalid path")
    rel = rel.lstrip("/")
    if not rel.startswith(CFG.drafts_prefix):
        raise ValueError(f"path must start with {CFG.drafts_prefix}")
    full = (WORKSPACE / rel).resolve()
    drafts_resolved = DRAFTS_ROOT.resolve()
    if full != drafts_resolved and drafts_resolved not in full.parents:
        raise ValueError("path outside drafts")
    return full


def resolve_media_file(rel: str) -> Path:
    """media_allow 접두로 시작하는 workspace 상대경로만 서빙.

    drafts 안의 심볼릭 링크는 링크 경로만 검사한다
    (외부 사진 폴더를 가리키는 링크도 미리보기 허용).
    """
    if not rel or ".." in Path(rel).parts:
        raise ValueError("invalid media path")
    rel = rel.lstrip("/")
    rel = rel.split("?", 1)[0].split("#", 1)[0]
    if not any(rel.startswith(p) for p in MEDIA_ROOT_PREFIXES):
        raise ValueError("media path not allowed")

    root = WORKSPACE.resolve()
    # abspath는 최종 심볼릭 링크를 따라가지 않음 → drafts 안 링크 경로 유지
    candidate = Path(os.path.abspath(WORKSPACE / rel))
    try:
        candidate.relative_to(root)
    except ValueError as e:
        raise ValueError("outside workspace") from e

    if candidate.is_symlink():
        if not candidate.exists():
            raise ValueError("not found")
        return candidate

    resolved = candidate.resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError("outside workspace")
    if not resolved.is_file():
        raise ValueError("not found")
    return resolved


def parse_title(text: str) -> str:
    m = TITLE_RE.search(text)
    if m:
        return m.group(1).strip()
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return ""


def parse_wp_id(text: str) -> str | None:
    m = WP_ID_RE.search(text)
    return m.group(1) if m else None


def parse_status(text: str) -> str | None:
    m = STATUS_RE.search(text)
    return m.group(1).lower() if m else None


def parse_topic(text: str) -> str | None:
    m = TOPIC_RE.search(text)
    return m.group(1).strip() if m else None


def parse_wp_category(text: str) -> str | None:
    m = WP_CATEGORY_RE.search(text)
    return m.group(1).strip() if m else None


def fetch_wp_status_map() -> dict[str, str]:
    """WP REST로 id→status 맵. 자격증명 없음/실패 시 빈 dict (frontmatter로 폴백)."""
    return wp_rest.fetch_status_map(CFG.resolved_env_file())


def yaml_quoted(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def sanitize_slug(raw: str) -> str:
    s = (raw or "").strip().lower().replace("_", "-").replace(" ", "-")
    s = SLUG_SAFE_RE.sub("-", s)
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return s[:60]


def unique_draft_dir(topic: str, slug: str) -> Path:
    base = DRAFTS_ROOT / topic
    base.mkdir(parents=True, exist_ok=True)
    candidate = base / slug
    if not candidate.exists():
        return candidate
    for i in range(2, 100):
        alt = base / f"{slug}-{i}"
        if not alt.exists():
            return alt
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return base / f"{slug}-{stamp}"


def save_image_data_url(full: Path, data_url: str) -> str:
    """data:image/...;base64,... → 원본 경로 덮어쓰기. EXIF(GPS 포함) 제거.

    Returns: backend name ('pillow'|'raw')
    """
    raw = (data_url or "").strip()
    if not raw.startswith("data:image/"):
        raise ValueError("data_url must be data:image/…;base64,…")
    try:
        header, b64 = raw.split(",", 1)
    except ValueError as e:
        raise ValueError("invalid data_url") from e
    if ";base64" not in header:
        raise ValueError("data_url must be base64")
    try:
        blob = base64.b64decode(b64, validate=False)
    except Exception as e:
        raise ValueError("base64 decode failed") from e
    if len(blob) > CFG.max_body_bytes:
        raise ValueError("image too large")
    ext = full.suffix.lower()
    mime = header[5:].split(";", 1)[0].strip().lower()
    try:
        from io import BytesIO

        from PIL import Image  # type: ignore

        with Image.open(BytesIO(blob)) as im:
            im.load()
            if im.mode in ("P", "LA"):
                im = im.convert("RGBA")
            if ext in (".jpg", ".jpeg"):
                if im.mode not in ("RGB", "L"):
                    bg = Image.new("RGB", im.size, (255, 255, 255))
                    if im.mode == "RGBA":
                        bg.paste(im, mask=im.split()[-1])
                        im = bg
                    else:
                        im = im.convert("RGB")
                im.save(full, format="JPEG", quality=92, optimize=True)
            elif ext == ".png":
                if im.mode not in ("RGB", "RGBA", "L"):
                    im = im.convert("RGBA")
                im.save(full, format="PNG", optimize=True)
            elif ext == ".webp":
                im.save(full, format="WEBP", quality=90)
            elif ext == ".gif":
                im.save(full, format="GIF")
            else:
                raise ValueError(f"unsupported extension: {ext}")
        return "pillow"
    except ImportError:
        pass

    # Pillow 없을 때: 캔버스 export는 EXIF 없음 → 확장자·MIME 맞으면 raw 기록
    ok_pairs = {
        ".jpg": ("image/jpeg",),
        ".jpeg": ("image/jpeg",),
        ".png": ("image/png",),
        ".webp": ("image/webp",),
        ".gif": ("image/gif",),
    }
    if ext not in ok_pairs or mime not in ok_pairs[ext]:
        if not (mime == "image/jpeg" and ext in (".jpg", ".jpeg")):
            raise ValueError(f"Pillow 없음 · MIME {mime} → {ext} 직접 저장 불가")
    full.write_bytes(blob)
    return "raw"


def rotate_image_file(full: Path, degrees: int) -> str:
    """파일을 degrees(시계 +)만큼 회전. Pillow 우선, 없으면 macOS sips.

    Returns: backend name ('pillow'|'sips')
    """
    d = degrees % 360
    if d == 270:
        d = -90
    elif d == -270:
        d = 90

    try:
        from PIL import Image  # type: ignore

        with Image.open(full) as im:
            if d in (90,):
                out = im.transpose(Image.Transpose.ROTATE_270)  # CW 90
            elif d in (-90,):
                out = im.transpose(Image.Transpose.ROTATE_90)  # CCW 90
            elif d in (180, -180):
                out = im.transpose(Image.Transpose.ROTATE_180)
            else:
                out = im.rotate(-d, expand=True)
            save_kw: dict = {}
            fmt = (im.format or full.suffix.lstrip(".").upper()).replace("JPG", "JPEG")
            if fmt == "JPEG":
                save_kw["quality"] = 92
                save_kw["optimize"] = True
            if "exif" in im.info:
                save_kw["exif"] = im.info["exif"]
            out.save(full, format=fmt, **save_kw)
        return "pillow"
    except ImportError:
        pass

    sips_deg = d if d >= 0 else (360 + d)
    if sips_deg not in (90, 180, 270):
        raise ValueError(f"unsupported rotate angle: {degrees}")
    if not shutil.which("sips"):
        raise ValueError("image rotate needs Pillow (pip install pillow)")
    proc = subprocess.run(
        ["sips", "-r", str(sips_deg), str(full)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise ValueError((proc.stderr or proc.stdout or "sips rotate failed").strip()[:200])
    return "sips"


# ── 티스토리 요약 (features.tistory_summary 일 때만) ─────────────────────────
def draft_topic_of(post: Path) -> str:
    """drafts/<topic>/<slug>/post.md → topic. frontmatter topic 우선."""
    try:
        text = post.read_text(encoding="utf-8")
        m = re.search(r"(?m)^topic:\s*['\"]?([^\s'\"]+)", text)
        if m:
            return (m.group(1) or "").strip()
    except OSError:
        pass
    try:
        return post.parent.parent.name
    except Exception:
        return ""


def tistory_summary_stub(*, title: str, wp_url: str = "") -> str:
    """원글 옆 tistory-summary.md 기본 골격 — 제목형 한 줄 + WP 원문 CTA."""
    title = (title or "").strip() or "(제목)"
    url = (wp_url or "").strip() or "(WP publish 후 주소 기입)"
    return (
        f"# 티스토리 요약 — {title}\n"
        "\n"
        f"- WP: {url}\n"
        "\n"
        "## 마크다운\n"
        "\n"
        "```markdown\n"
        f"**{title}**\n"
        "\n"
        "(2~3문장: 무슨 글인지·숫자·결론)\n"
        "\n"
        "---\n"
        "\n"
        "📰 **WordPress 원문 보기**\n"
        "\n"
        f"👉 {url}\n"
        "\n"
        "사진 · 표 · 전체 본문 · 최신 수정본은 위 주소에서 확인하세요.\n"
        "```\n"
    )


def ensure_tistory_summary(
    post: Path,
    *,
    title: str | None = None,
    wp_url: str | None = None,
) -> Path | None:
    """post.md 옆에 tistory-summary.md 를 보장. 없으면 스텁 생성, 있으면 WP URL 자리표시자만 보강.

    기능이 꺼져 있거나 tistory_skip_topics 에 속하면 신규 생성하지 않는다.
    """
    if not CFG.tistory_summary:
        return None
    summary = post.parent / SUMMARY_NAME
    topic = draft_topic_of(post)
    skip = topic in CFG.tistory_skip_topics
    if skip and not summary.is_file():
        return None
    title = (
        (title or "").strip()
        or parse_title(post.read_text(encoding="utf-8"))
        or post.parent.name
    )
    url = (wp_url or "").strip()
    if not summary.is_file():
        summary.write_text(tistory_summary_stub(title=title, wp_url=url), encoding="utf-8")
        return summary
    if not url:
        return summary
    text = summary.read_text(encoding="utf-8")
    updated = text.replace("(WP publish 후 자동 기입)", url)
    if re.search(r"(?m)^- WP:\s*$", updated) or re.search(r"(?m)^- WP:\s*\(WP publish", updated):
        updated = re.sub(r"(?m)^- WP:\s*.*$", f"- WP: {url}", updated, count=1)
    if updated != text:
        summary.write_text(updated, encoding="utf-8")
    return summary


def create_blank_draft(
    *,
    title: str,
    wp_category: str,
    slug: str | None = None,
) -> dict:
    title = (title or "").strip()
    if not title:
        raise ValueError("title required")
    wp_category = (wp_category or "").strip()
    cat_to_topic = CFG.category_to_topic()
    if wp_category not in cat_to_topic:
        raise ValueError(f"unknown wp_category: {wp_category}")
    topic = sanitize_slug(cat_to_topic[wp_category]) or "general"
    slug_in = sanitize_slug(slug or "") or sanitize_slug(title)
    if not slug_in:
        slug_in = f"{topic}-{datetime.now().strftime('%Y-%m-%d')}"
    root = unique_draft_dir(topic, slug_in)
    final_slug = root.name
    (root / "images").mkdir(parents=True, exist_ok=True)
    md = (
        "---\n"
        f"title: {yaml_quoted(title)}\n"
        f"slug: {final_slug}\n"
        "status: draft\n"
        f"topic: {topic}\n"
        f"wp_category: {wp_category}\n"
        'description: ""\n'
        "---\n"
        "\n"
        "본문을 작성하세요. 이미지는「이미지」또는 드래그로 넣습니다.\n"
    )
    post = root / "post.md"
    post.write_text(md, encoding="utf-8")
    summary = ensure_tistory_summary(post, title=title)
    out: dict = {
        "ok": True,
        "path": rel_to_workspace(post),
        "topic": topic,
        "slug": final_slug,
        "title": title,
        "wp_category": wp_category,
        "has_tistory_summary": bool(summary and summary.is_file()),
    }
    if summary is not None:
        out["tistory_summary_path"] = rel_to_workspace(summary)
    return out


def list_drafts() -> list[dict]:
    items: list[dict] = []
    if not DRAFTS_ROOT.is_dir():
        return items
    for post in DRAFTS_ROOT.rglob("post.md"):
        try:
            text = post.read_text(encoding="utf-8")
            parts = post.relative_to(DRAFTS_ROOT).parts
            path_topic = parts[0] if len(parts) >= 2 else ""
            slug = parts[1] if len(parts) >= 3 else (parts[0] if parts else "")
            topic = parse_topic(text) or path_topic
            summary = post.parent / SUMMARY_NAME
            has_summary = CFG.tistory_summary and summary.is_file()
            items.append(
                {
                    "path": rel_to_workspace(post),
                    "topic": topic,
                    "slug": slug,
                    "title": parse_title(text) or slug,
                    "mtime": int(post.stat().st_mtime),
                    "wp_id": parse_wp_id(text),
                    "status": parse_status(text),
                    "wp_category": parse_wp_category(text),
                    "has_tistory_summary": has_summary,
                    "tistory_summary_path": rel_to_workspace(summary) if has_summary else None,
                    "tistory_summary_mtime": int(summary.stat().st_mtime) if has_summary else None,
                }
            )
        except OSError:
            continue
    wp_map = fetch_wp_status_map()
    if wp_map:
        for item in items:
            wid = item.get("wp_id")
            if wid and wid in wp_map:
                item["status"] = wp_map[wid]
    for item in items:
        if item.get("status") not in ("draft", "publish"):
            item["status"] = "none" if not item.get("wp_id") else "unknown"
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items


def media_resolver_for(post: Path):
    """발행 HTML의 img src(/media/... 또는 images/...) → 로컬 파일."""
    draft_dir = post.parent.resolve()

    def resolve(src: str) -> Path | None:
        src = src.split("#", 1)[0].split("?", 1)[0]
        try:
            if src.startswith("/media/"):
                return resolve_media_file(src[len("/media/") :])
            rel = src.lstrip("./")
            if any(rel.startswith(p) for p in MEDIA_ROOT_PREFIXES):
                return resolve_media_file(rel)
            full = (draft_dir / rel).resolve()
            if draft_dir in full.parents and full.is_file():
                return full
        except ValueError:
            return None
        return None

    return resolve


def build_publish_cmd(full: Path, mode: str) -> list[str]:
    repl = {
        "{python}": sys.executable,
        "{file}": str(full),
        "{mode}": mode,
        "{workspace}": str(WORKSPACE),
    }
    out: list[str] = []
    for part in CFG.publish_cmd or []:
        for k, v in repl.items():
            part = part.replace(k, v)
        out.append(part)
    return out


class RequestRejected(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class Handler(BaseHTTPRequestHandler):
    server_version = "PreviewEditor/0.1"

    @property
    def cfg(self) -> AppConfig:
        return getattr(self.server, "cfg", CFG)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        if self.command == "HEAD":
            return
        self.wfile.write(body)

    def _send_json(self, obj: object, status: int = 200) -> None:
        self._send(*_json_bytes(obj, status))

    # ── 보안 ────────────────────────────────────────────────
    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").strip().lower()
        return host in {h.lower() for h in self.cfg.allowed_hosts}

    def _guard_host(self) -> bool:
        if self._host_ok():
            return True
        self._send_json({"error": "host not allowed"}, 403)
        return False

    def _guard_mutation(self) -> bool:
        """PUT/POST/DELETE: Host allowlist + Origin + CSRF 토큰(헤더 또는 JSON csrf_token)."""
        if not self._guard_host():
            return False
        origin = (self.headers.get("Origin") or "").strip()
        if origin and origin.lower() not in {o.lower() for o in self.cfg.allowed_origins()}:
            self._send_json({"error": "origin not allowed"}, 403)
            return False
        token = self.headers.get("X-CSRF-Token") or ""
        if not token:
            try:
                data = self._read_json()
            except RequestRejected as e:
                self._send_json({"error": str(e)}, e.status)
                return False
            except (ValueError, UnicodeDecodeError):
                data = {}
            token = str(data.get("csrf_token") or "") if isinstance(data, dict) else ""
        if not token or not hmac.compare_digest(token, self.cfg.csrf_token):
            self._send_json({"error": "invalid csrf token"}, 403)
            return False
        return True

    def _read_json(self) -> dict:
        if hasattr(self, "_json_cache"):
            return self._json_cache  # type: ignore[has-type]
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError as e:
            raise RequestRejected(400, "invalid Content-Length") from e
        if length < 0:
            raise RequestRejected(400, "invalid Content-Length")
        if length > self.cfg.max_body_bytes:
            raise RequestRejected(413, f"request body too large (>{self.cfg.max_body_bytes} bytes)")
        raw = self.rfile.read(length) if length else b""
        data = json.loads(raw.decode("utf-8")) if raw else {}
        if not isinstance(data, dict):
            raise ValueError("JSON object required")
        self._json_cache = data
        return data

    def _query(self) -> dict[str, str]:
        parsed = urllib.parse.urlparse(self.path)
        return {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}

    def _handle_errors(self, fn) -> None:
        try:
            fn()
        except RequestRejected as e:
            self._send_json({"error": str(e)}, e.status)
        except wp_rest.PublishError as e:
            self._send_json({"ok": False, "error": str(e)}, 502)
        except (ValueError, json.JSONDecodeError) as e:
            self._send_json({"error": str(e)}, 400)
        except OSError as e:
            self._send_json({"error": str(e)}, 500)

    # ── GET ────────────────────────────────────────────────
    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_GET(self) -> None:  # noqa: N802
        if not self._guard_host():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            return self._serve_static("index.html")
        if path in ("/favicon.ico", "/favicon.svg"):
            return self._send(200, FAVICON_SVG, "image/svg+xml")
        if path.startswith("/static/"):
            return self._serve_static(path[len("/static/") :])
        if path == "/api/config":
            return self._send_json(self.cfg.public_dict())
        if path == "/api/drafts":
            return self._send_json({"drafts": list_drafts()})
        if path == "/api/draft":
            return self._handle_errors(self._get_draft)
        if path == "/api/images":
            return self._handle_errors(self._get_images)
        if path.startswith("/media/"):
            return self._serve_media(path[len("/media/") :])
        self._send_json({"error": "not found"}, 404)

    def _get_draft(self) -> None:
        rel = self._query().get("path", "")
        full = resolve_draft_path(rel)
        if not full.is_file():
            return self._send_json({"error": "not found"}, 404)
        text = full.read_text(encoding="utf-8")
        self._send_json({"path": rel, "content": text, "title": parse_title(text)})

    def _get_images(self) -> None:
        rel = self._query().get("path", "")
        post = resolve_draft_path(rel)
        if post.name not in editable_names():
            raise ValueError("path must be a draft markdown file")
        images_dir = post.parent / "images"
        items: list[dict] = []
        if images_dir.is_dir():
            draft_rel = rel_to_workspace(post.parent)
            for p in sorted(images_dir.iterdir()):
                if not p.is_file() or p.suffix.lower() not in ALLOWED_IMG_EXT:
                    continue
                md_path = f"images/{p.name}"
                items.append(
                    {"md_path": md_path, "name": p.name, "media_url": f"/media/{draft_rel}/{md_path}"}
                )
        self._send_json({"ok": True, "images": items})

    # ── PUT / DELETE / POST ───────────────────────────────
    def do_PUT(self) -> None:  # noqa: N802
        if not self._guard_mutation():
            return
        if urllib.parse.urlparse(self.path).path != "/api/draft":
            return self._send_json({"error": "not found"}, 404)
        self._handle_errors(self._put_draft)

    def _put_draft(self) -> None:
        rel = self._query().get("path", "")
        full = resolve_draft_path(rel)
        if full.name not in editable_names():
            raise ValueError("only " + " / ".join(editable_names()) + " writable")
        content = self._read_json().get("content")
        if not isinstance(content, str):
            raise ValueError("content string required")
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")
        self._send_json({"ok": True, "path": rel})

    def do_DELETE(self) -> None:  # noqa: N802
        """완전 삭제 — drafts/<topic>/<slug>/ 폴더 전체 (post·요약·images)."""
        if not self._guard_mutation():
            return
        if urllib.parse.urlparse(self.path).path != "/api/draft":
            return self._send_json({"error": "not found"}, 404)
        self._handle_errors(self._delete_draft)

    def _delete_draft(self) -> None:
        rel = self._query().get("path", "")
        full = resolve_draft_path(rel)
        if full.name not in ("post.md", SUMMARY_NAME):
            raise ValueError("path must be a draft markdown file")
        draft_dir = full.parent.resolve()
        try:
            rel_parts = draft_dir.relative_to(DRAFTS_ROOT.resolve()).parts
        except ValueError as e:
            raise ValueError("outside drafts") from e
        if len(rel_parts) != 2:
            raise ValueError("only drafts/<topic>/<slug>/ can be deleted")
        if not draft_dir.is_dir():
            raise ValueError("draft folder not found")
        deleted_rel = rel_to_workspace(draft_dir)
        shutil.rmtree(draft_dir)
        self._send_json({"ok": True, "deleted": deleted_rel, "path": rel})

    def do_POST(self) -> None:  # noqa: N802
        if not self._guard_mutation():
            return
        routes = {
            "/api/new-draft": self._new_draft,
            "/api/ensure-tistory-summary": self._ensure_tistory_summary,
            "/api/upload": self._upload,
            "/api/image-rotate": self._image_rotate,
            "/api/image-save": self._image_save,
            "/api/publish": self._publish,
        }
        fn = routes.get(urllib.parse.urlparse(self.path).path)
        if fn is None:
            return self._send_json({"error": "not found"}, 404)
        self._handle_errors(fn)

    def _ensure_tistory_summary(self) -> None:
        if not self.cfg.tistory_summary:
            return self._send_json({"error": "tistory_summary feature disabled"}, 404)
        data = self._read_json()
        full = resolve_draft_path(str(data.get("path") or ""))
        if full.name == SUMMARY_NAME:
            full = full.parent / "post.md"
        if full.name != "post.md" or not full.is_file():
            raise ValueError("path must be existing post.md")
        if draft_topic_of(full) in self.cfg.tistory_skip_topics:
            raise ValueError("이 topic은 티스토리 요약을 만들지 않습니다 (tistory_skip_topics)")
        text = full.read_text(encoding="utf-8")
        m = re.search(r'^wp_url:\s*["\']?(.*?)["\']?\s*$', text, re.M)
        wp_url = (m.group(1) or "").strip() if m else ""
        summary = ensure_tistory_summary(full, title=parse_title(text) or None, wp_url=wp_url or None)
        if summary is None:
            raise ValueError("티스토리 요약을 만들 수 없습니다")
        self._send_json(
            {
                "ok": True,
                "path": rel_to_workspace(full),
                "tistory_summary_path": rel_to_workspace(summary),
                "has_tistory_summary": True,
            }
        )

    def _new_draft(self) -> None:
        data = self._read_json()
        result = create_blank_draft(
            title=str(data.get("title") or ""),
            wp_category=str(data.get("wp_category") or ""),
            slug=str(data.get("slug") or "") or None,
        )
        self._send_json(result)

    def _serve_static(self, rel: str) -> None:
        if not rel or ".." in rel.split("/"):
            return self._send_json({"error": "invalid"}, 400)
        root = STATIC_ROOT.resolve()
        full = (STATIC_ROOT / rel).resolve()
        if full != root and root not in full.parents:
            return self._send_json({"error": "invalid"}, 400)
        if not full.is_file():
            return self._send_json({"error": "not found"}, 404)
        ctype = mimetypes.guess_type(str(full))[0] or "application/octet-stream"
        if full.suffix == ".js":
            ctype = "application/javascript; charset=utf-8"
        elif full.suffix == ".css":
            ctype = "text/css; charset=utf-8"
        elif full.suffix == ".html":
            ctype = "text/html; charset=utf-8"
        self._send(200, full.read_bytes(), ctype)

    def _serve_media(self, rel: str) -> None:
        try:
            full = resolve_media_file(urllib.parse.unquote(rel))
            ctype = mimetypes.guess_type(str(full))[0] or "application/octet-stream"
            self._send(200, full.read_bytes(), ctype)
        except ValueError as e:
            code = 404 if str(e) == "not found" else 400
            self._send_json({"error": str(e)}, code)

    def _upload(self) -> None:
        data = self._read_json()
        rel = data.get("path") or ""
        filename = Path(data.get("filename") or "").name
        b64 = data.get("content_base64") or ""
        if not filename or not b64:
            raise ValueError("filename and content_base64 required")
        ext = Path(filename).suffix.lower()
        if ext not in ALLOWED_IMG_EXT:
            raise ValueError(f"forbidden extension: {ext}")
        post = resolve_draft_path(rel)
        if post.name not in editable_names():
            raise ValueError("path must be a draft markdown file")
        try:
            blob = base64.b64decode(b64)
        except Exception as e:
            raise ValueError("base64 decode failed") from e
        if len(blob) > self.cfg.max_body_bytes:
            raise RequestRejected(413, "file too large")
        images = post.parent / "images"
        images.mkdir(parents=True, exist_ok=True)
        (images / filename).write_bytes(blob)
        md_path = f"images/{filename}"
        self._send_json(
            {"ok": True, "md_path": md_path, "media_url": f"/media/{rel_to_workspace(post.parent)}/{md_path}"}
        )

    def _resolve_draft_image(self, rel: str, md_path: str) -> tuple[Path, Path, str]:
        """draft md path + images/… → (post, image_full, clean_md_path)."""
        post = resolve_draft_path(rel)
        if post.name not in editable_names():
            raise ValueError("path must be a draft markdown file")
        clean = (md_path or "").split("#", 1)[0].split("?", 1)[0].lstrip("./")
        if ".." in clean.split("/") or not clean.startswith("images/"):
            raise ValueError("md_path must be under images/")
        full = (post.parent / clean).resolve()
        if post.parent.resolve() not in full.parents:
            raise ValueError("outside draft")
        if full.suffix.lower() not in ALLOWED_IMG_EXT:
            raise ValueError("forbidden extension")
        return post, full, clean

    def _image_rotate(self) -> None:
        """원본 이미지 파일을 회전 (90/180/-90). md 경로는 그대로."""
        data = self._read_json()
        degrees = int(data.get("degrees") or 0)
        if degrees not in (90, -90, 180, 270, -180):
            raise ValueError("degrees must be ±90/180/270")
        post, full, clean = self._resolve_draft_image(data.get("path") or "", data.get("md_path") or "")
        if not full.is_file():
            raise ValueError("image not found")
        rotate_image_file(full, degrees)
        self._send_json(
            {"ok": True, "md_path": clean, "media_url": f"/media/{rel_to_workspace(post.parent)}/{clean}"}
        )

    def _image_save(self) -> None:
        """사진 편집기 결과(data URL)로 images/ 원본 덮어쓰기. EXIF 제거."""
        data = self._read_json()
        post, full, clean = self._resolve_draft_image(data.get("path") or "", data.get("md_path") or "")
        if not full.parent.is_dir():
            raise ValueError("images/ folder missing")
        backend = save_image_data_url(full, str(data.get("data_url") or ""))
        self._send_json(
            {
                "ok": True,
                "md_path": clean,
                "backend": backend,
                "media_url": f"/media/{rel_to_workspace(post.parent)}/{clean}",
            }
        )

    def _publish(self) -> None:
        data = self._read_json()
        rel = data.get("path") or ""
        mode = data.get("mode") or "draft"
        if mode not in ("draft", "publish"):
            raise ValueError("mode must be draft|publish")
        full = resolve_draft_path(rel)
        if not full.is_file() or full.name != "post.md":
            raise ValueError("WP publish는 post.md만 가능")
        cfg = self.cfg

        if cfg.publisher == "command":
            cmd = build_publish_cmd(full, mode)
            try:
                proc = subprocess.run(
                    cmd,
                    cwd=str(WORKSPACE),
                    capture_output=True,
                    text=True,
                    timeout=cfg.publish_timeout,
                )
            except subprocess.TimeoutExpired:
                return self._send_json({"error": "publish timeout"}, 504)
            out = (proc.stdout or "").strip()
            payload: dict = {
                "ok": proc.returncode == 0,
                "exit_code": proc.returncode,
                "stdout": out,
                "stderr": (proc.stderr or "").strip(),
            }
            if out:
                try:
                    payload["result"] = json.loads(out.splitlines()[-1])
                except json.JSONDecodeError:
                    pass
            ok = proc.returncode == 0
        else:
            html = data.get("html")
            text = full.read_text(encoding="utf-8")
            topic = parse_topic(text) or full.parent.parent.name
            result = wp_rest.publish(
                full,
                mode,
                html=html if isinstance(html, str) else None,
                env_file=cfg.resolved_env_file(),
                wp_category=cfg.topic_default_wp().get(topic),
                resolve_media=media_resolver_for(full),
            )
            payload = {"ok": True, "result": result}
            ok = True

        if ok and cfg.tistory_summary:
            result = payload.get("result") or {}
            wp_url = str(result.get("wp_url") or result.get("url") or "").strip()
            title = parse_title(full.read_text(encoding="utf-8"))
            try:
                summary = ensure_tistory_summary(full, title=title or None, wp_url=wp_url or None)
                if summary is not None:
                    payload["tistory_summary_path"] = rel_to_workspace(summary)
                    payload["has_tistory_summary"] = True
                else:
                    payload["has_tistory_summary"] = False
                    payload["tistory_summary_skipped"] = draft_topic_of(full)
            except OSError as e:
                payload["tistory_summary_error"] = str(e)
        self._send_json(payload, 200 if ok else 500)


def main(argv: list[str] | None = None) -> int:
    try:
        cfg = load_config(argv)
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    if cfg.host not in LOOPBACK_HOSTS:
        print("error: bind loopback only (127.0.0.1 / localhost / ::1)", file=sys.stderr)
        return 2
    configure(cfg)
    httpd = ThreadingHTTPServer((cfg.host, cfg.port), Handler)
    httpd.cfg = cfg  # type: ignore[attr-defined]
    print(f"Preview Editor  http://{cfg.host}:{cfg.port}/", flush=True)
    print(f"workspace       {cfg.workspace}", flush=True)
    print(f"drafts          {cfg.drafts_root}", flush=True)
    print(f"publisher       {cfg.publisher}", flush=True)
    if cfg.config_path:
        print(f"config          {cfg.config_path}", flush=True)
    if not cfg.drafts_root.is_dir():
        print(f"note: drafts folder not found yet ({cfg.drafts_root})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
