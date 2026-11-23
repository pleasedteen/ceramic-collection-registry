'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase, initDatabase, keyOf } = require('../src/db');
const engine = require('../src/engine');
const queries = require('../src/queries');

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceramic-'));
  const db = openDatabase(path.join(dir, 't.duckdb'));
  await initDatabase(db);
  return { db, mutex: new engine.Mutex(), dir };
}

async function seedBaseline(db, mutex) {
  await engine.importBatch(db, mutex, {
    batchId: 'bA', source: 'registry',
    records: [{ id: 'A', name: '青釉梅瓶', mark: '甲款', height: 20 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'bB', source: 'repair',
    records: [{ id: 'B', name: '青釉梅缾', mark: '甲款', material: '瓷', height: 20 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'bC', source: 'inventory',
    records: [{ id: 'C', name: '青釉梅缾', mark: '甲款', height: 20.4 }],
  });
  await engine.publish(db, mutex);
}

async function groupMap(db) {
  const r = await queries.listGroups(db);
  const m = new Map();
  for (const g of r.groups) m.set(g.members.slice().sort().join(','), g);
  return m;
}

test('固定基准：同组→判异拆分→更正→撤回更正→撤回判异', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);

  let gm = await groupMap(db);
  assert.deepEqual([...gm.keys()], ['inventory|C,registry|A,repair|B']);
  let g = [...gm.values()][0];
  assert.equal(g.fields.name, '青釉梅瓶');
  assert.equal(g.fieldSources.name, 'registry'); // 品名优先登记
  assert.equal(g.fields.material, '瓷');
  assert.equal(g.fieldSources.material, 'repair'); // 材质优先修复
  const gidAll = g.gid;

  // 判 A 与 C 异件 → AB 与 C
  await engine.judgeHeterology(db, mutex, {
    batchId: 'hAC', source1: 'registry', id1: 'A', source2: 'inventory', id2: 'C',
  });
  await engine.publish(db, mutex);
  gm = await groupMap(db);
  assert.deepEqual([...gm.keys()].sort(), ['inventory|C', 'registry|A,repair|B']);
  const abGid = gm.get('registry|A,repair|B').gid;
  const cGid = gm.get('inventory|C').gid;

  // 更正 B 为完全不同器物；更正 C 材质为陶（其余字段继承）
  await engine.correctRecord(db, mutex, {
    batchId: 'cB', source: 'repair', id: 'B',
    fields: { name: '黑釉茶盏', mark: '乙款', material: '炻器', height: 8 },
  });
  await engine.correctRecord(db, mutex, {
    batchId: 'cC', source: 'inventory', id: 'C', fields: { material: '陶' },
  });
  await engine.publish(db, mutex);
  gm = await groupMap(db);
  assert.deepEqual([...gm.keys()].sort(), ['inventory|C', 'registry|A', 'repair|B']);
  // C 仅改材质，品名/刻款/高度仍在
  const c = gm.get('inventory|C');
  assert.equal(c.fields.material, '陶');
  assert.equal(c.fields.name, '青釉梅缾');
  assert.equal(c.fields.mark, '甲款');
  assert.equal(c.fields.height, 20.4);

  // 撤回 B 的更正 → 恢复 AB 与 C；AB 材质瓷，C 仍陶
  await engine.withdrawBatch(db, mutex, { batchId: 'cB' });
  await engine.publish(db, mutex);
  gm = await groupMap(db);
  assert.deepEqual([...gm.keys()].sort(), ['inventory|C', 'registry|A,repair|B']);
  assert.equal(gm.get('inventory|C').fields.material, '陶');
  assert.equal(gm.get('registry|A,repair|B').fields.material, '瓷');
  // 成员未变的 C 馆藏沿用编号
  assert.equal(gm.get('inventory|C').gid, cGid);

  // 撤回异件判定 → 三条重新同组
  await engine.withdrawBatch(db, mutex, { batchId: 'hAC' });
  await engine.publish(db, mutex);
  gm = await groupMap(db);
  assert.deepEqual([...gm.keys()], ['inventory|C,registry|A,repair|B']);
});

test('整条更正只采用未撤回的最新版本', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  await engine.correctRecord(db, mutex, {
    batchId: 'x1', source: 'registry', id: 'A', fields: { name: '改名一' },
  });
  await engine.correctRecord(db, mutex, {
    batchId: 'x2', source: 'registry', id: 'A', fields: { name: '改名二' },
  });
  await engine.publish(db, mutex);
  let rec = await queries.getRecord(db, 'registry', 'A');
  assert.equal(rec.record.name, '改名二');
  await engine.withdrawBatch(db, mutex, { batchId: 'x2' });
  await engine.publish(db, mutex);
  rec = await queries.getRecord(db, 'registry', 'A');
  assert.equal(rec.record.name, '改名一');
});

test('异件判定必须分属不同来源（馆藏）', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  await engine.importBatch(db, mutex, {
    batchId: 'r2', source: 'registry',
    records: [{ id: 'Z', name: '另一登记', mark: '甲款', height: 5 }],
  });
  await assert.rejects(
    () =>
      engine.judgeHeterology(db, mutex, {
        batchId: 'bad', source1: 'registry', id1: 'A', source2: 'registry', id2: 'Z',
      }),
    /不同馆藏/
  );
});

test('撤回导入批次后该记录标记为 withdrawn，其余提交继续参与', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  await engine.withdrawBatch(db, mutex, { batchId: 'bC' });
  await engine.publish(db, mutex);
  const gm = await groupMap(db);
  assert.deepEqual([...gm.keys()], ['registry|A,repair|B']);
  const rec = await queries.getRecord(db, 'inventory', 'C');
  assert.equal(rec.status, 'withdrawn');
});

test('字段出处：空值让位给有效值', async () => {
  const { db, mutex } = await freshDb();
  await engine.importBatch(db, mutex, {
    batchId: 'r1', source: 'registry',
    records: [{ id: 'X', name: '只登记有品名', mark: null, height: null }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'p1', source: 'repair',
    records: [{ id: 'Y', name: '只登记有品名', mark: '甲款', material: '瓷', height: 12 }],
  });
  await engine.publish(db, mutex);
  const gm = await groupMap(db);
  const g = [...gm.values()][0];
  assert.equal(g.fields.name, '只登记有品名');
  assert.equal(g.fieldSources.name, 'registry');
  assert.equal(g.fields.mark, '甲款');
  assert.equal(g.fieldSources.mark, 'repair'); // 登记刻款为空，让位修复记录
  assert.equal(g.fields.material, '瓷');
  assert.equal(g.fieldSources.material, 'repair');
});

test('审计：版本详情含合并/拆分依据，旧馆藏可逐条追查', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  const before = (await queries.listGroups(db)).groups[0];
  await engine.judgeHeterology(db, mutex, {
    batchId: 'hAC', source1: 'registry', id1: 'A', source2: 'inventory', id2: 'C',
  });
  await engine.publish(db, mutex);
  const detail = await queries.versionDetail(db, 2);
  const kinds = detail.groups.map((g) => g.lineageBasis.kind);
  assert.ok(kinds.includes('split'));

  const trace = await queries.traceGroup(db, before.gid, 1);
  assert.equal(trace.members.length, 3);
  const aTrace = trace.members.find((m) => m.key === keyOf('registry', 'A'));
  assert.equal(aTrace.current.state, 'active');
  assert.ok(aTrace.chain.some((c) => c.gid));
});

// ---- 合并/拆分按成员去向统计 ----
test('合并/拆分统计：扩员不计拆分，交叉重组同时计入两类', async () => {
  const { db, mutex } = await freshDb();
  // v1：X1/X2 同组，Y 单独
  await engine.importBatch(db, mutex, {
    batchId: 'e-x1', source: 'registry',
    records: [{ id: 'X1', name: '青铜鼎', mark: '子款', height: 30 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'e-x2', source: 'repair',
    records: [{ id: 'X2', name: '青铜鼎', mark: '子款', height: 30 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'e-y', source: 'inventory',
    records: [{ id: 'Y', name: '白玉璧', mark: '丑款', height: 10 }],
  });
  await engine.publish(db, mutex);
  let groups = (await queries.listGroups(db)).groups;
  const yGroup = groups.find((g) => g.members.includes('inventory|Y'));

  // v2：新增 Z（与 X 同品名刻款但不同来源），X 组扩员 —— 不是拆分
  await engine.importBatch(db, mutex, {
    batchId: 'e-z', source: 'inventory',
    records: [{ id: 'Z', name: '青铜鼎', mark: '子款', height: 30 }],
  });
  await engine.publish(db, mutex);
  let d = await queries.versionDetail(db, 2);
  assert.equal(d.mergeSplit.splitCount, 0, '仅扩员不算拆分');
  assert.equal(d.mergeSplit.mergeCount, 0, '整组吸收全新记录不是多旧组汇合');
  const xSucc = d.groups.find((g) => g.members.includes('registry|X1'));
  assert.equal(xSucc.lineageBasis.kind, 'expanded');
  assert.equal(xSucc.lineageBasis.predecessors.length, 1, '扩员仅来自一个旧馆藏');
  const xGidV2 = xSucc.gid;

  // v3：Y 更正为与 X 相同刻款与高度、相近品名 → Y 的旧馆藏并入，X 组由 2 个旧馆藏汇合（合并）
  await engine.correctRecord(db, mutex, {
    batchId: 'e-y2', source: 'inventory', id: 'Y',
    fields: { name: '青铜鼎', mark: '子款', height: 30 },
  });
  await engine.publish(db, mutex);
  d = await queries.versionDetail(db, 3);
  assert.equal(d.mergeSplit.mergeCount, 1, 'X 组与 Y 组合并为一个新馆藏');
  assert.equal(d.mergeSplit.splitCount, 0, '旧的 X 组自身未分裂');
  const mergedContrib = d.mergeSplit.merges[0].contributors.map((c) => c.gid).sort();
  assert.deepEqual(mergedContrib, [yGroup.gid, xGidV2].sort());
});

test('拆分统计：仅撤回成员不算拆分（幸存成员仍聚在一处）', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex); // A/B/C 同组
  await engine.withdrawBatch(db, mutex, { batchId: 'bC' });
  await engine.publish(db, mutex);
  const d = await queries.versionDetail(db, 2);
  assert.equal(d.mergeSplit.splitCount, 0, '撤回一个成员后幸存者仍同组，不算拆分');
  const g = d.groups[0];
  assert.equal(g.lineageBasis.kind, 'contracted');
});

test('交叉重组：旧馆藏分裂的同时又汇入新馆藏，可同时计入合并与拆分', async () => {
  const { db, mutex } = await freshDb();
  // v1：P1/P2 同组，Q1/Q2 同组
  await engine.importBatch(db, mutex, {
    batchId: 'x-p1', source: 'registry',
    records: [{ id: 'P1', name: '粉彩盘', mark: '寅款', height: 5 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'x-p2', source: 'repair',
    records: [{ id: 'P2', name: '粉彩盘', mark: '寅款', height: 5 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'x-q1', source: 'inventory',
    records: [{ id: 'Q1', name: '五彩盘', mark: '卯款', height: 5 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'x-q2', source: 'inventory',
    records: [{ id: 'Q2', name: '五彩盘', mark: '卯款', height: 5 }],
  });
  // Q2 须来自不同来源以形成 Q 组内的跨来源匹配
  await engine.importBatch(db, mutex, {
    batchId: 'x-q2b', source: 'registry',
    records: [{ id: 'Q2b', name: '五彩盘', mark: '卯款', height: 5 }],
  });
  await engine.publish(db, mutex);
  let groups = (await queries.listGroups(db)).groups;
  const pGroupV1 = groups.find((g) => g.members.includes('registry|P1'));

  // v2：把 P2 改成与 Q 组匹配（并入 Q），同时 P1 保留 → P 组被拆成两处，
  // 且 Q 组由 Q 旧成员 + P2 两处旧馆藏汇合，交叉重组同时计入合并与拆分。
  await engine.correctRecord(db, mutex, {
    batchId: 'x-p2b', source: 'repair', id: 'P2',
    fields: { name: '五彩盘', mark: '卯款', height: 5 },
  });
  await engine.publish(db, mutex);
  const d = await queries.versionDetail(db, 2);
  assert.ok(d.mergeSplit.mergeCount >= 1, '至少有新馆藏由两个旧馆藏汇合');
  assert.ok(d.mergeSplit.splitCount >= 1, '至少有旧馆藏被拆往两处');
  const pSplit = d.mergeSplit.splits.find((s) => s.gid === pGroupV1.gid);
  assert.ok(pSplit, 'P 旧馆藏被拆分');
  assert.equal(pSplit.destinations.length, 2, 'P 组幸存成员流向两处');
});

test('边缘裁决：区分实际连通/冗余匹配/被异件拦下的边并标注批次', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  // A/B/C 三边两两匹配：先连通一边，另一边成环即冗余；判异后异件对直接剪开
  await engine.judgeHeterology(db, mutex, {
    batchId: 'hAC', source1: 'registry', id1: 'A', source2: 'inventory', id2: 'C',
  });
  await engine.publish(db, mutex);
  const d = await queries.versionDetail(db, 2);
  assert.ok(d.edges.connected.length >= 1, '至少一条边实际连通');
  assert.equal(d.edges.unknown.length, 0, '新库逐边裁决完整');
  const directCut = d.edges.cut.find(
    (e) => [e.k1, e.k2].sort().join('#') === 'inventory|C#registry|A'
  );
  assert.ok(directCut, 'A-C 是有效异件对');
  assert.equal(directCut.blockedByBatch, 'hAC');
  // C-B 也会被拦（合并会使 C 与 A 同组），同样标注异件批次
  const indirectCut = d.edges.cut.find(
    (e) => [e.k1, e.k2].sort().join('#') === 'inventory|C#repair|B'
  );
  assert.ok(indirectCut);
  assert.equal(indirectCut.blockedByBatch, 'hAC');
  assert.deepEqual(d.heterology, [
    { k1: 'inventory|C', k2: 'registry|A', batch_id: 'hAC' },
  ]);
  assert.equal(d.audit.complete, true);
  assert.deepEqual(d.audit.missing, []);

  // 独立复算：只读 edgeOrder，逐边并查集（connected 合并，其余不合并）即可重现归组
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of d.edgeOrder) {
    find(e.k1);
    find(e.k2);
    if (e.outcome === 'connected') union(e.k1, e.k2);
  }
  const recomputed = new Map();
  for (const e of d.edgeOrder) {
    for (const k of [e.k1, e.k2]) {
      const r = find(k);
      if (!recomputed.has(r)) recomputed.set(r, new Set());
      recomputed.get(r).add(k);
    }
  }
  const recomputedSets = [...recomputed.values()].map((s) => [...s].sort().join(',')).sort();
  const actualSets = d.groups.map((g) => g.members.join(',')).sort();
  assert.deepEqual(recomputedSets, actualSets, '仅凭 edgeOrder 可独立复算归组');
});

test('冗余匹配：三角全连通时成环的边记为 redundant 而非 connected', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  // 三条边置信度相同，按固定同分规则排序；只有两条真正连通，第三条成环
  await engine.correctRecord(db, mutex, {
    batchId: 'noop', source: 'registry', id: 'A', fields: { name: '青釉梅瓶' },
  });
  await engine.publish(db, mutex);
  const d = await queries.versionDetail(db, 2);
  assert.equal(d.edges.connected.length, 2, '3 个节点需 2 条边连通');
  assert.equal(d.edges.redundant.length, 1, '第三条边成环，属冗余匹配');
  assert.equal(d.edges.cut.length, 0);
});

test('撤回判异后，旧版本的统计与裁决依据仍可复核', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  await engine.judgeHeterology(db, mutex, {
    batchId: 'hAC', source1: 'registry', id1: 'A', source2: 'inventory', id2: 'C',
  });
  await engine.publish(db, mutex);
  const before = await queries.versionDetail(db, 2);
  assert.ok(before.edges.cut.every((e) => e.blockedByBatch === 'hAC'));
  assert.ok(before.heterology.length === 1);

  // 撤回判异并发布新版本
  await engine.withdrawBatch(db, mutex, { batchId: 'hAC' });
  await engine.publish(db, mutex);
  // 旧版本 v2 的裁决依据与统计不受撤回影响
  const after = await queries.versionDetail(db, 2);
  assert.equal(after.mergeSplit.splitCount, before.mergeSplit.splitCount);
  assert.deepEqual(
    after.edges.cut.map((e) => [e.k1, e.k2, e.blockedByBatch]),
    before.edges.cut.map((e) => [e.k1, e.k2, e.blockedByBatch])
  );
  assert.deepEqual(after.heterology, before.heterology);
  // 新版本不再有异件约束
  const latest = await queries.versionDetail(db, 3);
  assert.equal(latest.heterology.length, 0);
  assert.equal(latest.edges.cut.length, 0);
});

test('同一数据库重开库后，旧版本统计与裁决依据仍可复核', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  await engine.judgeHeterology(db, mutex, {
    batchId: 'hAC', source1: 'registry', id1: 'A', source2: 'inventory', id2: 'C',
  });
  await engine.publish(db, mutex);
  const before = await queries.versionDetail(db, 2);
  const file = db.file;
  await new Promise((resolve) => db.raw.close(resolve));
  const reopened = openDatabase(file);
  await initDatabase(reopened);
  const after = await queries.versionDetail(reopened, 2);
  assert.deepEqual(after.mergeSplit, before.mergeSplit);
  assert.deepEqual(after.heterology, before.heterology);
  assert.deepEqual(after.audit, before.audit);
  assert.deepEqual(
    after.edges.cut.map((e) => [e.k1, e.k2, e.blockedByBatch]),
    before.edges.cut.map((e) => [e.k1, e.k2, e.blockedByBatch])
  );
});

test('无关馆藏增加时，同一小批发布的审计增量保持不变', async () => {
  async function applyOneAdjust(db, mutex, tag) {
    const start = (await queries.latestVersion(db)).version;
    await engine.correctRecord(db, mutex, {
      batchId: `${tag}-corr`, source: 'repair', id: 'B',
      fields: { name: `微调${tag}`, mark: '乙款', material: '炻器', height: 8 },
    });
    await engine.publish(db, mutex);
    const log = (await queries.workloadLog(db)).find((r) => r.version === start + 1);
    return {
      reads: log.source_records_read,
      comparisons: log.comparisons,
      newGroups: log.new_group_rows,
      auditRows: log.audit_rows,
    };
  }

  // 干净库
  const clean = await freshDb();
  await seedBaseline(clean.db, clean.mutex);
  const cleanRes = await applyOneAdjust(clean.db, clean.mutex, 'clean');

  // 大库：同一基准 + 大量无关记录（不同分块）
  const big = await freshDb();
  await seedBaseline(big.db, big.mutex);
  const noise = [];
  for (let i = 0; i < 200; i++) {
    noise.push({ id: `noise${i}`, name: `无关陶器${i}`, mark: `杂款${i}`, height: 40 + (i % 10) });
  }
  await engine.importBatch(big.db, big.mutex, {
    batchId: 'noise', source: 'inventory', records: noise,
  });
  await engine.publish(big.db, big.mutex);
  const bigRes = await applyOneAdjust(big.db, big.mutex, 'big');

  assert.ok(cleanRes.auditRows > 0);
  assert.deepEqual(bigRes, cleanRes, '同一小批变更的三项工作量与审计增量不随全库规模增长');
});

test('发布中断（提交前崩溃）回滚，重启后状态一致', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  const before = await queries.listGroups(db);
  engine.setCrashBeforeCommit(true);
  await engine.correctRecord(db, mutex, {
    batchId: 'crash1', source: 'registry', id: 'A', fields: { name: '不应生效' },
  });
  await assert.rejects(() => engine.publish(db, mutex), /CRASH_BEFORE_COMMIT/);
  engine.setCrashBeforeCommit(false);
  // 同一数据库“重启”：重新打开连接
  const file = db.file;
  const db2 = openDatabase(file);
  await initDatabase(db2);
  // 发布事务已整体回滚：版本号与已发布馆藏字段保持崩溃前一致
  const after = await queries.listGroups(db2);
  assert.equal(after.version, before.version);
  const rec = await queries.getRecord(db2, 'registry', 'A');
  // 查询只读到完整发布：已发布馆藏字段仍为旧值（工作区里的更正尚未发布）
  assert.equal(rec.group.fields.name, '青釉梅瓶');
  assert.equal(rec.record.gid, before.groups[0].gid);
  // 待发布的工作区变更仍在，重新发布可正常完成并生效（不会因中断产生脏状态）
  const mutex2 = new engine.Mutex();
  const republish = await engine.publish(db2, mutex2);
  assert.equal(republish.version, before.version + 1);
  const rec2 = await queries.getRecord(db2, 'registry', 'A');
  assert.equal(rec2.group.fields.name, '不应生效');
});

test('同一数据库文件重启后，当前馆藏、版本与审计完全一致', async () => {
  const { db, mutex, dir } = await freshDb();
  await seedBaseline(db, mutex);
  await engine.judgeHeterology(db, mutex, {
    batchId: 'hAC', source1: 'registry', id1: 'A', source2: 'inventory', id2: 'C',
  });
  await engine.publish(db, mutex);
  const before = await queries.listGroups(db);
  const beforeVersions = await queries.listVersions(db);
  const file = db.file;

  // 模拟进程重启：关闭连接，重新打开同一文件
  await new Promise((resolve) => db.raw.close(resolve));
  const reopened = openDatabase(file);
  await initDatabase(reopened);
  const after = await queries.listGroups(reopened);
  assert.equal(after.version, before.version);
  assert.deepEqual(
    after.groups.map((g) => g.members.slice().sort().join(',')).sort(),
    before.groups.map((g) => g.members.slice().sort().join(',')).sort()
  );
  const afterVersions = await queries.listVersions(reopened);
  assert.equal(afterVersions.length, beforeVersions.length);
  // 审计：历史版本仍可回放
  const detail = await queries.versionDetail(reopened, 2);
  assert.ok(detail.groups.some((g) => g.lineageBasis.kind === 'split'));
  // 重启后还能继续增量发布
  const mutex2 = new engine.Mutex();
  await engine.withdrawBatch(reopened, mutex2, { batchId: 'hAC' });
  await engine.publish(reopened, mutex2);
  const merged = await queries.listGroups(reopened);
  assert.equal(merged.groups.length, 1);
});

test('旧库升级：无法可靠还原的裁决依据标明缺失，新发布则完整', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceramic-legacy-'));
  const file = path.join(dir, 'legacy.duckdb');
  // 用旧版 schema 建库（无 audit_complete / heterology_events / 逐边区分列）
  const legacy = openDatabase(file);
  const raw = legacy.raw;
  const run = (sql, params = []) =>
    new Promise((res, rej) =>
      params.length ? raw.run(sql, ...params, (e) => (e ? rej(e) : res())) : raw.run(sql, (e) => (e ? rej(e) : res()))
    );
  await run(`create sequence rv_seq`);
  await run(`create sequence gid_seq`);
  await run(`create table batches(batch_id varchar primary key, kind varchar not null, created_at bigint not null, withdrawn_at bigint, detail varchar not null)`);
  await run(`create table record_versions(rv_id bigint primary key default nextval('rv_seq'), source varchar not null, source_id varchar not null, seq integer not null, batch_id varchar not null, name varchar, mark varchar, material varchar, height double, withdrawn_at bigint, unique(source, source_id, seq))`);
  await run(`create table heterology_edges(batch_id varchar primary key, k1 varchar not null, k2 varchar not null, created_at bigint not null, withdrawn_at bigint)`);
  await run(`create table publications(version integer primary key, created_at bigint not null, reason varchar, stats varchar not null)`);
  await run(`create table group_lineage(gid varchar primary key, born_version integer, closed_version integer)`);
  await run(`create table recompute_log(version integer not null, touched_keys varchar not null, source_records_read integer not null, comparisons integer not null, new_group_rows integer not null, duration_ms integer not null)`);
  await run(`create table outbox(k varchar not null, reason varchar not null)`);
  await run(`create table block_name(nname varchar not null, k varchar not null, primary key(nname, k))`);
  await run(`create table block_mark(nmark varchar not null, k varchar not null, primary key(nmark, k))`);
  await run(`create table live_groups(gid varchar primary key, name varchar, name_src varchar, mark varchar, mark_src varchar, material varchar, material_src varchar, height double, height_src varchar)`);
  await run(`create table live_members(k varchar primary key, gid varchar not null)`);
  await run(`create table group_events(event_id bigint primary key default nextval('rv_seq'), version integer not null, gid varchar not null, op varchar not null, fields varchar, members varchar)`);
  await run(`create table membership_events(event_id bigint primary key default nextval('rv_seq'), version integer not null, k varchar, gid varchar, op varchar not null)`);
  await run(`create table evidence_events(event_id bigint primary key default nextval('rv_seq'), version integer not null, k1 varchar not null, k2 varchar not null, confidence double not null, evidence varchar not null, outcome varchar not null)`);
  // 旧版 v1：三条同组；证据只有 joined（无法区分连通/冗余），且无判异快照
  await run(`insert into publications values (1, 1, 'legacy', '{"groupCount":1}')`);
  await run(`insert into record_versions(source,source_id,seq,batch_id,name,mark,height) values ('registry','A',1,'bA','青釉梅瓶','甲款',20),('repair','B',1,'bB','青釉梅缾','甲款',20),('inventory','C',1,'bC','青釉梅缾','甲款',20.4)`);
  await run(`insert into group_events(version,gid,op,fields,members) values (1,'G000001','open','{}','["inventory|C","registry|A","repair|B"]')`);
  await run(`insert into live_groups(gid,name) values ('G000001','青釉梅瓶')`);
  await run(`insert into live_members values ('registry|A','G000001'),('repair|B','G000001'),('inventory|C','G000001')`);
  await run(`insert into evidence_events(version,k1,k2,confidence,evidence,outcome) values (1,'registry|A','repair|B',1,'{"name":1}','joined')`);
  await new Promise((r) => raw.close(r));

  // 用当前代码打开旧库：迁移补齐新增列/表
  const db = openDatabase(file);
  await initDatabase(db);
  const d1 = await queries.versionDetail(db, 1);
  assert.equal(d1.audit.complete, false, '旧版本标记为依据不完整');
  assert.equal(d1.audit.edgeDispositionComplete, false);
  assert.equal(d1.audit.heterologyBasisComplete, false);
  assert.ok(d1.audit.missing.some((m) => m.startsWith('edgeDisposition')));
  assert.ok(d1.audit.missing.some((m) => m.startsWith('heterologyBasis')));
  // 旧证据无法区分连通/冗余，归入 unknown 并保留原始 outcome
  assert.equal(d1.edges.unknown.length, 1);
  assert.equal(d1.edges.unknown[0].legacyOutcome, 'joined');
  assert.equal(d1.edges.connected.length, 0, '不臆造旧库边分类');

  // 在升级后的库继续发布：新版本依据完整
  const mutex = new engine.Mutex();
  await engine.correctRecord(db, mutex, {
    batchId: 'u1', source: 'repair', id: 'B', fields: { name: '黑釉茶盏', mark: '乙款', material: '炻器', height: 8 },
  });
  const pub = await engine.publish(db, mutex);
  const d2 = await queries.versionDetail(db, pub.version);
  assert.equal(d2.audit.complete, true);
  assert.deepEqual(d2.audit.missing, []);
  assert.equal(d2.edges.unknown.length, 0);
});
