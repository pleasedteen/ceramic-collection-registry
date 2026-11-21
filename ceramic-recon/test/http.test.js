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

    // 留存追查：v1 → v5，B 在 v3 改用更正批次 cB、v5 撤回后回到 bB（同一成员只出现一次）
    const retention = await c.get('/audit/groups/G000001?atVersion=1&toVersion=5');
    assert.equal(retention.retention.fromVersion, 1);
    assert.equal(retention.retention.toVersion, 5);
    assert.equal(retention.retention.retained.length, 3);
    assert.deepEqual(retention.retention.switchedBatch.map((m) => m.key), ['repair|B']);
    assert.deepEqual(retention.retention.switchedBatch[0].switches, [
      { version: 3, fromBatchId: 'bB', toBatchId: 'cB', seq: 2 },
      { version: 5, fromBatchId: 'cB', toBatchId: 'bB', seq: 1 },
    ]);
    assert.deepEqual(retention.retention.lapsed, []);
    assert.deepEqual(retention.retention.evidenceGaps, []);
    // toVersion 早于 atVersion → 400
    await assert.rejects(
      () => c.get('/audit/groups/G000001?atVersion=3&toVersion=2'),
      (e) => e.status === 400
    );
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
