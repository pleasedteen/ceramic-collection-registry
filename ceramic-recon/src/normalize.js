'use strict';

// 公开、固定的规范化与匹配规则（见 README《匹配规则》）
const VARIANT_MAP = {
  缾: '瓶',
  瓶: '瓶',
  甁: '瓶',
  罋: '瓮',
  瓮: '瓮',
  盌: '碗',
  碗: '碗',
  椀: '碗',
  盃: '杯',
  杯: '杯',
  盞: '盏',
  盏: '盏',
  茶: '茶',
};

function normalizeText(s) {
  if (s === null || s === undefined) return null;
  let t = String(s)
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .toLowerCase();
  t = [...t]
    .map((ch) => VARIANT_MAP[ch] || ch)
    .join('');
  return t;
}

function normalizeHeight(h) {
  if (h === null || h === undefined || h === '') return null;
  const n = Number(h);
  return Number.isFinite(n) ? n : null;
}

function normalizeRecord(r) {
  return {
    nName: normalizeText(r.name),
    nMark: normalizeText(r.mark),
    nHeight: normalizeHeight(r.height),
  };
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const ca = [...a];
  const cb = [...b];
  for (let i = 1; i <= ca.length; i++) {
    const cur = [i];
    for (let j = 1; j <= cb.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (ca[i - 1] === cb[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[cb.length];
}

function textSimilarity(a, b) {
  if (a === null || b === null) return null;
  if (a === b) return 1;
  const d = levenshtein(a, b);
  const denom = Math.max([...a].length, [...b].length);
  return denom === 0 ? 1 : Math.max(0, 1 - d / denom);
}

function heightSimilarity(x, y) {
  if (x === null || y === null) return null;
  const diff = Math.abs(x - y);
  if (diff <= 0.5) return 1;
  if (diff <= 2) return Math.round((1 - (diff - 0.5) / 1.5) * 1000) / 1000;
  return 0;
}

// 权重与阈值均为固定公开规则
const W_NAME = 0.6;
const W_MARK = 0.2;
const W_HEIGHT = 0.2;
const MATCH_THRESHOLD = 0.7;

function scorePair(a, b) {
  const parts = {};
  let weighted = 0;
  let weight = 0;
  const ns = textSimilarity(a.nName, b.nName);
  if (ns !== null) {
    parts.name = ns;
    weighted += W_NAME * ns;
    weight += W_NAME;
  }
  const ms = textSimilarity(a.nMark, b.nMark);
  if (ms !== null) {
    parts.mark = ms;
    weighted += W_MARK * ms;
    weight += W_MARK;
  }
  const hs = heightSimilarity(a.nHeight, b.nHeight);
  if (hs !== null) {
    parts.height = hs;
    weighted += W_HEIGHT * hs;
    weight += W_HEIGHT;
  }
  const confidence = weight === 0 ? 0 : Math.round((weighted / weight) * 1000000) / 1000000;
  return { confidence, parts };
}

// 分块：规范化品名相同 或 规范化刻款相同，才进入候选比较
function blockingKey(rec) {
  const keys = new Set();
  if (rec.nName) keys.add(`n:${rec.nName}`);
  if (rec.nMark) keys.add(`m:${rec.nMark}`);
  return [...keys];
}

module.exports = {
  normalizeText,
  normalizeHeight,
  normalizeRecord,
  textSimilarity,
  heightSimilarity,
  scorePair,
  blockingKey,
  MATCH_THRESHOLD,
  W_NAME,
  W_MARK,
  W_HEIGHT,
};
