# 결제 기록장 출시 준비 계획 (v0.4.0)

작성 2026-11-16. 목표: 크롬 웹스토어에 무료로 올려 사용자를 모은다. 광고·유료 기능은 넣지 않는다.
기준 브랜치 `feat/v0.4-redesign-launch-prep` (PR #1). MV3, 빌드 없음, 바닐라 JS, `npm test` + Playwright E2E.

공통 규칙: 키는 브라우저에만, 외부 쓰기·실계정 호출 없음, 함수 50줄·파일 800줄 이하, console.log 금지, 기존 E2E 7개 유지.

## Step 1. Azure 연결 숨기기

`src/lib/cloud/config.js`의 `AZURE_CLIENT_ID`가 비어 있으면 연결 화면(`.provider-grid`)과 빠른 추가 카탈로그에서 Azure를 보이지 않게 구현한다. 지금은 눌러도 안내 문구만 나와서 "안 되는 버튼"이 된다.

- Acceptance: ID가 비면 Azure 선택지가 없다(E2E 확인) / ID를 채우면 다시 보인다(단위 테스트) / 이미 저장된 Azure 연결은 서버·API 화면에 그대로 남는다
- Out of scope: Microsoft Entra 앱 등록 자체, GitHub App 등록

## Step 2. 실계정 미확인 서비스에 "베타" 표시 추가

OpenAI·Cloudflare·GitHub·Vercel은 문서와 가짜 응답으로만 검증했다. 확인된 서비스 목록(`VERIFIED_PROVIDERS = ['aws']`)을 한 곳에 두고, 나머지는 연결 화면 선택지와 연결 카드에 작은 "베타" 배지와 "문제가 있으면 알려 주세요(GitHub 이슈)" 링크를 붙인다.

- Acceptance: AWS에는 배지가 없고 나머지 4개에는 있다 / 목록 하나만 고치면 배지가 사라진다(단위 테스트) / 배지 글씨는 12px 이하, 기존 테마 토큰만 사용
- Out of scope: 실계정으로 각 서비스 확인하기

## Step 3. 버전·웹스토어 등록 문서 작성

`manifest.json`·`package.json` 버전을 0.4.0으로 맞추고, 두 버전이 같은지 보는 테스트를 추가한다. `docs/store-listing.md`에 웹스토어 등록 문안을 쓴다: 짧은 소개(132자 이하), 자세한 설명, 단일 목적 설명, 권한별 사유(특히 `<all_urls>`·`scripting`), 데이터 사용 공개 항목 체크 답안, 개인정보 처리방침 주소.

- Acceptance: manifest 설명 132자 이하 / 권한 사유가 manifest의 모든 권한을 빠짐없이 다룬다 / `docs/privacy.html`과 내용이 어긋나지 않는다
- Out of scope: 웹스토어 실제 업로드, 개발자 계정 등록

## Step 4. 웹스토어 스크린샷 E2E 만들기

`e2e/store-shots.e2e.mjs`를 만들어 가짜 데이터(구독 6개, AWS·OpenAI 연결 결과)로 1280x800 스크린샷 5장을 `e2e/store-shots/`에 저장한다: 이번 달, 빠른 추가, 서버·API, 달마다 그래프, 팝업.

- Acceptance: 5장 모두 1280x800 PNG / 실제 개인 데이터·키 없음 / 페이지 오류(pageerror) 0건
- Out of scope: 이미지 편집·문구 합성

## Step 5. 첫 실행 안내 구현

설치 직후(`runtime.onInstalled`, reason `install`) 대시보드를 열고, 기록이 없으면 홈에 안내 카드를 띄운다: ① 자주 쓰는 구독 골라 담기(빠른 추가 열기) ② 내 카드 등록 ③ 서버·API 연결(선택). 단계를 끝내면 체크되고, "다음에 하기"로 닫으면 다시 뜨지 않는다(`settings`에 저장).

- Acceptance: 새 설치에서 대시보드가 열리고 안내 카드가 보인다 / 구독 하나를 담으면 1단계가 체크된다 / 닫은 뒤 새로고침해도 안 뜬다, 업데이트(reason `update`) 때는 대시보드를 열지 않는다
- Out of scope: 사용자 유형별 맞춤 홈, 영어 지원

## Step 6. 출시 전 전체 점검

`npm test`와 E2E 전체를 돌리고, 확장 패키지에 들어갈 파일(테스트·e2e·docs·node_modules 제외)을 점검하는 zip 스크립트(`scripts/pack.mjs`)를 만든다. 보안 점검: 비밀값 하드코딩, content script의 storage 접근 제한, 오류 문장 속 키 가림, 권한 최소화.

- Acceptance: 테스트·E2E 전부 통과 / zip에 test·e2e·docs·node_modules·스크린샷이 없다 / 보안 점검 CRITICAL·HIGH 0건
- Out of scope: 웹스토어 제출

## 사람이 할 일 (자동화 안 함)

- PR #1 머지 → GitHub Pages 켜기(Settings → Pages → `main` / `/docs`) → `https://hd152521.github.io/record-payment/privacy.html` 확인
- 크롬 웹스토어 개발자 등록($5), 2단계 인증
- Step 6의 zip 업로드, 등록 문안·스크린샷 입력, 심사 제출
- 가능하면 OpenAI·Cloudflare·GitHub·Vercel 실계정 확인 → 확인되면 Step 2의 목록에 추가
