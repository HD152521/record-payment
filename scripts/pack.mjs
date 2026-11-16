// 사용: node scripts/pack.mjs  -> dist/payment-tracker-<버전>.zip
// 점검에 걸리면 zip을 만들지 않고 종료 코드 1로 끝난다.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const P = require('./pack-lib.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

const problems = [
  ...P.findHardcodedSecrets(root).map((m) => `비밀값 의심: ${m}`),
  ...P.findContentScriptViolations(root).map((m) => `content script 금지 사용: ${m}`),
  ...P.findUnusedPermissions(root).map((m) => `쓰이지 않는 권한: ${m}`),
  ...P.findManifestIssues(manifest),
  ...P.missingHtmlAssets(root, P.listPackFiles(root)).map((m) => `HTML 참조 파일 없음: ${m}`),
];

if (problems.length) {
  problems.forEach((p) => console.error(`[pack] ${p}`));
  process.exit(1);
}

const zip = P.buildPackage(root);
const outDir = path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `payment-tracker-${manifest.version}.zip`);
fs.writeFileSync(out, zip);
process.stdout.write(`${out} (${P.readZip(zip).length}개 파일, ${zip.length}바이트)\n`);
