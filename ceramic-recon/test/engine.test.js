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

test('归并说明按成员去向区分扩员/拆分/合并，只列促成归并的匹配边', async () => {
  const { db, mutex } = await freshDb();
  // 先 AB 同组发布，再纳入 C → 扩员（不是拆分）
  await engine.importBatch(db, mutex, {
    batchId: 'bA', source: 'registry',
    records: [{ id: 'A', name: '青釉梅瓶', mark: '甲款', height: 20 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'bB', source: 'repair',
    records: [{ id: 'B', name: '青釉梅缾', mark: '甲款', material: '瓷', height: 20 }],
  });
  await engine.publish(db, mutex); // v1: AB
  await engine.importBatch(db, mutex, {
    batchId: 'bC', source: 'inventory',
    records: [{ id: 'C', name: '青釉梅缾', mark: '甲款', height: 20.4 }],
  });
  await engine.publish(db, mutex); // v2: ABC

  const v2 = await queries.versionDetail(db, 2);
  assert.equal(v2.groups.length, 1);
  assert.equal(v2.groups[0].lineageBasis.kind, 'growth');
  assert.equal(v2.groups[0].lineageBasis.label, '扩员');
  assert.deepEqual(v2.groups[0].lineageBasis.addedMembers, ['inventory|C']);
  assert.deepEqual(v2.groups[0].lineageBasis.departedMembers, []);
  // 三条两两匹配中只有两条真正促成归并；第三条两端已连通，是冗余边
  const contributed = v2.groups[0].lineageBasis.contributingEdges
    .map((e) => [e.k1, e.k2].sort().join('#'))
    .sort();
  assert.deepEqual(contributed, ['inventory|C#repair|B', 'registry|A#repair|B']);
  assert.ok(v2.groups[0].lineageBasis.contributingEdges.every((e) => e.verified));
  // 全量证据里仍保留冗余边，但不计入归并依据
  const v2Evidence = await db.all(
    'select k1, k2, outcome from evidence_events where version = 2 order by event_id'
  );
  assert.equal(v2Evidence.length, 3);
  assert.equal(v2Evidence.filter((e) => e.outcome === 'redundant').length, 1);

  // 判 A 与 C 异件 → ABC 拆成 AB 与 C
  await engine.judgeHeterology(db, mutex, {
    batchId: 'hAC', source1: 'registry', id1: 'A', source2: 'inventory', id2: 'C',
  });
  await engine.publish(db, mutex); // v3
  const v3 = await queries.versionDetail(db, 3);
  const v3Kinds = v3.groups.map((g) => g.lineageBasis.kind);
  assert.deepEqual(v3Kinds, ['split', 'split']);

  // 被剪边标明阻挡它的判异批次：C#B 不是直接判异对，而是被 hAC 间接挡下
  assert.equal(v3.cutEdges.length, 2);
  const indirect = v3.cutEdges.find(
    (e) => [e.k1, e.k2].sort().join('#') === 'inventory|C#repair|B'
  );
  assert.deepEqual(indirect.blockedByBatchIds, ['hAC']);
  assert.deepEqual(indirect.blockedBy, [
    { batchId: 'hAC', k1: 'inventory|C', k2: 'registry|A' },
  ]);
  assert.equal(indirect.evidenceIncomplete, false);
  assert.match(indirect.reason, /hAC/);
  const direct = v3.cutEdges.find(
    (e) => [e.k1, e.k2].sort().join('#') === 'inventory|C#registry|A'
  );
  assert.deepEqual(direct.blockedByBatchIds, ['hAC']);

  // 撤回判异 → AB 与 C 合并回 ABC，说明为“合并”
  await engine.withdrawBatch(db, mutex, { batchId: 'hAC' });
  await engine.publish(db, mutex); // v4
  const v4 = await queries.versionDetail(db, 4);
  assert.equal(v4.groups[0].lineageBasis.kind, 'merge');
  assert.equal(v4.groups[0].lineageBasis.predecessors.length, 2);
  assert.equal(v4.groups[0].lineageBasis.contributingEdges.length, 2);
  assert.equal(v4.cutEdges.length, 0);

  // 撤回判异后，旧版（v3）说明仍按发布时的依据展示
  const v3again = await queries.versionDetail(db, 3);
  assert.deepEqual(
    v3again.groups.map((g) => g.lineageBasis.kind),
    ['split', 'split']
  );
  assert.equal(v3again.cutEdges.length, 2);
  assert.ok(v3again.cutEdges.every((e) => e.blockedByBatchIds.includes('hAC')));
});

test('旧库证据不足的剪边与归并条目单独标出', async () => {
  // 模拟早期库：evidence_events 无 blocked_by 列，历史行补列后为 NULL
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceramic-legacy-'));
  const file = path.join(dir, 'legacy.duckdb');
  const { default: duckdb } = await import('duckdb');
  const raw = new duckdb.Database(file);
  const run = (sql) =>
    new Promise((resolve, reject) => raw.run(sql, (e) => (e ? reject(e) : resolve())));
  await run(
    `create table evidence_events(
       event_id bigint, version integer, k1 varchar, k2 varchar,
       confidence double, evidence varchar, outcome varchar)`
  );
  await new Promise((r) => raw.close(r));

  const db = openDatabase(file);
  await initDatabase(db); // 迁移补列
  await db.run(
    "insert into publications(version, created_at, reason, stats) values(1, 1, '旧库发布', '{}')"
  );
  await db.run(
    `insert into group_events(version, gid, op, fields, members) values
     (1, 'G000001', 'open', '{"fields":{},"fieldSources":{}}', '["registry|A","repair|B"]')`
  );
  await db.run(
    `insert into evidence_events(event_id, version, k1, k2, confidence, evidence, outcome) values
     (1, 1, 'registry|A', 'repair|B', 0.9, '{}', 'joined'),
     (2, 1, 'inventory|C', 'repair|B', 0.8, '{}', 'cut')`
  );

  const detail = await queries.versionDetail(db, 1);
  assert.equal(detail.evidenceIncomplete, true);
  // 旧库 joined 行无法确认是否冗余，条目保留但标注未核实
  assert.equal(detail.groups[0].lineageBasis.contributingEdges.length, 1);
  assert.equal(detail.groups[0].lineageBasis.contributingEdges[0].verified, false);
  assert.equal(detail.groups[0].lineageBasis.evidenceIncomplete, true);
  // 剪边缺判异批次 → 单列标出，不臆造阻挡批次
  assert.equal(detail.cutEdges.length, 1);
  assert.equal(detail.cutEdges[0].evidenceIncomplete, true);
  assert.deepEqual(detail.cutEdges[0].blockedBy, []);
  assert.deepEqual(detail.cutEdges[0].blockedByBatchIds, []);
  assert.match(detail.cutEdges[0].reason, /旧库证据不足/);
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
