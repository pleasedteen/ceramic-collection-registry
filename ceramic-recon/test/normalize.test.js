'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeText,
  normalizeHeight,
  scorePair,
  textSimilarity,
  heightSimilarity,
  MATCH_THRESHOLD,
} = require('../src/normalize');

test('规范化：异体字 缾/瓶 归一，去空白与大小写', () => {
  assert.equal(normalizeText('青釉梅缾'), normalizeText('青釉梅瓶'));
  assert.equal(normalizeText(' 黑釉　茶盏 '), '黑釉茶盏');
  assert.equal(normalizeText('ABC'), normalizeText('abc'));
  assert.equal(normalizeText(null), null);
});

test('高度规范化：非数值返回 null', () => {
  assert.equal(normalizeHeight('20.4'), 20.4);
  assert.equal(normalizeHeight(''), null);
  assert.equal(normalizeHeight('abc'), null);
});

test('文本相似度：相等为 1，编辑距离衰减', () => {
  assert.equal(textSimilarity('青釉梅瓶', '青釉梅瓶'), 1);
  const s = textSimilarity('青釉梅瓶', '黑釉茶盏');
  assert.ok(s > 0 && s < 1);
});

test('高度相似度：20 与 20.4 视为等同（差 0.4 ≤ 0.5）', () => {
  assert.equal(heightSimilarity(20, 20.4), 1);
  assert.equal(heightSimilarity(8, 20), 0);
});

test('基准三件两两达到匹配阈值，且证据可串联', () => {
  const A = { nName: normalizeText('青釉梅瓶'), nMark: normalizeText('甲款'), nHeight: 20 };
  const B = { nName: normalizeText('青釉梅缾'), nMark: normalizeText('甲款'), nHeight: 20 };
  const C = { nName: normalizeText('青釉梅缾'), nMark: normalizeText('甲款'), nHeight: 20.4 };
  for (const [x, y] of [[A, B], [B, C], [A, C]]) {
    const r = scorePair(x, y);
    assert.ok(r.confidence >= MATCH_THRESHOLD, `confidence=${r.confidence}`);
    assert.equal(r.parts.name, 1);
    assert.equal(r.parts.mark, 1);
    assert.equal(r.parts.height, 1);
  }
});

test('更正后的黑釉茶盏与青釉梅瓶低于匹配阈值', () => {
  const A = { nName: normalizeText('青釉梅瓶'), nMark: normalizeText('甲款'), nHeight: 20 };
  const B2 = { nName: normalizeText('黑釉茶盏'), nMark: normalizeText('乙款'), nHeight: 8 };
  const r = scorePair(A, B2);
  assert.ok(r.confidence < MATCH_THRESHOLD, `confidence=${r.confidence}`);
});
