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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceramic-pub-'));
  const db = openDatabase(path.join(dir, 'p.duckdb'));
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
  return (await queries.listGroups(db)).groups[0].gid;
}

async function membersOf(db) {
  const r = await queries.listGroups(db);
  return r.groups.map((g) => g.members.slice().sort().join(',')).sort();
}

// ---------------- 未发布的导入 / 更正 / 撤回都不可见 ----------------

test('未发布的更正不会提前出现在来源明细或馆藏字段里', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  await engine.correctRecord(db, mutex, {
    batchId: 'cA', source: 'registry', id: 'A', fields: { name: '未发布改名' },
  });
  // 工作区已变更，但查询只能读到完整发布
  const rec = await queries.getRecord(db, 'registry', 'A');
  assert.equal(rec.record.name, '青釉梅瓶');
  const groups = await queries.listGroups(db);
  assert.equal(groups.version, 1);
  assert.equal(groups.groups[0].fields.name, '青釉梅瓶');
  // 发布后才生效
  await engine.publish(db, mutex);
  const after = await queries.getRecord(db, 'registry', 'A');
  assert.equal(after.record.name, '未发布改名');
});

test('未发布的撤回不会让馆藏列表或来源明细提前变化', async () => {
  const { db, mutex } = await freshDb();
  const gid = await seedBaseline(db, mutex);
  assert.equal((await queries.listGroups(db)).groups.length, 1);
  await engine.withdrawBatch(db, mutex, { batchId: 'bC' });
  // 未发布：C 仍在原馆藏，来源明细仍可读
  assert.deepEqual(await membersOf(db), ['inventory|C,registry|A,repair|B']);
  const rec = await queries.getRecord(db, 'inventory', 'C');
  assert.equal(rec.found, true);
  assert.equal(rec.record.gid, gid);
  const groups = await queries.listGroups(db);
  assert.equal(groups.version, 1);
  // 发布后：C 已撤回，其余提交继续参与
  await engine.publish(db, mutex);
  assert.deepEqual(await membersOf(db), ['registry|A,repair|B']);
  const after = await queries.getRecord(db, 'inventory', 'C');
  assert.equal(after.status, 'withdrawn');
});

test('未发布的导入对查询完全不可见，且明确标记为 unpublished', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  await engine.importBatch(db, mutex, {
    batchId: 'bZ', source: 'inventory',
    records: [{ id: 'Z', name: '新到青釉梅瓶', mark: '甲款', height: 20 }],
  });
  const groups = await queries.listGroups(db);
  assert.equal(groups.version, 1);
  assert.equal(groups.groups.length, 1);
  const rec = await queries.getRecord(db, 'inventory', 'Z');
  assert.equal(rec.found, false);
  assert.equal(rec.status, 'unpublished'); // 不是 withdrawn（从未发布）
  // 发布后进入馆藏
  await engine.publish(db, mutex);
  const rec2 = await queries.getRecord(db, 'inventory', 'Z');
  assert.equal(rec2.found, true);
});

test('批次与发布时间相同也按发布标记区分已发布/未发布', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  // 同一批次内两条记录：A 已发布后再更正，新版本未发布
  await engine.correctRecord(db, mutex, {
    batchId: 'same-batch', source: 'registry', id: 'A', fields: { name: '工作区改名' },
  });
  // 同批次里再加一条新导入（同 created_at 毫秒级也难以区分，但发布标记是确定的）
  await engine.importBatch(db, mutex, {
    batchId: 'same-batch-2', source: 'inventory',
    records: [{ id: 'W', name: '工作区新记录' }],
  });
  const rows = await db.all(
    `select source_id, seq, published_version from record_versions
     where source_id in ('A','W') order by source_id, seq`
  );
  const aOld = rows.find((r) => r.source_id === 'A' && r.seq === 1);
  const aNew = rows.find((r) => r.source_id === 'A' && r.seq === 2);
  const wNew = rows.find((r) => r.source_id === 'W');
  assert.equal(aOld.published_version, 1, '旧版已随 v1 发布');
  assert.equal(aNew.published_version, null, '更正版尚未发布');
  assert.equal(wNew.published_version, null, '新导入尚未发布');
  // 来源明细仍取已发布的旧版
  assert.equal((await queries.getRecord(db, 'registry', 'A')).record.name, '青釉梅瓶');
});

// ---------------- 发布暂停 / 交叉提交快照 ----------------

test('发布暂停时仍能查完旧版的列表、来源明细与旧馆藏追查', async () => {
  const { db, mutex } = await freshDb();
  const gid = await seedBaseline(db, mutex);
  await engine.withdrawBatch(db, mutex, { batchId: 'bC' });
  // 在发布事务写入完成、提交前暂停：期间工作区删表已发生
  let seen = null;
  engine.setBeforeCommitHook(async () => {
    const groups = await queries.listGroups(db);
    const rec = await queries.getRecord(db, 'inventory', 'C');
    const trace = await queries.traceGroup(db, gid, 1);
    seen = { groups, rec, trace };
  });
  try {
    await engine.publish(db, mutex);
  } finally {
    engine.setBeforeCommitHook(null);
  }
  assert.ok(seen);
  // 旧版：v1、三个成员、C 可见、旧馆藏可追查
  assert.equal(seen.groups.version, 1);
  assert.deepEqual(seen.groups.groups[0].members.slice().sort(), [
    'inventory|C', 'registry|A', 'repair|B',
  ]);
  assert.equal(seen.rec.found, true);
  assert.equal(seen.trace.found, true);
  assert.equal(seen.trace.members.length, 3);
  // 提交后才是新版
  const after = await queries.listGroups(db);
  assert.equal(after.version, 2);
  assert.deepEqual(after.groups[0].members.slice().sort(), ['registry|A', 'repair|B']);
});

test('审计字段变更按版本回放：沿用编号的馆藏也记录本版字段', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  await engine.withdrawBatch(db, mutex, { batchId: 'bC' });
  await engine.publish(db, mutex);
  // v2：C 撤回，AB 同组（成员集合与 v1 的 ABC 不同，故是新建编号）
  const g2 = (await queries.listGroups(db)).groups.find((g) => g.members.length === 2);
  const abGid = g2.gid;
  // v3：更正 A 品名，成员仍是 AB，编号沿用 v2
  await engine.correctRecord(db, mutex, {
    batchId: 'cA', source: 'registry', id: 'A', fields: { name: '新青釉瓶' },
  });
  await engine.publish(db, mutex);
  const g3 = (await queries.listGroups(db)).groups.find((g) => g.members.length === 2);
  assert.equal(g3.gid, abGid, '成员未变的馆藏沿用原编号');
  assert.equal(g3.fields.name, '新青釉瓶');
  // 按版本回放：v2 旧名，v3 新名（沿用编号的 change 事件必须留痕）
  const v2 = await queries.versionDetail(db, 2);
  const v3 = await queries.versionDetail(db, 3);
  assert.equal(v2.groups.find((g) => g.gid === abGid).fields.name, '青釉梅瓶');
  assert.equal(v3.groups.find((g) => g.gid === abGid).fields.name, '新青釉瓶');
});

// ---------------- 发布中断 / 重启 / 重试 ----------------

test('发布中断后重启重试：结果与一次成功发布一致（编号稳定、无重复版本）', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  const file = db.file;
  const before = await queries.listGroups(db);

  await engine.withdrawBatch(db, mutex, { batchId: 'bC' });
  // 提交前崩溃
  engine.setCrashBeforeCommit(true);
  await assert.rejects(() => engine.publish(db, mutex), /CRASH_BEFORE_COMMIT/);
  engine.setCrashBeforeCommit(false);

  // 重启（重开同一文件），中断的发布整体回滚
  const db2 = openDatabase(file);
  await initDatabase(db2);
  const afterCrash = await queries.listGroups(db2);
  assert.equal(afterCrash.version, before.version);
  assert.deepEqual(
    afterCrash.groups.map((g) => g.members.slice().sort().join(',')).sort(),
    before.groups.map((g) => g.members.slice().sort().join(',')).sort()
  );
  // 工作区变更仍在：C 仍可在旧版中读到，新发布尚未生效
  assert.equal((await queries.getRecord(db2, 'inventory', 'C')).found, true);

  // 重试发布：版本号顺延，成员与一次成功发布一致
  const m2 = new engine.Mutex();
  const retry = await engine.publish(db2, m2);
  assert.equal(retry.version, before.version + 1);
  assert.deepEqual(await membersOf(db2), ['registry|A,repair|B']);
  const ab = (await queries.listGroups(db2)).groups[0];
  // 成员集合（AB）与 v1 的 ABC 不同，应得到全新编号；崩溃重试不应消耗额外编号
  assert.equal(ab.gid, 'G000002');
  // 版本列表没有空洞或重复
  const versions = (await queries.listVersions(db2)).map((v) => v.version);
  assert.deepEqual(versions, [1, 2]);
  // C 在新版已撤回
  assert.equal((await queries.getRecord(db2, 'inventory', 'C')).status, 'withdrawn');

  // 再重启一次，结果稳定
  await new Promise((r) => db2.raw.close(r));
  const db3 = openDatabase(file);
  await initDatabase(db3);
  assert.deepEqual(await membersOf(db3), ['registry|A,repair|B']);
  assert.equal((await queries.listGroups(db3)).version, 2);
});

test('崩溃回滚后重试与不崩溃直接发布的编号完全相同', async () => {
  async function run(withCrash) {
    const { db, mutex } = await freshDb();
    await seedBaseline(db, mutex);
    // 拆分：判 A、C 异件
    await engine.judgeHeterology(db, mutex, {
      batchId: 'hAC', source1: 'registry', id1: 'A', source2: 'inventory', id2: 'C',
    });
    if (withCrash) {
      engine.setCrashBeforeCommit(true);
      await assert.rejects(() => engine.publish(db, mutex), /CRASH_BEFORE_COMMIT/);
      engine.setCrashBeforeCommit(false);
    }
    await engine.publish(db, mutex);
    const r = await queries.listGroups(db);
    const out = r.groups.map((g) => `${g.gid}:${g.members.slice().sort().join(',')}`).sort();
    // 审计也可回放
    const detail = await queries.versionDetail(db, r.version);
    assert.ok(detail.groups.length === r.groups.length);
    return out;
  }
  const plain = await run(false);
  const crashed = await run(true);
  assert.deepEqual(crashed, plain, '崩溃重试后的馆藏编号与一次成功发布一致');
});
