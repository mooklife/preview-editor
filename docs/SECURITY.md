# 보안 모델 (Security)

Preview Editor는 **본인 컴퓨터에서 혼자 쓰는 로컬 도구**를 전제로 합니다. 인증 기능이 없으므로
아래 방어선을 끄거나 인터넷에 직접 노출하지 마세요.

## 기본 방어

| 항목 | 동작 |
|---|---|
| 루프백 바인드 | `127.0.0.1` / `localhost` / `::1` 이외 주소는 시작 거부 |
| Host allowlist | 모든 요청의 `Host` 헤더가 `allowed_hosts`에 없으면 403 (DNS rebinding 방지) |
| Origin 검사 | 변경 요청(PUT/POST/DELETE)에 `Origin`이 있으면 `allowed_hosts`의 http/https 출처만 허용 |
| CSRF 토큰 | 서버 시작마다 새 토큰 생성. 변경 요청은 `X-CSRF-Token` 헤더(또는 JSON `csrf_token`) 필수 |
| 경로 제한 | 편집·삭제는 `<workspace>/<drafts_dir>/` 안, 미디어 서빙은 `media_allow` 접두만 |
| 크기 제한 | 요청 본문·업로드는 `max_body_bytes`(기본 40MB) 초과 시 413 |

## 원격 접속이 필요하면

리버스 프록시/터널(예: Cloudflare Tunnel + Access)로 **인증을 앞단에 두고**, 그 호스트명을
`allowed_hosts`에 추가하세요. 서버 자체는 여전히 루프백에만 바인드합니다.

## 비밀정보

- WP Application Password는 `.env`(또는 `--env-file`)에만 두고 커밋하지 마세요.
- `publisher: "command"`의 `publish_cmd`는 설정 파일 작성자가 정한 명령을 그대로 실행합니다.
  신뢰하지 않는 설정 파일을 쓰지 마세요.

## 취약점 제보

공개 이슈 대신 저장소 관리자에게 비공개로 알려 주세요.
