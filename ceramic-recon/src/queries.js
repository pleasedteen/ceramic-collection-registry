'use strict';
const { keyOf, parseKey, SOURCE_LABEL } = require('./db');

async function latestVersionRow(db) {
  const rows = await db.all('select * from publications order by version desc limit 1');
  return rows[0] || null;
}

async function getVersionRow(db, version) {
  const rows = await db.all('select * from publications where version = ?', [version]);
  return rows[0] || null;
}

async function listVersions(db) {
  const rows = await db.all(
    'select version, created_at, reason, stats from publications order by version'
  );
  return rows.map((r) => ({ ...r, stats: JSON.parse(r.stats) }));
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

// 当前馆藏（最新完整发布）
async function listGroups(db) {
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
  const ver = await latestVersionRow(db);
  if (!ver) return null;
  const rows = await db.all('select * from live_groups where gid = ?', [gid]);
  if (!rows.length) return null;
  const members = await db.all('select k from live_members where gid = ? order by k', [gid]);
  const evidence = await db.all(
    'select k1, k2, confidence, evidence, outcome from evidence_events where version = ? and (k1 in (select k from live_members where gid = ?)) order by k1, k2',
    [ver.version, gid]
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

async function getRecord(db, source, id) {
  const ver = await latestVersionRow(db);
  if (!ver) return { published: false };
  const k = keyOf(source, id);
  const live = await db.all('select gid from live_members where k = ?', [k]);
  if (!live.length) {
    const hist = await db.all(
      'select rv_id, seq, batch_id, withdrawn_at from record_versions where source = ? and source_id = ? order by seq',
      [source, id]
    );
    if (!hist.length) return { published: true, found: false };
    return { published: true, found: false, status: 'withdrawn', history: hist };
  }
  const gid = live[0].gid;
  const gRow = await db.all('select * from live_groups where gid = ?', [gid]);
  const members = await db.all('select k from live_members where gid = ? order by k', [gid]);
  const recRows = await db.all(
    'select * from v_active_records where source = ? and source_id = ?',
    [source, id]
  );
  const evidence = await db.all(
    'select k1, k2, confidence, evidence, outcome from evidence_events where version = ? order by k1, k2',
    [ver.version]
  );
  const rec = recRows[0] || {};
  return {
    published: true,
    found: true,
    record: {
      source,
      id,
      name: rec.name,
      mark: rec.mark,
      material: rec.material,
      height: rec.height,
      gid,
    },
    group: {
      ...shapeGroup(gRow[0]),
      members: members.map((m) => m.k),
      matchEvidence: evidence
        .filter((e) => {
          const ks = members.map((m) => m.k);
          return ks.includes(e.k1) && ks.includes(e.k2);
        })
        .map((e) => ({ ...e, evidence: JSON.parse(e.evidence) })),
    },
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
      // 成员未变、沿用编号的馆藏发生字段/出处变化（如同编号改材质）
      const g = groups.get(e.gid);
      if (g) {
        const payload = e.fields ? JSON.parse(e.fields) : {};
        if (payload.fields) g.fields = payload.fields;
        if (payload.fieldSources) g.fieldSources = payload.fieldSources;
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
  const row = await getVersionRow(db, version);
  if (!row) return null;
  const groups = await buildVersionSnapshot(db, version);
  const prevGroups = version > 1 ? await buildVersionSnapshot(db, version - 1) : [];
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
  const ver = atVersion
    ? await getVersionRow(db, atVersion)
    : await latestVersionRow(db);
  if (!ver) return null;
  const thenGroups = await buildVersionSnapshot(db, ver.version);
  const g = thenGroups.find((x) => x.gid === gid);
  if (!g) return { found: false, gid };
  const curVer = await latestVersionRow(db);
  const allVersions = await db.all('select version from publications order by version');
  const members = await Promise.all(
    g.members.map(async (k) => {
      const { source, id } = parseKey(k);
      const curLive = await db.all('select gid from live_members where k = ?', [k]);
      let status;
      if (curLive.length) {
        status = { state: 'active', gid: curLive[0].gid };
      } else {
        const withdrawn = await db.all(
          'select 1 from record_versions where source = ? and source_id = ? and withdrawn_at is not null limit 1',
          [source, id]
        );
        status = { state: withdrawn.length ? 'withdrawn' : 'absent' };
      }
      // 归属链：逐版回放该成员所在 gid
      const chain = [];
      for (const v of allVersions) {
        const snap = await buildVersionSnapshot(db, v.version);
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
  const rows = await db.all('select * from recompute_log order by version');
  return rows.map((r) => ({ ...r, touched_keys: JSON.parse(r.touched_keys) }));
}

async function lineageRows(db) {
  return db.all('select * from group_lineage order by gid');
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
  latestVersion: latestVersionRow,
  buildVersionSnapshot,
};
