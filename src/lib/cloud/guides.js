/* 연결 마법사의 서비스별 안내서와 "토큰 만들기" 페이지 주소. 화면 코드 없이 데이터만 둔다.
   단계 한 줄은 조각 배열: 문자열, {b} 굵게, {code} 코드, {a, href} 링크, {copy} 복사 칸(화면이 채움).
   미리 채우기 파라미터 근거는 docs/plan/easy-connect.md "Step 1 결과" 표. */
(function (root) {
  'use strict';

  const TOKEN_NAME = '결제 기록장 사용료 읽기';
  const GITHUB_EXPIRES_DAYS = 90;
  const GITHUB_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  const CF_PERMISSIONS = [{ key: 'billing', type: 'read' }];

  // URLSearchParams는 공백을 +로 바꿔서, 콘솔이 그대로 읽도록 %20으로 인코딩한다.
  const query = (params) => Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  function cloudflareUrl() {
    return `https://dash.cloudflare.com/profile/api-tokens?${query({
      permissionGroupKeys: JSON.stringify(CF_PERMISSIONS), accountId: '*', zoneId: 'all', name: TOKEN_NAME,
    })}`;
  }

  // 조직 토큰에는 계정 권한(Plan)을 줄 수 없어서 조직 Administration 읽기만 채운다.
  function githubUrl({ org } = {}) {
    const name = String(org || '').trim();
    const base = { name: TOKEN_NAME, description: '결제 기록장이 사용료만 읽어요', expires_in: String(GITHUB_EXPIRES_DAYS) };
    const scope = GITHUB_NAME_RE.test(name)
      ? { target_name: name, organization_administration: 'read' }
      : { plan: 'read' };
    return `https://github.com/settings/personal-access-tokens/new?${query({ ...base, ...scope })}`;
  }

  // AWS: 템플릿(aws/readonly-cost-user.json)으로 비용 조회만 되는 IAM 사용자를 만들고, 액세스 키는 IAM 콘솔에서 직접 만든다.
  // 빠른 생성 링크는 templateURL에 S3 주소만 받아서, config의 AWS_TEMPLATE_URL이 S3 https 주소일 때만 쓴다.
  const AWS_TEMPLATE_FILE = 'aws/readonly-cost-user.json';
  const AWS_REGION = 'us-east-1'; // IAM·Cost Explorer는 전역이라 리전은 스택이 놓일 곳일 뿐이다
  const AWS_STACK_NAME = 'payment-tracker-cost-reader';
  const S3_HOST_RE = /^(?:s3\.[a-z0-9-]+|[a-z0-9.-]+\.s3(?:\.[a-z0-9-]+)?)\.amazonaws\.com$/;

  function s3TemplateUrl(value) {
    let parsed;
    try { parsed = new URL(String(value || '')); } catch { return null; }
    return parsed.protocol === 'https:' && S3_HOST_RE.test(parsed.hostname) ? parsed.href : null;
  }

  function awsQuickCreateUrl(templateUrl) {
    const host = `https://${AWS_REGION}.console.aws.amazon.com/cloudformation/home?region=${AWS_REGION}`;
    return `${host}#/stacks/create/review?${query({ templateURL: templateUrl, stackName: AWS_STACK_NAME })}`;
  }

  const AWS_KEY_STEPS = [
    ['스택이 끝나면 같은 탭에서 ', { b: 'IAM → 사용자 → payment-tracker-cost-reader → 보안 자격 증명 → 액세스 키 만들기' }, '로 가서 "AWS 외부에서 실행되는 애플리케이션"을 골라요.'],
    ['비밀 액세스 키는 이때 한 번만 보여요. 같은 탭에서 만들면 자동으로 가져오고, 안 되면 두 값을 아래에 붙여 넣어요.'],
  ];
  const AWS_LINKS = [
    { label: 'IAM 사용자 목록(액세스 키 만들기)', url: 'https://console.aws.amazon.com/iam/home#/users' },
    { label: '액세스 키 만들기 도움말', url: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/access-key-self-managed.html' },
  ];

  const AWS_STACK_GUIDE = {
    openLabel: '읽기 전용 사용자 만들기 열기',
    prefilled: true,
    url: ({ templateUrl } = {}) => awsQuickCreateUrl(s3TemplateUrl(templateUrl)),
    steps: [
      ['위 버튼을 누르면 비용 조회(', { code: 'ce:GetCostAndUsage' }, ') 하나만 허용하는 IAM 사용자를 만드는 CloudFormation 화면이 열려요.'],
      ['맨 아래 ', { b: 'IAM 리소스를 생성할 수 있음을 확인' }, '에 체크하고 ', { b: '스택 생성' }, '을 눌러요.'],
      ...AWS_KEY_STEPS,
    ],
    links: AWS_LINKS,
  };

  const GUIDES = {
    aws: {
      openLabel: 'CloudFormation 스택 만들기 열기',
      prefilled: false,
      url: () => 'https://console.aws.amazon.com/cloudformation/home#/stacks/create',
      steps: [
        [{ file: AWS_TEMPLATE_FILE, a: '템플릿 파일' }, '을 받아 둬요. 비용 조회(', { code: 'ce:GetCostAndUsage' }, ') 하나만 허용하는 IAM 사용자를 만드는 파일이에요.'],
        ['위 버튼으로 스택 만들기 화면을 열고 ', { b: '템플릿 파일 업로드' }, '로 받은 파일을 올려요. 마지막에 ', { b: 'IAM 리소스를 생성할 수 있음을 확인' }, '에 체크하고 제출해요.'],
        ...AWS_KEY_STEPS,
        [{ b: '평소 쓰는 관리자 키는 넣지 마세요.' }, ' 이 확장은 키 권한을 확인하지 못해서, 이 스택이 만든 전용 사용자 키여야 안전해요.'],
      ],
      links: AWS_LINKS,
    },
    azure: {
      openLabel: '',
      prefilled: false,
      url: () => null,
      steps: [
        ['아래 버튼으로 Azure를 쓰는 Microsoft 계정에 로그인하고 ', { b: '허용' }, '을 눌러요.'],
        ['구독에 ', { b: 'Cost Management 읽기 권한자' }, ' 이상의 역할이 있어야 비용이 보여요. 구독 소유자라면 이미 있어요.'],
        ['Azure에는 "비용만 읽기" 로그인 권한이 따로 없어서, 저장되는 로그인 토큰은 내 Azure 권한을 그대로 가져요. 공용 PC에서는 연결하지 마세요.'],
      ],
      links: [
        { label: 'Azure 포털', url: 'https://portal.azure.com/' },
        { label: '비용 읽기 역할 도움말', url: 'https://learn.microsoft.com/azure/cost-management-billing/costs/assign-access-acm-data' },
      ],
    },
    openai: {
      openLabel: 'Admin keys 화면 열기',
      prefilled: false,
      url: () => 'https://platform.openai.com/settings/organization/admin-keys',
      steps: [
        ['위 버튼으로 조직 설정의 Admin keys 화면을 열고 ', { b: 'Create new admin key' }, '를 눌러요. 조직 Owner만 만들 수 있어요.'],
        ['권한을 고를 수 있으면 ', { b: '읽기 전용' }, '으로 만들어요. 관리자 키는 조직의 키·멤버까지 다룰 만큼 권한이 넓어서 공용 PC에서는 연결하지 마세요.'],
        ['키는 만들 때 한 번만 보여요. 바로 복사해서 아래에 붙여 넣어요.'],
      ],
      links: [
        { label: 'Admin keys 화면', url: 'https://platform.openai.com/settings/organization/admin-keys' },
        { label: 'Costs API 문서', url: 'https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs' },
      ],
    },
    cloudflare: {
      openLabel: 'Billing 읽기 토큰 만들기 열기',
      prefilled: true,
      url: cloudflareUrl,
      steps: [
        ['위 버튼을 누르면 ', { b: 'Account · Billing · Read' }, ' 권한을 채워 달라는 주소로 토큰 만들기 화면이 열려요.'],
        ['권한이 비어 있으면 ', { b: 'Account → Billing → Read' }, ' 하나만 직접 골라요.'],
        [{ b: 'Continue to summary → Create Token' }, '을 눌러요.'],
        ['토큰은 한 번만 보여요. 복사해서 아래에 붙여 넣고, 계정이 여러 개면 계정 ID도 넣어요. 계정 ID는 대시보드 주소 ', { code: 'dash.cloudflare.com/계정ID' }, '에 있어요.'],
      ],
      links: [
        { label: 'API 토큰 화면', url: 'https://dash.cloudflare.com/profile/api-tokens' },
        { label: '토큰 만들기 도움말', url: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/' },
      ],
    },
    github: {
      openLabel: 'Plan 읽기 토큰 만들기 열기',
      prefilled: true,
      url: githubUrl,
      steps: [
        ['조직 사용료를 보려면 먼저 아래에 조직 이름을 넣어요. 개인 계정이면 비워 둬요.'],
        ['위 버튼을 누르면 ', { b: 'Plan: Read-only' }, '(조직이면 ', { b: 'Administration: Read-only' }, ')가 채워진 Fine-grained 토큰 화면이 열려요.'],
        [{ b: 'Generate token' }, '을 누르고 나온 토큰을 아래에 붙여 넣어요.'],
        ['GitHub 새 청구 플랫폼을 쓰는 계정에서만 읽혀요. 안 되면 아래 "요금제로 직접 기록"을 써 주세요.'],
      ],
      links: [
        { label: '내 토큰 목록', url: 'https://github.com/settings/personal-access-tokens' },
        { label: '토큰 도움말', url: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens' },
      ],
    },
    vercel: {
      openLabel: 'Account Tokens 화면 열기',
      prefilled: false,
      url: () => 'https://vercel.com/account/tokens',
      steps: [
        ['위 버튼으로 Account Tokens 화면을 열고 토큰 이름을 적어요.'],
        [{ b: 'Scope' }, '는 비용을 볼 팀으로 좁히고 만료일도 정해요. 팀에서 Owner·Billing처럼 청구를 볼 수 있는 역할이어야 해요.'],
        ['Vercel에는 읽기 전용 토큰이 없어서 이 토큰으로 그 팀을 다룰 수도 있어요. 이 확장은 청구 조회만 하지만 공용 PC에서는 연결하지 마세요.'],
        ['토큰은 한 번만 보여요. 복사해서 아래에 붙여 넣어요.'],
      ],
      links: [
        { label: 'Account Tokens 화면', url: 'https://vercel.com/account/tokens' },
        { label: '토큰 도움말', url: 'https://vercel.com/docs/accounts/access-tokens' },
      ],
    },
  };

  function deepFreeze(value) {
    if (value && typeof value === 'object') Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  }

  deepFreeze(GUIDES);
  deepFreeze(AWS_STACK_GUIDE);

  /**
   * @param {string} provider
   * @param {{templateUrl?: string}} opts templateUrl=config의 AWS_TEMPLATE_URL
   * @returns {object|null} 보여 줄 안내서. AWS는 S3 템플릿 주소가 있으면 빠른 생성 안내, 없으면 파일 올리기 안내.
   */
  function guideFor(provider, { templateUrl } = {}) {
    if (!Object.prototype.hasOwnProperty.call(GUIDES, provider)) return null;
    return provider === 'aws' && s3TemplateUrl(templateUrl) ? AWS_STACK_GUIDE : GUIDES[provider];
  }

  /** @returns {string|null} 서비스의 토큰 만들기 페이지 주소. 로그인 방식(Azure)이나 모르는 서비스는 null. */
  function createUrl(provider, opts = {}) {
    const guide = guideFor(provider, opts);
    return guide ? guide.url(opts) : null;
  }

  const api = { GUIDES, guideFor, createUrl };
  root.PaymentCloudGuides = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
