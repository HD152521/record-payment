'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/lib/motion.js');

test('easeOut: 0에서 시작해 1에서 끝나고 중간엔 앞쪽이 빠르다', () => {
  assert.equal(M.easeOut(0), 0);
  assert.equal(M.easeOut(1), 1);
  assert.ok(M.easeOut(0.5) > 0.5);
});

test('countValue: 진행률에 따라 정수로 사이 값을 낸다', () => {
  assert.equal(M.countValue(0, 190360, 0), 0);
  assert.equal(M.countValue(0, 190360, 1), 190360);
  const mid = M.countValue(100, 200, 0.5);
  assert.ok(Number.isInteger(mid) && mid > 150 && mid < 200);
});

test('countValue: 줄어들 때도 끝값에서 정확히 멈춘다', () => {
  assert.equal(M.countValue(50000, 30000, 1), 30000);
  assert.ok(M.countValue(50000, 30000, 0.5) < 50000);
});

test('countValue: 진행률이 범위를 벗어나도 시작·끝값을 넘지 않는다', () => {
  assert.equal(M.countValue(0, 100, -1), 0);
  assert.equal(M.countValue(0, 100, 2), 100);
});

test('shouldAnimate: 같은 값·움직임 줄이기·첫 값 없음이면 바로 바꾼다', () => {
  assert.equal(M.shouldAnimate(100, 100, false), false);
  assert.equal(M.shouldAnimate(0, 100, true), false);
  assert.equal(M.shouldAnimate(0, 100, false), true);
  assert.equal(M.shouldAnimate(NaN, 100, false), false);
});
