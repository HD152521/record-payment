/* AWS Signature Version 4 서명. 브라우저·Node 모두 WebCrypto(crypto.subtle)만 쓴다. */
(function (root) {
  'use strict';

  const enc = new TextEncoder();
  const subtle = () => root.crypto.subtle;
  const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

  async function sha256Hex(text) {
    return toHex(await subtle().digest('SHA-256', enc.encode(text)));
  }

  async function hmac(key, text) {
    const raw = typeof key === 'string' ? enc.encode(key) : key;
    const cryptoKey = await subtle().importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return subtle().sign('HMAC', cryptoKey, enc.encode(text));
  }

  const amzDate = (now) => new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, '');

  const encodeRfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

  function canonicalQuery(searchParams) {
    return [...searchParams.entries()]
      .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)])
      .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1)))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
  }

  /**
   * 서명된 헤더 묶음을 돌려준다(host 제외: fetch가 알아서 넣는다).
   * @returns {Promise<Record<string,string>>}
   */
  async function signRequest({ method, url, headers = {}, body = '', accessKeyId, secretAccessKey, sessionToken, region, service, now = Date.now() }) {
    const u = new URL(url);
    const stamp = amzDate(now);
    const day = stamp.slice(0, 8);
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
    const signed = { ...lower, host: u.host, 'x-amz-date': stamp, ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}) };
    const names = Object.keys(signed).sort();
    const canonical = [
      method.toUpperCase(),
      u.pathname || '/',
      canonicalQuery(u.searchParams),
      names.map((n) => `${n}:${signed[n]}\n`).join(''),
      names.join(';'),
      await sha256Hex(body),
    ].join('\n');
    const scope = `${day}/${region}/${service}/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonical)].join('\n');

    const kDate = await hmac(`AWS4${secretAccessKey}`, day);
    const kRegion = await hmac(kDate, region);
    const kService = await hmac(kRegion, service);
    const kSigning = await hmac(kService, 'aws4_request');
    const signature = toHex(await hmac(kSigning, toSign));

    const { host, ...sendable } = signed;
    return {
      ...sendable,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    };
  }

  const api = { signRequest, sha256Hex };
  root.PaymentSigV4 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
