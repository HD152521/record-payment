/* 카탈로그의 icon 이름에 맞는 Simple Icons(CC0) SVG만 icons/brands/로 복사한다.
   사용: npm pack simple-icons 로 받아 푼 폴더를 넘긴다.
   node scripts/fetch-brand-icons.mjs <압축 푼 simple-icons 폴더>/package */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const source = process.argv[2];
if (!source) {
  console.error('사용법: node scripts/fetch-brand-icons.mjs <simple-icons 패키지 폴더>');
  process.exit(1);
}

const { ITEMS } = require(path.join(root, 'src/lib/catalog.js'));
const out = path.join(root, 'icons', 'brands');
fs.mkdirSync(out, { recursive: true });
const slugs = [...new Set(ITEMS.filter((i) => i.icon).map((i) => i.icon))];
const missing = slugs.filter((slug) => !fs.existsSync(path.join(source, 'icons', `${slug}.svg`)));
if (missing.length) {
  console.error(`Simple Icons에 없는 아이콘: ${missing.join(', ')}`);
  process.exit(1);
}
for (const slug of slugs) {
  const svg = fs.readFileSync(path.join(source, 'icons', `${slug}.svg`), 'utf8').replace(/<title>.*?<\/title>/, '');
  fs.writeFileSync(path.join(out, `${slug}.svg`), svg);
}
console.error(`${slugs.length}개 아이콘을 icons/brands/에 복사했어요.`);
