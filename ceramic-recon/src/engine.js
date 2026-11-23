'use strict';
const { keyOf, parseKey, SOURCES, CURRENT_FORMAT } = require('./db');
const {
  normalizeRecord,
  scorePair,
  blockingKey,
  MATCH_THRESHOLD,
} = require('./normalize');

// 字段取值优先级（固定公开规则）：空值让位给有效值
const FIELD_PRIORITY = {
  name: ['registry', 'repair', 'inventory'], // 品名优先取登记
  mark: ['registry', 'repair', 'inventory'],
  material: ['repair', 'registry', 'inventory'], // 材质优先取修复记录
  height: ['registry', 'repair', 'inventory'],
};
const FIELDS = ['name', 'mark', 'material', 'height'];

let crashBeforeCommit = false;
function setCrashBeforeCommit(v) {
  crashBeforeCommit = !!v;
}

class Mutex {
  constructor() {
    this.chain = Promise.resolve();
  }
  run(fn) {
    const run = this.chain.then(() => fn());
    this.chain = run.catch(() => {});
    return run;
  }
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function now() {
  return Date.now();
}

async function nextSeq(db, source, id) {
  const rows = await db.all(
    'select coalesce(max(seq), 0) + 1 as s from record_versions where source = ? and source_id = ?',
    [source, id]
  );
  return rows[0].s;
}

async function assertNewBatch(db, batchId) {
  const rows = await db.all('select 1 from batches where batch_id = ?', [batchId]);
  if (rows.length) throw new ApiError(409, `批次编号已存在: ${batchId}`);
}

async function activeVersion(db, source, id) {
  const rows = await db.all('select * from v_active_records where source = ? and source_id = ?', [
    source,
    id,
  ]);
  return rows[0] || null;
}

function validateSource(source) {
  if (!SOURCES.includes(source)) {
    throw new ApiError(400, `来源必须是 ${SOURCES.join('/')} 之一`);
  }
}

function cleanFields(input) {
  const f = input || {};
  const strOrNull = (v) => (v === undefined || v === null || v === '' ? null : String(v));
  return {
    name: strOrNull(f.name),
    mark: strOrNull(f.mark),
    material: strOrNull(f.material),
    height:
      f.height === undefined || f.height === null || f.height === ''
        ? null
        : Number(f.height),
  };
}

// 整条更正：未在请求中给出的字段，继承当前有效版本；显式给出（含 null）才覆盖
function mergeCorrection(active, input) {
  const f = input || {};
  const pick = (field) => (f[field] === undefined ? active[field] : cleanFields({ [field]: f[field] })[field]);
  const merged = {
    name: pick('name'),
    mark: pick('mark'),
    material: pick('material'),
    height: pick('height'),
  };
  if (Number.isNaN(merged.height)) throw new ApiError(400, 'height 不是有效数值');
  return merged;
}

async function addOutbox(db, rows) {
  await insertChunked(db, 'outbox', ['k', 'reason'], rows, '(?, ?)');
}

// 重建某条键的分块索引（先删后插），反映其当前有效规范化字段
async function reindexKey(db, k) {
  const { source, id } = parseKey(k);
  const rows = await db.all('select * from v_active_records where source = ? and source_id = ?', [
    source,
    id,
  ]);
  await db.run('delete from block_name where k = ?', [k]);
  await db.run('delete from block_mark where k = ?', [k]);
  if (!rows.length) return; // 已无有效版本（撤回），索引清空
  const rec = { ...rows[0], ...normalizeRecord(rows[0]) };
  if (rec.nName) await db.run('insert into block_name(nname, k) values(?, ?)', [rec.nName, k]);
  if (rec.nMark) await db.run('insert into block_mark(nmark, k) values(?, ?)', [rec.nMark, k]);
}

// 分块多值插入：rows 为参数二维数组，each 为每行占位符（如 '(?, ?)'）
async function insertChunked(db, table, columns, rows, each, chunkSize = 250) {
  if (!rows.length) return;
  for (let s = 0; s < rows.length; s += chunkSize) {
    const part = rows.slice(s, s + chunkSize);
    const sql = `insert into ${table}(${columns.join(',')}) values ${part
      .map(() => each)
      .join(',')}`;
    await db.run(sql, part.flat());
  }
}

// 批量重建一组键的分块索引（集合式，避免逐键多次往返）
async function reindexKeys(db, keys) {
  if (!keys.length) return;
  for (let s = 0; s < keys.length; s += 250) {
    const part = keys.slice(s, s + 250);
    const ph = part.map(() => '?').join(',');
    await db.run(`delete from block_name where k in (${ph})`, part);
    await db.run(`delete from block_mark where k in (${ph})`, part);
  }
  const rows = [];
  for (let s = 0; s < keys.length; s += 250) {
    const part = keys.slice(s, s + 250);
    const ph = part.map(() => '?').join(',');
    const got = await db.all(
      `select source, source_id, name, mark, height from v_active_records
       where concat(source, '|', source_id) in (${ph})`,
      part
    );
    rows.push(...got);
  }
  const nameRows = [];
  const markRows = [];
  for (const r of rows) {
    const k = keyOf(r.source, r.source_id);
    const nr = normalizeRecord(r);
    if (nr.nName) nameRows.push([nr.nName, k]);
    if (nr.nMark) markRows.push([nr.nMark, k]);
  }
  await insertChunked(db, 'block_name', ['nname', 'k'], nameRows, '(?, ?)');
  await insertChunked(db, 'block_mark', ['nmark', 'k'], markRows, '(?, ?)');
}
// 经分块索引取得与候选键共享规范化品名或刻款的全部成员键（集合式，不做逐键查询）
async function blockCandidates(db, keys) {
  const out = new Set(keys);
  if (!keys.length) return out;
  const list = [...keys];
  const nnames = new Set();
  const nmarks = new Set();
  // 分块读取代入键的规范化品名/刻款（block 表只含有效记录）
  for (let s = 0; s < list.length; s += 500) {
    const part = list.slice(s, s + 500);
    const ph = part.map(() => '?').join(',');
    const nr = await db.all(`select nname from block_name where k in (${ph})`, part);
    nr.forEach((r) => nnames.add(r.nname));
    const mr = await db.all(`select nmark from block_mark where k in (${ph})`, part);
    mr.forEach((r) => nmarks.add(r.nmark));
  }
  const nameList = [...nnames];
  for (let s = 0; s < nameList.length; s += 500) {
    const part = nameList.slice(s, s + 500);
    const ph = part.map(() => '?').join(',');
    const r = await db.all(`select k from block_name where nname in (${ph})`, part);
    r.forEach((x) => out.add(x.k));
  }
  const markList = [...nmarks];
  for (let s = 0; s < markList.length; s += 500) {
    const part = markList.slice(s, s + 500);
    const ph = part.map(() => '?').join(',');
    const r = await db.all(`select k from block_mark where nmark in (${ph})`, part);
    r.forEach((x) => out.add(x.k));
  }
  return out;
}

// ---------------- 写操作 ----------------

async function importBatch(db, mutex, body) {
  return mutex.run(() => tx(db, () => doImport(db, body)));
}

async function doImport(db, body) {
  const { batchId, source, records } = body || {};
  if (!batchId) throw new ApiError(400, '缺少 batchId');
  validateSource(source);
  if (!Array.isArray(records) || records.length === 0) {
    throw new ApiError(400, 'records 必须是非空数组');
  }
  await assertNewBatch(db, batchId);
  const ids = new Set();
  for (const r of records) {
    if (!r || !r.id) throw new ApiError(400, '每条记录必须含 id');
    if (ids.has(r.id)) throw new ApiError(400, `批次内编号重复: ${r.id}`);
    ids.add(r.id);
  }
  // 集合式校验：本批次编号是否已有有效版本
  const idList = [...ids];
  const idPh = idList.map(() => '?').join(',');
  const dupRows = await db.all(
    `select source_id from v_active_records where source = ? and source_id in (${idPh})`,
    [source, ...idList]
  );
  if (dupRows.length) {
    throw new ApiError(
      409,
      `${source}|${dupRows[0].source_id} 已有有效版本，整条变更请使用更正接口`
    );
  }
  // 每个编号当前最大 seq（新导入恒为 1，但统一按规则取 max+1）
  const seqRows = await db.all(
    `select source_id, coalesce(max(seq), 0) + 1 as next_seq
     from record_versions where source = ? and source_id in (${idPh}) group by source_id`,
    [source, ...idList]
  );
  const seqMap = new Map(seqRows.map((r) => [r.source_id, Number(r.next_seq)]));

  const valueParams = [];
  const out = [];
  const keys = [];
  for (const r of records) {
    const f = cleanFields(r);
    const seq = seqMap.get(r.id) || 1;
    valueParams.push([source, r.id, seq, batchId, f.name, f.mark, f.material, f.height]);
    const k = keyOf(source, r.id);
    keys.push(k);
    out.push([k, 'import']);
  }
  // 分块多值插入，避免超大参数展开导致栈溢出
  await insertChunked(
    db,
    'record_versions',
    ['source', 'source_id', 'seq', 'batch_id', 'name', 'mark', 'material', 'height'],
    valueParams,
    '(?, ?, ?, ?, ?, ?, ?, ?)'
  );
  await reindexKeys(db, keys);
  await db.run('insert into batches(batch_id, kind, created_at, detail) values(?, ?, ?, ?)', [
    batchId,
    'import',
    now(),
    JSON.stringify({ source, count: records.length }),
  ]);
  await addOutbox(db, out);
  return { batchId, kind: 'import', count: records.length };
}

async function correctRecord(db, mutex, body) {
  return mutex.run(() => tx(db, () => doCorrect(db, body)));
}

async function doCorrect(db, body) {
  const { batchId, source, id, fields } = body || {};
  if (!batchId) throw new ApiError(400, '缺少 batchId');
  validateSource(source);
  if (!id) throw new ApiError(400, '缺少 id');
  await assertNewBatch(db, batchId);
  const active = await activeVersion(db, source, id);
  if (!active) throw new ApiError(404, `目标记录不存在或无有效版本: ${source}|${id}`);
  const f = mergeCorrection(active, fields);
  const seq = await nextSeq(db, source, id);
  await db.run(
    `insert into record_versions(source, source_id, seq, batch_id, name, mark, material, height)
     values(?, ?, ?, ?, ?, ?, ?, ?)`,
    [source, id, seq, batchId, f.name, f.mark, f.material, f.height]
  );
  await reindexKey(db, keyOf(source, id));
  await db.run('insert into batches(batch_id, kind, created_at, detail) values(?, ?, ?, ?)', [
    batchId,
    'correct',
    now(),
    JSON.stringify({ source, id, supersedes: active.rv_id }),
  ]);
  await addOutbox(db, [[keyOf(source, id), 'correct']]);
  return { batchId, kind: 'correct', target: keyOf(source, id), seq };
}

async function judgeHeterology(db, mutex, body) {
  return mutex.run(() => tx(db, () => doJudge(db, body)));
}

async function doJudge(db, body) {
  const { batchId, source1, id1, source2, id2 } = body || {};
  if (!batchId) throw new ApiError(400, '缺少 batchId');
  validateSource(source1);
  validateSource(source2);
  await assertNewBatch(db, batchId);
  const k1 = keyOf(source1, id1);
  const k2 = keyOf(source2, id2);
  if (k1 === k2) throw new ApiError(400, '判异必须针对两条不同来源记录');
  if (source1 === source2) {
    throw new ApiError(400, '异件两条来源记录必须分属不同馆藏（来源）');
  }
  const a = await activeVersion(db, source1, id1);
  const b = await activeVersion(db, source2, id2);
  if (!a || !b) throw new ApiError(404, '判异目标必须都是有效记录');
  const dup = await db.all(
    'select 1 from v_active_heterology where (k1 = ? and k2 = ?) or (k1 = ? and k2 = ?)',
    [k1, k2, k2, k1]
  );
  if (dup.length) throw new ApiError(409, '两条记录之间已存在有效异件判定');
  const [lo, hi] = [k1, k2].sort();
  await db.run(
    'insert into heterology_edges(batch_id, k1, k2, created_at) values(?, ?, ?, ?)',
    [batchId, lo, hi, now()]
  );
  await db.run('insert into batches(batch_id, kind, created_at, detail) values(?, ?, ?, ?)', [
    batchId,
    'heterology',
    now(),
    JSON.stringify({ k1: lo, k2: hi }),
  ]);
  await addOutbox(db, [
    [lo, 'heterology'],
    [hi, 'heterology'],
  ]);
  return { batchId, kind: 'heterology', k1: lo, k2: hi };
}

async function withdrawBatch(db, mutex, body) {
  return mutex.run(() => tx(db, () => doWithdraw(db, body)));
}

async function doWithdraw(db, body) {
  const { batchId } = body || {};
  if (!batchId) throw new ApiError(400, '缺少 batchId');
  const rows = await db.all('select * from batches where batch_id = ?', [batchId]);
  if (!rows.length) throw new ApiError(404, `批次不存在: ${batchId}`);
  const batch = rows[0];
  if (batch.withdrawn_at !== null) throw new ApiError(409, '该批次已撤回');
  const touched = [];
  if (batch.kind === 'heterology') {
    const edge = await db.all('select * from heterology_edges where batch_id = ?', [batchId]);
    await db.run('update heterology_edges set withdrawn_at = ? where batch_id = ?', [
      now(),
      batchId,
    ]);
    touched.push(
      [edge[0].k1, 'withdraw'],
      [edge[0].k2, 'withdraw']
    );
  } else {
    const rvs = await db.all('select distinct source, source_id from record_versions where batch_id = ?', [
      batchId,
    ]);
    await db.run('update record_versions set withdrawn_at = ? where batch_id = ?', [
      now(),
      batchId,
    ]);
    for (const r of rvs) touched.push([keyOf(r.source, r.source_id), 'withdraw']);
  }
  await db.run('update batches set withdrawn_at = ? where batch_id = ?', [now(), batchId]);
  if (batch.kind !== 'heterology') {
    for (const [k] of touched) await reindexKey(db, k);
  }
  await addOutbox(db, touched);
  return { batchId, kind: batch.kind, withdrawn: true, touched: touched.map(([k]) => k) };
}

// ---------------- 归组计算 ----------------

// 并查集
class UnionFind {
  constructor(keys) {
    this.parent = new Map(keys.map((k) => [k, k]));
  }
  find(x) {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const nxt = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = nxt;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // 固定规则：以字典序较小的根为新根，保证可复算
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

// 确定性分区（并查集）：
//   匹配边已按“置信度降序；同分按最小端点编号降序、再最大端点降序”排序。
//   逐条合并：异件对的匹配边直接剪开；其余边若合并会使某条有效异件判定两端
//   落入同一组，也剪开跳过。冲突因此按置信度优先、同分按固定公开规则处理，
//   且异件两端必属不同馆藏。
// heterologyBatch: token（两键排序后以 # 连接）→ 判异批次编号，用于记录“当时阻断它的判异批次”。
function partitionGroups(keys, sortedMatchEdges, heterologySet, heterologyBatch = new Map()) {
  const uf = new UnionFind(keys);
  const cutEdges = [];

  const heteroByNode = new Map(keys.map((k) => [k, new Set()]));
  for (const token of heterologySet) {
    const [a, b] = token.split('#');
    if (heteroByNode.has(a) && heteroByNode.has(b)) {
      heteroByNode.get(a).add(b);
      heteroByNode.get(b).add(a);
    }
  }

  // 返回若合并 k1、k2 会被触发（两端分属两组件）的全部异件对
  const violatingPairs = (k1, k2) => {
    const r1 = uf.find(k1);
    const r2 = uf.find(k2);
    if (r1 === r2) return [];
    const members1 = new Set(keys.filter((k) => uf.find(k) === r1));
    const members2 = new Set(keys.filter((k) => uf.find(k) === r2));
    const seen = new Set();
    const pairs = [];
    for (const a of members1) {
      for (const b of heteroByNode.get(a) || []) {
        if (members2.has(b)) {
          const pair = [a, b].sort();
          const token = pair.join('#');
          if (!seen.has(token)) {
            seen.add(token);
            pairs.push({ k1: pair[0], k2: pair[1], batchId: heterologyBatch.get(token) || null });
          }
        }
      }
    }
    pairs.sort((x, y) => (x.k1 + '#' + x.k2 < y.k1 + '#' + y.k2 ? -1 : 1));
    return pairs;
  };

  for (const e of sortedMatchEdges) {
    if (!uf.parent.has(e.k1) || !uf.parent.has(e.k2)) continue;
    const token = [e.k1, e.k2].sort().join('#');
    if (heterologySet.has(token)) {
      // 异件凌驾匹配：直判异
      cutEdges.push({
        ...e,
        block: {
          kind: 'direct',
          pairs: [
            {
              k1: token.split('#')[0],
              k2: token.split('#')[1],
              batchId: heterologyBatch.get(token) || null,
            },
          ],
        },
      });
      continue;
    }
    const pairs = violatingPairs(e.k1, e.k2);
    if (pairs.length) {
      // 间接阻断：合并会让某条有效异件判定两端同组
      cutEdges.push({ ...e, block: { kind: 'indirect', pairs } });
      continue;
    }
    // 记录该匹配边是否真的促成了归并（两端原属不同组件）
    e.contributed = uf.find(e.k1) !== uf.find(e.k2);
    uf.union(e.k1, e.k2);
  }

  const groupsMap = new Map();
  for (const k of keys) {
    const root = uf.find(k);
    if (!groupsMap.has(root)) groupsMap.set(root, []);
    groupsMap.get(root).push(k);
  }
  const groups = [...groupsMap.values()].map((g) => g.sort());
  groups.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { groups, cutEdges };
}

function isBlank(v) {
  return v === null || v === undefined || v === '' || v === 'null';
}

function resolveFields(members, recMap) {
  const fields = {};
  const fieldSources = {};
  for (const f of FIELDS) {
    fields[f] = null;
    fieldSources[f] = null;
    for (const src of FIELD_PRIORITY[f]) {
      const holder = members
        .map((k) => recMap.get(k))
        .find((r) => r && r.source === src && !isBlank(r[f]));
      if (holder) {
        fields[f] = holder[f];
        fieldSources[f] = src;
        break;
      }
    }
  }
  return { fields, fieldSources };
}

// 仅读取受影响成员相关的当前归属（增量，不扫描全库）：
// 返回受影响 k->gid、涉及 gid->其全部成员
async function readLiveMembershipScoped(db, affectedKeys) {
  const k2gid = new Map();
  const gid2members = new Map();
  if (!affectedKeys.length) return { k2gid, gid2members };
  const rows = await db.allIn(
    'select k, gid from live_members',
    'k',
    affectedKeys
  );
  const gids = new Set(rows.map((r) => r.gid));
  for (const r of rows) k2gid.set(r.k, r.gid);
  if (gids.size) {
    const memberRows = await db.allIn(
      'select k, gid from live_members',
      'gid',
      [...gids]
    );
    for (const r of memberRows) {
      if (!gid2members.has(r.gid)) gid2members.set(r.gid, []);
      gid2members.get(r.gid).push(r.k);
    }
  }
  return { k2gid, gid2members };
}

async function recompute(db, affectedHint, firstPublish) {
  const t0 = now();
  let affected = new Set(affectedHint);
  if (firstPublish) {
    const all = await db.all('select source, source_id from v_active_records');
    affected = new Set(all.map((r) => keyOf(r.source, r.source_id)));
  }
  // 异件边端点始终纳入，保证判异约束参与分区
  const edgesAll = await db.all('select k1, k2, batch_id from v_active_heterology');
  const heterologyBatch = new Map();
  for (const e of edgesAll) {
    heterologyBatch.set([e.k1, e.k2].sort().join('#'), e.batch_id);
    affected.add(e.k1);
    affected.add(e.k2);
  }

  // 读取受影响边当前生效的证据状态（用于“只在边变化时记历史”）。
  // 上一发布的有效证据 = version<=上一版的最新事件；首版无历史。
  let prevEvidence = new Map();

  // 读取受影响成员当前归属（首版为空）
  let prevK2Gid = new Map();
  let prevGid2Members = new Map();
  if (!firstPublish) {
    const scoped = await readLiveMembershipScoped(db, [...affected]);
    prevK2Gid = scoped.k2gid;
    prevGid2Members = scoped.gid2members;
  }

  // 受影响成员所在旧馆藏的全部成员都要重算（组件闭包，避免漏算同组其他来源）
  if (!firstPublish) {
    let grew = true;
    while (grew) {
      grew = false;
      // 每轮先补齐当前 affected 的旧归属，再沿旧馆藏闭包扩展
      const scoped = await readLiveMembershipScoped(db, [...affected]);
      for (const [k, gid] of scoped.k2gid) prevK2Gid.set(k, gid);
      for (const [gid, members] of scoped.gid2members) prevGid2Members.set(gid, members);
      for (const [gid, members] of prevGid2Members) {
        if (members.some((m) => affected.has(m))) {
          for (const m of members) {
            if (!affected.has(m)) {
              affected.add(m);
              grew = true;
            }
          }
        }
      }
    }
  }

  // 经分块索引把候选扩展到“与受影响记录共享规范化品名或刻款”的成员，
  // 用于发现跨馆藏的合并/拆分；不相关分块的记录不会被读取或比较。
  let scope;
  if (firstPublish) {
    scope = new Set(
      (await db.all('select source, source_id from v_active_records')).map((r) =>
        keyOf(r.source, r.source_id)
      )
    );
  } else {
    scope = await blockCandidates(db, [...affected]);
    for (const k of scope) affected.add(k);
    // 分块扩展可能纳入新成员，补齐它们的旧归属，确保其原馆藏被正确重算而非误建
    const extra = await readLiveMembershipScoped(db, [...affected]);
    for (const [k, gid] of extra.k2gid) prevK2Gid.set(k, gid);
    for (const [gid, members] of extra.gid2members) prevGid2Members.set(gid, members);
  }

  let activeRows;
  if (firstPublish) {
    activeRows = await db.all('select * from v_active_records');
  } else {
    activeRows = await db.allIn(
      'select * from v_active_records',
      "concat(source, '|', source_id)",
      scope
    );
  }
  const sourceRecordsRead = activeRows.length;

  // 子图确定后，读取至少一端落在受影响子图内的边的最新有效证据。
  // 内层先过滤再取每边最新事件，读取量只随受影响边数增长，不随无关发布增长。
  if (!firstPublish) {
    const list = [...affected];
    for (let s = 0; s < list.length; s += 400) {
      const part = list.slice(s, s + 400);
      const ph = part.map(() => '?').join(',');
      const rows = await db.all(
        `select q.k1, q.k2, q.outcome, q.confidence, q.evidence, q.contributed,
                q.block_kind, q.block_batches, q.format_version
         from (
           select k1, k2, outcome, confidence, evidence, contributed, block_kind, block_batches,
                  format_version, row_number() over (partition by k1, k2 order by event_id desc) rn
           from evidence_events where k1 in (${ph}) or k2 in (${ph})
         ) q where q.rn = 1`,
        [...part, ...part]
      );
      for (const row of rows) {
        prevEvidence.set(`${row.k1}#${row.k2}`, {
          outcome: row.outcome,
          confidence: row.confidence,
          evidence: row.evidence,
          contributed: row.contributed,
          blockKind: row.block_kind,
          blockBatches: row.block_batches,
          formatVersion: row.format_version === null ? null : Number(row.format_version),
        });
      }
    }
  }

  const recMap = new Map();
  for (const r of activeRows) {
    const k = keyOf(r.source, r.source_id);
    recMap.set(k, { ...r, k, ...normalizeRecord(r) });
  }

  // 分块候选 + 评分（只比较跨来源、且两端均在受影响子图内的候选对）
  const blocks = new Map();
  for (const rec of recMap.values()) {
    for (const bk of blockingKey(rec)) {
      if (!blocks.has(bk)) blocks.set(bk, []);
      blocks.get(bk).push(rec.k);
    }
  }
  const pairSet = new Set();
  for (const arr of blocks.values()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const [a, b] = [arr[i], arr[j]].sort();
        if (parseKey(a).source === parseKey(b).source) continue;
        if (!firstPublish && (!affected.has(a) || !affected.has(b))) continue;
        pairSet.add(`${a}#${b}`);
      }
    }
  }
  let comparisons = 0;
  const matchEdges = [];
  for (const token of pairSet) {
    const [k1, k2] = token.split('#');
    comparisons += 1;
    const { confidence, parts } = scorePair(recMap.get(k1), recMap.get(k2));
    if (confidence >= MATCH_THRESHOLD) {
      matchEdges.push({ k1, k2, confidence, evidence: parts });
    }
  }
  // 置信度优先；同分按“最小端点编号降序、再最大端点降序”（固定公开同分规则，见 README）
  matchEdges.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const aMin = a.k1 < a.k2 ? a.k1 : a.k2;
    const aMax = a.k1 < a.k2 ? a.k2 : a.k1;
    const bMin = b.k1 < b.k2 ? b.k1 : b.k2;
    const bMax = b.k1 < b.k2 ? b.k2 : b.k1;
    if (aMin !== bMin) return aMin < bMin ? 1 : -1;
    if (aMax !== bMax) return aMax < bMax ? 1 : -1;
    return 0;
  });

  const heterologySet = new Set(
    edgesAll
      .filter((e) => affected.has(e.k1) && affected.has(e.k2))
      .map((e) => [e.k1, e.k2].sort().join('#'))
  );

  // 仅在受影响子图上分区；scope 中非受影响成员只作比较参照，归属保持不变
  const affectedKeys = [...affected].filter((k) => recMap.has(k)).sort();
  const { groups: newGroups, cutEdges: cutEdgesAll } = partitionGroups(
    affectedKeys,
    matchEdges,
    heterologySet,
    heterologyBatch
  );
  newGroups.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  // 成员未变的馆藏沿用编号：用上一版成员签名 -> gid
  const prevSig = new Map();
  for (const [gid, members] of prevGid2Members) {
    prevSig.set(members.slice().sort().join(','), gid);
  }
  const resultGroups = [];
  const newLineage = [];
  // 新编号从“已存在的最大编号”之后分配。不用序列：DuckDB 尾部 nextval 未必落盘，
  // 旧库迁移后重启可能重置序列，导致编号冲突。这里以实际已分配编号为准，稳健且可复算。
  const maxRow = await db.all(
    `select max(try_cast(substr(gid, 2) as bigint)) m from (
       select gid from group_lineage
       union all select gid from live_groups
     )`
  );
  let nextSeqNo = Number(maxRow[0].m || 0);
  let newGroupRows = 0;
  const reusedGids = new Set();
  for (const members of newGroups) {
    const sig = members.join(',');
    let gid = prevSig.get(sig);
    if (gid) {
      reusedGids.add(gid);
    } else {
      nextSeqNo += 1;
      gid = `G${String(nextSeqNo).padStart(6, '0')}`;
      newGroupRows += 1;
      newLineage.push([gid, null]);
    }
    const { fields, fieldSources } = resolveFields(members, recMap);
    const internalEdges = matchEdges.filter(
      (e) => members.includes(e.k1) && members.includes(e.k2)
    );
    resultGroups.push({ gid, members, fields, fieldSources, matchEvidence: internalEdges });
  }
  if (newLineage.length) {
    await insertChunked(db, 'group_lineage', ['gid', 'born_version'], newLineage, '(?, ?)');
  }

  // 本次被重算（含关闭、合并、拆分）的旧馆藏集合
  const touchedOldGids = new Set();
  for (const k of affected) {
    if (prevK2Gid.has(k)) touchedOldGids.add(prevK2Gid.get(k));
  }

  // 本次受影响子图内所有“有效匹配边”的规范状态：促成归并（joined）或被拒（cut）。
  // 以此与上一发布的有效状态逐边比对，只有发生变化的边才写入证据历史。
  const cutByToken = new Map();
  for (const c of cutEdgesAll) cutByToken.set([c.k1, c.k2].sort().join('#'), c);
  const currentEdges = new Map();
  for (const e of matchEdges) {
    const token = [e.k1, e.k2].sort().join('#');
    const cut = cutByToken.get(token);
    if (cut) {
      currentEdges.set(token, {
        k1: token.split('#')[0],
        k2: token.split('#')[1],
        confidence: e.confidence,
        evidence: JSON.stringify(e.evidence),
        outcome: 'cut',
        contributed: false,
        blockKind: cut.block.kind,
        blockBatches: JSON.stringify(cut.block.pairs),
      });
    } else {
      currentEdges.set(token, {
        k1: token.split('#')[0],
        k2: token.split('#')[1],
        confidence: e.confidence,
        evidence: JSON.stringify(e.evidence),
        outcome: 'joined',
        contributed: !!e.contributed,
        blockKind: null,
        blockBatches: null,
      });
    }
  }
  const removedTokens = [];
  for (const [token, prev] of prevEvidence) {
    if (currentEdges.has(token)) continue;
    if (prev.outcome !== 'joined' && prev.outcome !== 'cut') continue;
    // 只有两端都在本次受影响子图内时，边的消失才是本次可证实的结论；
    // 一端在子图外的历史边不在本次比较范围内，不能误记为 removed。
    const [a, b] = token.split('#');
    if (!affected.has(a) || !affected.has(b)) continue;
    removedTokens.push(token);
  }

  return {
    resultGroups,
    recMap,
    cutEdgesAll,
    matchEdges,
    currentEdges,
    prevEvidence,
    removedTokens,
    prevK2Gid,
    prevGid2Members,
    touchedOldGids,
    reusedGids,
    newGroupRows,
    metrics: {
      sourceRecordsRead,
      comparisons,
      newGroupRows,
      affectedKeys: [...affected].sort(),
      durationMs: now() - t0,
    },
  };
}

async function publish(db, mutex, body = {}) {
  return mutex.run(() => tx(db, () => doPublish(db, body.reason || null)));
}

async function doPublish(db, reason) {
  const outbox = await db.all('select distinct k from outbox');
  const pubCountRows = await db.all('select count(*) c from publications');
  const firstPublish = pubCountRows[0].c === 0;
  if (!outbox.length && !firstPublish) {
    return { noop: true };
  }
  const r = await recompute(db, outbox.map((o) => o.k), firstPublish);

  const verRows = await db.all('select coalesce(max(version), 0) + 1 v from publications');
  const version = verRows[0].v;

  const newGidSet = new Set(r.resultGroups.map((g) => g.gid));
  // 1) 关闭本次消失的旧馆藏（被合并/拆分后不再以相同成员存在）
  const closedGids = [];
  for (const gid of r.touchedOldGids) {
    if (!newGidSet.has(gid)) closedGids.push(gid);
  }
  if (closedGids.length) {
    for (const gid of closedGids) {
      await db.run('update group_lineage set closed_version = ? where gid = ? and closed_version is null', [
        version,
        gid,
      ]);
      await db.run('insert into group_events(version, gid, op) values(?, ?, ?)', [
        version,
        gid,
        'close',
      ]);
    }
  }
  // 2) 回填新建馆藏的诞生版本
  await db.run('update group_lineage set born_version = ? where born_version is null', [version]);

  // 3) 写入本次结果馆藏的当前态与 open/change 事件、成员归属事件
  const groupEventRows = [];
  const liveGroupRows = [];
  const leaveRows = [];
  const joinRows = [];
  const liveMemberRows = [];
  // 受影响旧馆藏的原字段（用于判断沿用编号的馆藏字段是否变化，变化则记 change 事件，
  // 保证按版本回放的字段与出处也与当时一致）
  const prevFieldRows = new Map();
  if (!firstPublish && r.touchedOldGids.size) {
    for (let s = 0; s < [...r.touchedOldGids].length; s += 500) {
      const part = [...r.touchedOldGids].slice(s, s + 500);
      const ph = part.map(() => '?').join(',');
      const got = await db.all(`select * from live_groups where gid in (${ph})`, part);
      for (const row of got) prevFieldRows.set(row.gid, row);
    }
  }
  for (const g of r.resultGroups) {
    const isNew = !r.prevGid2Members.has(g.gid);
    liveGroupRows.push([
      g.gid,
      g.fields.name, g.fieldSources.name,
      g.fields.mark, g.fieldSources.mark,
      g.fields.material, g.fieldSources.material,
      g.fields.height, g.fieldSources.height,
    ]);
    if (isNew) {
      groupEventRows.push([
        version,
        g.gid,
        'open',
        JSON.stringify({ fields: g.fields, fieldSources: g.fieldSources }),
        JSON.stringify(g.members),
      ]);
    } else {
      const prev = prevFieldRows.get(g.gid);
      const changed =
        !prev ||
        prev.name !== g.fields.name ||
        prev.mark !== g.fields.mark ||
        prev.material !== g.fields.material ||
        (prev.height === null ? null : Number(prev.height)) !==
          (g.fields.height === null ? null : Number(g.fields.height)) ||
        prev.name_src !== g.fieldSources.name ||
        prev.mark_src !== g.fieldSources.mark ||
        prev.material_src !== g.fieldSources.material ||
        prev.height_src !== g.fieldSources.height;
      if (changed) {
        groupEventRows.push([
          version,
          g.gid,
          'change',
          JSON.stringify({ fields: g.fields, fieldSources: g.fieldSources }),
          null,
        ]);
      }
    }
    const prevMembers = new Set(r.prevGid2Members.get(g.gid) || []);
    for (const k of g.members) {
      liveMemberRows.push([k, g.gid]);
      if (r.prevK2Gid.get(k) !== g.gid) {
        if (r.prevK2Gid.has(k)) leaveRows.push([version, k, r.prevK2Gid.get(k), 'leave']);
        joinRows.push([version, k, g.gid, 'join']);
      }
    }
    for (const k of prevMembers) {
      if (!g.members.includes(k)) {
        leaveRows.push([version, k, g.gid, 'leave']);
      }
    }
  }

  // 仅替换受影响旧馆藏的当前态；无关馆藏的 live 行完全不触碰（规模无关）
  const affectedOldGids = [...r.touchedOldGids];
  if (firstPublish) {
    await db.run('delete from live_groups');
    await db.run('delete from live_members');
  } else if (affectedOldGids.length) {
    for (let s = 0; s < affectedOldGids.length; s += 500) {
      const part = affectedOldGids.slice(s, s + 500);
      const ph = part.map(() => '?').join(',');
      await db.run(`delete from live_groups where gid in (${ph})`, part);
      await db.run(`delete from live_members where gid in (${ph})`, part);
    }
  }
  const keepCount = firstPublish
    ? 0
    : (await db.all('select count(*) c from live_groups'))[0].c;

  await insertChunked(db, 'live_groups',
    ['gid', 'name', 'name_src', 'mark', 'mark_src', 'material', 'material_src', 'height', 'height_src'],
    liveGroupRows, '(?, ?, ?, ?, ?, ?, ?, ?, ?)');
  await insertChunked(db, 'live_members', ['k', 'gid'], liveMemberRows, '(?, ?)');

  await insertChunked(db, 'group_events', ['version', 'gid', 'op', 'fields', 'members'], groupEventRows, '(?, ?, ?, ?, ?)');
  await insertChunked(db, 'membership_events', ['version', 'k', 'gid', 'op'], leaveRows, '(?, ?, ?, ?)');
  await insertChunked(db, 'membership_events', ['version', 'k', 'gid', 'op'], joinRows, '(?, ?, ?, ?)');

  // 4) 证据历史：只在边的有效证据发生变化时追加一条事件。
  //    某版某边的有效证据 = version<=该版的最新事件（history 不随无关发布增长）。
  const evidenceRows = [];
  const sameEvidence = (prev, cur) =>
    prev &&
    // 旧格式事件缺少 contributed / 阻断批次等字段，需在新格式下重记一次，
    // 但旧版解释仍只读旧事件，不受影响。
    (prev.formatVersion === null || Number(prev.formatVersion) >= CURRENT_FORMAT) &&
    prev.outcome === cur.outcome &&
    prev.contributed === cur.contributed &&
    Number(prev.confidence) === Number(cur.confidence) &&
    String(prev.evidence) === String(cur.evidence) &&
    (prev.blockKind || null) === (cur.blockKind || null) &&
    (prev.blockBatches || null) === (cur.blockBatches || null);
  for (const [token, cur] of r.currentEdges) {
    const prev = r.prevEvidence.get(token);
    if (sameEvidence(prev, cur)) continue;
    evidenceRows.push([
      version, CURRENT_FORMAT, cur.k1, cur.k2, cur.confidence,
      cur.evidence, cur.outcome, cur.contributed === null ? null : !!cur.contributed,
      cur.blockKind, cur.blockBatches,
    ]);
  }
  // 之前有效、现在不再生效（低于阈值或记录撤回）的边，记一条 removed
  for (const token of r.removedTokens) {
    const [k1, k2] = token.split('#');
    evidenceRows.push([
      version, CURRENT_FORMAT, k1, k2, null, null, 'removed', null, null, null,
    ]);
  }
  await insertChunked(
    db,
    'evidence_events',
    ['version', 'format_version', 'k1', 'k2', 'confidence', 'evidence', 'outcome', 'contributed', 'block_kind', 'block_batches'],
    evidenceRows,
    '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const evidenceChanges = evidenceRows.length;

  // 5) 馆藏证据完整起始版：本次涉及的结果馆藏自本版起被完整跟踪。
  //    用于判断某馆藏在更早版本的证据是否“升级前无法证实”（缺证）。
  const evidenceStateRows = [];
  for (const g of r.resultGroups) evidenceStateRows.push([g.gid, version]);
  if (evidenceStateRows.length) {
    for (let s = 0; s < evidenceStateRows.length; s += 200) {
      const part = evidenceStateRows.slice(s, s + 200);
      const ph = part.map(() => '(?, ?)').join(',');
      await db.run(
        `insert into group_evidence_state(gid, since_version) values ${ph}
         on conflict(gid) do update set since_version = least(group_evidence_state.since_version, excluded.since_version)`,
        part.flat()
      );
    }
  }

  const stats = { ...r.metrics, evidenceChanges, groupCount: keepCount + r.resultGroups.length };
  await db.run('insert into publications(version, created_at, reason, stats, format_version) values(?, ?, ?, ?, ?)', [
    version,
    now(),
    reason,
    JSON.stringify(stats),
    CURRENT_FORMAT,
  ]);
  await db.run(
    `insert into recompute_log(version, touched_keys, source_records_read, comparisons, new_group_rows, evidence_changes, duration_ms)
     values(?, ?, ?, ?, ?, ?, ?)`,
    [
      version,
      JSON.stringify(r.metrics.affectedKeys),
      r.metrics.sourceRecordsRead,
      r.metrics.comparisons,
      r.metrics.newGroupRows,
      evidenceChanges,
      r.metrics.durationMs,
    ]
  );
  await db.run('delete from outbox');

  if (crashBeforeCommit) {
    throw new Error('CRASH_BEFORE_COMMIT test hook');
  }
  return { version, stats };
}

async function tx(db, fn) {
  await db.run('BEGIN');
  try {
    const out = await fn();
    await db.run('COMMIT');
    return out;
  } catch (e) {
    try {
      await db.run('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}

module.exports = {
  Mutex,
  ApiError,
  importBatch,
  correctRecord,
  judgeHeterology,
  withdrawBatch,
  publish,
  setCrashBeforeCommit,
  FIELD_PRIORITY,
  FIELDS,
};
