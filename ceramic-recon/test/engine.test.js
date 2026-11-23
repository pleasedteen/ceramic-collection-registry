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

// ---------------- 证据历史与单馆藏复核 ----------------

test('单馆藏复核：直接与间接阻断都能看到被拒匹配边及当时的判异批次', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  await engine.judgeHeterology(db, mutex, {
    batchId: 'hAC', source1: 'registry', id1: 'A', source2: 'inventory', id2: 'C',
  });
  await engine.publish(db, mutex);

  const groups = (await queries.listGroups(db)).groups;
  const cg = groups.find((g) => g.members.join(',') === 'inventory|C');
  const detail = await queries.getGroup(db, cg.gid);

  // 与 C 相接的两条被拒匹配边：A-C 直判异，B-C 间接阻断
  const byPair = new Map(detail.group.rejectedEdges.map((e) => [`${e.k1}#${e.k2}`, e]));
  const direct = byPair.get('inventory|C#registry|A');
  const indirect = byPair.get('inventory|C#repair|B');
  assert.ok(direct, '应包含 C-A 直判异边');
  assert.ok(indirect, '应包含 C-B 间接阻断边');
  assert.equal(direct.blockKind, 'direct');
  assert.equal(indirect.blockKind, 'indirect');
  // 两条边都被判异批次 hAC 阻断（间接边的阻断来源是可核查的具体对）
  assert.deepEqual(direct.blockedByBatches, ['hAC']);
  assert.deepEqual(indirect.blockedByBatches, ['hAC']);
  assert.equal(indirect.blockedBy.pairs.length, 1);
  assert.equal(indirect.blockedBy.pairs[0].k1, 'inventory|C');
  assert.equal(indirect.blockedBy.pairs[0].k2, 'registry|A');

  // 促成归并的边属于 AB 馆藏，不属于 C 馆藏
  assert.equal(detail.group.contributingEdges.length, 0);
  const ab = groups.find((g) => g.members.join(',') === 'registry|A,repair|B');
  const abDetail = await queries.getGroup(db, ab.gid);
  assert.deepEqual(
    abDetail.group.contributingEdges.map((e) => `${e.k1}#${e.k2}`),
    ['registry|A#repair|B']
  );
  // 同一版本的版本详情也给出同样的阻断解释
  const vd = await queries.versionDetail(db, 2);
  const cut = vd.cutEdges.find((e) => e.k1 === 'inventory|C' && e.k2 === 'repair|B');
  assert.equal(cut.blockKind, 'indirect');
  assert.deepEqual(cut.blockedByBatches, ['hAC']);
});

test('撤回判异后重新归并，各版解释按当时结果显示且编号沿用', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  const v1Group = (await queries.listGroups(db)).groups[0];
  await engine.judgeHeterology(db, mutex, {
    batchId: 'hAC', source1: 'registry', id1: 'A', source2: 'inventory', id2: 'C',
  });
  await engine.publish(db, mutex);
  await engine.withdrawBatch(db, mutex, { batchId: 'hAC' });
  await engine.publish(db, mutex);

  // v2 拆分：C 独立，AB 同组；v3 判异撤回：三条重新同组
  const v2 = await queries.versionDetail(db, 2);
  assert.ok(v2.groups.some((g) => g.lineageBasis.kind === 'split'));
  assert.ok(v2.cutEdges.some((e) => e.blockKind === 'direct'));

  const v3 = await queries.versionDetail(db, 3);
  const merged = v3.groups.find((g) => g.members.length === 3);
  assert.ok(merged, 'v3 应重新归并为一个馆藏');
  assert.equal(v3.cutEdges.length, 0, 'v3 撤回判异后不应再有被拒边');
  // v1/v3 成员相同但并不相邻：v3 解释按当时结果显示为重新归并（merge），且三条边均促成
  assert.equal(merged.lineageBasis.kind, 'merge');
  // 三条边中两条真正促成归并，第三条因两端已连通而不计为促成边
  assert.equal(merged.contributingEdges.length, 2);
  assert.equal(merged.contributingEdges.length + 1, v1Group.members.length);

  // 历史版 v2 的解释仍显示当时的直判异
  const v2GroupAgain = await queries.versionDetail(db, 2);
  assert.ok(v2GroupAgain.cutEdges.every((e) => e.blockedByBatches.includes('hAC')));
  // v1 的馆藏仍可查询
  const trace = await queries.traceGroup(db, v1Group.gid, 1);
  assert.equal(trace.members.length, 3);
  assert.equal(trace.explanation.evidenceStatus.complete, true);
});

test('新增证据历史按发生变化的边计，且单馆藏复核读取量不随无关发布增长', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  const gid = (await queries.listGroups(db)).groups[0].gid;
  const before = await queries.getGroup(db, gid);
  assert.deepEqual(
    before.group.contributingEdges.map((e) => `${e.k1}#${e.k2}`),
    ['inventory|C#repair|B', 'registry|A#repair|B']
  );

  // 与基准无关的 10 次发布
  const sources = ['registry', 'repair', 'inventory'];
  for (let i = 0; i < 10; i++) {
    await engine.importBatch(db, mutex, {
      batchId: `noise-${i}`,
      source: sources[i % 3],
      records: [{ id: `N${i}`, name: `无关器物${i}`, mark: `杂款${i}`, height: 40 + i }],
    });
    await engine.publish(db, mutex);
  }
  const after = await queries.getGroup(db, gid);
  // 读取量（历史行数与边数）不随无关发布增长
  assert.equal(after.evidenceRead.historyRowsRead, before.evidenceRead.historyRowsRead);
  assert.equal(after.evidenceRead.edgesExamined, before.evidenceRead.edgesExamined);
  // 无关发布不追加该馆藏相关的证据事件（新增证据历史按发生变化的边计）
  const log = await queries.workloadLog(db);
  const later = log.filter((r) => r.version > before.version - 1);
  assert.ok(later.every((r) => r.evidence_changes === 0 || r.version === 1));
  // 当前解释仍与 v1 一致
  assert.deepEqual(
    after.group.contributingEdges.map((e) => `${e.k1}#${e.k2}`),
    before.group.contributingEdges.map((e) => `${e.k1}#${e.k2}`)
  );
});

test('发布中断重启后解释一致，重新发布成功后才可查到新版解释', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  await engine.judgeHeterology(db, mutex, {
    batchId: 'hAC', source1: 'registry', id1: 'A', source2: 'inventory', id2: 'C',
  });
  await engine.publish(db, mutex);
  const cg = (await queries.listGroups(db)).groups.find(
    (g) => g.members.join(',') === 'inventory|C'
  );
  const beforeDetail = await queries.getGroup(db, cg.gid);
  const beforeVersions = await queries.listVersions(db);

  // 撤回判异后发布前崩溃
  engine.setCrashBeforeCommit(true);
  await engine.withdrawBatch(db, mutex, { batchId: 'hAC' });
  await assert.rejects(() => engine.publish(db, mutex), /CRASH_BEFORE_COMMIT/);
  engine.setCrashBeforeCommit(false);

  // 同一库重启
  const file = db.file;
  await new Promise((resolve) => db.raw.close(resolve));
  const db2 = openDatabase(file);
  await initDatabase(db2);

  // 崩溃的发布整体回滚：版本与解释保持崩溃前
  assert.deepEqual((await queries.listVersions(db2)).map((v) => v.version),
    beforeVersions.map((v) => v.version));
  const afterCrashDetail = await queries.getGroup(db2, cg.gid);
  assert.equal(afterCrashDetail.version, beforeDetail.version);
  assert.deepEqual(
    afterCrashDetail.group.rejectedEdges.map((e) => `${e.k1}#${e.k2}`),
    beforeDetail.group.rejectedEdges.map((e) => `${e.k1}#${e.k2}`)
  );
  // 崩溃前最新版仍是拆分态
  assert.equal((await queries.listGroups(db2)).groups.length, 2);

  // 重新发布成功后才可查到新版（重新归并）解释
  const mutex2 = new engine.Mutex();
  const republished = await engine.publish(db2, mutex2);
  assert.equal(republished.version, beforeDetail.version + 1);
  const merged = await queries.listGroups(db2);
  assert.equal(merged.groups.length, 1);
  const newDetail = await queries.getGroup(db2, merged.groups[0].gid);
  assert.equal(newDetail.version, republished.version);
  assert.equal(newDetail.group.contributingEdges.length, 2);
  assert.equal(newDetail.group.rejectedEdges.length, 0);
});

test('旧库升级：既有版本标记缺证但仍可查询，新发布带完整证据历史', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceramic-old-'));
  const file = path.join(dir, 'old.duckdb');
  const { openDatabase: open } = require('../src/db');
  const old = open(file);
  // 旧版 schema（证据历史为“每版全量、无 format_version / contributed / block_*”）
  const oldSchema = [
    'create sequence if not exists rv_seq',
    'create sequence if not exists gid_seq',
    `create table batches(batch_id varchar primary key, kind varchar not null, created_at bigint not null, withdrawn_at bigint, detail varchar not null)`,
    `create table record_versions(rv_id bigint primary key default nextval('rv_seq'), source varchar not null, source_id varchar not null, seq integer not null, batch_id varchar not null, name varchar, mark varchar, material varchar, height double, withdrawn_at bigint, unique(source, source_id, seq))`,
    `create table heterology_edges(batch_id varchar primary key, k1 varchar not null, k2 varchar not null, created_at bigint not null, withdrawn_at bigint)`,
    `create table publications(version integer primary key, created_at bigint not null, reason varchar, stats varchar not null)`,
    `create table group_lineage(gid varchar primary key, born_version integer, closed_version integer)`,
    `create table recompute_log(version integer not null, touched_keys varchar not null, source_records_read integer not null, comparisons integer not null, new_group_rows integer not null, duration_ms integer not null)`,
    `create table outbox(k varchar not null, reason varchar not null)`,
    `create table block_name(nname varchar not null, k varchar not null, primary key(nname, k))`,
    `create table block_mark(nmark varchar not null, k varchar not null, primary key(nmark, k))`,
    `create table live_groups(gid varchar primary key, name varchar, name_src varchar, mark varchar, mark_src varchar, material varchar, material_src varchar, height double, height_src varchar)`,
    `create table live_members(k varchar primary key, gid varchar not null)`,
    `create table group_events(event_id bigint primary key default nextval('rv_seq'), version integer not null, gid varchar not null, op varchar not null, fields varchar, members varchar)`,
    `create table membership_events(event_id bigint primary key default nextval('rv_seq'), version integer not null, k varchar not null, gid varchar, op varchar not null)`,
    `create table evidence_events(event_id bigint primary key default nextval('rv_seq'), version integer not null, k1 varchar not null, k2 varchar not null, confidence double not null, evidence varchar not null, outcome varchar not null)`,
  ];
  for (const s of oldSchema) await old.run(s);
  // 旧库已发布的一版：A、B 同组，A-C 无有效证据（当时未记录）
  const fields = JSON.stringify({
    fields: { name: '青釉梅瓶', mark: null, material: null, height: 20 },
    fieldSources: { name: 'registry', mark: null, material: null, height: 'registry' },
  });
  await old.run(
    `insert into group_events(version, gid, op, fields, members) values(1, 'G000001', 'open', ?, ?)`,
    [fields, JSON.stringify(['registry|A', 'repair|B'])]
  );
  await old.run(
    `insert into membership_events(version, k, gid, op) values
       (1, 'registry|A', 'G000001', 'join'), (1, 'repair|B', 'G000001', 'join')`
  );
  await old.run(
    `insert into evidence_events(version, k1, k2, confidence, evidence, outcome)
     values(1, 'registry|A', 'repair|B', 1.0, ?, 'joined')`,
    [JSON.stringify({ name: 1, mark: 1, height: 1 })]
  );
  await old.run(
    `insert into publications(version, created_at, reason, stats) values(1, 1, '旧库发布', ?)`,
    [JSON.stringify({ sourceRecordsRead: 2, comparisons: 1, newGroupRows: 1 })]
  );
  await old.run(
    `insert into recompute_log values(1, '[]', 2, 1, 1, 1)`
  );
  await old.run(`insert into live_groups values('G000001','青釉梅瓶','registry',null,null,null,null,20,'registry')`);
  await old.run(`insert into live_members values('registry|A','G000001'),('repair|B','G000001')`);
  // 旧库的有效来源记录与分块索引（A、B）
  await old.run(
    `insert into record_versions(source, source_id, seq, batch_id, name, mark, material, height)
     values ('registry','A',1,'old-import','青釉梅瓶',null,null,20),
            ('repair','B',1,'old-import','青釉梅缾',null,null,20)`
  );
  await old.run(`insert into block_name(nname, k) values ('青釉梅瓶','registry|A'),('青釉梅瓶','repair|B')`);
  // 旧库以新代码打开并初始化（迁移）；先关闭旧连接再重开同一文件
  await new Promise((resolve) => old.raw.close(resolve));
  const db = open(file);
  await initDatabase(db);

  // 旧版本仍可查询
  const versions = await queries.listVersions(db);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].evidenceComplete, false);

  const detail = await queries.getGroup(db, 'G000001');
  assert.ok(detail, '旧库馆藏仍可查询');
  assert.equal(detail.version, 1);
  assert.equal(detail.group.members.length, 2);
  // 升级前无法证实的部分标明缺证
  assert.equal(detail.group.evidenceStatus.complete, false);
  assert.ok(detail.group.evidenceStatus.reasons.length > 0);
  const vd = await queries.versionDetail(db, 1);
  assert.equal(vd.formatVersion, 1);
  assert.equal(vd.evidenceStatus.complete, false);

  // 新发布使用完整证据历史，缺证标记不再出现
  const mutex = new engine.Mutex();
  await engine.importBatch(db, mutex, {
    batchId: 'rC', source: 'inventory',
    records: [{ id: 'C', name: '青釉梅瓶', mark: null, height: 20 }],
  });
  await engine.publish(db, mutex, { reason: '升级后发布' });
  const merged = (await queries.listGroups(db)).groups.find((g) => g.members.length === 3);
  assert.ok(merged, 'A/B/C 应同组');
  const upgraded = await queries.getGroup(db, merged.gid);
  assert.equal(upgraded.group.evidenceStatus.complete, true);
  assert.ok(upgraded.group.contributingEdges.length >= 1);
});

test('字段沿用的馆藏字段变化时，各版字段与出处按当时结果回放', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  const before = (await queries.listGroups(db)).groups[0];
  // 仅更正 A 的刻款，成员不变 → 沿用编号，字段应随版本变化
  await engine.correctRecord(db, mutex, {
    batchId: 'cA', source: 'registry', id: 'A', fields: { mark: '新刻款' },
  });
  await engine.publish(db, mutex);
  const after = (await queries.listGroups(db)).groups[0];
  assert.equal(after.gid, before.gid, '成员未变应沿用编号');

  const v1 = await queries.versionDetail(db, 1);
  const v2 = await queries.versionDetail(db, 2);
  assert.equal(v1.groups[0].fields.mark, '甲款');
  assert.equal(v2.groups[0].fields.mark, '新刻款');
  assert.equal(v1.groups[0].fieldSources.mark, 'registry');
  // 单馆藏复核同样按版本回放
  const atV1 = await queries.getGroup(db, before.gid, 1);
  assert.equal(atV1.group.fields.mark, '甲款');
  const latest = await queries.getGroup(db, before.gid);
  assert.equal(latest.group.fields.mark, '新刻款');
  // 当前馆藏字段与最新版一致
  assert.equal(after.fields.mark, '新刻款');
});
