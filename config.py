"""Preview Editor 설정 로더.

우선순위: CLI 인자 > 환경변수(PE_*) > --config JSON > 기본값.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 3013
DEFAULT_TITLE = "Preview Editor"
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")

DEFAULT_CATEGORIES: list[dict[str, str]] = [
    {"value": "uncategorized", "label": "Uncategorized", "topic": "general"},
    {"value": "blog", "label": "Blog", "topic": "general"},
]

PUBLISHERS = ("builtin", "command")


@dataclass
class AppConfig:
    workspace: Path = field(default_factory=lambda: Path.cwd())
    drafts_dir: str = "drafts"
    media_allow: list[str] = field(default_factory=lambda: ["drafts/"])
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    allowed_hosts: list[str] = field(default_factory=list)
    categories: list[dict[str, str]] = field(
        default_factory=lambda: [dict(c) for c in DEFAULT_CATEGORIES]
    )
    # topic → 기본 wp_category (categories 에서 자동 유도한 값 위에 덮어씀)
    topic_defaults: dict[str, str] = field(default_factory=dict)
    publisher: str = "builtin"
    publish_cmd: list[str] | None = None
    publish_timeout: int = 600
    features: dict[str, Any] = field(
        default_factory=lambda: {"tistory_summary": False, "tistory_skip_topics": []}
    )
    env_file: Path | None = None
    max_body_bytes: int = 40 * 1024 * 1024
    title: str = DEFAULT_TITLE
    config_path: Path | None = None
    csrf_token: str = field(default_factory=lambda: secrets.token_urlsafe(32))

    # ── 파생 값 ──────────────────────────────────────────────
    @property
    def drafts_root(self) -> Path:
        return self.workspace / self.drafts_dir

    @property
    def drafts_prefix(self) -> str:
        return self.drafts_dir.strip("/") + "/"

    @property
    def tistory_summary(self) -> bool:
        return bool(self.features.get("tistory_summary"))

    @property
    def tistory_skip_topics(self) -> frozenset[str]:
        return frozenset(str(t) for t in self.features.get("tistory_skip_topics") or [])

    def category_to_topic(self) -> dict[str, str]:
        return {c["value"]: c.get("topic") or "general" for c in self.categories}

    def topic_default_wp(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for c in self.categories:
            out.setdefault(c.get("topic") or "general", c["value"])
        out.update(self.topic_defaults)
        return out

    def resolved_env_file(self) -> Path:
        return self.env_file if self.env_file else self.workspace / ".env"

    def allowed_origins(self) -> set[str]:
        origins: set[str] = set()
        for h in self.allowed_hosts:
            origins.add(f"http://{h}")
            origins.add(f"https://{h}")
        return origins

    def public_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "categories": self.categories,
            "topic_defaults": self.topic_default_wp(),
            "features": {
                "tistory_summary": self.tistory_summary,
                "tistory_skip_topics": sorted(self.tistory_skip_topics),
            },
            "csrf_token": self.csrf_token,
            "drafts_prefix": self.drafts_prefix,
            "media_allow": self.media_allow,
            "publisher": self.publisher,
        }


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="preview-editor",
        description="Preview Editor — 로컬 Markdown WYSIWYG 편집기 (WordPress 발행 지원)",
    )
    p.add_argument("--workspace", help="작업 폴더 (drafts/ 를 포함하는 루트). 기본: 현재 폴더")
    p.add_argument("--config", help="JSON 설정 파일 경로")
    p.add_argument("--host", help=f"바인드 주소 (루프백만 허용, 기본 {DEFAULT_HOST})")
    p.add_argument("--port", type=int, help=f"포트 (기본 {DEFAULT_PORT})")
    p.add_argument("--env-file", help="WP 자격증명 .env 경로 (기본: <workspace>/.env)")
    p.add_argument("--publisher", choices=PUBLISHERS, help="builtin(WP REST) | command(외부 명령)")
    return p


def _read_json_config(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"config must be a JSON object: {path}")
    return data


def _load_categories(raw: Any, base_dir: Path) -> list[dict[str, str]]:
    if isinstance(raw, str):
        p = Path(raw).expanduser()
        if not p.is_absolute():
            p = base_dir / p
        raw = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            raw = raw.get("categories")
    if not isinstance(raw, list):
        raise ValueError("categories must be a list or a path to a JSON list")
    out: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict) or not item.get("value"):
            raise ValueError(f"invalid category entry: {item!r}")
        out.append(
            {
                "value": str(item["value"]),
                "label": str(item.get("label") or item["value"]),
                "topic": str(item.get("topic") or "general"),
            }
        )
    if not out:
        raise ValueError("categories must not be empty")
    return out


def _as_bool(v: str) -> bool:
    return v.strip().lower() in ("1", "true", "yes", "y", "on")


def _apply_mapping(cfg: AppConfig, data: dict[str, Any], base_dir: Path) -> None:
    if "workspace" in data and data["workspace"]:
        ws = Path(str(data["workspace"])).expanduser()
        cfg.workspace = ws if ws.is_absolute() else (base_dir / ws)
    if "drafts_dir" in data:
        cfg.drafts_dir = str(data["drafts_dir"]).strip("/") or "drafts"
    if "media_allow" in data:
        cfg.media_allow = [str(x) for x in data["media_allow"]]
    if "host" in data:
        cfg.host = str(data["host"])
    if "port" in data:
        cfg.port = int(data["port"])
    if "allowed_hosts" in data:
        cfg.allowed_hosts = [str(x) for x in data["allowed_hosts"]]
    if "categories" in data:
        cfg.categories = _load_categories(data["categories"], base_dir)
    if "categories_file" in data:
        cfg.categories = _load_categories(str(data["categories_file"]), base_dir)
    if "topic_defaults" in data:
        cfg.topic_defaults = {str(k): str(v) for k, v in dict(data["topic_defaults"]).items()}
    if "publisher" in data:
        cfg.publisher = str(data["publisher"])
    if "publish_cmd" in data:
        cmd = data["publish_cmd"]
        cfg.publish_cmd = [str(x) for x in cmd] if cmd else None
    if "publish_timeout" in data:
        cfg.publish_timeout = int(data["publish_timeout"])
    if "features" in data and isinstance(data["features"], dict):
        cfg.features = {**cfg.features, **data["features"]}
    if "env_file" in data and data["env_file"]:
        ef = Path(str(data["env_file"])).expanduser()
        cfg.env_file = ef if ef.is_absolute() else (base_dir / ef)
    if "max_body_bytes" in data:
        cfg.max_body_bytes = int(data["max_body_bytes"])
    if "title" in data:
        cfg.title = str(data["title"])


def _env_mapping(env: dict[str, str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if env.get("PE_WORKSPACE"):
        out["workspace"] = env["PE_WORKSPACE"]
    if env.get("PE_DRAFTS_DIR"):
        out["drafts_dir"] = env["PE_DRAFTS_DIR"]
    if env.get("PE_HOST"):
        out["host"] = env["PE_HOST"]
    if env.get("PE_PORT"):
        out["port"] = int(env["PE_PORT"])
    if env.get("PE_ALLOWED_HOSTS"):
        out["allowed_hosts"] = [h.strip() for h in env["PE_ALLOWED_HOSTS"].split(",") if h.strip()]
    if env.get("PE_PUBLISHER"):
        out["publisher"] = env["PE_PUBLISHER"]
    if env.get("PE_ENV_FILE"):
        out["env_file"] = env["PE_ENV_FILE"]
    if env.get("PE_TISTORY_SUMMARY"):
        out["features"] = {"tistory_summary": _as_bool(env["PE_TISTORY_SUMMARY"])}
    if env.get("PE_MAX_BODY_BYTES"):
        out["max_body_bytes"] = int(env["PE_MAX_BODY_BYTES"])
    return out


def load_config(
    argv: list[str] | None = None, env: dict[str, str] | None = None
) -> AppConfig:
    """CLI > env PE_* > --config JSON > defaults 순으로 AppConfig 생성."""
    env = dict(os.environ if env is None else env)
    args = build_arg_parser().parse_args(argv)
    cfg = AppConfig()
    cwd = Path.cwd()

    config_arg = args.config or env.get("PE_CONFIG")
    if config_arg:
        cpath = Path(config_arg).expanduser().resolve()
        if not cpath.is_file():
            raise FileNotFoundError(f"config not found: {cpath}")
        cfg.config_path = cpath
        _apply_mapping(cfg, _read_json_config(cpath), cpath.parent)

    _apply_mapping(cfg, _env_mapping(env), cwd)

    cli: dict[str, Any] = {}
    if args.workspace:
        cli["workspace"] = args.workspace
    if args.host:
        cli["host"] = args.host
    if args.port:
        cli["port"] = args.port
    if args.env_file:
        cli["env_file"] = args.env_file
    if args.publisher:
        cli["publisher"] = args.publisher
    _apply_mapping(cfg, cli, cwd)

    cfg.workspace = cfg.workspace.expanduser().resolve()
    if cfg.publisher not in PUBLISHERS:
        raise ValueError(f"publisher must be one of {PUBLISHERS}")
    if cfg.publisher == "command" and not cfg.publish_cmd:
        raise ValueError("publisher=command requires publish_cmd")
    if not cfg.media_allow:
        cfg.media_allow = [cfg.drafts_prefix]

    loopback = [f"127.0.0.1:{cfg.port}", f"localhost:{cfg.port}", f"[::1]:{cfg.port}"]
    cfg.allowed_hosts = list(dict.fromkeys([*loopback, *cfg.allowed_hosts]))
    # CSRF: 재시작마다 바뀌면 열린 탭의 업로드/저장이 403 → workspace에 유지
    cfg.csrf_token = _load_or_create_csrf(cfg.workspace)
    return cfg


def _load_or_create_csrf(workspace: Path) -> str:
    path = workspace / ".preview-editor-csrf"
    try:
        existing = path.read_text(encoding="utf-8").strip()
        if len(existing) >= 16:
            return existing
    except OSError:
        pass
    token = secrets.token_urlsafe(32)
    try:
        path.write_text(token + "\n", encoding="utf-8")
        try:
            path.chmod(0o600)
        except OSError:
            pass
    except OSError:
        pass
    return token
