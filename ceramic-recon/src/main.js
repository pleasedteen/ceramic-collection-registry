#!/usr/bin/env node
'use strict';
const { openDatabase, initDatabase } = require('./db');
const engine = require('./engine');
const { createServer } = require('./server');

async function main() {
  const dbFile = process.env.CERAMIC_DB || './data/ceramic.duckdb';
  const port = parseInt(process.env.PORT || '8080', 10);
  if (process.env.CRASH_BEFORE_COMMIT === '1') {
    engine.setCrashBeforeCommit(true);
  }
  const db = openDatabase(dbFile);
  await initDatabase(db);
  const mutex = new engine.Mutex();
  const server = createServer({ db, mutex });
  server.listen(port, () => {
    console.log(`陶瓷馆藏核对服务已启动: http://127.0.0.1:${port} (数据库 ${dbFile})`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
