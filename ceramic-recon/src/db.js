'use strict';
const duckdb = require('duckdb');
const path = require('path');
const fs = require('fs');

const SOURCES = ['registry', 'repair', 'inventory'];
const SOURCE_LABEL = { registry: '登记', repair: '修复', inventory: '旧清册' };

function keyOf(source, id) {
  return `${source}|${id}`;
}
function parseKey(k) {
  const i = k.indexOf('|');
  return { source: k.slice(0, i), id: k.slice(i + 1) };
}

function openDatabase(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const raw = new duckdb.Database(file);
  const convert = (row) => {
    if (!row || typeof row !== 'object') return row;
    for (const k of Object.keys(row)) {
      if (typeof row[k] === 'bigint') row[k] = Number(row[k]);
    }
    return row;
  };
  const api = {
    raw,
    file,
    all(sql, params = []) {
      return new Promise((resolve, reject) => {
        const cb = (err, rows) =>
          err ? reject(err) : resolve(rows.map((r) => convert(r)));
        if (params.length === 0) raw.all(sql, cb);
        else raw.all(sql, ...params, cb);
      });
    },
    run(sql, params = []) {
      return new Promise((resolve, reject) => {
        const cb = (err) => (err ? reject(err) : resolve(undefined));
        if (params.length === 0) raw.run(sql, cb);
        else raw.run(sql, ...params, cb);
      });
    },
    // 分块执行 "where <col> in (...)"，避免超大参数展开导致栈溢出
    async allIn(sqlPrefix, col, values, sqlSuffix = '', chunkSize = 500) {
      const out = [];
      const list = [...values];
      for (let s = 0; s < list.length; s += chunkSize) {
        const part = list.slice(s, s + chunkSize);
        const ph = part.map(() => '?').join(',');
        const rows = await this.all(
          `${sqlPrefix} where ${col} in (${ph}) ${sqlSuffix}`,
          part
        );
        out.push(...rows);
      }
      return out;
    },
  };
  return api;
}

const SCHEMA = `
create sequence if not exists rv_seq;
create sequence if not exists gid_seq;
create table if not exists batches(
  batch_id varchar primary key,
  kind varchar not null,
  created_at bigint not null,
  withdrawn_at bigint,
  detail varchar not null
);
create table if not exists record_versions(
  rv_id bigint primary key default nextval('rv_seq'),
  source varchar not null,
  source_id varchar not null,
  seq integer not null,
  batch_id varchar not null,
  name varchar, mark varchar, material varchar,
  height double,
  withdrawn_at bigint,
  unique(source, source_id, seq)
);
create table if not exists heterology_edges(
  batch_id varchar primary key,
  k1 varchar not null,
  k2 varchar not null,
  created_at bigint not null,
  withdrawn_at bigint
);
create table if not exists publications(
  version integer primary key,
  created_at bigint not null,
  reason varchar,
  stats varchar not null,
  -- 2 = 带逐版证据历史语义；旧库经迁移后既有版本标为 1（解释缺证）
  format_version integer not null default 2
);
create table if not exists group_lineage(
  gid varchar primary key,
  born_version integer,
  closed_version integer
);
create table if not exists recompute_log(
  version integer not null,
  touched_keys varchar not null,
  source_records_read integer not null,
  comparisons integer not null,
  new_group_rows integer not null,
  evidence_changes integer not null default 0,
  duration_ms integer not null
);
create table if not exists outbox(
  k varchar not null,
  reason varchar not null
);
-- 分块索引：按规范化品名/刻款维护成员，支持增量发布按索引定位候选而不扫描全库
create table if not exists block_name(
  nname varchar not null,
  k varchar not null,
  primary key(nname, k)
);
create table if not exists block_mark(
  nmark varchar not null,
  k varchar not null,
  primary key(nmark, k)
);

-- ===== 关系化当前态（最新发布版的物化结果，查询只读到完整发布）=====
create table if not exists live_groups(
  gid varchar primary key,
  name varchar, name_src varchar,
  mark varchar, mark_src varchar,
  material varchar, material_src varchar,
  height double, height_src varchar
);
create table if not exists live_members(
  k varchar primary key,
  gid varchar not null
);

-- ===== 只追加的历史事件（审计与按版本重建依据）=====
create table if not exists group_events(
  event_id bigint primary key default nextval('rv_seq'),
  version integer not null,
  gid varchar not null,
  op varchar not null,
  fields varchar,
  members varchar
);
create table if not exists membership_events(
  event_id bigint primary key default nextval('rv_seq'),
  version integer not null,
  k varchar not null,
  gid varchar,
  op varchar not null
);
-- 证据历史：只记录“发生变化的边”。某版某条边的有效证据取 version<=该版的最新事件。
-- outcome: joined（实际促成归并）/ cut（被拒匹配边）/ removed（边消失或不再达到阈值）
-- block_kind / block_batches：cut 时记录当时阻断它的判异批次（direct 直判异 / indirect 间接阻断）
create table if not exists evidence_events(
  event_id bigint primary key default nextval('rv_seq'),
  version integer not null,
  format_version integer not null default 2,
  k1 varchar not null,
  k2 varchar not null,
  confidence double,
  evidence varchar,
  outcome varchar not null,
  contributed boolean,
  block_kind varchar,
  block_batches varchar
);
-- 馆藏证据完整起始版：自该版起该馆藏的证据历史被完整跟踪（升级前的老馆藏无此记录 ⇒ 缺证）
create table if not exists group_evidence_state(
  gid varchar primary key,
  since_version integer not null
);
create index if not exists idx_group_events_ver on group_events(version);
create index if not exists idx_membership_events_ver on membership_events(version);
create index if not exists idx_membership_events_k on membership_events(k);
create index if not exists idx_membership_events_gid on membership_events(gid);
create index if not exists idx_evidence_ver on evidence_events(version);
create index if not exists idx_evidence_k1 on evidence_events(k1);
create index if not exists idx_evidence_k2 on evidence_events(k2);
create index if not exists idx_evidence_edge on evidence_events(k1, k2, version);
create view if not exists v_active_records as
select rv.*
from record_versions rv
join (
  select source, source_id, max(seq) as seq
  from record_versions
  where withdrawn_at is null
  group by 1, 2
) m on m.source = rv.source and m.source_id = rv.source_id and m.seq = rv.seq
where rv.withdrawn_at is null;
create view if not exists v_active_heterology as
select batch_id, k1, k2, created_at
from heterology_edges
where withdrawn_at is null;
`;

const CURRENT_FORMAT = 2;

// 旧库升级：补齐新列，把既有版本标记为旧格式（1），其解释视为缺证。
// 幂等：重复执行无副作用。
async function migrate(db) {
  const cols = async (table) =>
    (await db.all(
      `select column_name from information_schema.columns where table_name = ?`,
      [table]
    )).map((r) => r.column_name);
  const addCol = async (table, col, decl) => {
    const have = await cols(table);
    if (!have.includes(col)) await db.run(`alter table ${table} add column ${col} ${decl}`);
  };

  await addCol('publications', 'format_version', `integer default ${CURRENT_FORMAT - 1}`);
  await addCol('recompute_log', 'evidence_changes', 'integer default 0');
  await addCol('evidence_events', 'format_version', 'integer default 1');
  await addCol('evidence_events', 'block_kind', 'varchar');
  await addCol('evidence_events', 'block_batches', 'varchar');
  await addCol('evidence_events', 'contributed', 'boolean');
  // evidence_events.confidence / evidence 在旧库中为 not null；缺证行允许为空
  try {
    await db.run('alter table evidence_events alter column confidence drop not null');
  } catch {
    /* 已可空 */
  }
  try {
    await db.run('alter table evidence_events alter column evidence drop not null');
  } catch {
    /* 已可空 */
  }
  // 迁移前已存在的版本，其证据历史不完整 → 标记为旧格式（format_version = 1）
  await db.run(`update publications set format_version = ${CURRENT_FORMAT - 1} where format_version is null`);
  await db.run('update publications set format_version = 1 where format_version = 0');
  await db.run('update recompute_log set evidence_changes = 0 where evidence_changes is null');
  await db.run('update evidence_events set format_version = 1 where format_version is null');
}

async function initDatabase(db) {
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.run(stmt);
  }
  await migrate(db);
}

module.exports = {
  openDatabase,
  initDatabase,
  CURRENT_FORMAT,
  SOURCES,
  SOURCE_LABEL,
  keyOf,
  parseKey,
};
