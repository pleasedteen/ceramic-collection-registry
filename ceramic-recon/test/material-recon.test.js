'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase, initDatabase } = require('../src/db');
const engine = require('../src/engine');
const queries = require('../src/queries');
const { reconcileMaterial, inMaterialClass, UNKNOWN } = require('../src/material-recon');

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceramic-mat-'));
  const db = openDatabase(path.join(dir, 't.duckdb'));
  await initDatabase(db);
  return { db, mutex: new engine.Mutex(), dir };
}

// 构造三版场景：
// v1 瓷：P=[RA,RB](瓷)、PS 组(瓷，全程不变)
// v1 陶：T1=[RT,PT](陶)、Ta=[Ra,Pa](陶)、Tb=[Rb,Pb](陶)，Ta/Tb 间有异件判定故拆开
// v1 未知：U1=[RU1](null)、U2=[RU2,IU2](null)
// v2：RB 材质瓷→炻器(P 同编号离开瓷)；PT 陶→瓷(T1 同编号进入瓷)；
//     撤回异件 ⇒ Ta/Tb 合并为 Tab(陶，重组)；RU1 补材质陶(U1 离开未知进入陶)；
//     新增 RN 无材质(未知类新增)
// v3：撤回 RU1 更正(U1 回到未知)；撤回 RN 导入(RN 消失)
async function seedScenario(db, mutex) {
  // 瓷组 P
  await engine.importBatch(db, mutex, {
    batchId: 'i-RA', source: 'registry',
    records: [{ id: 'RA', name: '瓷瓶甲', mark: '款甲', height: 20 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'i-RB', source: 'repair',
    records: [{ id: 'RB', name: '瓷瓶甲', mark: '款甲', material: '瓷', height: 20 }],
  });
  // 瓷组 PS（全程稳定）
  await engine.importBatch(db, mutex, {
    batchId: 'i-RS', source: 'registry',
    records: [{ id: 'RS', name: '稳瓶', mark: '款稳', height: 30 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'i-PS', source: 'repair',
    records: [{ id: 'PS', name: '稳瓶', mark: '款稳', material: '瓷', height: 30 }],
  });
  // 陶组 T1
  await engine.importBatch(db, mutex, {
    batchId: 'i-RT', source: 'registry',
    records: [{ id: 'RT', name: '陶壶一', mark: '款乙', height: 15 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'i-PT', source: 'repair',
    records: [{ id: 'PT', name: '陶壶一', mark: '款乙', material: '陶', height: 15 }],
  });
  // 陶组 Ta / Tb（共享刻款，本会匹配，靠异件判定拆开）
  await engine.importBatch(db, mutex, {
    batchId: 'i-Ra', source: 'registry',
    records: [{ id: 'Ra', name: '分盒甲', mark: '共同款', height: 10 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'i-Pa', source: 'repair',
    records: [{ id: 'Pa', name: '分盒甲', mark: '共同款', material: '陶', height: 10 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'i-Rb', source: 'registry',
    records: [{ id: 'Rb', name: '分盒乙', mark: '共同款', height: 10.2 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'i-Pb', source: 'repair',
    records: [{ id: 'Pb', name: '分盒乙', mark: '共同款', material: '陶', height: 10.2 }],
  });
  await engine.judgeHeterology(db, mutex, {
    batchId: 'h-ab', source1: 'registry', id1: 'Ra', source2: 'repair', id2: 'Pb',
  });
  // 未知组 U1（仅登记、无材质）与 U2（登记+旧清册，均无材质）
  await engine.importBatch(db, mutex, {
    batchId: 'i-RU1', source: 'registry',
    records: [{ id: 'RU1', name: '无名罐一', mark: '款丙', height: 12 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'i-RU2', source: 'registry',
    records: [{ id: 'RU2', name: '无名罐二', mark: '款丁', height: 13 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'i-IU2', source: 'inventory',
    records: [{ id: 'IU2', name: '无名罐二', mark: '款丁', height: 13.2 }],
  });
  await engine.publish(db, mutex, { reason: 'v1 初始盘点' });

  // ---- v2 ----
  await engine.correctRecord(db, mutex, {
    batchId: 'c-RB', source: 'repair', id: 'RB', fields: { material: '炻器' },
  });
  await engine.correctRecord(db, mutex, {
    batchId: 'c-PT', source: 'repair', id: 'PT', fields: { material: '瓷' },
  });
  await engine.withdrawBatch(db, mutex, { batchId: 'h-ab' });
  await engine.correctRecord(db, mutex, {
    batchId: 'c-RU1', source: 'registry', id: 'RU1', fields: { material: '陶' },
  });
  await engine.importBatch(db, mutex, {
    batchId: 'i-RN', source: 'registry',
    records: [{ id: 'RN', name: '新杂项', mark: '款新', height: 5 }],
  });
  await engine.publish(db, mutex, { reason: 'v2 材质更正、合并、新增' });

  // ---- v3 ----
  await engine.withdrawBatch(db, mutex, { batchId: 'c-RU1' });
  await engine.withdrawBatch(db, mutex, { batchId: 'i-RN' });
  await engine.publish(db, mutex, { reason: 'v3 撤回' });
}

test('未知类判定：空值/null/字符串 null 归入未知，具体材质不混淆', () => {
  assert.equal(inMaterialClass(null, UNKNOWN), true);
  assert.equal(inMaterialClass('', UNKNOWN), true);
  assert.equal(inMaterialClass('null', UNKNOWN), true);
  assert.equal(inMaterialClass(undefined, UNKNOWN), true);
  assert.equal(inMaterialClass('陶', UNKNOWN), false);
  assert.equal(inMaterialClass('陶', '陶'), true);
  assert.equal(inMaterialClass(null, '陶'), false);
});

test('瓷类 v1→v2：净差为零仍可核对换入换出，同编号改材质双向记账', async () => {
  const { db, mutex } = await freshDb();
  await seedScenario(db, mutex);
  const r = await reconcileMaterial(db, 1, 2, '瓷');

  assert.equal(r.materialQuery, '瓷');
  assert.equal(r.unknown, false);
  assert.deepEqual(r.counts, { from: 2, to: 2, delta: 0 });

  // 归入：T1 同编号由陶改瓷
  assert.equal(r.joined.length, 1);
  const join = r.joined[0];
  assert.equal(join.reason, 'material-changed');
  assert.equal(join.material, '瓷');
  assert.equal(join.previousMaterial, '陶');
  assert.deepEqual(join.members, ['registry|RT', 'repair|PT'].sort());
  // 同编号改材质进入：旧版整组在类外，逐条成员的旧类内归属为空、旧馆藏编号已另列
  for (const m of join.previousMembership) {
    assert.equal(m.gid, null);
    assert.equal(m.material, null);
  }
  const snap1 = await queries.buildVersionSnapshot(db, 1);
  const oldT1 = snap1.find((g) => g.members.join(',') === join.members.join(','));
  assert.equal(oldT1.fields.material, '陶');

  // 离开：P 同编号由瓷改炻器
  assert.equal(r.left.length, 1);
  const leave = r.left[0];
  assert.equal(leave.reason, 'material-changed');
  assert.equal(leave.material, '瓷');
  assert.equal(leave.nextMaterial, '炻器');
  assert.deepEqual(leave.members, ['registry|RA', 'repair|RB'].sort());

  // 两条同编号材质变化都被记录
  const changedGids = r.sameGidMaterialChanged.map((c) =>
    [c.oldMaterial, c.newMaterial].sort().join('->')
  );
  assert.ok(changedGids.includes(['瓷', '陶'].sort().join('->')));
  assert.ok(changedGids.includes(['炻器', '瓷'].sort().join('->')));

  // 稳定馆藏：PS 两版都在瓷类
  assert.equal(r.stableCount, 1);
  assert.equal(r.stableMaterialChangedCount, 0);
  assert.equal(r.checks.netDeltaConsistent, true);
  assert.equal(r.checks.memberNetConsistent, true);
});

test('陶类 v1→v2：重组换入换出 + 同编号改材质，件数差与成员差均可核对', async () => {
  const { db, mutex } = await freshDb();
  await seedScenario(db, mutex);
  const r = await reconcileMaterial(db, 1, 2, '陶');

  assert.deepEqual(r.counts, { from: 3, to: 2, delta: -1 });
  const joinReasons = r.joined.map((j) => j.reason).sort();
  assert.deepEqual(joinReasons, ['material-changed', 'regroup']);
  // 合并馆藏 Tab：四个成员，来自旧版两个陶组
  const tab = r.joined.find((j) => j.reason === 'regroup');
  assert.equal(tab.members.length, 4);
  assert.ok(tab.previousMembership.every((m) => m.gid && m.material === '陶'));
  // U1 同编号由未知改陶进入
  const u1 = r.joined.find((j) => j.reason === 'material-changed');
  assert.deepEqual(u1.members, ['registry|RU1']);
  assert.equal(u1.previousMaterial, null);

  // 离开：T1 改瓷（material-changed），Ta/Tb 被合并（regroup）
  assert.equal(r.left.length, 3);
  const leftReasons = r.left.map((j) => j.reason).sort();
  assert.deepEqual(leftReasons, ['material-changed', 'regroup', 'regroup']);
  assert.equal(r.checks.netDeltaConsistent, true);
  assert.equal(r.checks.joinedMinusLeft, -1);
  assert.equal(r.checks.memberNetConsistent, true);
});

test('未知类 v1→v2：新增归入、补材质离开，净差为零', async () => {
  const { db, mutex } = await freshDb();
  await seedScenario(db, mutex);
  const r = await reconcileMaterial(db, 1, 2, UNKNOWN);

  assert.equal(r.unknown, true);
  assert.equal(r.material, '未知');
  assert.deepEqual(r.counts, { from: 2, to: 2, delta: 0 });
  assert.equal(r.joined.length, 1);
  assert.equal(r.joined[0].reason, 'new');
  assert.deepEqual(r.joined[0].members, ['registry|RN']);
  assert.equal(r.left.length, 1);
  assert.equal(r.left[0].reason, 'material-changed');
  assert.deepEqual(r.left[0].members, ['registry|RU1']);
  assert.equal(r.left[0].nextMaterial, '陶');
  assert.equal(r.checks.netDeltaConsistent, true);
  assert.equal(r.checks.memberNetConsistent, true);
  // U2 两版均为未知，保持稳定
  assert.equal(r.stableCount, 1);
});

test('未知类 v2→v3：撤回更正回归未知（归入），撤回导入致馆藏消失（离开 withdrawn）', async () => {
  const { db, mutex } = await freshDb();
  await seedScenario(db, mutex);
  const r = await reconcileMaterial(db, 2, 3, UNKNOWN);

  assert.deepEqual(r.counts, { from: 2, to: 2, delta: 0 });
  assert.equal(r.joined.length, 1);
  assert.deepEqual(r.joined[0].members, ['registry|RU1']);
  assert.equal(r.joined[0].reason, 'material-changed');
  assert.equal(r.joined[0].previousMaterial, '陶');
  assert.equal(r.left.length, 1);
  assert.equal(r.left[0].reason, 'withdrawn');
  assert.deepEqual(r.left[0].members, ['registry|RN']);
  assert.equal(r.checks.netDeltaConsistent, true);
});

test('反向核对 v2→v1 与正向 v1→v2 的归入/离开互为镜像', async () => {
  const { db, mutex } = await freshDb();
  await seedScenario(db, mutex);
  const fwd = await reconcileMaterial(db, 1, 2, '瓷');
  const rev = await reconcileMaterial(db, 2, 1, '瓷');
  assert.deepEqual(rev.counts, { from: 2, to: 2, delta: 0 });
  assert.equal(rev.joined.length, fwd.left.length);
  assert.equal(rev.left.length, fwd.joined.length);
  assert.deepEqual(
    rev.joined.map((j) => j.members.join(',')).sort(),
    fwd.left.map((j) => j.members.join(',')).sort()
  );
});

test('参数校验：缺材质 400、版本不存在 404、同版本 400', async () => {
  const { db, mutex } = await freshDb();
  await seedScenario(db, mutex);
  await assert.rejects(() => reconcileMaterial(db, 1, 2, ''), /材质/);
  await assert.rejects(() => reconcileMaterial(db, 1, 99, '瓷'), (e) => e.status === 404);
  await assert.rejects(() => reconcileMaterial(db, 2, 2, '瓷'), (e) => e.status === 400);
});

test('结果与两版实际物化快照逐组一致（不依赖事件口径）', async () => {
  const { db, mutex } = await freshDb();
  await seedScenario(db, mutex);
  for (const [v1, v2, mat] of [[1, 2, '瓷'], [1, 2, '陶'], [1, 2, UNKNOWN], [2, 3, UNKNOWN]]) {
    const r = await reconcileMaterial(db, v1, v2, mat);
    const snap1 = await queries.buildVersionSnapshot(db, v1);
    const snap2 = await queries.buildVersionSnapshot(db, v2);
    const expect1 = snap1.filter((g) => inMaterialClass(g.fields.material, mat)).length;
    const expect2 = snap2.filter((g) => inMaterialClass(g.fields.material, mat)).length;
    assert.equal(r.counts.from, expect1);
    assert.equal(r.counts.to, expect2);
  }
});
