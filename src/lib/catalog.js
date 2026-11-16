/* 고르기만 하면 되는 플랫폼 목록. IT인이 매달 내는 서버·API·개발/AI 도구·생활 구독 위주.
   가격은 PRICES_AS_OF 기준 참고가라서 사용자가 실제 결제액으로 고칠 수 있게 양식에만 채운다.
   connect가 있으면 키·로그인으로 사용료를 자동으로 가져오는 곳이다. */
(function (root) {
  'use strict';

  const PRICES_AS_OF = '2026-11';
  const CONNECTORS = ['aws', 'azure', 'openai', 'cloudflare', 'github', 'vercel'];

  const CATEGORIES = [
    { id: 'cloud', label: '서버·클라우드' },
    { id: 'ai', label: 'AI' },
    { id: 'dev', label: '개발 도구' },
    { id: 'work', label: '업무 도구' },
    { id: 'life', label: '생활 구독' },
  ];

  const usd = (name, amount, cycle = 'monthly') => ({ name, amount, currency: 'USD', cycle });
  const krw = (name, amount, cycle = 'monthly') => ({ name, amount, currency: 'KRW', cycle });

  const ITEMS = [
    // 서버·클라우드
    { id: 'aws', name: 'AWS', site: 'aws.amazon.com', category: 'cloud', connect: 'aws', aliases: ['아마존', 'amazon web services'] },
    { id: 'azure', name: 'Azure', site: 'azure.microsoft.com', category: 'cloud', connect: 'azure', aliases: ['애저', 'microsoft azure'] },
    { id: 'gcp', name: 'Google Cloud', site: 'cloud.google.com', category: 'cloud', aliases: ['gcp', '구글 클라우드'] },
    { id: 'cloudflare', name: 'Cloudflare', site: 'cloudflare.com', category: 'cloud', connect: 'cloudflare', aliases: ['클라우드플레어'],
      plans: [usd('Workers Paid', 5), usd('Pro', 25)] },
    { id: 'vercel', name: 'Vercel', site: 'vercel.com', category: 'cloud', connect: 'vercel', aliases: ['버셀'], plans: [usd('Pro (1명)', 20)] },
    { id: 'supabase', name: 'Supabase', site: 'supabase.com', category: 'cloud', aliases: ['수파베이스'],
      plans: [usd('Pro', 25), usd('Team', 599)] },
    { id: 'netlify', name: 'Netlify', site: 'netlify.com', category: 'cloud', aliases: ['네틀리파이'] },
    { id: 'railway', name: 'Railway', site: 'railway.com', category: 'cloud', aliases: ['레일웨이'],
      plans: [usd('Hobby', 5), usd('Pro', 20)] },
    { id: 'ncloud', name: '네이버 클라우드', site: 'ncloud.com', category: 'cloud', currency: 'KRW', aliases: ['ncp', 'naver cloud'] },
    { id: 'gabia', name: '가비아 (도메인·호스팅)', site: 'gabia.com', category: 'cloud', currency: 'KRW', aliases: ['도메인', 'domain'], cycle: 'yearly' },

    // AI
    { id: 'openai', name: 'OpenAI API', site: 'platform.openai.com', category: 'ai', connect: 'openai', aliases: ['오픈ai', 'gpt api'] },
    { id: 'chatgpt', name: 'ChatGPT', site: 'chatgpt.com', category: 'ai', aliases: ['챗gpt', '챗지피티', 'chat gpt'],
      plans: [usd('Plus', 20), usd('Pro', 200)] },
    { id: 'claude', name: 'Claude', site: 'claude.ai', category: 'ai', aliases: ['클로드', 'anthropic'],
      plans: [usd('Pro', 20), usd('Max 5x', 100), usd('Max 20x', 200)] },
    { id: 'anthropic-api', name: 'Claude API', site: 'console.anthropic.com', category: 'ai', aliases: ['anthropic api', '클로드 api'] },
    { id: 'gemini', name: 'Gemini (Google AI Pro)', site: 'gemini.google.com', category: 'ai', aliases: ['제미나이', 'google ai'],
      plans: [krw('Google AI Pro', 29000)] },
    { id: 'cursor', name: 'Cursor', site: 'cursor.com', category: 'ai', aliases: ['커서'],
      plans: [usd('Pro', 20), usd('Pro+', 60), usd('Ultra', 200)] },
    { id: 'perplexity', name: 'Perplexity', site: 'perplexity.ai', category: 'ai', aliases: ['퍼플렉시티'], plans: [usd('Pro', 20)] },
    { id: 'midjourney', name: 'Midjourney', site: 'midjourney.com', category: 'ai', aliases: ['미드저니'],
      plans: [usd('Basic', 10), usd('Standard', 30)] },

    // 개발 도구
    { id: 'github', name: 'GitHub', site: 'github.com', category: 'dev', connect: 'github', aliases: ['깃허브', 'copilot', '코파일럿'],
      plans: [usd('Pro', 4), usd('Copilot Pro', 10), usd('Copilot Pro+', 39)] },
    { id: 'jetbrains', name: 'JetBrains', site: 'jetbrains.com', category: 'dev', aliases: ['젯브레인', 'intellij', 'pycharm'],
      plans: [usd('IntelliJ IDEA Ultimate', 169, 'yearly'), usd('All Products Pack', 289, 'yearly')] },
    { id: 'docker', name: 'Docker', site: 'docker.com', category: 'dev', aliases: ['도커'], plans: [usd('Pro', 9)] },
    { id: 'sentry', name: 'Sentry', site: 'sentry.io', category: 'dev', aliases: ['센트리'], plans: [usd('Team', 26)] },
    { id: 'apple-dev', name: 'Apple Developer', site: 'developer.apple.com', category: 'dev', aliases: ['애플 개발자'],
      plans: [usd('개발자 프로그램', 99, 'yearly')] },

    // 업무 도구
    { id: 'notion', name: 'Notion', site: 'notion.so', category: 'work', aliases: ['노션'], plans: [usd('Plus', 12)] },
    { id: 'figma', name: 'Figma', site: 'figma.com', category: 'work', aliases: ['피그마'], plans: [usd('Professional', 20)] },
    { id: 'slack', name: 'Slack', site: 'slack.com', category: 'work', aliases: ['슬랙'], plans: [usd('Pro (1명)', 8.75)] },
    { id: 'google-workspace', name: 'Google Workspace', site: 'workspace.google.com', category: 'work', aliases: ['구글 워크스페이스', 'gsuite'],
      plans: [usd('Business Starter (1명)', 7)] },
    { id: 'm365', name: 'Microsoft 365', site: 'microsoft.com', category: 'work', currency: 'KRW', aliases: ['오피스', 'office'], cycle: 'yearly' },

    // 생활 구독
    { id: 'netflix', name: 'Netflix', site: 'netflix.com', category: 'life', aliases: ['넷플릭스', '넷플'],
      plans: [krw('광고형 스탠다드', 5500), krw('스탠다드', 13500), krw('프리미엄', 17000)] },
    { id: 'youtube', name: 'YouTube Premium', site: 'youtube.com', category: 'life', aliases: ['유튜브', '유튜브 프리미엄'],
      plans: [krw('개인', 14900)] },
    { id: 'spotify', name: 'Spotify', site: 'spotify.com', category: 'life', aliases: ['스포티파이'], plans: [krw('Individual', 11990)] },
    { id: 'disney', name: 'Disney+', site: 'disneyplus.com', category: 'life', aliases: ['디즈니', '디즈니플러스'],
      plans: [krw('스탠다드', 9900), krw('프리미엄', 13900)] },
    { id: 'icloud', name: 'iCloud+', site: 'icloud.com', category: 'life', aliases: ['아이클라우드'],
      plans: [krw('50GB', 1100), krw('200GB', 4400), krw('2TB', 14000)] },
    { id: 'coupang', name: '쿠팡 와우', site: 'coupang.com', category: 'life', aliases: ['쿠팡', 'wow'], plans: [krw('와우 멤버십', 7890)] },
    { id: 'naver-plus', name: '네이버플러스 멤버십', site: 'naver.com', category: 'life', aliases: ['네이버', 'naver plus'],
      plans: [krw('월간', 4900)] },
  ];

  const squash = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

  function search(query, category = null) {
    const q = squash(query);
    return ITEMS.filter((item) => {
      if (category && item.category !== category) return false;
      if (!q) return true;
      return [item.name, item.site, item.id, ...(item.aliases || [])].some((v) => squash(v).includes(q));
    });
  }

  function findBySite(host) {
    const h = String(host || '').toLowerCase();
    if (!h) return null;
    return ITEMS.find((item) => h === item.site || h.endsWith(`.${item.site}`)) || null;
  }

  // GitHub 사용량 보고서에 요금제·Copilot 구독료가 들어가는지 실계정으로 확인 전이라 덮지 않는다.
  const COVERS_PLAN_FEES = new Set(['aws', 'azure', 'openai', 'cloudflare', 'vercel']);

  /** 사용료 연결 값이 이 기록을 이미 포함하면 그 연결 id. 같은 돈이 두 번 더해지지 않게 한다. */
  function coveredBy(record, connectedProviders) {
    const item = findBySite(record && record.site);
    const id = item && item.connect;
    return id && COVERS_PLAN_FEES.has(id) && connectedProviders.has(id) ? id : null;
  }

  /** 고른 플랫폼·요금제를 기록 양식에 넣을 값으로 바꾼다. 요금제가 없으면 금액은 비워 둔다. */
  function recordFields(item, plan) {
    return {
      site: item.site,
      kind: 'subscription',
      cycle: plan ? plan.cycle : (item.cycle || 'monthly'),
      amount: plan ? plan.amount : null,
      currency: plan ? plan.currency : (item.currency || 'USD'),
      note: plan ? plan.name : '',
    };
  }

  const api = { PRICES_AS_OF, CONNECTORS, CATEGORIES, ITEMS, search, findBySite, recordFields, coveredBy };
  root.PaymentCatalog = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
