#!/usr/bin/env node
'use strict';
/*
 * 馆员材质盘点核对脚本（只读已发布版本，不依赖 HTTP 服务）：
 *
 * 第一部分：构造含“归入 / 离开 / 同编号改材质 / 拆并重组 / 新增 / 撤回 / 未知类”的
 *   三版场景，任选两个新发布版，按指定材质（含未知 unknown）对比馆藏件数，
 *   逐条列出归入、离开该类的馆藏编号及其当版成员；净差为零也能核对换入换出。
 *
 * 第二部分：加入 5 万件从未归入目标材质的馆藏后，
 *   - 同一串小批变更在干净库与大库上的“实际读取来源记录数 / 匹配比较数 /
 *     新增历史馆藏行数”逐次相同（读历史量不随全库规模增长）；
 *   - 小批发布的历史事件只覆盖受影响馆藏，5 万无关馆藏零历史增量。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase, initDatabase } = require('../src/db');
const engine = require('../src/engine');
const queries = require('../src/queries');
const { reconcileMaterial, UNKNOWN } = require('../src/material-recon');

function hr(t) {
  console.log('\n' + '='.repeat(76));
  console.log(t);
  console.log('='.repeat(76));
}

// 与 test/material-recon.test.js 相同的三版场景
async function seedScenario(db, mutex) {
  const imp = (batchId, source, records) =>
    engine.importBatch(db, mutex, { batchId, source, records });
  await imp('i-RA', 'registry', [{ id: 'RA', name: '瓷瓶甲', mark: '款甲', height: 20 }]);
  await imp('i-RB', 'repair', [{ id: 'RB', name: '瓷瓶甲', mark: '款甲', material: '瓷', height: 20 }]);
  await imp('i-RS', 'registry', [{ id: 'RS', name: '稳瓶', mark: '款稳', height: 30 }]);
  await imp('i-PS', 'repair', [{ id: 'PS', name: '稳瓶', mark: '款稳', material: '瓷', height: 30 }]);
  await imp('i-RT', 'registry', [{ id: 'RT', name: '陶壶一', mark: '款乙', height: 15 }]);
  await imp('i-PT', 'repair', [{ id: 'PT', name: '陶壶一', mark: '款乙', material: '陶', height: 15 }]);
  await imp('i-Ra', 'registry', [{ id: 'Ra', name: '分盒甲', mark: '共同款', height: 10 }]);
  await imp('i-Pa', 'repair', [{ id: 'Pa', name: '分盒甲', mark: '共同款', material: '陶', height: 10 }]);
  await imp('i-Rb', 'registry', [{ id: 'Rb', name: '分盒乙', mark: '共同款', height: 10.2 }]);
  await imp('i-Pb', 'repair', [{ id: 'Pb', name: '分盒乙', mark: '共同款', material: '陶', height: 10.2 }]);
  await engine.judgeHeterology(db, mutex, {
    batchId: 'h-ab', source1: 'registry', id1: 'Ra', source2: 'repair', id2: 'Pb',
  });
  await imp('i-RU1', 'registry', [{ id: 'RU1', name: '无名罐一', mark: '款丙', height: 12 }]);
  await imp('i-RU2', 'registry', [{ id: 'RU2', name: '无名罐二', mark: '款丁', height: 13 }]);
  await imp('i-IU2', 'inventory', [{ id: 'IU2', name: '无名罐二', mark: '款丁', height: 13.2 }]);
  await engine.publish(db, mutex, { reason: 'v1 初始盘点' });

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
  await imp('i-RN', 'registry', [{ id: 'RN', name: '新杂项', mark: '款新', height: 5 }]);
  await engine.publish(db, mutex, { reason: 'v2 材质更正、合并、新增' });

  await engine.withdrawBatch(db, mutex, { batchId: 'c-RU1' });
  await engine.withdrawBatch(db, mutex, { batchId: 'i-RN' });
  await engine.publish(db, mutex, { reason: 'v3 撤回' });
}

function printReport(r) {
  const v = r.versions;
  console.log(
    `\n■ 材质【${r.material}】 v${v.from} → v${v.to}：` +
      `件数 ${r.counts.from} → ${r.counts.to}（净差 ${r.counts.delta >= 0 ? '+' : ''}${r.counts.delta}）`
  );
  if (!r.joined.length) {
    console.log('  归入：无');
  } else {
    console.log(`  归入 ${r.joined.length} 个馆藏：`);
    for (const g of r.joined) {
      console.log(`    + ${g.gid}（${g.reason}，当版材质=${g.material ?? '空'}）成员=[${g.members.join(', ')}]`);
      if (g.previousMaterial !== null || g.previousSameMembersGid) {
        console.log(`        同编号旧馆藏 ${g.previousSameMembersGid} 旧材质=${g.previousMaterial ?? '空'}`);
      }
    }
  }
  if (!r.left.length) {
    console.log('  离开：无');
  } else {
    console.log(`  离开 ${r.left.length} 个馆藏：`);
    for (const g of r.left) {
      console.log(`    - ${g.gid}（${g.reason}，旧版材质=${g.material ?? '空'}）成员=[${g.members.join(', ')}]`);
      if (g.nextSameMembersGid) {
        console.log(`        同编号新馆藏 ${g.nextSameMembersGid} 新材质=${g.nextMaterial ?? '空'}`);
      }
    }
  }
  if (r.sameGidMaterialChanged.length) {
    console.log('  同编号改材质记账：');
    for (const c of r.sameGidMaterialChanged) {
      console.log(
        `    ~ ${c.oldGid}→${c.gid}：${c.oldMaterial ?? '空'} → ${c.newMaterial ?? '空'} 成员=[${c.members.join(', ')}]`
      );
    }
  }
  console.log(
    `  核对：归入-离开=${r.checks.joinedMinusLeft}，净差一致=${r.checks.netDeltaConsistent}；` +
      `成员口径 ${r.checks.memberCountA}→${r.checks.memberCountB}，成员净差一致=${r.checks.memberNetConsistent}`
  );
}

// 加入 n 条彼此唯一、与场景不共块、且材质均为“杂陶”的无关记录（永不归入瓷/炻器/未知类）
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
          id: `nz-${source}-${idx}`,
          name: `外部${source}器${idx}`,
          mark: `散${source}印${idx}`,
          material: '杂陶',
          height: 40 + (idx % 40),
        });
      }
      await engine.importBatch(db, mutex, {
        batchId: `nz-${source}-${start}`, source, records,
      });
      made += size;
    }
  }
  await engine.publish(db, mutex, { reason: `加入 ${made} 条从未归入目标材质的无关记录` });
  return made;
}

// 同一串小批变更（10 轮 ×2 发布 = 20 次）：
// 每轮先让 A 临时改名（瓷瓶甲→散件，匹配断开，AB 馆藏一分为二，新增馆藏行 > 0），
// 再撤回该更正（重新合并）；每轮都伴随材质 change 事件。工作量只取决于受影响组件。
async function runSmallBatches(db, mutex, startVersion) {
  for (let i = 1; i <= 10; i++) {
    const corr = `sb-split-${i}`;
    await engine.correctRecord(db, mutex, {
      batchId: corr, source: 'registry', id: 'RA',
      fields: { name: `散件${i}`, material: '临时杂项' },
    });
    await engine.publish(db, mutex, { reason: `小批第${2 * i - 1}次：A 临时拆分` });
    await engine.withdrawBatch(db, mutex, { batchId: corr });
    await engine.publish(db, mutex, { reason: `小批第${2 * i}次：撤回恢复` });
  }
  const log = await queries.workloadLog(db);
  return log.filter((r) => r.version > startVersion);
}
// 历史事件实际只覆盖的馆藏集合（用于证明无关馆藏零历史增量）
async function historyGidsSince(db, version) {
  const rows = await db.all(
    'select distinct gid from group_events where version > ? union select distinct gid from membership_events where version > ?',
    [version, version]
  );
  return new Set(rows.map((r) => r.gid));
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceramic-inv-'));

  // ---------------- 第一部分：两版材质盘点核对 ----------------
  hr('第一部分：任选两个发布版，按材质（含未知）核对馆藏件数与换入换出');
  const dbFile = path.join(dir, 'inv.duckdb');
  const db = openDatabase(dbFile);
  await initDatabase(db);
  const mutex = new engine.Mutex();
  await seedScenario(db, mutex);

  const versions = await queries.listVersions(db);
  console.log(`已发布版本：${versions.map((x) => `v${x.version}(${x.reason})`).join('，')}`);

  // 任选两个“新发布版”：v1→v2 与 v2→v3，材质覆盖瓷、陶、未知
  const reports = [
    await reconcileMaterial(db, 1, 2, '瓷'),
    await reconcileMaterial(db, 1, 2, '陶'),
    await reconcileMaterial(db, 1, 2, UNKNOWN),
    await reconcileMaterial(db, 2, 3, UNKNOWN),
  ];
  for (const r of reports) printReport(r);

  // 机器可核对断言：所有报告的件数净差与换入换出账目必须自洽
  for (const r of reports) {
    if (!r.checks.netDeltaConsistent || !r.checks.memberNetConsistent) {
      throw new Error(`材质 ${r.material} 核对账目不自洽`);
    }
  }
  const porcelain = reports[0];
  if (porcelain.counts.delta !== 0 || porcelain.joined.length !== 1 || porcelain.left.length !== 1) {
    throw new Error('瓷类净差为零的换入换出不符合预期');
  }

  // ---------------- 第二部分：5 万无关馆藏下的规模无关性 ----------------
  hr('第二部分：加入 5 万件从未归入目标材质的馆藏，核对读取历史量与历史增量');

  // 干净库：只含场景
  const cleanFile = path.join(dir, 'clean.duckdb');
  const dbClean = openDatabase(cleanFile);
  await initDatabase(dbClean);
  const mutexClean = new engine.Mutex();
  await seedScenario(dbClean, mutexClean);
  const cleanStart = (await queries.latestVersion(dbClean)).version;
  const cleanLog = await runSmallBatches(dbClean, mutexClean, cleanStart);

  // 大库：场景 + 5 万无关记录
  const noiseMade = await addNoise(db, mutex, 50000);
  const totalActive = (await db.all('select count(*) c from v_active_records'))[0].c;
  const bigGroups = (await queries.listGroups(db)).groups;
  const noiseGroups = bigGroups.filter((g) => g.members.every((m) => m.includes('nz-')));
  console.log(`\n大库有效来源记录 ${totalActive} 条（本次新增无关记录 ${noiseMade} 条），馆藏 ${bigGroups.length} 个`);
  console.log(`其中无关馆藏 ${noiseGroups.length} 个，材质集合=[${[...new Set(noiseGroups.map((g) => g.fields.material))].join(', ')}]`);

  // 无关馆藏从未归入目标材质：瓷 / 炻器 / 未知
  const leaked = noiseGroups.filter(
    (g) => g.fields.material === '瓷' || g.fields.material === '炻器' || g.fields.material === null
  );
  if (leaked.length) throw new Error('存在归入目标材质的无关馆藏');
  console.log('✓ 5 万件无关馆藏从未归入目标材质（瓷/炻器/未知），盘点结果不受其影响');

  const bigStart = (await queries.latestVersion(db)).version;
  const bigLog = await runSmallBatches(db, mutex, bigStart);

  console.log('\n同一串小批发布的工作量（干净库 / 大库）：');
  console.log('次 | 读取记录 | 匹配比较 | 新增馆藏行 | 一致');
  let allSame = true;
  for (let i = 0; i < cleanLog.length; i++) {
    const c = cleanLog[i];
    const b = bigLog[i];
    const same =
      c.source_records_read === b.source_records_read &&
      c.comparisons === b.comparisons &&
      c.new_group_rows === b.new_group_rows;
    allSame = allSame && same;
    console.log(
      `${String(i + 1).padStart(2)} | ${String(c.source_records_read).padStart(4)}/${String(b.source_records_read).padStart(5)}` +
        ` | ${String(c.comparisons).padStart(4)}/${String(b.comparisons).padStart(5)}` +
        ` | ${String(c.new_group_rows).padStart(4)}/${String(b.new_group_rows).padStart(5)} | ${same ? '✓' : '✗'}`
    );
  }
  const sum = (log) =>
    log.reduce(
      (acc, r) => ({
        reads: acc.reads + r.source_records_read,
        comparisons: acc.comparisons + r.comparisons,
        newGroups: acc.newGroups + r.new_group_rows,
      }),
      { reads: 0, comparisons: 0, newGroups: 0 }
    );
  const tc = sum(cleanLog);
  const tb = sum(bigLog);
  console.log('\n小批发布累计：');
  console.log(`  干净库：读取 ${tc.reads}，比较 ${tc.comparisons}，新增历史馆藏行 ${tc.newGroups}`);
  console.log(`  大库  ：读取 ${tb.reads}，比较 ${tb.comparisons}，新增历史馆藏行 ${tb.newGroups}`);

  // 大库小批发布的历史事件只涉及受影响馆藏，无关馆藏零历史增量
  const touchedGids = await historyGidsSince(db, bigStart);
  const cleanTouchedGids = await historyGidsSince(dbClean, cleanStart);
  const noiseGidSet = new Set(noiseGroups.map((g) => g.gid));
  const noiseTouched = [...touchedGids].filter((gid) => noiseGidSet.has(gid));
  console.log(
    `\n小批发布期间产生历史的馆藏：干净库 ${cleanTouchedGids.size} 个 / 大库 ${touchedGids.size} 个，` +
      `大库其中无关馆藏 ${noiseTouched.length} 个`
  );
  const affectedOnly = noiseTouched.length === 0 && cleanTouchedGids.size === touchedGids.size;
  console.log(
    affectedOnly
      ? '✓ 两库产生历史的馆藏数相同，小批发布只为受影响馆藏增加历史，5 万无关馆藏历史零增长'
      : '✗ 历史写入扩散到了无关馆藏'
  );

  const ok =
    allSame &&
    tc.reads === tb.reads &&
    tc.comparisons === tb.comparisons &&
    tc.newGroups === tb.newGroups &&
    affectedOnly;
  console.log(
    ok
      ? '\n结论 ✓：加入 5 万件无关馆藏后实际读取历史量不增长，小批发布只为受影响馆藏增加历史。'
      : '\n结论 ✗：规模无关性被破坏，请检查分块增量逻辑。'
  );
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
