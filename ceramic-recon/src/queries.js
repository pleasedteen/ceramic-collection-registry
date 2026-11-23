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

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// 按“成员去向”统计合并与拆分：
//   - 合并：某新馆藏的成员来自 ≥2 个旧馆藏（每条 ≥1 名成员）；
//   - 拆分：某旧馆藏的幸存成员流向 ≥2 个新馆藏。
//   仅扩员（吸收全新记录）或仅撤回成员（幸存者仍聚在同一馆藏）都不算拆分；
//   交叉重组（旧馆藏被拆到多处、新馆藏又由多处汇入）可同时计入两类。
function summarizeLineage(prevGroups, groups) {
  const prevMemberToGid = new Map();
  for (const pg of prevGroups) for (const m of pg.members) prevMemberToGid.set(m, pg.gid);
  const succMemberToGid = new Map();
  for (const g of groups) for (const m of g.members) succMemberToGid.set(m, g.gid);
  const prevByGid = new Map(prevGroups.map((p) => [p.gid, p]));

  // 各新馆藏的贡献者（旧馆藏 -> 汇入的成员）
  const contributorsBySucc = new Map();
  for (const g of groups) {
    const c = new Map();
    for (const m of g.members) {
      const pg = prevMemberToGid.get(m);
      if (pg === undefined) continue;
      if (!c.has(pg)) c.set(pg, []);
      c.get(pg).push(m);
    }
    contributorsBySucc.set(g.gid, c);
  }
  // 各旧馆藏的成员去向（新馆藏 -> 流入的幸存成员）；撤回/消失的成员不计
  const destByPrev = new Map();
  for (const pg of prevGroups) {
    const d = new Map();
    for (const m of pg.members) {
      const sg = succMemberToGid.get(m);
      if (sg === undefined) continue;
      if (!d.has(sg)) d.set(sg, []);
      d.get(sg).push(m);
    }
    destByPrev.set(pg.gid, d);
  }

  const splitGids = new Set();
  for (const [pgid, d] of destByPrev) if (d.size >= 2) splitGids.add(pgid);

  const merges = [];
  const splits = [];
  const byGid = new Map();
  for (const g of groups) {
    const contrib = contributorsBySucc.get(g.gid);
    const isMerge = contrib.size >= 2;
    const isPartOfSplit = [...contrib.keys()].some((pg) => splitGids.has(pg));
    let unchanged = false;
    let gained = false;
    let lost = false;
    if (contrib.size === 1) {
      const [pgid, shared] = [...contrib.entries()][0];
      const prev = prevByGid.get(pgid);
      const prevMembers = new Set(prev.members);
      const curMembers = new Set(g.members);
      unchanged = sameSet(prevMembers, curMembers);
      gained = g.members.length > shared.length; // 含无旧归属的全新记录（扩员）
      lost = prev.members.length > shared.length; // 旧成员未出现在此（撤回或移出）
    }
    let kind;
    if (contrib.size === 0) kind = 'new';
    else if (isMerge && isPartOfSplit) kind = 'merge+split';
    else if (isMerge) kind = 'merge';
    else if (isPartOfSplit) kind = 'split';
    else if (unchanged) kind = 'unchanged';
    else if (gained && !lost) kind = 'expanded';
    else if (lost && !gained) kind = 'contracted';
    else kind = 'changed';

    const predecessors = [...contrib.entries()]
      .map(([gid, shared]) => ({ gid, shared: shared.slice().sort() }))
      .sort((a, b) => (a.gid < b.gid ? -1 : 1));
    byGid.set(g.gid, { kind, merge: isMerge, split: isPartOfSplit, predecessors });
    if (isMerge) merges.push({ gid: g.gid, contributors: predecessors });
  }
  for (const pg of prevGroups) {
    const d = destByPrev.get(pg.gid);
    if (!d || d.size < 2) continue;
    const destinations = [...d.entries()]
      .map(([gid, moved]) => ({ gid, members: moved.slice().sort() }))
      .sort((a, b) => (a.gid < b.gid ? -1 : 1));
    splits.push({ gid: pg.gid, members: pg.members.slice(), destinations });
  }
  merges.sort((a, b) => (a.gid < b.gid ? -1 : 1));
  splits.sort((a, b) => (a.gid < b.gid ? -1 : 1));
  return { byGid, merges, splits };
}

// 版本详情：馆藏、字段出处、合并/拆分依据、逐边裁决
// 所有依据都来自只追加事件，撤回判异或重开同一数据库后仍可回放旧版本。
async function versionDetail(db, version) {
  const row = await getVersionRow(db, version);
  if (!row) return null;
  const groups = await buildVersionSnapshot(db, version);
  const prevGroups = version > 1 ? await buildVersionSnapshot(db, version - 1) : [];

  const lineage = summarizeLineage(prevGroups, groups);
  const enriched = groups.map((g) => ({ ...g, lineageBasis: lineage.byGid.get(g.gid) }));

  // 受影响子图（本次发布实际重算的键）与逐边裁决
  const logRows = await db.all('select * from recompute_log where version = ?', [version]);
  const affectedKeys = logRows.length ? JSON.parse(logRows[0].touched_keys) : [];

  const evidence = await db.all('select * from evidence_events where version = ? order by event_id', [
    version,
  ]);
  /** @type {{ connected: any[], redundant: any[], cut: any[], unknown: any[] }} */
  const edges = { connected: [], redundant: [], cut: [], unknown: [] };
  // seq = 边的处理次序（同一发布内按置信度降序、同分固定规则）。把四类边按 seq
  // 归并即可独立复算：逐边并查集，connected 合并、redundant/cut 不合并。
  let seq = 0;
  for (const e of evidence) {
    const shaped = {
      seq: seq++,
      k1: e.k1,
      k2: e.k2,
      confidence: e.confidence,
      evidence: JSON.parse(e.evidence),
      outcome: e.outcome,
    };
    if (e.outcome === 'connected' || e.outcome === 'redundant') {
      edges[e.outcome].push(shaped);
    } else if (e.outcome === 'cut') {
      edges.cut.push({
        ...shaped,
        blockedByBatch: e.blocked_by_batch || null,
        blockedPair: e.blocked_pair ? JSON.parse(e.blocked_pair) : null,
        reason:
          e.cut_reason === 'heterology'
            ? '该匹配边两端即有效异件对，被异件判定直接剪开'
            : '合并会使某条有效异件判定两端同组，故跳过该边',
      });
    } else {
      // 旧库只记录 joined/cut，无法区分实际连通与冗余匹配
      edges.unknown.push({ ...shaped, legacyOutcome: e.outcome });
    }
  }
  const orderedEdges = [...edges.connected, ...edges.redundant, ...edges.cut, ...edges.unknown].sort(
    (a, b) => a.seq - b.seq
  );

  // 当版有效异件判定快照（只追加）
  const heterology = await db.all(
    'select k1, k2, batch_id from heterology_events where version = ? order by event_id',
    [version]
  );

  // 旧库（升级前写入）没有可完整还原的依据：audit_complete 为空即标明缺失
  const complete = row.audit_complete === true;
  const edgeDispositionComplete =
    complete && edges.unknown.length === 0 && edges.cut.every((e) => e.blockedByBatch);
  const heterologyBasisComplete = complete;
  const missing = [];
  if (!edgeDispositionComplete) {
    missing.push('edgeDisposition：旧库未记录逐边“实际连通/冗余匹配/被异件拦下”的区分');
  }
  if (!heterologyBasisComplete) {
    missing.push('heterologyBasis：旧库未保存当版有效异件判定快照');
  }
  if (edges.cut.some((e) => !e.blockedByBatch)) {
    missing.push('cutBlockedBy：旧库未记录拦下匹配边的异件批次');
  }

  return {
    version,
    createdAt: row.created_at,
    reason: row.reason,
    stats: JSON.parse(row.stats),
    audit: {
      complete,
      edgeDispositionComplete,
      heterologyBasisComplete,
      missing,
    },
    affectedKeys,
    mergeSplit: {
      mergeCount: lineage.merges.length,
      splitCount: lineage.splits.length,
      merges: lineage.merges,
      splits: lineage.splits,
    },
    groups: enriched,
    edges,
    // 逐边处理次序（可独立复算归组）：按 seq 逐边并查集即可重现分组
    edgeOrder: orderedEdges.map((e) => ({ seq: e.seq, k1: e.k1, k2: e.k2, outcome: e.outcome || 'legacy' })),
    heterology,
    // 向后兼容字段：剪开的边（含拦下它的异件批次）
    cutEdges: edges.cut,
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
