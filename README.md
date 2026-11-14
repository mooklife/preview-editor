# Preview Editor

**무료 · 로컬 · WordPress 지향 Markdown WYSIWYG 편집기.**
디스크의 `post.md`를 보이는 그대로 편집하고, 버튼 하나로 WordPress에 draft/publish 합니다.
Python 3 표준 라이브러리만으로 동작합니다(설치할 패키지 없음, Pillow는 선택).

> English summary is at the bottom.

## 특징

- **Markdown이 원본** — `drafts/<topic>/<slug>/post.md` + `images/`. 에디터는 저장할 때만 파일을 씁니다.
- **WYSIWYG 한 창** (Toast UI Editor) — 표 병합, 정렬, 문단 위 여백, 이미지 폭/회전/가로 묶기.
- **사진 편집** — 크롭·필터·스티커·모자이크 (TOAST UI Image Editor). 저장 시 EXIF(GPS) 제거(Pillow 설치 시).
- **WordPress 발행** — 내장 REST 발행기(로컬 이미지 자동 업로드, 카테고리·태그·대표 이미지) 또는 외부 명령 훅.
- **로컬 전용 보안** — 루프백 바인드 + Host allowlist + Origin 검사 + 세션 CSRF 토큰.

## 빠른 시작

```bash
git clone <this-repo> preview-editor
cd preview-editor
python3 server.py --workspace examples/workspace
# → http://127.0.0.1:3013
```

샘플 글 `examples/workspace/drafts/general/hello/post.md`가 목록에 보이면 성공입니다.

내 블로그 폴더로 쓰려면:

```bash
python3 server.py --workspace ~/my-blog      # ~/my-blog/drafts/** 를 편집
```

### 옵션

| CLI | 환경변수 | 설명 |
|---|---|---|
| `--workspace PATH` | `PE_WORKSPACE` | 작업 루트 (기본: 현재 폴더). 그 안의 `drafts/`를 편집 |
| `--config FILE` | `PE_CONFIG` | JSON 설정 파일 (`config.example.json` 참고) |
| `--host` / `--port` | `PE_HOST` / `PE_PORT` | 기본 `127.0.0.1:3013` (루프백만 허용) |
| `--env-file FILE` | `PE_ENV_FILE` | WP 자격증명 파일 (기본 `<workspace>/.env`) |
| `--publisher` | `PE_PUBLISHER` | `builtin`(기본) / `command` |

우선순위: **CLI > 환경변수(PE_\*) > JSON 설정 > 기본값**.

## WordPress 연결

1. WP 관리자 → 사용자 → 프로필 → **애플리케이션 비밀번호** 생성
2. `.env.example`을 `<workspace>/.env`로 복사하고 채우기

```env
WP_BASE_URL=https://example.com
WP_APP_USER=your-username
WP_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx
```

3. 에디터에서「WP draft」또는「WP publish」

내장 발행기는 에디터가 렌더한 HTML을 본문으로 보내고, 본문의 로컬 이미지를 WP 미디어로 올린 뒤
URL을 바꿉니다. 성공하면 `post.md` frontmatter에 `wp_id`, `wp_url`, `status`를 기록하므로
다음 발행부터는 같은 글을 갱신합니다. 자격증명이 있으면 목록 배지(P/D)도 WP 상태와 동기화됩니다.

### 외부 발행 스크립트 쓰기

이미 쓰는 발행 스크립트가 있다면 `publisher: "command"`로 연결합니다.

```json
{
  "publisher": "command",
  "publish_cmd": ["{python}", "/path/to/publish.py", "--file", "{file}", "--mode", "{mode}", "--json"]
}
```

자리표시자: `{python}`(현재 파이썬), `{file}`(post.md 절대경로), `{mode}`(draft|publish), `{workspace}`.
스크립트 stdout 마지막 줄이 JSON(`{"wp_url": ..., "status": ...}`)이면 UI가 결과를 표시합니다.

## 카테고리

신규 초안 대화상자와 상단 카테고리 선택은 설정의 `categories`를 씁니다.
각 항목의 `value`는 WP 카테고리 **슬러그**, `topic`은 초안이 저장될 `drafts/<topic>/` 폴더입니다.

```json
"categories": [
  { "value": "blog", "label": "Blog", "topic": "general" },
  { "value": "travel", "label": "Travel", "topic": "travel" }
]
```

목록 대신 파일 경로(`"categories_file": "categories.example.json"`)를 줄 수도 있습니다.
frontmatter에 `wp_category`가 없으면 topic별 첫 카테고리가 기본값이며, `topic_defaults`로 덮어쓸 수 있습니다.

## 보안

로컬에서 혼자 쓰는 도구입니다. 서버는 루프백에만 바인드되고, 모든 요청은 Host allowlist를,
변경 요청은 Origin 검사와 CSRF 토큰을 통과해야 합니다. 원격 접속이 필요하면 인증이 있는
터널/프록시를 앞에 두고 그 호스트를 `allowed_hosts`에 추가하세요. 자세한 내용은
[docs/SECURITY.md](docs/SECURITY.md).

## 테마 스니펫

`wp-theme-snippet.css`를 WP「추가 CSS」에 붙이면 발행된 글이 에디터 미리보기와 비슷하게 보입니다
(본문 폭 680px, 이미지·표·인용 스타일).

## 선택 기능: 티스토리 요약

`features.tistory_summary: true`로 켜면 각 원글 옆에 `tistory-summary.md`를 만들고 목록에서 함께 편집합니다.
기본값은 꺼짐입니다. `tistory_skip_topics`에 넣은 topic은 요약을 만들지 않습니다.

## 폴더 구조

```
server.py            # HTTP 서버 (표준 라이브러리)
config.py            # 설정 로더
publishers/wp_rest.py# WP REST 발행기 (urllib)
static/              # 프론트엔드 (vendor/ 는 서드파티)
examples/workspace/  # 샘플 작업 공간
```

## 라이선스

[MIT](LICENSE). 포함된 서드파티 라이브러리는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 보세요.

---

## English summary

**Preview Editor** is a free, local, WordPress-oriented Markdown WYSIWYG editor.
Your Markdown files on disk (`drafts/<topic>/<slug>/post.md` + `images/`) are the source of truth;
the browser UI (Toast UI Editor) edits them in place and publishes to WordPress as draft or publish.

- Run: `python3 server.py --workspace examples/workspace` → http://127.0.0.1:3013 (Python 3 stdlib only; Pillow optional for EXIF stripping/rotation).
- Config: CLI > `PE_*` env vars > `--config` JSON > defaults. See `config.example.json`.
- WordPress: put `WP_BASE_URL`, `WP_APP_USER`, `WP_APP_PASSWORD` (Application Password) in `<workspace>/.env`. The builtin REST publisher uploads local images, sets category/tags/featured image, and writes `wp_id`/`wp_url` back to frontmatter. Or plug in your own script via `publisher: "command"`.
- Categories come from the JSON config (`value` = WP category slug, `topic` = drafts subfolder).
- Security: loopback-only bind, Host allowlist, Origin check, and a per-session CSRF token on all mutating requests.
- `wp-theme-snippet.css` makes published posts look like the editor preview.
- License: MIT.
