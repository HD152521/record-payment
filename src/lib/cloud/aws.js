/* AWS Cost Explorer 연동. 하루 한 번 GetCostAndUsage 1회(요청당 $0.01)만 부른다.
   월말 예상은 GetCostForecast(추가 과금) 대신 costs.js에서 직접 계산한다. */
(function (root) {
  'use strict';

  const C = root.PaymentCloudCosts || require('./costs.js');
  const { signRequest } = root.PaymentSigV4 || require('./sigv4.js');

  const ENDPOINT = 'https://ce.us-east-1.amazonaws.com/';
  const MAX_PAGES = 5;
  const ACCESS_KEY_RE = /^AKIA[A-Z0-9]{16}$/; // 임시 키(ASIA)는 세션 토큰이 필요하고 금방 만료돼서 받지 않는다

  const POLICY = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: ['ce:GetCostAndUsage'], Resource: '*' }],
  };

  function validateCredentials({ accessKeyId, secretAccessKey }) {
    if (!ACCESS_KEY_RE.test(String(accessKeyId || '').trim())) {
      throw new Error('액세스 키 ID는 AKIA로 시작하는 20자예요.');
    }
    if (String(secretAccessKey || '').trim().length < 30) {
      throw new Error('비밀 액세스 키가 너무 짧아요. 40자 전체를 붙여 넣어 주세요.');
    }
  }

  function buildBody(now, nextPageToken) {
    const w = C.billingWindow(now);
    return {
      TimePeriod: { Start: C.isoDate(w.lastMonth), End: C.isoDate(w.tomorrow) },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      ...(nextPageToken ? { NextPageToken: nextPageToken } : {}),
    };
  }

  function parseEntries(response) {
    return (response.ResultsByTime || []).flatMap((r) => {
      const month = String(r.TimePeriod && r.TimePeriod.Start || '').slice(0, 7);
      return (r.Groups || []).map((g) => {
        const metric = (g.Metrics && g.Metrics.UnblendedCost) || {};
        return { month, service: (g.Keys && g.Keys[0]) || '기타', amount: Number(metric.Amount), currency: metric.Unit || 'USD' };
      });
    });
  }

  function explainError(err) {
    const type = String((err.body && (err.body.__type || err.body.Type)) || '');
    if (type.includes('AccessDenied')) return new Error('권한이 없어요. 사용자에게 ce:GetCostAndUsage 정책을 붙였는지 확인해 주세요.');
    if (type.includes('UnrecognizedClient') || type.includes('InvalidSignature')) return new Error('액세스 키가 맞지 않아요. 다시 복사해 붙여 넣어 주세요.');
    if (type.includes('DataUnavailable')) return new Error('Cost Explorer가 아직 준비 중이에요. 처음 켠 뒤 최대 24시간 걸려요.');
    return err;
  }

  async function fetchEntries(account, { fetchImpl = fetch, now = Date.now() } = {}) {
    const { accessKeyId, secretAccessKey } = account.credentials;
    const entries = [];
    let token = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = JSON.stringify(buildBody(now, token));
      const headers = await signRequest({
        method: 'POST',
        url: ENDPOINT,
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage' },
        body,
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
        region: 'us-east-1',
        service: 'ce',
        now: Date.now(),
      });
      let json;
      try {
        json = await C.requestJson(fetchImpl, ENDPOINT, { method: 'POST', headers, body }, 'AWS');
      } catch (err) {
        throw explainError(err);
      }
      entries.push(...parseEntries(json));
      token = json.NextPageToken;
      if (!token) break;
    }
    return { entries };
  }

  const api = { id: 'aws', label: 'AWS', POLICY, validateCredentials, buildBody, parseEntries, fetchEntries };
  root.PaymentCloudAWS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
