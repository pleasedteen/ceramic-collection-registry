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
  const memberSet = new Set(members.map((m) => m.k));
  const evidence = await db.all(
    'select * from evidence_events where version = ? order by k1, k2',
    [ver.version]
  );
  const shaped = evidence.map(shapeEvidenceRow);
  return {
    version: ver.version,
    group: {
      ...shapeGroup(rows[0]),
      members: members.map((m) => m.k),
      // 馆藏内匹配证据：两端都在本馆藏的边（joined 真正促成归并，redundant 为冗余）
      matchEvidence: shaped.filter((e) => memberSet.has(e.k1) && memberSet.has(e.k2)),
      // 被剪边：只要有一端在本馆藏就列出，便于查“哪条判异拦下了本馆藏的去路”
      cutEdges: shaped
        .filter((e) => e.outcome === 'cut' && (memberSet.has(e.k1) || memberSet.has(e.k2)))
        .map((e) => ({
          k1: e.k1,
          k2: e.k2,
          confidence: e.confidence,
          evidence: e.evidence,
          blockedBy: e.blockedBy,
          blockedByBatchIds: e.blockedByBatchIds,
          evidenceIncomplete: e.evidenceIncomplete,
        })),
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
    'select * from evidence_events where version = ? order by k1, k2',
    [ver.version]
  );
  const rec = recRows[0] || {};
  const memberSet = new Set(members.map((m) => m.k));
  const shaped = evidence.map(shapeEvidenceRow);
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
      matchEvidence: shaped.filter((e) => memberSet.has(e.k1) && memberSet.has(e.k2)),
      cutEdges: shaped
        .filter((e) => e.outcome === 'cut' && (memberSet.has(e.k1) || memberSet.has(e.k2)))
        .map((e) => ({
          k1: e.k1,
          k2: e.k2,
          confidence: e.confidence,
          evidence: e.evidence,
          blockedBy: e.blockedBy,
          blockedByBatchIds: e.blockedByBatchIds,
          evidenceIncomplete: e.evidenceIncomplete,
        })),
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
      // 成员未变但字段更新：刷新本版展示的字段，保留成员集合
      const g = groups.get(e.gid);
      if (g && e.fields) {
        const payload = JSON.parse(e.fields);
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

// 版本详情：馆藏、字段出处、按成员去向的归并/扩员/拆分依据、被剪边
const LINEAGE_LABEL = {
  new: '新建',
  unchanged: '不变',
  growth: '扩员',
  split: '拆分',
  merge: '合并',
};

// 版本发布时记录的每条匹配边（含被剪原因）。老版本若没有 blocked_by 列数据，
// 说明是旧库在补齐该列之前发布的，标记 evidenceIncomplete，不臆造判异批次。
function shapeEvidenceRow(e) {
  const raw = e.blocked_by === null || e.blocked_by === undefined ? null : String(e.blocked_by);
  const blockedBy = raw === null ? [] : JSON.parse(raw);
  return {
    k1: e.k1,
    k2: e.k2,
    confidence: e.confidence,
    evidence: JSON.parse(e.evidence),
    outcome: e.outcome,
    blockedBy,
    blockedByBatchIds: blockedBy.map((b) => b.batchId),
    evidenceIncomplete: raw === null,
  };
}

// 按成员去向判定本版馆藏与上一版馆藏的关系。成员去向指：
//   原馆藏成员是否全部留在本馆藏（留在原馆藏/迁往他馆藏），以及本馆藏是否纳入新成员。
//   1 个前身且其成员全部留下、仅新增记录 ⇒ 扩员 growth；
//   1 个前身但其成员有一部分迁走 ⇒ 拆分 split；
//   ≥2 个前身 ⇒ 合并 merge。
function describeLineage(group, prevGroups, prevGidByMember) {
  const memberSet = new Set(group.members);
  const sourceGids = new Set();
  const addedMembers = [];
  for (const m of group.members) {
    const g = prevGidByMember.get(m);
    if (g) sourceGids.add(g);
    else addedMembers.push(m);
  }
  const predecessors = [...sourceGids]
    .sort()
    .map((gid) => {
      const pg = prevGroups.find((x) => x.gid === gid);
      return { gid, shared: pg.members.filter((m) => memberSet.has(m)) };
    });
  const departedMembers = [];
  for (const pg of predecessors) {
    const prev = prevGroups.find((x) => x.gid === pg.gid);
    for (const m of prev.members) {
      if (!memberSet.has(m)) departedMembers.push(m);
    }
  }

  let kind;
  if (sourceGids.size === 0) kind = 'new';
  else if (sourceGids.size >= 2) kind = 'merge';
  else {
    const only = prevGroups.find((x) => x.gid === predecessors[0].gid);
    const keptAll = only.members.every((m) => memberSet.has(m));
    if (!keptAll) kind = 'split';
    else if (addedMembers.length > 0) kind = 'growth';
    else kind = 'unchanged';
  }
  return {
    kind,
    label: LINEAGE_LABEL[kind],
    predecessors,
    addedMembers: addedMembers.sort(),
    departedMembers: departedMembers.sort(),
  };
}

async function versionDetail(db, version) {
  const row = await getVersionRow(db, version);
  if (!row) return null;
  const groups = await buildVersionSnapshot(db, version);
  const prevGroups = version > 1 ? await buildVersionSnapshot(db, version - 1) : [];
  const prevGidByMember = new Map();
  for (const pg of prevGroups) for (const m of pg.members) prevGidByMember.set(m, pg.gid);

  const evidence = await db.all(
    'select * from evidence_events where version = ? order by event_id',
    [version]
  );
  const shaped = evidence.map(shapeEvidenceRow);
  const versionEvidenceIncomplete = shaped.some((e) => e.evidenceIncomplete);

  const enriched = groups.map((g) => {
    const memberSet = new Set(g.members);
    const lineageBasis = describeLineage(g, prevGroups, prevGidByMember);
    // 归并依据只列真正促成归并的匹配边（两端都在本馆藏内、且处理结果为 joined）；
    // 两端已连通的冗余边不列入。旧库没有 blocked_by 列，无法区分当时记成 joined
    // 的边里哪些是冗余边，因此整版标为 evidenceIncomplete，条目保留但标注未核实。
    const ownEvidence = shaped.filter((e) => memberSet.has(e.k1) && memberSet.has(e.k2));
    const contributingEdges = ownEvidence
      .filter((e) => e.outcome === 'joined')
      .map((e) => ({
        k1: e.k1,
        k2: e.k2,
        confidence: e.confidence,
        evidence: e.evidence,
        verified: !e.evidenceIncomplete,
      }));
    return {
      ...g,
      lineageBasis: {
        ...lineageBasis,
        contributingEdges,
        // 只有本版实际比较过（留下证据边）的馆藏才谈得上证据不足；
        // 未重算的旧馆藏本版没有新依据，不算证据不足。
        evidenceIncomplete: versionEvidenceIncomplete && ownEvidence.length > 0,
      },
    };
  });

  const cutEdges = shaped
    .filter((e) => e.outcome === 'cut')
    .map((e) => ({
      k1: e.k1,
      k2: e.k2,
      confidence: e.confidence,
      evidence: e.evidence,
      blockedBy: e.blockedBy,
      blockedByBatchIds: e.blockedByBatchIds,
      evidenceIncomplete: e.evidenceIncomplete,
      reason: e.evidenceIncomplete
        ? '旧库证据不足：该版发布时未记录阻挡它的判异批次'
        : e.blockedByBatchIds.length
          ? `被判异批次 ${e.blockedByBatchIds.join('、')} 挡下，该匹配边被剪开（同分按编号固定规则处理）`
          : '该匹配边被剪开（同分按编号固定规则处理）',
    }));
  return {
    version,
    createdAt: row.created_at,
    reason: row.reason,
    stats: JSON.parse(row.stats),
    evidenceIncomplete: versionEvidenceIncomplete,
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
};
