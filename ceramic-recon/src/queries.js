'use strict';
const { keyOf, parseKey, SOURCE_LABEL } = require('./db');

// 所有对外查询都在一个独立的只读快照事务里完成：
//   - 发布进行中（工作区事务未提交）仍读得到完整旧版，不会看到“列表变空”的中间态；
//   - 同一响应的多次查询共享同一快照，即使期间有新发布提交也不会新旧混版。
function withSnapshot(db, fn) {
  if (db.withReadSnapshot) return db.withReadSnapshot((s) => fn(s));
  return fn(db);
}

async function latestVersionRow(db) {
  const rows = await db.all('select * from publications order by version desc limit 1');
  return rows[0] || null;
}

async function getVersionRow(db, version) {
  const rows = await db.all('select * from publications where version = ?', [version]);
  return rows[0] || null;
}

async function listVersions(db) {
  return withSnapshot(db, async (s) => {
    const rows = await s.all(
      'select version, created_at, reason, stats from publications order by version'
    );
    return rows.map((r) => ({ ...r, stats: JSON.parse(r.stats) }));
  });
}

function shapeGroup(row) {
  return {
    gid: row.gid,
    fields: {
      name: row.name,
      mark: row.mark,
      material: row.material,
      height: row.height,
    },
    fieldSources: {
      name: row.name_src,
      mark: row.mark_src,
      material: row.material_src,
      height: row.height_src,
    },
  };
}

function shapeRecord(row) {
  return {
    source: row.source,
    id: row.source_id,
    name: row.name,
    mark: row.mark,
    material: row.material,
    height: row.height,
  };
}

// 当前馆藏（最新完整发布）
async function listGroups(db) {
  return withSnapshot(db, (s) => listGroupsIn(s));
}

async function listGroupsIn(db) {
  const ver = await latestVersionRow(db);
  if (!ver) return { published: false, groups: [] };
  const groupRows = await db.all('select * from live_groups order by gid');
  const memberRows = await db.all('select k, gid from live_members order by k');
  const membersByGid = new Map();
  for (const m of memberRows) {
    if (!membersByGid.has(m.gid)) membersByGid.set(m.gid, []);
    membersByGid.get(m.gid).push(m.k);
  }
  const groups = groupRows.map((gr) => ({
    ...shapeGroup(gr),
    members: (membersByGid.get(gr.gid) || []).sort(),
  }));
  return { published: true, version: ver.version, groups };
}

async function getGroup(db, gid) {
  return withSnapshot(db, (s) => getGroupIn(s, gid));
}

async function getGroupIn(db, gid) {
  const ver = await latestVersionRow(db);
  if (!ver) return null;
  const rows = await db.all('select * from live_groups where gid = ?', [gid]);
  if (!rows.length) return null;
  const members = await db.all('select k from live_members where gid = ? order by k', [gid]);
  const evidence = await db.all(
    `select k1, k2, confidence, evidence, outcome from evidence_events
     where version = ?
       and k1 in (select k from live_members where gid = ?)
       and k2 in (select k from live_members where gid = ?)
     order by k1, k2`,
    [ver.version, gid, gid]
  );
  return {
    version: ver.version,
    group: {
      ...shapeGroup(rows[0]),
      members: members.map((m) => m.k),
      matchEvidence: evidence.map((e) => ({ ...e, evidence: JSON.parse(e.evidence) })),
    },
  };
}

// 单条记录当前归属：字段只取已发布的 live_records 快照，
// 绝不读工作区 v_active_records，所以未发布的更正/撤回不会提前显示。
async function getRecord(db, source, id) {
  return withSnapshot(db, (s) => getRecordIn(s, source, id));
}

async function getRecordIn(db, source, id) {
  const ver = await latestVersionRow(db);
  if (!ver) return { published: false };
  const k = keyOf(source, id);
  const recRows = await db.all('select * from live_records where k = ?', [k]);
  if (!recRows.length) {
    // 未在最新发布中出现：区分“已发布后撤回”与“尚未发布（工作区新建或改动）”
    const hist = await db.all(
      `select rv_id, seq, batch_id, withdrawn_at, published_version
       from record_versions where source = ? and source_id = ? order by seq`,
      [source, id]
    );
    if (!hist.length) return { published: true, version: ver.version, found: false };
    const everPublished = hist.some((h) => h.published_version !== null);
    if (!everPublished) {
      return {
        published: true,
        version: ver.version,
        found: false,
        status: 'unpublished',
        history: hist,
      };
    }
    const withdrawn = hist.some((h) => h.withdrawn_at !== null);
    return {
      published: true,
      version: ver.version,
      found: false,
      status: withdrawn ? 'withdrawn' : 'absent',
      history: hist,
    };
  }
  const rec = recRows[0];
  const live = await db.all('select gid from live_members where k = ?', [k]);
  const gid = live.length ? live[0].gid : null;
  const gRow = gid ? await db.all('select * from live_groups where gid = ?', [gid]) : [];
  const members = gid
    ? await db.all('select k from live_members where gid = ? order by k', [gid])
    : [];
  const evidence = gid
    ? await db.all(
        `select k1, k2, confidence, evidence, outcome from evidence_events
         where version = ?
           and k1 in (select k from live_members where gid = ?)
           and k2 in (select k from live_members where gid = ?)
         order by k1, k2`,
        [ver.version, gid, gid]
      )
    : [];
  return {
    published: true,
    version: ver.version,
    found: true,
    record: { ...shapeRecord(rec), gid },
    group: gRow.length
      ? {
          ...shapeGroup(gRow[0]),
          members: members.map((m) => m.k),
          matchEvidence: evidence.map((e) => ({ ...e, evidence: JSON.parse(e.evidence) })),
        }
      : null,
  };
}

// 按版本重建某一版的馆藏（关系事件回放，用于审计历史发布版）
async function buildVersionSnapshot(db, version) {
  const groupEv = await db.all(
    'select * from group_events where version <= ? order by event_id',
    [version]
  );
  const memberEv = await db.all(
    'select * from membership_events where version <= ? order by event_id',
    [version]
  );
  const groups = new Map(); // gid -> { members:Set, fields, fieldSources }
  for (const e of groupEv) {
    if (e.op === 'open') {
      const payload = e.fields ? JSON.parse(e.fields) : {};
      groups.set(e.gid, {
        gid: e.gid,
        members: new Set(e.members ? JSON.parse(e.members) : []),
        fields: payload.fields || {},
        fieldSources: payload.fieldSources || {},
      });
    } else if (e.op === 'change') {
      const payload = e.fields ? JSON.parse(e.fields) : {};
      const g = groups.get(e.gid);
      if (g) {
        g.fields = payload.fields || g.fields;
        g.fieldSources = payload.fieldSources || g.fieldSources;
      }
    } else if (e.op === 'close') {
      groups.delete(e.gid);
    }
  }
  const gidOf = new Map();
  for (const [gid, g] of groups) {
    for (const m of g.members) gidOf.set(m, gid);
  }
  for (const e of memberEv) {
    if (e.op === 'leave') {
      const g = groups.get(e.gid);
      if (g) g.members.delete(e.k);
      gidOf.delete(e.k);
    } else if (e.op === 'join') {
      gidOf.set(e.k, e.gid);
      const g = groups.get(e.gid);
      if (g) g.members.add(e.k);
    }
  }
  return [...groups.values()]
    .map((g) => ({
      gid: g.gid,
      members: [...g.members].sort(),
      fields: g.fields,
      fieldSources: g.fieldSources,
    }))
    .filter((g) => g.members.length > 0)
    .sort((a, b) => (a.members[0] < b.members[0] ? -1 : 1));
}

// 版本详情：馆藏、字段出处、合并/拆分依据
async function versionDetail(db, version) {
  return withSnapshot(db, (s) => versionDetailIn(s, version));
}

async function versionDetailIn(db, version) {
  const row = await getVersionRow(db, version);
  if (!row) return null;
  // 上一版取“真实存在的最大更小版本”，不假设版本号连续
  const prevRows = await db.all(
    'select max(version) v from publications where version < ?',
    [version]
  );
  const prevVersion = prevRows[0] && prevRows[0].v != null ? Number(prevRows[0].v) : null;
  const groups = await buildVersionSnapshot(db, version);
  const prevGroups = prevVersion ? await buildVersionSnapshot(db, prevVersion) : [];
  const enriched = groups.map((g) => {
    const memberSet = new Set(g.members);
    const hits = prevGroups
      .filter((pg) => pg.members.some((m) => memberSet.has(m)))
      .map((pg) => ({ gid: pg.gid, shared: pg.members.filter((m) => memberSet.has(m)) }));
    const basis = { kind: 'new', predecessors: hits };
    if (hits.length > 1) basis.kind = 'merge';
    else if (hits.length === 1) {
      const prev = prevGroups.find((x) => x.gid === hits[0].gid);
      const prevSize = prev ? prev.members.length : 0;
      basis.kind =
        hits[0].shared.length === prevSize && hits[0].shared.length === g.members.length
          ? 'unchanged'
          : 'split';
    }
    return { ...g, lineageBasis: basis };
  });
  const evidence = await db.all('select * from evidence_events where version = ? order by event_id', [
    version,
  ]);
  const cutEdges = evidence
    .filter((e) => e.outcome === 'cut')
    .map((e) => ({
      k1: e.k1,
      k2: e.k2,
      confidence: e.confidence,
      evidence: JSON.parse(e.evidence),
      reason: '异件强制拆分，该匹配边被剪开（同分按编号固定规则处理）',
    }));
  return {
    version,
    createdAt: row.created_at,
    reason: row.reason,
    stats: JSON.parse(row.stats),
    groups: enriched,
    cutEdges,
  };
}

// 旧馆藏追查：逐条成员 → 当前归属或已撤回，及其跨版本归属链
async function traceGroup(db, gid, atVersion) {
  return withSnapshot(db, (s) => traceGroupIn(s, gid, atVersion));
}

async function traceGroupIn(db, gid, atVersion) {
  const ver = atVersion
    ? await getVersionRow(db, atVersion)
    : await latestVersionRow(db);
  if (!ver) return null;
  const thenGroups = await buildVersionSnapshot(db, ver.version);
  const g = thenGroups.find((x) => x.gid === gid);
  if (!g) return { found: false, gid };
  const curVer = await latestVersionRow(db);
  const allVersions = await db.all('select version from publications order by version');
  // 目标版本快照只依赖 <= 目标版本的事件；逐版回放也各自是独立快照
  const snapshots = new Map();
  for (const v of allVersions) {
    snapshots.set(v.version, await buildVersionSnapshot(db, v.version));
  }
  const members = await Promise.all(
    g.members.map(async (k) => {
      const { source, id } = parseKey(k);
      const curLive = await db.all('select gid from live_members where k = ?', [k]);
      let status;
      if (curLive.length) {
        status = { state: 'active', gid: curLive[0].gid };
      } else {
        const hist = await db.all(
          `select withdrawn_at, published_version from record_versions
           where source = ? and source_id = ? order by seq desc`,
          [source, id]
        );
        const everPublished = hist.some((h) => h.published_version !== null);
        const withdrawn = hist.some((h) => h.withdrawn_at !== null);
        let state = 'absent';
        if (!everPublished) state = 'unpublished';
        else if (withdrawn) state = 'withdrawn';
        status = { state };
      }
      // 归属链：逐版回放该成员所在 gid（用已算好的快照，避免混版）
      const chain = [];
      for (const v of allVersions) {
        const snap = snapshots.get(v.version);
        const hit = snap.find((sg) => sg.members.includes(k));
        chain.push({ version: v.version, gid: hit ? hit.gid : null });
      }
      return {
        key: k,
        source,
        sourceLabel: SOURCE_LABEL[source],
        id,
        current: status,
        chain,
      };
    })
  );
  return {
    found: true,
    gid,
    atVersion: ver.version,
    members,
    currentVersion: curVer ? curVer.version : null,
  };
}

async function workloadLog(db) {
  return withSnapshot(db, async (s) => {
    const rows = await s.all('select * from recompute_log order by version');
    return rows.map((r) => ({ ...r, touched_keys: JSON.parse(r.touched_keys) }));
  });
}

async function lineageRows(db) {
  return withSnapshot(db, (s) => s.all('select * from group_lineage order by gid'));
}

module.exports = {
  listVersions,
  listGroups,
  getGroup,
  getRecord,
  versionDetail,
  traceGroup,
  workloadLog,
  lineageRows,
  // 健康检查也走只读快照：发布事务进行中不会读到未提交的版本号
  latestVersion: (db) => withSnapshot(db, (s) => latestVersionRow(s)),
};
