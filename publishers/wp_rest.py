"""WordPress REST 발행기 — 표준 라이브러리(urllib)만 사용.

자격증명(.env 또는 환경변수):
  WP_BASE_URL       예: https://example.com   (WP_BASE_URL_LOCAL 도 허용)
  WP_APP_USER       WordPress 사용자명
  WP_APP_PASSWORD   Application Password (공백 무시)
"""

from __future__ import annotations

import base64
import hashlib
import html as html_lib
import json
import mimetypes
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

USER_AGENT = "PreviewEditor/0.1 (+wp_rest)"
FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?(.*)\Z", re.S)


class PublishError(Exception):
    pass


# ── env / auth ──────────────────────────────────────────────────────────────
def load_env(path: Path | None) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path or not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        if k.startswith("export "):
            k = k[len("export ") :].strip()
        out[k] = v.strip().strip('"').strip("'")
    return out


def credentials(env_file: Path | None) -> tuple[str, str, str] | None:
    env = load_env(env_file)

    def pick(*keys: str) -> str:
        for k in keys:
            v = env.get(k) or os.environ.get(k)
            if v:
                return v
        return ""

    base = pick("WP_BASE_URL", "WP_BASE_URL_LOCAL")
    user = pick("WP_APP_USER")
    password = pick("WP_APP_PASSWORD").replace(" ", "")
    if not (base and user and password):
        return None
    return base.rstrip("/"), user, password


def api_request(
    base: str,
    path: str,
    *,
    user: str,
    password: str,
    method: str = "GET",
    data: dict | None = None,
    raw_body: bytes | None = None,
    extra_headers: dict[str, str] | None = None,
    timeout: int = 120,
) -> tuple[int, object]:
    token = base64.b64encode(f"{user}:{password}".encode()).decode()
    headers = {
        "Authorization": f"Basic {token}",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    if extra_headers:
        headers.update(extra_headers)
    body = raw_body
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            try:
                return resp.status, json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                return resp.status, {"message": f"non-json response: {raw[:200]}"}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw) if raw else {"message": str(e)}
        except json.JSONDecodeError:
            return e.code, {"message": raw[:500] or str(e)}


# ── status map (목록 배지) ──────────────────────────────────────────────────
def fetch_status_map(env_file: Path | None) -> dict[str, str]:
    """WP id → status. 자격증명이 없거나 실패하면 빈 dict."""
    cred = credentials(env_file)
    if not cred:
        return {}
    base, user, password = cred
    out: dict[str, str] = {}
    try:
        for page in range(1, 21):
            q = urllib.parse.urlencode(
                {"status": "any", "per_page": "100", "page": str(page), "_fields": "id,status"}
            )
            code, data = api_request(
                base, f"/wp-json/wp/v2/posts?{q}", user=user, password=password, timeout=15
            )
            if code != 200 or not isinstance(data, list) or not data:
                break
            for row in data:
                wid, st = row.get("id"), row.get("status")
                if wid is not None and st in ("draft", "publish"):
                    out[str(wid)] = st
            if len(data) < 100:
                break
    except Exception:
        return {}
    return out


# ── frontmatter ────────────────────────────────────────────────────────────
def parse_frontmatter(text: str) -> tuple[dict, str]:
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    meta: dict = {}
    for line in m.group(1).splitlines():
        if ":" not in line or line.startswith((" ", "\t", "#")):
            continue
        k, v = line.split(":", 1)
        v = v.strip()
        if v.startswith("[") and v.endswith("]"):
            meta[k.strip()] = [x.strip().strip("'\"") for x in v[1:-1].split(",") if x.strip()]
        else:
            meta[k.strip()] = v.strip("'\"")
    return meta, m.group(2)


def rewrite_frontmatter(path: Path, updates: dict[str, str]) -> None:
    text = path.read_text(encoding="utf-8")
    m = FRONTMATTER_RE.match(text)
    if not m:
        lines: list[str] = []
        body = text
    else:
        lines, body = m.group(1).splitlines(), m.group(2)
    keys = set(updates)
    out: list[str] = []
    for line in lines:
        k = line.split(":", 1)[0].strip() if ":" in line else ""
        if k in keys:
            out.append(f"{k}: {updates[k]}")
            keys.discard(k)
        else:
            out.append(line)
    for k in updates:
        if k in keys:
            out.append(f"{k}: {updates[k]}")
    path.write_text("---\n" + "\n".join(out) + "\n---\n" + body, encoding="utf-8")


# ── markdown fallback (프론트 HTML이 없을 때) ─────────────────────────────
def _inline(s: str) -> str:
    s = html_lib.escape(s, quote=False)
    s = re.sub(r"!\[([^\]]*)\]\(([^)\s]+)\)", r'<img src="\2" alt="\1" />', s)
    s = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", r'<a href="\2">\1</a>', s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    return s


def simple_md_to_html(md: str) -> str:
    out: list[str] = []
    para: list[str] = []
    in_code = False
    code: list[str] = []
    list_tag: str | None = None

    def flush_para() -> None:
        if para:
            out.append("<p>" + "<br />".join(_inline(x) for x in para) + "</p>")
            para.clear()

    def close_list() -> None:
        nonlocal list_tag
        if list_tag:
            out.append(f"</{list_tag}>")
            list_tag = None

    for line in md.splitlines():
        if line.strip().startswith("```"):
            if in_code:
                out.append("<pre><code>" + html_lib.escape("\n".join(code)) + "</code></pre>")
                code.clear()
                in_code = False
            else:
                flush_para()
                close_list()
                in_code = True
            continue
        if in_code:
            code.append(line)
            continue
        h = re.match(r"^(#{1,6})\s+(.*)$", line)
        ul = re.match(r"^\s*[-*]\s+(.*)$", line)
        ol = re.match(r"^\s*\d+\.\s+(.*)$", line)
        if h:
            flush_para()
            close_list()
            n = len(h.group(1))
            out.append(f"<h{n}>{_inline(h.group(2))}</h{n}>")
        elif ul or ol:
            flush_para()
            tag = "ul" if ul else "ol"
            if list_tag != tag:
                close_list()
                out.append(f"<{tag}>")
                list_tag = tag
            out.append(f"<li>{_inline((ul or ol).group(1))}</li>")
        elif line.startswith(">"):
            flush_para()
            close_list()
            out.append(f"<blockquote><p>{_inline(line.lstrip('> '))}</p></blockquote>")
        elif not line.strip():
            flush_para()
            close_list()
        else:
            close_list()
            para.append(line)
    flush_para()
    close_list()
    return "\n".join(out)


# ── media ──────────────────────────────────────────────────────────────────
def ensure_media(local: Path, *, prefix: str, base: str, user: str, password: str) -> dict | None:
    raw = local.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()[:10]
    unique = f"{prefix}__{local.stem}.{digest}{local.suffix}"
    q = urllib.parse.urlencode({"search": Path(unique).stem, "per_page": 20})
    code, data = api_request(base, f"/wp-json/wp/v2/media?{q}", user=user, password=password)
    if code == 200 and isinstance(data, list):
        pat = re.compile(
            "^" + re.escape(Path(unique).stem) + r"(?:-\d+)?" + re.escape(local.suffix) + "$"
        )
        for item in data:
            src = str(item.get("source_url") or "")
            if pat.fullmatch(Path(urllib.parse.urlparse(src).path).name):
                return {"id": int(item["id"]), "source_url": src}
    mime = mimetypes.guess_type(str(local))[0] or "application/octet-stream"
    code, data = api_request(
        base,
        "/wp-json/wp/v2/media",
        user=user,
        password=password,
        method="POST",
        raw_body=raw,
        extra_headers={
            "Content-Type": mime,
            "Content-Disposition": f'attachment; filename="{unique}"',
        },
    )
    if code not in (200, 201) or not isinstance(data, dict) or "source_url" not in data:
        return None
    return {"id": int(data["id"]), "source_url": str(data["source_url"])}


_IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.I)
_SRC_RE = re.compile(r'\bsrc="([^"]+)"', re.I)


def upload_local_images(
    html: str,
    *,
    resolve_media: Callable[[str], Path | None],
    prefix: str,
    base: str,
    user: str,
    password: str,
    warnings: list[str],
) -> str:
    """<img src="/media/..."> 등 로컬 경로를 WP 미디어 URL로 치환. #w=NN 은 width 스타일로."""

    def repl(m: re.Match[str]) -> str:
        tag = m.group(0)
        sm = _SRC_RE.search(tag)
        if not sm:
            return tag
        src = html_lib.unescape(sm.group(1))
        parsed = urllib.parse.urlparse(src)
        if parsed.scheme in ("http", "https") and parsed.hostname not in (
            "127.0.0.1",
            "localhost",
        ):
            return tag
        if parsed.scheme == "data":
            return tag
        width = re.search(r"[#&]w=(\d{1,3})", src)
        file_src = urllib.parse.unquote(parsed.path)
        local = resolve_media(file_src)
        if local is None:
            warnings.append(f"image not found: {src}")
            return tag
        media = ensure_media(local, prefix=prefix, base=base, user=user, password=password)
        if not media:
            warnings.append(f"media upload failed: {local.name}")
            return tag
        new_tag = tag[: sm.start()] + f'src="{media["source_url"]}"' + tag[sm.end() :]
        if width and "style=" not in new_tag:
            new_tag = new_tag.replace("<img", f'<img style="width:{int(width.group(1))}%"', 1)
        return new_tag

    return _IMG_TAG_RE.sub(repl, html)


def _category_ids(base: str, user: str, password: str, slug: str | None) -> list[int]:
    if not slug:
        return []
    q = urllib.parse.urlencode({"slug": slug})
    code, data = api_request(base, f"/wp-json/wp/v2/categories?{q}", user=user, password=password)
    if code == 200 and isinstance(data, list) and data:
        return [int(data[0]["id"])]
    return []


def _tag_ids(base: str, user: str, password: str, tags: list[str]) -> list[int]:
    ids: list[int] = []
    for name in dict.fromkeys(t.strip() for t in tags if t.strip()):
        q = urllib.parse.urlencode({"search": name})
        code, data = api_request(base, f"/wp-json/wp/v2/tags?{q}", user=user, password=password)
        found = None
        if code == 200 and isinstance(data, list):
            found = next(
                (int(t["id"]) for t in data if str(t.get("name", "")).lower() == name.lower()), None
            )
        if found is None:
            code, data = api_request(
                base, "/wp-json/wp/v2/tags", user=user, password=password, method="POST",
                data={"name": name},
            )
            if code in (200, 201) and isinstance(data, dict) and "id" in data:
                found = int(data["id"])
        if found is not None:
            ids.append(found)
    return ids


# ── publish ────────────────────────────────────────────────────────────────
def publish(
    path: Path,
    mode: str,
    *,
    html: str | None = None,
    env_file: Path | None = None,
    wp_category: str | None = None,
    resolve_media: Callable[[str], Path | None] | None = None,
) -> dict:
    """post.md → WP 글 생성/갱신. 성공 시 frontmatter에 wp_id/wp_url/status 기록.

    html 이 주어지면(에디터 렌더 결과) 본문으로 사용하고, 없으면 간이 MD 변환.
    """
    if mode not in ("draft", "publish"):
        raise PublishError("mode must be draft|publish")
    cred = credentials(env_file)
    if not cred:
        raise PublishError(
            "WP credentials missing: set WP_BASE_URL / WP_APP_USER / WP_APP_PASSWORD in .env"
        )
    base, user, password = cred
    text = path.read_text(encoding="utf-8")
    meta, body = parse_frontmatter(text)
    title = str(meta.get("title") or path.parent.name)
    slug = str(meta.get("slug") or path.parent.name)
    content = html if isinstance(html, str) and html.strip() else simple_md_to_html(body)
    warnings: list[str] = []

    def default_resolver(src: str) -> Path | None:
        p = (path.parent / src.lstrip("./")).resolve()
        return p if p.is_file() and path.parent.resolve() in p.parents else None

    resolver = resolve_media or default_resolver
    content = upload_local_images(
        content, resolve_media=resolver, prefix=path.parent.name,
        base=base, user=user, password=password, warnings=warnings,
    )

    payload: dict = {"title": title, "slug": slug, "status": mode, "content": content}
    desc = str(meta.get("description") or "").strip()
    if desc:
        payload["excerpt"] = desc
    featured = str(meta.get("featured_image") or "").strip()
    if featured:
        local = resolver(featured.split("#", 1)[0].split("?", 1)[0])
        if local is None:
            local = default_resolver(featured.split("#", 1)[0].split("?", 1)[0])
        media = (
            ensure_media(local, prefix=path.parent.name, base=base, user=user, password=password)
            if local
            else None
        )
        if media:
            payload["featured_media"] = media["id"]
        else:
            warnings.append(f"featured_image not uploaded: {featured}")
    cat_slug = str(meta.get("wp_category") or "").strip() or wp_category
    cats = _category_ids(base, user, password, cat_slug)
    if cats:
        payload["categories"] = cats
    tags = meta.get("tags") if isinstance(meta.get("tags"), list) else []
    tag_ids = _tag_ids(base, user, password, tags) if tags else []
    if tag_ids:
        payload["tags"] = tag_ids

    post_id = str(meta.get("wp_id") or "").strip()
    action = "update" if post_id else "create"
    if post_id:
        code, data = api_request(
            base, f"/wp-json/wp/v2/posts/{post_id}", user=user, password=password,
            method="POST", data=payload,
        )
    else:
        code, data = api_request(
            base, "/wp-json/wp/v2/posts", user=user, password=password,
            method="POST", data=payload,
        )
    if code >= 400 or not isinstance(data, dict) or "id" not in data:
        msg = data.get("message") if isinstance(data, dict) else data
        raise PublishError(f"WP API {code}: {msg}")

    wp_id = str(data["id"])
    link = str(data.get("link") or f"{base}/?p={wp_id}")
    rewrite_frontmatter(
        path,
        {"wp_id": wp_id, "wp_url": link, "status": mode, "slug": str(data.get("slug") or slug)},
    )
    return {
        "ok": True,
        "action": action,
        "wp_id": wp_id,
        "wp_url": link,
        "status": mode,
        "wp_category": cat_slug,
        "categories": cats,
        "tags": tag_ids,
        "warnings": warnings,
    }
