'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase, initDatabase } = require('../src/db');
const engine = require('../src/engine');
const { createServer } = require('../src/server');
const { client } = require('../src/http-client');

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceramic-http-'));
  const db = openDatabase(path.join(dir, 'http.duckdb'));
  await initDatabase(db);
  const mutex = new engine.Mutex();
  const server = createServer({ db, mutex });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const c = client(`http://127.0.0.1:${port}`);
  return { c, server, dir };
}

test('HTTP 全流程：导入→发布→判异→查询→审计→撤回', async () => {
  const { c, server } = await startServer();
  try {
    await c.post('/batches/imports', {
      batchId: 'bA', source: 'registry',
      records: [{ id: 'A', name: '青釉梅瓶', mark: '甲款', height: 20 }],
    });
    await c.post('/batches/imports', {
      batchId: 'bB', source: 'repair',
      records: [{ id: 'B', name: '青釉梅缾', mark: '甲款', material: '瓷', height: 20 }],
    });
    await c.post('/batches/imports', {
      batchId: 'bC', source: 'inventory',
      records: [{ id: 'C', name: '青釉梅缾', mark: '甲款', height: 20.4 }],
    });
    const p1 = await c.post('/publications', {});
    assert.equal(p1.version, 1);

    let groups = await c.get('/groups');
    assert.equal(groups.groups.length, 1);
    assert.equal(groups.groups[0].fieldSources.material, 'repair');

    // 查询只读到完整发布：判异先发布，更正随后单独发布，互不串扰
    await c.post('/batches/heterologies', {
      batchId: 'hAC', source1: 'registry', id1: 'A', source2: 'inventory', id2: 'C',
    });
    const p2 = await c.post('/publications', {});
    assert.equal(p2.version, 2);
    groups = await c.get('/groups');
    assert.deepEqual(
      groups.groups.map((g) => g.members.slice().sort().join(',')).sort(),
      ['inventory|C', 'registry|A,repair|B']
    );

    // 未发布的更正不影响查询
    await c.post('/batches/corrections', {
      batchId: 'cB', source: 'repair', id: 'B',
      fields: { name: '黑釉茶盏', mark: '乙款', material: '炻器', height: 8 },
    });
    groups = await c.get('/groups');
    assert.equal(groups.version, 2, '未发布的更正不应影响查询');
    await c.post('/publications', {});
    groups = await c.get('/groups');
    assert.equal(groups.groups.length, 3, '更正发布后 B 脱离原组');

    const detail = await c.get('/versions/2');
    assert.ok(Array.isArray(detail.cutEdges));
    const trace = await c.get('/audit/groups/G000001?atVersion=1');
    assert.equal(trace.members.length, 3);
    const workload = await c.get('/audit/workload');
    assert.ok(workload.log.length >= 2);

    // 错误路径返回结构化错误
    await assert.rejects(() => c.get('/groups/NOPE'), (e) => e.status === 404);
    await assert.rejects(
      () =>
        c.post('/batches/heterologies', {
          batchId: 'same', source1: 'registry', id1: 'A', source2: 'registry', id2: 'A',
        }),
      (e) => e.status === 400
    );

    // 撤回判异：A 与 C 重新合并，但 B 因更正后已不匹配，仍独立（共 2 组）
    await c.post('/batches/withdrawals', { batchId: 'hAC' });
    await c.post('/publications', {});
    groups = await c.get('/groups');
    assert.equal(groups.groups.length, 2);
    // 再撤回 B 的更正，三者恢复同组
    await c.post('/batches/withdrawals', { batchId: 'cB' });
    await c.post('/publications', {});
    groups = await c.get('/groups');
    assert.equal(groups.groups.length, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('HTTP 健康检查与重复批次冲突', async () => {
  const { c, server } = await startServer();
  try {
    const h = await c.get('/health');
    assert.equal(h.ok, true);
    await c.post('/batches/imports', {
      batchId: 'dup', source: 'registry', records: [{ id: 'Q', name: 'x' }],
    });
    await assert.rejects(
      () =>
        c.post('/batches/imports', {
          batchId: 'dup', source: 'registry', records: [{ id: 'R', name: 'y' }],
        }),
      (e) => e.status === 409
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('HTTP 单馆藏复核与按版本解释：间接阻断、判异撤回后重新归并', async () => {
  const { c, server } = await startServer();
  try {
    await c.post('/batches/imports', {
      batchId: 'bA', source: 'registry',
      records: [{ id: 'A', name: '青釉梅瓶', mark: '甲款', height: 20 }],
    });
    await c.post('/batches/imports', {
      batchId: 'bB', source: 'repair',
      records: [{ id: 'B', name: '青釉梅缾', mark: '甲款', material: '瓷', height: 20 }],
    });
    await c.post('/batches/imports', {
      batchId: 'bC', source: 'inventory',
      records: [{ id: 'C', name: '青釉梅缾', mark: '甲款', height: 20.4 }],
    });
    await c.post('/publications', {});
    const v1 = (await c.get('/groups')).groups[0];
    await c.post('/batches/heterologies', {
      batchId: 'hAC', source1: 'registry', id1: 'A', source2: 'inventory', id2: 'C',
    });
    await c.post('/publications', {});

    const groups = (await c.get('/groups')).groups;
    const cg = groups.find((g) => g.members.join(',') === 'inventory|C');
    const g = await c.get(`/groups/${cg.gid}`);
    const rejected = new Map(g.group.rejectedEdges.map((e) => [`${e.k1}#${e.k2}`, e]));
    assert.equal(rejected.get('inventory|C#registry|A').blockKind, 'direct');
    assert.equal(rejected.get('inventory|C#repair|B').blockKind, 'indirect');
    assert.deepEqual(rejected.get('inventory|C#repair|B').blockedByBatches, ['hAC']);

    // 撤回判异并发布，三条重新归并；旧版解释按当时结果显示
    await c.post('/batches/withdrawals', { batchId: 'hAC' });
    await c.post('/publications', {});
    const mergedGid = (await c.get('/groups')).groups[0].gid;
    const merged = await c.get(`/groups/${mergedGid}`);
    assert.equal(merged.group.rejectedEdges.length, 0);
    assert.equal(merged.group.contributingEdges.length, 2);

    // 指定旧版本查询：仍是拆分态，解释里带当时的判异批次
    const atV2 = await c.get(`/groups/${cg.gid}?atVersion=2`);
    assert.equal(atV2.version, 2);
    assert.ok(atV2.group.rejectedEdges.every((e) => e.blockedByBatches.includes('hAC')));
    // v1 的馆藏仍可查询
    const atV1 = await c.get(`/groups/${v1.gid}?atVersion=1`);
    assert.equal(atV1.group.members.length, 3);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
