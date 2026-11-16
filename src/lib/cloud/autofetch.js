/* 토큰 자동 받기(easy-connect Step 3)의 순수 규칙. DOM·chrome 없이 node에서 시험한다.
   - 어느 주소가 그 서비스의 콘솔인지(https + 정해진 호스트만)
   - 완료 화면 글자들에서 토큰을 고르는 법: 정확히 하나만 찾았을 때만 쓴다(둘 이상이면 붙여넣기로)
   - 대시보드에 보여 줄 가린 미리보기, 저장할 때 섞을 수 있는 칸
   background와 토큰 생성 탭(주입 스크립트) 양쪽에서 쓴다. */
(function (root) {
  'use strict';

  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  // 접두어가 있는 토큰은 화면 글 전체(texts)에서도 찾고, 접두어 없는 값은 입력칸·코드(fields)에서만 찾는다.
  const RULES = {
    github: { hosts: ['github.com'], secret: { token: { re: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{40,255}/g, loose: true } } },
    vercel: { hosts: ['vercel.com'], secret: { token: { re: /(?<![A-Za-z0-9_-])vcp_[A-Za-z0-9_-]{20,200}/g, loose: true } } },
    openai: { hosts: ['platform.openai.com'], secret: { adminKey: { re: /(?<![A-Za-z0-9_-])sk-admin-[A-Za-z0-9_-]{20,300}/g, loose: true } } },
    cloudflare: { hosts: ['dash.cloudflare.com'], secret: { apiToken: { re: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-])/g, mixed: true } } },
    aws: {
      hosts: ['console.aws.amazon.com'],
      subdomains: true,
      secret: {
        accessKeyId: { re: /(?<![A-Z0-9])AKIA[A-Z0-9]{16}(?![A-Z0-9])/g },
        secretAccessKey: { re: /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g, mixed: true },
      },
    },
  };

  // 사용자가 연결 창에 적은 칸 중 토큰과 함께 저장해도 되는 것(비밀값이 아닌 것)
  const EXTRA_FIELDS = { github: ['org'], cloudflare: ['accountId'], vercel: ['team'], openai: [], aws: [] };
  const PREFIXES = ['github_pat_', 'sk-admin-', 'vcp_', 'AKIA'];
  const SHOWN_TAIL = 4;
  const PLAIN_HEAD = 4;

  const ruleFor = (provider) => (typeof provider === 'string' && own(RULES, provider) ? RULES[provider] : null);

  // 로그인·가입 화면은 비밀번호 칸이 있어서 콘솔 주소라도 읽지 않는다.
  const LOGIN_PATHS = ['/login', '/sign-in', '/signin', '/session', '/sign-up', '/oauth'];
  const isLoginPath = (pathname) => LOGIN_PATHS.some((p) => pathname.toLowerCase().startsWith(p));

  /** @returns {boolean} 그 서비스 콘솔의 https 페이지인지(로그인·가입 화면은 제외) */
  function isProviderPage(provider, url) {
    const rule = ruleFor(provider);
    if (!rule) return false;
    let parsed;
    try { parsed = new URL(url); } catch { return false; }
    if (parsed.protocol !== 'https:' || isLoginPath(parsed.pathname)) return false;
    const host = parsed.hostname;
    return rule.hosts.some((h) => host === h || (rule.subdomains && host.endsWith(`.${h}`)));
  }

  const isMixed = (s) => /[A-Za-z]/.test(s) && /[0-9]/.test(s);

  function findOne(spec, fields, texts) {
    const sources = spec.loose ? [...fields, ...texts] : fields;
    const found = new Set();
    for (const text of sources) {
      for (const m of String(text).matchAll(spec.re)) {
        if (!spec.mixed || isMixed(m[0])) found.add(m[0]);
      }
    }
    return found.size === 1 ? [...found][0] : null;
  }

  /**
   * @param {string} provider
   * @param {{fields: string[], texts: string[]}} page fields=입력칸 값·코드 글자, texts=화면 글 전체
   * @returns {object|null} 서비스 연결에 넣을 비밀값. 하나라도 못 찾거나 여러 개면 null.
   */
  function extractCredentials(provider, { fields = [], texts = [] } = {}) {
    const rule = ruleFor(provider);
    if (!rule) return null;
    const entries = Object.entries(rule.secret).map(([key, spec]) => [key, findOne(spec, fields, texts)]);
    return entries.every(([, v]) => v) ? Object.fromEntries(entries) : null;
  }

  function maskOne(value) {
    const prefix = PREFIXES.find((p) => value.startsWith(p)) || value.slice(0, PLAIN_HEAD);
    return `${prefix}…${value.slice(-SHOWN_TAIL)}`;
  }

  /** @returns {string} 대시보드에 보여 줄 가린 값. 비밀 액세스 키는 보이지 않는다. */
  function preview(provider, credentials) {
    const c = credentials || {};
    if (provider === 'aws') return maskOne(String(c.accessKeyId || ''));
    const value = c.token || c.apiToken || c.adminKey || '';
    return maskOne(String(value));
  }

  /** 읽은 비밀값에 연결 창의 선택 칸(조직·계정 ID·팀)만 덧붙인다. 비밀값은 덮어쓸 수 없다. */
  function mergeCredentials(provider, secret, extra = {}) {
    const allowed = own(EXTRA_FIELDS, provider) ? EXTRA_FIELDS[provider] : [];
    const picked = allowed.map((key) => {
      const v = typeof extra[key] === 'string' ? extra[key].trim() : '';
      return [key, v || undefined];
    });
    return { ...Object.fromEntries(picked), ...secret };
  }

  const api = { PROVIDERS: Object.freeze(Object.keys(RULES)), isProviderPage, extractCredentials, preview, mergeCredentials };
  root.PaymentAutofetch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
