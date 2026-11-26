/* 확장 패키지(zip) 만들기와 출시 전 보안 점검. 빌드 없이 node만 쓴다. */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const EXCLUDED_DIRS = new Set(['test', 'e2e', 'docs', 'node_modules', 'scripts', 'aws', 'dist', '.git', '.ruff_cache']);
const EXCLUDED_ROOT_FILES = new Set(['package.json', 'package-lock.json', 'README.md', '.gitignore']);
const EXCLUDED_EXT = /\.(stackdump|zip|map|md)$/;
const SCREENSHOT_EXT = /\.(png|jpe?g|webp)$/;

const PERMISSION_API = {
  storage: /chrome\.storage\b/,
  webNavigation: /chrome\.webNavigation\b/,
  alarms: /chrome\.alarms\b/,
  identity: /chrome\.identity\b/,
  declarativeNetRequestWithHostAccess: /chrome\.declarativeNetRequest\b/,
  scripting: /chrome\.scripting\b/,
  notifications: /chrome\.notifications\b/,
};
const ALLOWED_PERMISSIONS = new Set(Object.keys(PERMISSION_API));

const SECRET_PATTERNS = [
  { name: 'openai', re: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'aws', re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

function toPosix(p) { return p.split(path.sep).join('/'); }

function isPackable(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => EXCLUDED_DIRS.has(p))) return false;
  if (parts.length === 1 && EXCLUDED_ROOT_FILES.has(rel)) return false;
  if (EXCLUDED_EXT.test(rel)) return false;
  if (SCREENSHOT_EXT.test(rel) && parts[0] !== 'icons') return false;
  return true;
}

function walk(root, dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((ent) => {
    const rel = dir ? `${dir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) return EXCLUDED_DIRS.has(ent.name) ? [] : walk(root, rel);
    return ent.isFile() ? [rel] : [];
  });
}

function listPackFiles(root) {
  return walk(root, '').filter(isPackable).sort();
}

function missingHtmlAssets(root, files) {
  const set = new Set(files);
  return files.filter((f) => f.endsWith('.html')).flatMap((html) => {
    const text = fs.readFileSync(path.join(root, html), 'utf8');
    const refs = [...text.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"#?]+)"/g)].map((m) => m[1]);
    return refs
      .filter((r) => !/^(https?:)?\/\//.test(r))
      .map((r) => path.posix.normalize(path.posix.join(path.posix.dirname(html), r)))
      .filter((r) => !set.has(r))
      .map((r) => `${html} -> ${r}`);
  });
}

// ---- zip (store/deflate, 외부 의존성 없음) ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // 1980-01-01, 같은 입력이면 같은 zip이 나오게 고정
const UTF8_FLAG = 0x0800;

function localHeader(entry, comp, crc) {
  const name = Buffer.from(entry.name, 'utf8');
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(UTF8_FLAG, 6);
  h.writeUInt16LE(comp.method, 8);
  h.writeUInt16LE(DOS_TIME, 10);
  h.writeUInt16LE(DOS_DATE, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(comp.data.length, 18);
  h.writeUInt32LE(entry.data.length, 22);
  h.writeUInt16LE(name.length, 26);
  return Buffer.concat([h, name]);
}

function centralHeader(entry, comp, crc, offset) {
  const name = Buffer.from(entry.name, 'utf8');
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(UTF8_FLAG, 8);
  h.writeUInt16LE(comp.method, 10);
  h.writeUInt16LE(DOS_TIME, 12);
  h.writeUInt16LE(DOS_DATE, 14);
  h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(comp.data.length, 20);
  h.writeUInt32LE(entry.data.length, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt32LE(offset, 42);
  return Buffer.concat([h, name]);
}

function compress(data) {
  const deflated = zlib.deflateRawSync(data);
  return deflated.length < data.length ? { method: 8, data: deflated } : { method: 0, data };
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const comp = compress(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.concat([localHeader(entry, comp, crc), comp.data]);
    centrals.push(centralHeader(entry, comp, crc, offset));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

/** 검증용: buildZip이 만든 zip을 다시 읽는다. */
function readZip(zip) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('zip 끝 표식이 없어요');
  const count = zip.readUInt16LE(eocd + 10);
  let pos = zip.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const method = zip.readUInt16LE(pos + 10);
    const crc = zip.readUInt32LE(pos + 16);
    const size = zip.readUInt32LE(pos + 20);
    const nameLen = zip.readUInt16LE(pos + 28);
    const local = zip.readUInt32LE(pos + 42);
    const name = zip.toString('utf8', pos + 46, pos + 46 + nameLen);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if (crc32(data) !== crc) throw new Error(`CRC 불일치: ${name}`);
    out.push({ name, data });
    pos += 46 + nameLen;
  }
  return out;
}

// manifest의 key는 압축해제 설치에서 기기마다 확장 ID를 같게 하려고 둔다. 스토어는 key가 든 업로드를 받지 않는다.
function packData(root, name) {
  const data = fs.readFileSync(path.join(root, name));
  if (name !== 'manifest.json') return data;
  const { key, ...manifest } = JSON.parse(data.toString('utf8'));
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}
`);
}

function buildPackage(root) {
  const entries = listPackFiles(root).map((name) => ({ name, data: packData(root, name) }));
  return buildZip(entries);
}

// ---- 보안 점검 ----
function sourceFiles(root, overrides) {
  if (overrides) return overrides;
  const files = listPackFiles(root).filter((f) => /\.(js|html|json)$/.test(f));
  return Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
}

function findHardcodedSecrets(root, overrides) {
  return Object.entries(sourceFiles(root, overrides)).flatMap(([file, text]) =>
    SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => `${file}: ${p.name}`));
}

function contentScriptFiles(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  return [...new Set(manifest.content_scripts.flatMap((c) => c.js))];
}

// content script는 모든 사이트에서 돈다. 저장소(비밀값이 있는 cloudAccounts 등)를 만지면 안 된다.
function findContentScriptViolations(root, overrides) {
  const files = overrides || Object.fromEntries(contentScriptFiles(root).map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
  return Object.entries(files)
    .filter(([, text]) => /chrome\.storage|cloudAccounts|importScripts|\beval\(|new Function\(/.test(text))
    .map(([file]) => file);
}

function findUnusedPermissions(root, overrides) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const all = Object.entries(sourceFiles(root, overrides))
    .filter(([f]) => f.endsWith('.js'))
    .map(([, t]) => t)
    .join('\n');
  return manifest.permissions.filter((p) => !PERMISSION_API[p] || !PERMISSION_API[p].test(all));
}

function findManifestIssues(manifest) {
  const issues = [];
  (manifest.permissions || []).forEach((p) => { if (!ALLOWED_PERMISSIONS.has(p)) issues.push(`허용 목록에 없는 권한: ${p}`); });
  if (manifest.web_accessible_resources) issues.push('web_accessible_resources는 쓰지 않아요');
  if (manifest.externally_connectable) issues.push('externally_connectable은 쓰지 않아요');
  if (manifest.content_security_policy) issues.push('기본 CSP를 그대로 써요');
  if (manifest.optional_permissions) issues.push('optional_permissions 점검 필요');
  return issues;
}

module.exports = {
  isPackable, listPackFiles, missingHtmlAssets, crc32, buildZip, readZip, buildPackage,
  findHardcodedSecrets, findContentScriptViolations, findUnusedPermissions, findManifestIssues,
};
