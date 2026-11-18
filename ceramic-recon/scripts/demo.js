#!/usr/bin/env node
'use strict';
/*
 * 演示：
 *  1) 重放固定基准（A/B/C 同组 → 判异 AB+C → 更正 → 撤回更正 → 撤回判异）；
 *  2) 在“干净库”与“加入 5 万条无关来源记录的库”上，执行完全相同的一串 20 次小批变更
 *     （更正与撤回交替），对比每次发布的三项工作量：
 *       - 读取的来源记录数 source_records_read
 *       - 匹配比较数 comparisons
 *       - 新增历史馆藏数据量 new_group_rows
 *  期望：相同变更在两库上的工作量逐次相等，不随全库规模增长。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase, initDatabase } = require('../src/db');
const engine = require('../src/engine');
const queries = require('../src/queries');

function hr(t) {
  console.log('\n' + '='.repeat(72));
  console.log(t);
  console.log('='.repeat(72));
}

async function seedBaseline(db, mutex) {
  await engine.importBatch(db, mutex, {
    batchId: 'base-A', source: 'registry',
    records: [{ id: 'A', name: '青釉梅瓶', mark: '甲款', height: 20 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'base-B', source: 'repair',
    records: [{ id: 'B', name: '青釉梅缾', mark: '甲款', material: '瓷', height: 20 }],
  });
  await engine.importBatch(db, mutex, {
    batchId: 'base-C', source: 'inventory',
    records: [{ id: 'C', name: '青釉梅缾', mark: '甲款', height: 20.4 }],
  });
  await engine.publish(db, mutex, { reason: '基准入库' });
}

async function showGroups(db, title) {
  const r = await queries.listGroups(db);
  console.log(`\n【${title}】发布版本 v${r.version}，馆藏 ${r.groups.length} 个：`);
  for (const g of r.groups) {
    console.log(
      `  ${g.gid}  成员=[${g.members.join(', ')}]`
    );
    console.log(
      `     品名=${g.fields.name}（出处:${g.fieldSources.name}） 材质=${g.fields.material}（出处:${g.fieldSources.material}） 刻款=${g.fields.mark} 高度=${g.fields.height}`
    );
  }
}

// 同一串 20 次小批变更：10 次更正 + 10 次撤回，交替进行，每次后发布
async function runTwentyChanges(db, mutex, tag) {
  const startVersion = (await queries.latestVersion(db)).version;
  for (let i = 1; i <= 10; i++) {
    const corrBatch = `demo-corr-${i}`;
    await engine.correctRecord(db, mutex, {
      batchId: corrBatch,
      source: 'repair',
      id: 'B',
      fields: { name: `临时茶盏${i}`, mark: '乙款', material: '炻器', height: 8 },
    });
    await engine.publish(db, mutex, { reason: `${tag} 第${2 * i - 1}次：更正 B` });

    await engine.withdrawBatch(db, mutex, { batchId: corrBatch });
    await engine.publish(db, mutex, { reason: `${tag} 第${2 * i}次：撤回更正` });
  }
  const log = await queries.workloadLog(db);
  return log.filter((r) => r.version > startVersion);
}

// 加入 n 条彼此唯一、且与基准不共块的无关来源记录（三来源均分）
async function addNoise(db, mutex, n) {
  const sources = ['registry', 'repair', 'inventory'];
  const perSource = Math.floor(n / sources.length);
  const chunk = 1000;
  let made = 0;
  for (const source of sources) {
    for (let start = 0; start < perSource; start += chunk) {
      const size = Math.min(chunk, perSource - start);
      const records = [];
      for (let k = 0; k < size; k++) {
        const idx = start + k;
        records.push({
          id: `noise-${source}-${idx}`,
          // 名、款均含来源与序号，保证规范化后全局唯一、跨来源不共块
          name: `无关${source}陶器${idx}`,
          mark: `杂${source}款${idx}`,
          material: source === 'repair' ? '陶' : null,
          height: 30 + (idx % 50),
        });
      }
      await engine.importBatch(db, mutex, {
        batchId: `noise-${source}-${start}`,
        source,
        records,
      });
      made += size;
    }
  }
  await engine.publish(db, mutex, { reason: `加入 ${made} 条无关来源记录` });
  return made;
}

function summarize(log) {
  return log.map((r) => ({
    v: r.version,
    reads: r.source_records_read,
    comparisons: r.comparisons,
    newGroups: r.new_group_rows,
  }));
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceramic-demo-'));

  // ---------- 第一部分：固定基准重放 ----------
  hr('第一部分：固定基准重放');
  const dbFile = path.join(dir, 'demo.duckdb');
  const db = openDatabase(dbFile);
  await initDatabase(db);
  const mutex = new engine.Mutex();

  await seedBaseline(db, mutex);
  await showGroups(db, '初始：三条同组');

  await engine.judgeHeterology(db, mutex, {
    batchId: 'base-hAC', source1: 'registry', id1: 'A', source2: 'inventory', id2: 'C',
  });
  await engine.publish(db, mutex, { reason: '判 A 与 C 异件' });
  await showGroups(db, '判异后：应为 AB 与 C 两个馆藏');

  await engine.correctRecord(db, mutex, {
    batchId: 'base-cB', source: 'repair', id: 'B',
    fields: { name: '黑釉茶盏', mark: '乙款', material: '炻器', height: 8 },
  });
  await engine.correctRecord(db, mutex, {
    batchId: 'base-cC', source: 'inventory', id: 'C', fields: { material: '陶' },
  });
  await engine.publish(db, mutex, { reason: '更正 B、更正 C 材质' });
  await showGroups(db, '更正后：B 脱离，C 材质为陶');

  await engine.withdrawBatch(db, mutex, { batchId: 'base-cB' });
  await engine.publish(db, mutex, { reason: '撤回 B 的更正' });
  await showGroups(db, '撤回 B 更正：恢复 AB 与 C，AB 材质瓷、C 陶');

  await engine.withdrawBatch(db, mutex, { batchId: 'base-hAC' });
  await engine.publish(db, mutex, { reason: '撤回异件判定' });
  await showGroups(db, '撤回判异：三条重新同组');

  // ---------- 第二部分：规模无关性 ----------
  hr('第二部分：相同 20 次小批变更在不同规模库上的工作量对比');

  // 干净库：另起一个仅含基准的库
  const cleanFile = path.join(dir, 'clean.duckdb');
  const dbClean = openDatabase(cleanFile);
  await initDatabase(dbClean);
  const mutexClean = new engine.Mutex();
  await seedBaseline(dbClean, mutexClean);
  const cleanLog = await runTwentyChanges(dbClean, mutexClean, '干净库');

  // 大库：当前演示库 + 5 万条无关记录
  const noiseCount = await addNoise(db, mutex, 50000);
  const totalActive = (await db.all('select count(*) c from v_active_records'))[0].c;
  console.log(`\n大库当前有效来源记录总数：${totalActive}（其中无关记录 ${noiseCount} 条）`);
  const bigLog = await runTwentyChanges(db, mutex, '大库');

  const cleanSum = summarize(cleanLog);
  const bigSum = summarize(bigLog);

  console.log('\n每次发布的三项工作量（左：干净库 / 右：含 5 万无关记录的大库）：');
  console.log('次数 | 读取记录(clean/big) | 匹配比较(clean/big) | 新增馆藏(clean/big)');
  for (let i = 0; i < cleanSum.length; i++) {
    const c = cleanSum[i];
    const b = bigSum[i];
    const same =
      c.reads === b.reads && c.comparisons === b.comparisons && c.newGroups === b.newGroups;
    console.log(
      `${String(i + 1).padStart(2)}   | ${String(c.reads).padStart(4)} / ${String(b.reads).padStart(6)}` +
        `       | ${String(c.comparisons).padStart(4)} / ${String(b.comparisons).padStart(6)}` +
        `        | ${String(c.newGroups).padStart(4)} / ${String(b.newGroups).padStart(6)}` +
        `   ${same ? '✓ 相同' : '✗ 不一致'}`
    );
  }

  const totals = (s) =>
    s.reduce(
      (acc, r) => ({
        reads: acc.reads + r.reads,
        comparisons: acc.comparisons + r.comparisons,
        newGroups: acc.newGroups + r.newGroups,
      }),
      { reads: 0, comparisons: 0, newGroups: 0 }
    );
  const tc = totals(cleanSum);
  const tb = totals(bigSum);
  console.log('\n20 次发布累计：');
  console.log(`  干净库：读取 ${tc.reads} 条，比较 ${tc.comparisons} 次，新增馆藏数据 ${tc.newGroups} 行`);
  console.log(`  大库  ：读取 ${tb.reads} 条，比较 ${tb.comparisons} 次，新增馆藏数据 ${tb.newGroups} 行`);
  const invariantHolds =
    tc.reads === tb.reads && tc.comparisons === tb.comparisons && tc.newGroups === tb.newGroups;
  console.log(
    invariantHolds
      ? '\n结论 ✓：加入 5 万条无关馆藏后，相同变更的三项工作量完全相同，不随全库规模增长。'
      : '\n结论 ✗：工作量随规模发生变化，需要检查分块增量逻辑。'
  );

  // 最终归组核对：只展示基准 A/B/C 所在馆藏，避免打印 5 万无关馆藏
  const finalGroups = await queries.listGroups(db);
  const baselineGroup = finalGroups.groups.find((g) =>
    g.members.includes('registry|A') &&
    g.members.includes('repair|B') &&
    g.members.includes('inventory|C')
  );
  console.log('\n【大库演示结束时的基准馆藏（应仍为三条同组）】');
  if (baselineGroup) {
    console.log(`  ${baselineGroup.gid}  成员=[${baselineGroup.members.join(', ')}]`);
    console.log(
      `     品名=${baselineGroup.fields.name}（出处:${baselineGroup.fieldSources.name}） ` +
      `材质=${baselineGroup.fields.material}（出处:${baselineGroup.fieldSources.material}） ` +
      `刻款=${baselineGroup.fields.mark} 高度=${baselineGroup.fields.height}`
    );
    console.log(`  （其余 ${finalGroups.groups.length - 1} 个为无关馆藏，未参与本次任何重算）`);
  } else {
    console.log('  ✗ 未找到三条同组的基准馆藏！');
    process.exit(1);
  }

  if (!invariantHolds) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
