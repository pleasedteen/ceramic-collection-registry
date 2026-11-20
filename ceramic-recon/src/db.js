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
  stats varchar not null
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
create table if not exists evidence_events(
  event_id bigint primary key default nextval('rv_seq'),
  version integer not null,
  k1 varchar not null,
  k2 varchar not null,
  confidence double not null,
  evidence varchar not null,
  outcome varchar not null,
  -- 被剪边记录阻挡它的有效判异（JSON 数组：batchId/k1/k2）；非剪边为空数组。
  -- 旧库无此列时由下方 ALTER 补上，历史行为 NULL ⇒ 证据不足，查询时单独标出。
  blocked_by varchar
);
create index if not exists idx_group_events_ver on group_events(version);
create index if not exists idx_membership_events_ver on membership_events(version);
create index if not exists idx_membership_events_k on membership_events(k);
create index if not exists idx_evidence_ver on evidence_events(version);
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

async function initDatabase(db) {
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.run(stmt);
  }
  // 旧库升级：早期 evidence_events 没有 blocked_by 列，补列后历史行保持 NULL，
  // 查询侧据此把“旧库证据不足”的剪边单独标出，不臆造判异批次。
  const cols = await db.all(
    "select column_name from information_schema.columns where table_name = 'evidence_events'"
  );
  if (!cols.some((c) => c.column_name === 'blocked_by')) {
    await db.run('alter table evidence_events add column blocked_by varchar');
  }
}

module.exports = { openDatabase, initDatabase, SOURCES, SOURCE_LABEL, keyOf, parseKey };
