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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceramic-trace-'));
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

// v1 三件同组 → v2 更正 B 脱离 → v3 撤回 C 的导入（C 无有效版本）→ v4 重新导入 C（新批次）
async function seedRetentionScenario(db, mutex) {
  await seedBaseline(db, mutex); // v1: G000001 = {A,B,C}
  await engine.correctRecord(db, mutex, {
    batchId: 'cB', source: 'repair', id: 'B',
    fields: { name: '黑釉茶盏', mark: '乙款', material: '炻器', height: 8 },
  });
  await engine.publish(db, mutex); // v2: {A,C}=G2, {B}=G3
  await engine.withdrawBatch(db, mutex, { batchId: 'bC' });
  await engine.publish(db, mutex); // v3: C 无有效来源版本
  await engine.importBatch(db, mutex, {
    batchId: 'bC2', source: 'inventory',
    records: [{ id: 'C', name: '青釉梅缾', mark: '甲款', height: 20.4 }],
  });
  await engine.publish(db, mutex); // v4: C 以新批次恢复，{A,C} 重新同组
  const groups = await queries.listGroups(db);
  const g2 = (await queries.listGroups(db)).groups; // 触发读取，确保服务正常
  assert.ok(groups.groups.length >= 2 && g2.length >= 2);
  return { gidAC: 'G000002', gidAll: 'G000001' };
}

test('追查留存：三类成员区分、按成员去重、明细定位发布版与来源批次', async () => {
  const { db, mutex } = await freshDb();
  const { gidAC, gidAll } = await seedRetentionScenario(db, mutex);

  // 以 v2 的 {A,C} 馆藏为起始范围，核对 v2 → v4 之间的留存
  const trace = await queries.traceGroup(db, gidAC, 2, 4);
  assert.equal(trace.found, true);
  assert.equal(trace.atVersion, 2);
  assert.equal(trace.toVersion, 4);
  assert.equal(trace.members.length, 2);

  const r = trace.retention;
  assert.equal(r.fromVersion, 2);
  assert.equal(r.toVersion, 4);

  // 期末仍有有效来源版本：A（批次 bA 未变）与 C（期末为新批次 bC2），各出现一次
  assert.deepEqual(
    r.retained.map((m) => m.key).sort(),
    [keyOf('inventory', 'C'), keyOf('registry', 'A')]
  );
  const aRetained = r.retained.find((m) => m.key === keyOf('registry', 'A'));
  assert.equal(aRetained.batchId, 'bA');
  assert.equal(aRetained.seq, 1);
  const cRetained = r.retained.find((m) => m.key === keyOf('inventory', 'C'));
  assert.equal(cRetained.batchId, 'bC2');
  assert.equal(cRetained.seq, 2);

  // 期间改用过其他批次：仅 C，且明细定位到 v4 与 bC → bC2
  assert.deepEqual(r.switchedBatch.map((m) => m.key), [keyOf('inventory', 'C')]);
  assert.deepEqual(r.switchedBatch[0].switches, [
    { version: 4, fromBatchId: 'bC', toBatchId: 'bC2', seq: 2 },
  ]);

  // 期间曾无有效来源版本：仅 C，区间为 [v3, v4)，失效前批次 bC
  assert.deepEqual(r.lapsed.map((m) => m.key), [keyOf('inventory', 'C')]);
  assert.deepEqual(r.lapsed[0].lapses, [
    { sinceVersion: 3, untilVersion: 4, lostBatchId: 'bC' },
  ]);

  assert.deepEqual(r.evidenceGaps, []);

  // 期末截在 v3（C 已撤回、尚未重新导入）：C 期末仍无有效版本，不计入 retained
  const traceV3 = await queries.traceGroup(db, gidAC, 2, 3);
  assert.deepEqual(
    traceV3.retention.retained.map((m) => m.key),
    [keyOf('registry', 'A')]
  );
  assert.deepEqual(traceV3.retention.lapsed.map((m) => m.key), [keyOf('inventory', 'C')]);
  assert.deepEqual(traceV3.retention.lapsed[0].lapses, [
    { sinceVersion: 3, untilVersion: null, lostBatchId: 'bC' },
  ]);
  assert.deepEqual(traceV3.retention.switchedBatch, []);

  // 以 v1 的三件同组为起始范围：B 在 v2 改用了更正批次 cB；C 在 v4 以新批次 bC2 恢复
  const traceAll = await queries.traceGroup(db, gidAll, 1, 4);
  const rAll = traceAll.retention;
  assert.deepEqual(
    rAll.switchedBatch.map((m) => m.key).sort(),
    [keyOf('inventory', 'C'), keyOf('repair', 'B')]
  );
  const bSwitch = rAll.switchedBatch.find((m) => m.key === keyOf('repair', 'B'));
  assert.deepEqual(bSwitch.switches, [
    { version: 2, fromBatchId: 'bB', toBatchId: 'cB', seq: 2 },
  ]);
  // B 期末仍有效、期间无失效；C 同时出现在 retained/switchedBatch/lapsed 中，每类各一次
  assert.deepEqual(
    rAll.retained.map((m) => m.key).sort(),
    [keyOf('inventory', 'C'), keyOf('registry', 'A'), keyOf('repair', 'B')]
  );
  assert.deepEqual(rAll.lapsed.map((m) => m.key), [keyOf('inventory', 'C')]);
  const bRetained = rAll.retained.find((m) => m.key === keyOf('repair', 'B'));
  assert.equal(bRetained.batchId, 'cB');
});

test('追查留存：未发布的变更不计入', async () => {
  const { db, mutex } = await freshDb();
  const { gidAC } = await seedRetentionScenario(db, mutex);

  // 工作区里更正 A 但不发布：追查 v2 → v4 不应出现 A 的批次变更
  await engine.correctRecord(db, mutex, {
    batchId: 'cA', source: 'registry', id: 'A', fields: { name: '未发布改名' },
  });
  let trace = await queries.traceGroup(db, gidAC, 2, 4);
  assert.deepEqual(trace.retention.switchedBatch.map((m) => m.key), [keyOf('inventory', 'C')]);
  const aBefore = trace.retention.retained.find((m) => m.key === keyOf('registry', 'A'));
  assert.equal(aBefore.batchId, 'bA');

  // 发布后（v5），同一区间到 v5 的追查才计入 A 的批次变更
  await engine.publish(db, mutex);
  trace = await queries.traceGroup(db, gidAC, 2, 5);
  const aSwitches = trace.retention.switchedBatch.find((m) => m.key === keyOf('registry', 'A'));
  assert.deepEqual(aSwitches.switches, [
    { version: 5, fromBatchId: 'bA', toBatchId: 'cA', seq: 2 },
  ]);
  const aAfter = trace.retention.retained.find((m) => m.key === keyOf('registry', 'A'));
  assert.equal(aAfter.batchId, 'cA');
});

test('追查留存：旧数据不足时标记证据缺口', async () => {
  const { db, mutex } = await freshDb();
  await seedBaseline(db, mutex);
  // 模拟升级前的旧库：有发布与成员历史，但没有任何来源版本状态事件
  await db.run('delete from record_state_events');
  const trace = await queries.traceGroup(db, 'G000001', 1, 1);
  assert.equal(trace.found, true);
  assert.equal(trace.members.length, 3);
  assert.deepEqual(trace.retention.retained, []);
  assert.deepEqual(trace.retention.switchedBatch, []);
  assert.deepEqual(trace.retention.lapsed, []);
  assert.deepEqual(
    trace.retention.evidenceGaps.map((g) => g.key).sort(),
    [keyOf('inventory', 'C'), keyOf('registry', 'A'), keyOf('repair', 'B')]
  );
  for (const gap of trace.retention.evidenceGaps) {
    assert.match(gap.reason, /旧数据不足/);
  }
});

test('追查参数：toVersion 早于 atVersion 报错，起始版不在馆藏生命周期内返回未找到', async () => {
  const { db, mutex } = await freshDb();
  const { gidAll } = await seedRetentionScenario(db, mutex);
  await assert.rejects(() => queries.traceGroup(db, gidAll, 3, 2), /不能早于/);
  // G000001 在 v2 已关闭：以 v2 为起始版查不到该馆藏
  const gone = await queries.traceGroup(db, gidAll, 2, 4);
  assert.equal(gone.found, false);
  // 不存在的版本
  assert.equal(await queries.traceGroup(db, gidAll, 99, null), null);
});

// 统计一次追查扫描的历史行数与一次发布写入的追查载荷字节数（含参数等辅助数据）
function instrument(db) {
  const stats = { scannedRows: 0, payloadRows: 0, payloadBytes: 0 };
  const all0 = db.all;
  const run0 = db.run;
  db.all = function (sql, params) {
    return Promise.resolve(all0.call(db, sql, params)).then((rows) => {
      stats.scannedRows += rows.length;
      return rows;
    });
  };
  db.run = function (sql, params) {
    if (/insert into record_state_events/.test(sql)) {
      stats.payloadRows += Math.floor((params || []).length / 5);
      stats.payloadBytes +=
        Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(params || []));
    }
    return run0.call(db, sql, params);
  };
  return stats;
}

async function buildTraceDb(noiseReleases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceramic-scale-'));
  const db = openDatabase(path.join(dir, 's.duckdb'));
  await initDatabase(db);
  const mutex = new engine.Mutex();
  await seedBaseline(db, mutex); // v1: G000001 = {A,B,C}
  for (let i = 0; i < noiseReleases; i++) {
    await engine.importBatch(db, mutex, {
      batchId: `noise-${i}`, source: 'registry',
      records: [{ id: `N${i}`, name: `无关陶器${i}`, mark: `杂款${i}`, height: 30 }],
    });
    await engine.publish(db, mutex); // 与被追查馆藏无关的“无变化发布”
  }
  return { db, mutex };
}

test('规模无关性：无关馆藏与无变化发布扩容十倍后，追查扫描行数与载荷字节增幅不超过两倍', async () => {
  const small = await buildTraceDb(5);
  const big = await buildTraceDb(50); // 10 倍无关馆藏与无变化发布

  // 首次查询扫描的历史行数
  const sStats = instrument(small.db);
  const tSmall = await queries.traceGroup(small.db, 'G000001', 1, null);
  const bStats = instrument(big.db);
  const tBig = await queries.traceGroup(big.db, 'G000001', 1, null);
  assert.equal(tSmall.found, true);
  assert.equal(tBig.found, true);
  assert.ok(
    bStats.scannedRows <= sStats.scannedRows * 2,
    `扫描历史行数 ${sStats.scannedRows} -> ${bStats.scannedRows} 超过两倍`
  );

  // 同一笔单键更正发布写入的追查载荷（含辅助数据）
  for (const [side, stats] of [[small, sStats], [big, bStats]]) {
    await engine.correctRecord(side.db, side.mutex, {
      batchId: 'trace-cB', source: 'repair', id: 'B', fields: { material: '炻器' },
    });
    stats.payloadRows = 0;
    stats.payloadBytes = 0;
    await engine.publish(side.db, side.mutex);
  }
  assert.equal(sStats.payloadRows, 1);
  assert.equal(bStats.payloadRows, 1);
  assert.ok(
    bStats.payloadBytes <= sStats.payloadBytes * 2,
    `追查载荷字节数 ${sStats.payloadBytes} -> ${bStats.payloadBytes} 超过两倍`
  );
});
