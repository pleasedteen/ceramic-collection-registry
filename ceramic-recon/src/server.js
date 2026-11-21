'use strict';
const http = require('http');
const { URL } = require('url');
const engine = require('./engine');
const queries = require('./queries');
const { parseKey } = require('./db');

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 50 * 1024 * 1024) reject(new engine.ApiError(413, '请求体过大'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new engine.ApiError(400, 'JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function createServer(deps) {
  const { db, mutex } = deps;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && p === '/health') {
        const v = await queries.latestVersion(db);
        return json(res, 200, { ok: true, currentVersion: v ? v.version : 0 });
      }

      if (req.method === 'POST' && p === '/batches/imports') {
        return json(res, 201, await engine.importBatch(db, mutex, await readBody(req)));
      }
      if (req.method === 'POST' && p === '/batches/corrections') {
        return json(res, 201, await engine.correctRecord(db, mutex, await readBody(req)));
      }
      if (req.method === 'POST' && p === '/batches/heterologies') {
        return json(res, 201, await engine.judgeHeterology(db, mutex, await readBody(req)));
      }
      if (req.method === 'POST' && p === '/batches/withdrawals') {
        return json(res, 200, await engine.withdrawBatch(db, mutex, await readBody(req)));
      }
      if (req.method === 'POST' && p === '/publications') {
        return json(res, 201, await engine.publish(db, mutex, await readBody(req)));
      }

      if (req.method === 'GET' && p === '/groups') {
        return json(res, 200, await queries.listGroups(db));
      }
      if (req.method === 'GET' && p.startsWith('/groups/')) {
        const gid = decodeURIComponent(p.slice('/groups/'.length));
        const out = await queries.getGroup(db, gid);
        return out ? json(res, 200, out) : json(res, 404, { error: '馆藏不存在或尚未发布' });
      }
      if (req.method === 'GET' && p.startsWith('/records/')) {
        const tail = decodeURIComponent(p.slice('/records/'.length));
        const [source, id] = tail.split('|');
        if (!source || !id) throw new engine.ApiError(400, '路径应为 /records/<source>|<id>');
        return json(res, 200, await queries.getRecord(db, source, id));
      }
      if (req.method === 'GET' && p === '/versions') {
        return json(res, 200, await queries.listVersions(db));
      }
      if (req.method === 'GET' && /^\/versions\/\d+$/.test(p)) {
        const v = parseInt(p.split('/')[2], 10);
        const out = await queries.versionDetail(db, v);
        return out ? json(res, 200, out) : json(res, 404, { error: '版本不存在' });
      }
      if (req.method === 'GET' && /^\/audit\/groups\/[^/]+$/.test(p)) {
        const parts = p.split('/');
        const gid = decodeURIComponent(parts[3]);
        const at = url.searchParams.get('atVersion');
        const to = url.searchParams.get('toVersion');
        const out = await queries.traceGroup(
          db,
          gid,
          at ? parseInt(at, 10) : null,
          to ? parseInt(to, 10) : null
        );
        return out && out.found ? json(res, 200, out) : json(res, 404, { error: '馆藏不存在' });
      }
      if (req.method === 'GET' && p === '/audit/workload') {
        return json(res, 200, { log: await queries.workloadLog(db) });
      }
      if (req.method === 'GET' && p === '/audit/lineage') {
        return json(res, 200, { groups: await queries.lineageRows(db) });
      }
      return json(res, 404, { error: '未知路径' });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      return json(res, status, { error: e.message });
    }
  });
}

module.exports = { createServer };
