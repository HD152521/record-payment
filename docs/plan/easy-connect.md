# 쉬운 연결: 토큰을 몰라도 서비스 사용료를 연결하기

작성 2026-11-12 · 상태: **Step 1~6 구현 완료(커밋 전, 사용자 검토 대기)** · 갱신 2026-11-12

- 모두 가짜 화면·가짜 응답으로만 확인했다. 실제 계정으로 눌러 본 것은 없다.
- 사용자가 정할 것: GitHub App 등록 후 `GITHUB_CLIENT_ID` 채우기, AWS 템플릿을 올릴 공개 S3 버킷 운영자 정하고 `AWS_TEMPLATE_URL` 채우기, Azure 앱 등록.
- 실제 콘솔에서 확인할 것: 서비스별 완료 화면 DOM·로그인 경로, Cloudflare Billing 읽기 미리 채우기, 확장 페이지에서 `github.com/login/*` 호출 시 CORS·Origin 거부 여부. 다르면 붙여넣기(D)로 돌아가고 규칙을 고친다.

## 문제

지금은 서비스마다 사용자가 직접 콘솔에 들어가 토큰·키를 만들고 권한을 고르고 붙여 넣어야 한다.
IT인이라도 "Cloudflare Billing Read 토큰"·"GitHub fine-grained Plan 읽기"를 처음 만드는 사람은 여기서 포기한다.

## 아이디·비밀번호를 받는 방식은 하지 않는다

| 이유 | 설명 |
|---|---|
| 권한이 전부 | 비밀번호는 읽기 전용이 아니다. 새면 계정 전체(서버 삭제·결제)가 넘어간다. 지금 설계의 "읽기 전용 키만" 원칙이 깨진다. |
| 로그인이 막힌다 | AWS·GitHub·Cloudflare 등은 MFA·캡차·새 기기 확인을 건다. 자동 로그인은 수시로 깨지고, 우회하면 봇 탐지에 걸린다. |
| 약관·심사 | 대부분 서비스 약관이 제3자에게 비밀번호를 맡기는 자동 로그인을 금지한다. 크롬 웹스토어도 남의 계정 비밀번호를 모으는 확장은 거절·삭제 대상이다. |
| 피싱과 구별 불가 | "여기에 AWS 비밀번호 넣으세요"는 피싱 화면과 같다. 사용자에게 나쁜 습관을 가르친다. |

## 대신 쓸 방법 (쉬운 순)

### A. 이미 로그인된 브라우저를 활용해 "토큰 자동 가져오기"
사용자는 이미 크롬에서 각 콘솔에 로그인돼 있다. 확장이 **권한이 미리 채워진 토큰 생성 페이지**를 열어 주고,
사용자가 "만들기"만 누르면 완료 화면에 뜬 토큰을 확장이 읽어 "이 토큰으로 연결할까요?"라고 묻는다. 붙여넣기도, 권한 고르기도 없다.
- Cloudflare: 권한이 채워진 토큰 생성 URL 지원 여부 확인 필요.
- GitHub: fine-grained 토큰 생성 URL에 이름·권한 미리 채우기 파라미터 지원 여부 확인 필요.
- Vercel·OpenAI: 미리 채우기는 없을 수 있다 → 생성 페이지 바로 열기 + 완료 화면 읽기만.
- 읽기는 "연결" 버튼으로 연 그 탭, 그 페이지에서 한 번만. 평소에는 토큰 페이지를 보지 않는다. 화면 구조가 바뀌면 붙여넣기로 돌아간다.

### B. 진짜 "로그인으로 연결" (OAuth, 서버 없이 되는 곳만)
- Azure: 이미 Entra 로그인 방식(chrome.identity). 앱 등록만 남음.
- GitHub: GitHub App + device flow(코드 입력 방식)로 비밀키 없이 로그인 연결이 되는지, 청구 사용량을 읽을 권한을 줄 수 있는지 확인 필요.
- Vercel·Cloudflare·OpenAI: 공개 OAuth가 없거나 서버(클라이언트 비밀키)가 필요 → A 방식으로.

### C. AWS 원클릭 만들기
AWS는 OAuth가 없다. CloudFormation 빠른 생성 링크로 `ce:GetCostAndUsage`만 가진 IAM 사용자를 한 번에 만든다.
비밀키를 스택 출력에 넣지 않고, 만든 뒤 IAM 화면의 "액세스 키 만들기"로 보내 A 방식처럼 완료 화면을 읽는다.

### D. 단계별 안내서 (모든 서비스 공통 대비책)
연결 창 안에 서비스별 3~5단계 안내(어디 누르고 무엇을 고르는지)와 바로가기 링크. A·B·C가 깨져도 이걸로 끝까지 갈 수 있어야 한다.

### E. (실험) 토큰 없이 청구 페이지 읽기
결제 자동 기록처럼, 사용자가 콘솔의 청구 화면을 열면 이번 달 금액을 읽어 기록. 토큰이 전혀 없지만 화면 구조 의존이 커서 실험으로만 둔다.

## 단계

### Step 1. 서비스별 가능 여부 확인
Cloudflare·GitHub 토큰 미리 채우기 URL, GitHub App device flow로 청구 사용량을 읽을 수 있는지, Vercel·OpenAI 토큰 생성 완료 화면 구조, AWS CloudFormation 빠른 생성 링크를 공식 문서로 확인하고 서비스별로 A/B/C/D 중 무엇을 쓸지 표로 정한다.
- 완료 기준: 서비스 6개 각각 "쓸 방식·근거 링크·안 되는 이유"가 표에 있다.

### Step 2. 연결 마법사와 단계별 안내서
연결 창을 "1) 서비스 고르기 → 2) 버튼 하나로 생성 페이지 열기 → 3) 자동으로 받거나 붙여넣기"로 바꾸고, 서비스별 안내서(D)를 넣는다.
- 완료 기준: 6개 서비스 모두 안내서와 바로가기 링크가 보이고, 기존 붙여넣기 연결이 그대로 동작한다.

### Step 3. 토큰 자동 가져오기
연결 버튼으로 연 탭에서만 토큰 생성 완료 화면을 읽어 확인을 받고 저장한다(A).
- 완료 기준: 가짜 토큰 생성 페이지로 E2E가 통과한다. 연결 버튼으로 열지 않은 탭에서는 아무것도 읽지 않는다. 토큰은 확인 전까지 저장되지 않는다.
- 범위 밖: 토큰 생성 버튼을 확장이 대신 누르는 것.

### Step 4. GitHub 로그인 연결
Step 1에서 가능하다고 확인되면 GitHub App device flow로 "GitHub 로그인으로 연결"을 만든다(B).
- 완료 기준: 코드 입력 화면이 뜨고, 승인 후 토큰이 저장되어 사용료를 읽는다. 비밀키는 확장에 들어가지 않는다.

### Step 5. AWS 원클릭 만들기
CloudFormation 빠른 생성 링크와 템플릿으로 읽기 전용 IAM 사용자를 만들고, 액세스 키 생성 화면으로 이어 준다(C).
- 완료 기준: 템플릿에는 `ce:GetCostAndUsage` 외 권한이 없다. 비밀키가 스택 출력에 나오지 않는다.

### Step 6. 테스트와 문서
자동 가져오기·안내서 흐름 E2E와 README 연결 절을 갱신한다.
- 완료 기준: E2E 전부 통과, README에 서비스별 연결 방식 표가 있다.

## Step 1 결과

확인 2026-11-12, 공식 문서 기준(제3자 문서만 있는 건 그렇게 적음). 실제 계정으로 눌러 본 것은 없다. 확인 못 한 건 "미확인".

| 서비스 | 쓸 방식 | 정확한 URL·파라미터 | 근거 링크 | 안 되는 이유·위험 |
|---|---|---|---|---|
| Cloudflare | **A** (+D) | 사용자 토큰: `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=<인코딩JSON>&accountId=*&zoneId=all&name=<이름>`. 권한 JSON은 `[{"key":"billing","type":"read"}]` 을 URL 인코딩(`%5B%7B%22key%22%3A%22billing%22%2C%22type%22%3A%22read%22%7D%5D`). `accountId`·`zoneId` 는 사용자 토큰에서 필수, `name` 은 선택. 계정 토큰은 `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=...&name=...` (계정 관리자만 만들 수 있어 사용자 토큰을 쓴다). | [토큰 템플릿 URL](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/), [토큰 만들기](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) | `billing` 키는 표에 있지만 `billing`+`read` 조합 예시는 문서에 없음 → **실제로 채워지는지 미확인**(Step 3에서 열어 보고 안 채워지면 D). 완료 화면에 토큰이 "한 번만" 보이고 검증용 curl 예시가 같이 뜬다(문서). 완료 화면의 DOM 구조는 미확인. |
| GitHub (PAT) | **A** (+D) | 개인: `https://github.com/settings/personal-access-tokens/new?name=<이름>&description=<설명>&expires_in=<일수>&plan=read` (`target_name` 생략 = 내 계정). 조직: `...&target_name=<조직>&organization_administration=read`. 값은 `read`/`write`/`admin`, `expires_in` 은 일수 또는 `none`. | [미리 채우기 파라미터](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), [PAT 권한표](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) | 권한표: `GET /users/{username}/settings/billing/usage` = 사용자 권한 "Plan" read, 조직 `GET /organizations/{org}/settings/billing/usage` = 조직 "Administration" read. "Plan" 같은 계정 권한은 토큰 주인이 자기 계정일 때만 쓸 수 있다. 조직 Administration read 는 사용료 외 조직 설정도 읽힌다(읽기 전용이긴 함). enhanced billing 계정만 열림(기존과 같음). 완료 화면 DOM 구조 미확인. |
| GitHub (로그인) | **B** 가능(조건부) | GitHub App(사용자 권한 Plan: read) + device flow. `POST https://github.com/login/device/code` 에 `client_id` → 사용자가 코드 입력 → `POST https://github.com/login/oauth/access_token` 에 `client_id`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code` 로 `interval` 간격 폴링. 앱 설정에서 device flow 를 켜야 함(안 켜면 `device_flow_disabled`). | [사용자 토큰 만들기](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [토큰 갱신](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens), [App 권한표](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) | App 권한표 "Plan" 절: `/users/{username}/settings/billing/usage` read, **UAT(사용자 토큰)만** 허용 → device flow 토큰으로 읽을 수 있다. device flow 는 토큰 받기에 `client_secret` 이 없고, 갱신도 "device flow로 만든 토큰이면 `client_secret` 불필요" → **비밀키 없이 됨**. 토큰 8시간, 갱신 토큰 6개월. 남은 것: GitHub App 등록(외부 쓰기라 이번엔 안 함, 사용자가 해야 함), 확장 service worker 에서 `github.com/login/*` 호출 시 CORS·host_permissions 동작은 **미확인**. 조직 사용료는 App이 조직에 설치돼야 함(UAT, Administration read). |
| Vercel | **A** (생성 페이지 열기 + 완료 화면 읽기만) +D | `https://vercel.com/account/tokens` (Account Tokens). 이름 → Scope(Full Account 또는 팀) → 만료 → Create. | [Access tokens](https://vercel.com/docs/accounts/access-tokens), [Sign in with Vercel 권한](https://vercel.com/docs/sign-in-with-vercel/scopes-and-permissions) | 미리 채우기 파라미터는 문서에 없음 → **미확인(없는 것으로 본다)**. 토큰은 "생성 시 한 번만" 보이고 `vcp_` 로 시작(문서). **읽기 전용 토큰이 없다**: 팀/프로젝트 범위만 고를 수 있고 범위 안에서 읽기·쓰기 모두 됨 → 안내서에 "사용료 읽기만 하지만 토큰 자체는 쓰기도 됨, 팀 범위로 좁히세요"를 적는다. Sign in with Vercel(OAuth)에 Billing Read Only 권한이 있으나 "API 권한은 private beta"이고 콜백 URL 등록·code 교환에 비밀키가 필요한지(PKCE 공개 클라이언트 여부)는 **미확인** → B는 보류. |
| OpenAI | **A** (페이지 열기 + 완료 화면 읽기만) +D | 관리자 키 페이지 `https://platform.openai.com/settings/organization/admin-keys` (**제3자 연동 문서 기준, 공식 문서로 미확인**). 사용료(`/v1/organization/costs`)는 관리자 키(`sk-admin-`)로만 읽힘. | [Costs API 참조](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs), [Admin API Keys 참조](https://developers.openai.com/api/reference/resources/organization/subresources/admin_api_keys/methods/create), 도움말 https://help.openai.com/en/articles/9687866 (403으로 직접 못 읽음) | 미리 채우기 파라미터 **미확인(없는 것으로 본다)**. 조직 Owner 만 관리자 키를 만들 수 있음(도움말 검색 요약 기준). 키는 생성 때만 전체가 보임(API 참조: "only shown on create"). 관리자 키를 읽기 전용(Usage read)으로 제한할 수 있는지는 제3자 문서만 있어 **미확인**. OAuth 없음 → B 불가. |
| AWS | **C 보류 → D** (+액세스 키 완료 화면은 A) | 빠른 생성: `https://<리전>.console.aws.amazon.com/cloudformation/home?region=<리전>#/stacks/create/review?templateURL=<S3 URL>&stackName=<이름>&param_<이름>=<값>`. `templateURL` 은 **S3 URL만**(`https://s3.<리전>.amazonaws.com/<버킷>/<파일>` 등 3형식). IAM 사용자를 만드므로 사용자가 "IAM 리소스 생성 확인"에 체크해야 함. 액세스 키: IAM 콘솔 `https://console.aws.amazon.com/iam` → 사용자 → Security credentials → Create access key → 용도 "Other" → Retrieve access keys 화면에서 Show / Download .csv. | [빠른 생성 링크](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-create-stacks-quick-create-links.html), [액세스 키 만들기](https://docs.aws.amazon.com/IAM/latest/UserGuide/access-key-self-managed.html), [관리자가 사용자 키 관리](https://docs.aws.amazon.com/IAM/latest/UserGuide/access-keys-admin-managed.html) | 템플릿을 공개 S3 버킷에 올려야 해서(우리는 서버·버킷 없음, 이번 작업에서 S3 업로드 금지) **Step 5는 사용자 결정 필요**: 버킷을 누가 운영할지 정하기 전엔 D(정책 JSON `ce:GetCostAndUsage` 복사 + IAM 화면 단계 안내)로 간다. 특정 사용자의 "액세스 키 만들기" 화면으로 바로 가는 콘솔 URL(`#/users/details/<이름>/...` 형태)은 공식 문서에 없어 **미확인** → IAM 콘솔 첫 화면 링크만 쓴다. 비밀키는 "이때 한 번만" 보임(문서). |
| Azure | **B** (기존 유지) | 기존 Entra 로그인(`chrome.identity`) 그대로. | 이번에 다시 확인 안 함 | 앱 등록이 남아 있음(외부 쓰기라 이번 범위 밖). |

정리
- 미리 채우기 URL이 문서로 확인된 곳: Cloudflare, GitHub. 나머지(Vercel·OpenAI·AWS 액세스 키)는 "페이지 바로 열기 + 완료 화면 읽기"까지만.
- 모든 서비스의 완료 화면 DOM 구조는 미확인 → Step 3은 가짜 페이지로 테스트하고, 실제 화면이 다르면 붙여넣기로 돌아간다(플랜의 원칙 그대로).
- Step 4(GitHub 로그인)는 기술적으로 가능. 다만 GitHub App 등록(client_id 발급)이 먼저 필요하고 이건 사용자가 해야 한다.
- Step 5(AWS 원클릭)는 템플릿을 둘 공개 S3 버킷이 필요해 사용자 결정 전까지 보류.
- 위험(공통): 완료 화면을 읽으려면 dash.cloudflare.com·github.com·vercel.com·platform.openai.com·console.aws.amazon.com 접근 권한이 확장에 필요하다. 웹스토어 심사·사용자 경고 문구가 커질 수 있어 `optional_host_permissions` 로 연결 버튼 누를 때만 요청하는 게 맞다(심사 영향은 미확인).

## Step 2~4 결과(요약)

- Step 2: 연결 창이 "서비스 고르기 → 만들기 화면 열기 → 자동 받기/붙여넣기" 마법사가 됐다. 안내 데이터는 `src/lib/cloud/guides.js`(`GUIDES`, `guideFor`, `createUrl`).
- Step 3: 규칙 `src/lib/cloud/autofetch.js`, 탭 감시·주입 `src/lib/cloud/autofetch-watch.js`, 읽기 스크립트 `src/autofetch-page.js`. 연결 버튼으로 연 탭 하나만, 그 서비스 https 콘솔에서만, 토큰 후보가 정확히 하나일 때만 받는다. 확인 전에는 `chrome.storage.session`(autofetchFound)에만 있다. 추가 권한은 `scripting`뿐(`<all_urls>`가 이미 있어서 optional_host_permissions는 안 씀).
- Step 4: GitHub App device flow 로그인. 자격증명은 `{accessToken(ghu_), refreshToken(ghr_), expiresAt, org?}`, 갱신된 쌍은 accountPatch로 저장. 폴링은 대시보드(cloud-ui.js)에서 돈다. `GITHUB_CLIENT_ID`가 비면 버튼 대신 안내.

## Step 6 결과

- E2E 6개: `extension`, `cloud`, `picker`, `providers`, `autofetch`, `wizard`(새로 추가). 모두 통과.
- `autofetch`: 고정 2.5초 대기를 없앴다. 시험용 관찰 장치(service worker에서 `chrome.scripting.executeScript`를 감싸 주입 횟수를 세고, 확장 리스너 다음에 붙인 `webNavigation.onCompleted` 리스너로 "background가 그 이동을 처리한 시점"을 남김)를 기다린 뒤 주입 횟수로 "읽지 않음"을 확인한다. Vercel·OpenAI 완료 화면, 완료 화면에 토큰 모양 비밀번호 칸이 같이 있는 경우를 추가했다.
- `wizard`: 대시보드 페이지의 설정 객체에 가짜 `GITHUB_CLIENT_ID`·S3 `AWS_TEMPLATE_URL`을 넣고, GitHub 로그인(코드 표시 → 대기 → 승인 → 저장·사용료, 비밀키 안 보냄, 창 닫으면 폴링 멈춤)과 AWS 빠른 생성 주소를 확인한다.
- README "서버·API 사용료" 절에 A/B/C/D 연결 방식 표, "아이디·비밀번호는 받지 않는 이유", GitHub App 등록, AWS 템플릿 안내를 넣었다.
- Cloudflare 안내 1단계 문구를 "채워 달라는 주소로 열려요"로 낮췄다(실제로 채워지는지 미확인).

## Step 5 결과

- 템플릿: `aws/readonly-cost-user.json`(CloudFormation은 JSON도 받는다. 단위 테스트가 `JSON.parse`로 바로 검사하려고 JSON으로 둠). IAM 사용자 하나 + 인라인 정책 `ce:GetCostAndUsage`(Resource `*`)뿐. 액세스 키·로그인 프로필·관리형 정책 없음, 출력은 사용자 이름과 IAM 사용자 목록 주소뿐(비밀키 없음). 사용자 이름을 지정해서 배포 때 `CAPABILITY_NAMED_IAM` 확인 체크가 필요하다.
- `config.js`의 `AWS_TEMPLATE_URL`(빈 값). S3 https 주소(3형식)일 때만 빠른 생성 링크 `https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?templateURL=..&stackName=payment-tracker-cost-reader`를 쓴다. 비거나 S3가 아니면 "템플릿 파일 받기 → `#/stacks/create`에서 업로드" 안내 + IAM 사용자 목록 링크.
- 키 자동 받기: Step 3 규칙에 AWS가 이미 있어서(AKIA + 40자 비밀키 둘 다 보일 때만) 새 코드 없이 E2E만 추가했다. 연결 버튼으로 연 탭에서 IAM으로 옮겨 키를 만들어야 받는다.
- 미확인: `#/stacks/create` 해시 경로와 빠른 생성 링크가 실제 콘솔에서 그대로 열리는지, IAM "Retrieve access keys" 화면에서 비밀키가 Show 전엔 DOM에 없는지(없으면 붙여넣기로 돌아감). 템플릿 S3 업로드·버킷 운영은 사용자 결정 대기.

## 하지 않는 것
- 아이디·비밀번호 입력, 자동 로그인
- 사용자 키를 서버로 보내는 것(A안 유지)
- E 실험은 이번 범위에 넣지 않는다
