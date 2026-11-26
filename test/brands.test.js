const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const K = require('../src/lib/catalog.js');

const ROOT = path.join(__dirname, '..');
const BRAND_DIR = path.join(ROOT, 'icons', 'brands');
const MAX_BRAND_BYTES = 300 * 1024;

test('every catalog item gets an avatar: a real icon or a letter on its own colour', () => {
  for (const item of K.ITEMS) {
    const a = K.avatarFor(item);
    assert.match(a.color, /^#[0-9a-f]{6}$|^hsl\(/i, item.id);
    assert.ok(a.letter && a.letter.length >= 1, item.id);
    if (a.icon) assert.ok(fs.existsSync(path.join(ROOT, a.icon)), `${item.id} -> ${a.icon}`);
  }
});

test('items with an icon field point at a svg inside icons/brands', () => {
  const withIcon = K.ITEMS.filter((i) => i.icon);
  assert.ok(withIcon.length >= 20, 'most services should have a logo');
  for (const item of withIcon) {
    assert.match(item.icon, /^[a-z0-9]+$/, item.id);
    assert.match(item.color, /^[0-9A-F]{6}$/, `${item.id} needs an official colour`);
    assert.equal(K.avatarFor(item).icon, `icons/brands/${item.icon}.svg`);
  }
});

test('items without an icon get different avatar colours from each other', () => {
  const plain = K.ITEMS.filter((i) => !i.icon);
  const colors = plain.map((i) => K.avatarFor(i).color);
  assert.equal(new Set(colors).size, colors.length, 'letter avatars must not share a colour');
  assert.ok(plain.every((i) => K.avatarFor(i).icon === null));
});

test('avatarFor is stable and tolerates empty or unknown input', () => {
  const item = K.ITEMS.find((i) => !i.icon);
  assert.deepEqual(K.avatarFor(item), K.avatarFor(item));
  const unknown = K.avatarFor({ id: 'x', name: '' });
  assert.equal(unknown.letter, '?');
  assert.equal(unknown.icon, null);
  assert.equal(K.avatarFor(null).letter, '?');
});

test('dark brand colours are flagged so the UI can swap them for the ink colour', () => {
  assert.equal(K.avatarFor({ id: 'a', name: 'A', icon: 'a', color: '000000' }).isDark, true);
  assert.equal(K.avatarFor({ id: 'b', name: 'B', icon: 'b', color: 'F38020' }).isDark, false);
});

test('brand icons are plain svgs without scripts or external references, under the size budget', () => {
  const files = fs.readdirSync(BRAND_DIR).filter((f) => f.endsWith('.svg'));
  let total = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(BRAND_DIR, f), 'utf8');
    total += Buffer.byteLength(text);
    assert.match(text, /^<svg\b/, f);
    assert.ok(!/<script|onload=|https?:\/\/(?!www\.w3\.org)/i.test(text), f);
  }
  assert.ok(total < MAX_BRAND_BYTES, `brand icons use ${total} bytes`);
  const used = new Set(K.ITEMS.filter((i) => i.icon).map((i) => `${i.icon}.svg`));
  assert.deepEqual(files.filter((f) => !used.has(f)), [], 'no unused icon files');
});

test('letter avatars use the first letter or digit of the name, uppercased', () => {
  assert.equal(K.avatarFor({ id: 'a', name: 'ChatGPT' }).letter, 'C');
  assert.equal(K.avatarFor({ id: 'b', name: '쿠팡 와우' }).letter, '쿠');
  assert.equal(K.avatarFor({ id: 'c', name: '  (3M) tool' }).letter, '3');
});
