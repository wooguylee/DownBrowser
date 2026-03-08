# DownBrowser

`DownBrowser`는 Playwright와 Chrome DevTools Protocol(CDP)을 사용해 브라우저 기반 동영상 전송 흐름을 테스트하는 Node.js CLI 도구입니다.

실제 브라우저를 열고 페이지 수준의 네트워크 요청을 감시하면서 HLS manifest와 세그먼트 요청을 찾고, 선택한 스트림을 하나의 로컬 파일로 저장합니다.

이 프로젝트는 본인이 운영하는 서비스 또는 접근 권한이 있는 콘텐츠를 테스트하는 용도로 사용하는 것을 전제로 합니다.

## 주요 기능

- Playwright로 Chromium 실행
- CDP로 `.m3u8`, `.ts`, `m4s` 등 미디어 요청 감지
- 직접 manifest URL을 넣어 다운로드 가능
- 웹페이지를 열고 자동으로 동영상 스트림 탐지 가능
- interactive 모드에서 브라우저를 열어 둔 채 CLI로 제어 가능
- CLI에서 URL 열기 또는 브라우저 주소창에서 직접 이동 후 `scan` 가능
- 감지된 동영상 소스, `video` 요소, 버튼 목록 확인 가능
- 녹화 시작/중지 가능
- 멀티탭 지원 및 탭별 독립 추적 상태 유지
- 병합된 미디어 파일과 메타데이터 JSON 저장

## 요구 사항

- Node.js 20 이상
- npm
- Playwright Chromium 브라우저 설치

## 설치

```bash
npm install
npx playwright install chromium
```

## 빠른 시작

### 1. manifest URL로 바로 다운로드

```bash
node index.js --manifest-url "https://example.com/path/playlist.m3u8" --name sample
```

### 2. 페이지를 열고 자동 탐지

```bash
node index.js --url "https://example.com/watch/123" --headful
```

### 3. interactive 모드 시작

```bash
node index.js --interactive
```

이후 다음 중 하나로 진행하면 됩니다.

- 터미널에서 `open <url>` 실행
- 브라우저 주소창에 직접 URL 입력 후 `scan` 실행

## 실행 방법

```bash
node index.js --url <page-url> [options]
node index.js --manifest-url <m3u8-url> [options]
node index.js --interactive [--url <page-url>] [options]
```

### 옵션

- `--url <url>`: 페이지를 열고 HLS 트래픽 탐지
- `--manifest-url <url>`: 이미 알고 있는 manifest를 직접 다운로드
- `--interactive`: 브라우저를 열어 둔 채 터미널에서 제어
- `--output-dir <dir>`: 저장 디렉터리, 기본값 `./downloads`
- `--name <name>`: 저장 파일 기본 이름
- `--headful`: UI가 보이는 Chromium 실행
- `--headless`: headless 강제 실행
- `--timeout-ms <ms>`: 페이지 이동 타임아웃
- `--poll-seconds <sec>`: live playlist 폴링 대기 시간
- `--max-empty-polls <count>`: 빈 폴링 반복 시 종료 기준
- `--settle-ms <ms>`: 페이지 로드 후 스캔 완료까지 대기 시간
- `--help`: 도움말 출력

## Interactive 모드

interactive 모드는 수동으로 페이지를 탐색하고 어떤 영상을 저장할지 선택해야 할 때 가장 유용합니다.

실행:

```bash
npm run interactive
```

또는:

```bash
node index.js --interactive --output-dir downloads
```

### 일반적인 사용 흐름

```text
open https://example.com/watch/123
scan
sources
record 0 my-video
status
stop
exit
```

### 브라우저에서 직접 이동하는 흐름

```text
# 1. 도구 실행
node index.js --interactive

# 2. 브라우저 주소창에 원하는 URL 입력

# 3. 다시 터미널에서 실행
scan
sources
record 0 my-video
```

### 콘솔 세션 예시

```text
$ node index.js --interactive --output-dir downloads
Browser ready.
Use `open <url>` from the terminal, or type a URL directly in the browser and then run `scan`.

downbrowser[t1]> open https://example.com/watch/123
Loaded: Example Video Page
Detected manifests:
  [0] segments=120 variants=0 endList=yes https://cdn.example.com/video/master.m3u8

downbrowser[t1]> status
Page: Example Video Page
URL: https://example.com/watch/123
Tab: 1
Tracker scope: 3 last reset=2026-03-09 07:47:59
Sources: 1
Sources fresh for current page: yes
Last scan: 2026-03-09 07:48:01 title="Example Video Page" url=https://example.com/watch/123 sources=1 videos=1
Recording: idle

downbrowser[t1]> record 0 example-save
Recording started from tab 1, source 0: https://cdn.example.com/video/master.m3u8

downbrowser[t1]> stop
Stop requested for tab 1. Waiting for current segment to finish...
```

## 명령어 설명

- `help`: 도움말 출력
- `tabs`: 현재 열린 탭 목록 출력
- `new-tab`: 새 탭 생성
- `use-tab <n>`: 특정 탭으로 전환
- `close-tab [n]`: 탭 닫기, 생략 시 현재 탭
- `open <url>`: 현재 탭에서 URL 열기
- `scan`: 현재 페이지 기준으로 동영상 소스 다시 탐지
- `videos`: 현재 페이지의 `video` 요소 목록 출력
- `buttons`: 현재 페이지의 버튼 목록 출력
- `sources`: 감지된 manifest 목록과 freshness 정보 출력
- `clear`: 현재 탭의 추적된 소스 초기화
- `play [n]`: `video` 요소 재생 시도, 기본 `0`
- `pause [n]`: `video` 요소 일시정지, 기본 `0`
- `click-button <n>`: 버튼 인덱스로 클릭
- `click <selector>`: CSS selector 첫 요소 클릭
- `press <key>`: 키 입력 전송, 예: `Space`
- `refresh`: 재생 유도 후 현재 소스/비디오 목록 출력
- `reload`: 현재 페이지 다시 로드 후 재탐지
- `record [n] [name]`: 특정 소스 녹화 시작, 이름 지정 가능
- `stop`: 현재 세그먼트까지 저장 후 녹화 중지
- `status`: 현재 탭 상태, freshness, 녹화 진행 상태 출력
- `exit`: 필요 시 녹화 종료 후 프로그램 종료

## 멀티탭 동작 방식

각 탭은 독립적인 tracker 상태를 가집니다.

- 탭 간 manifest가 섞이지 않음
- `record`는 현재 탭에서 탐지된 소스만 사용
- `status`에서 현재 탭 기준 freshness 확인 가능
- 다른 탭으로 이동해도 이전 탭 상태는 유지됨

예시:

```text
new-tab
open https://example.com/a
scan

new-tab
open https://example.com/b
scan

tabs
use-tab 1
record 0 first-video
```

## 출력 파일

녹화가 완료되면 다음 파일이 저장됩니다.

- `<name>.ts`: 병합된 transport stream 파일
- `<name>.json`: manifest URL, 세그먼트 목록, 크기, 총계 등의 메타데이터

예시:

```text
downloads/
  my-video.ts
  my-video.json
```

## status / freshness 설명

`status`는 다음 정보를 보여줍니다.

- 현재 탭 번호
- 현재 페이지 제목과 URL
- tracker scope id
- 마지막 reset 시각
- 현재 페이지 기준 source freshness 여부
- 마지막 scan 시각과 scan 대상 페이지
- 녹화 중이면 저장된 세그먼트 수, 바이트 수, 마지막 세그먼트

`record`는 현재 페이지 기준으로 source가 stale 상태면 실행되지 않습니다. 이 경우 `scan` 또는 `reload`를 먼저 실행하면 됩니다.

## FFmpeg 후처리

현재 도구는 결과물을 기본적으로 `.ts` 파일로 저장합니다.

더 범용적인 컨테이너가 필요하면 `ffmpeg`로 재인코딩 없이 remux 할 수 있습니다.

```bash
ffmpeg -i downloads/my-video.ts -c copy downloads/my-video.mp4
```

자주 쓰는 예시:

- 기본 remux:

```bash
ffmpeg -i downloads/my-video.ts -c copy downloads/my-video.mp4
```

- 기존 파일 덮어쓰기:

```bash
ffmpeg -y -i downloads/my-video.ts -c copy downloads/my-video.mp4
```

- 저장된 파일 정보 먼저 확인:

```bash
ffprobe downloads/my-video.ts
```

참고:

- `-c copy`는 오디오/비디오를 재인코딩하지 않습니다
- MP4와 맞지 않는 스트림이면 MKV로 remux 할 수 있습니다

```bash
ffmpeg -i downloads/my-video.ts -c copy downloads/my-video.mkv
```

## 스크립트

`package.json`에 포함된 스크립트:

```bash
npm run download
npm run interactive
```

## 주요 파일

- `index.js`: CLI 본체, interactive 제어, CDP 추적, 다운로드 로직
- `demo.html`: 로컬 HLS 테스트용 페이지
- `server.js`: 간단한 정적 서버
- `README.md`: 영문 문서
- `README.ko.md`: 한글 문서

## 로컬 테스트 예시

```bash
node index.js --interactive
open file:///Z:/Work/WorkAI/DownBrowser/demo.html
scan
record 0 demo-test
```

## 문제 해결

### source가 안 잡힐 때

- `scan` 실행
- `play 0` 실행
- `reload` 실행
- `--headful`로 다시 실행

### source가 stale 상태일 때

- 대상 페이지로 다시 이동
- `scan` 또는 `reload` 실행
- `status`에서 freshness가 `yes`인지 확인

### 잘못된 탭을 보고 있을 때

- `tabs` 실행
- `use-tab <n>`으로 전환
- `status`로 확인

## 라이선스

ISC
