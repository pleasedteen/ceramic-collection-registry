'use strict';
const { keyOf, parseKey, SOURCE_LABEL, CURRENT_FORMAT } = require('./db');

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
    'select version, created_at, reason, stats, format_version from publications order by version'
  );
  return rows.map((r) => ({
    ...r,
    stats: JSON.parse(r.stats),
    evidenceComplete: Number(r.format_version) >= CURRENT_FORMAT,
  }));
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

function parseEvidenceRow(r) {
  let evidence = null;
  if (r.evidence !== null && r.evidence !== undefined) {
    try {
      evidence = JSON.parse(r.evidence);
    } catch {
      evidence = null;
    }
  }
  let blockingPairs = [];
  if (r.block_batches !== null && r.block_batches !== undefined) {
    try {
      blockingPairs = JSON.parse(r.block_batches);
    } catch {
      blockingPairs = [];
    }
  }
  return {
    k1: r.k1,
    k2: r.k2,
    confidence: r.confidence === null || r.confidence === undefined ? null : r.confidence,
    evidence,
    outcome: r.outcome,
    contributed: r.contributed === null || r.contributed === undefined ? null : !!r.contributed,
    blockKind: r.block_kind || null,
    blockingPairs,
    recordedVersion: r.version,
    formatVersion: r.format_version === null || r.format_version === undefined ? null : Number(r.format_version),
  };
}

// 读取某一版下“每条边的最新有效证据”。证据历史只存变化，因此取 version<=V 的最新事件。
// filterKeys 非空时只读取至少一端落在这些成员内的边——单馆藏复核的读取量因此只随
// 该馆藏相关边增长，不随无关发布增长。
async function loadEvidence(db, version, filterKeys) {
  const base = `select q.k1, q.k2, q.outcome, q.confidence, q.evidence, q.contributed,
                       q.block_kind, q.block_batches, q.version, q.format_version
                from (
                  select k1, k2, outcome, confidence, evidence, contributed, block_kind,
                         block_batches, version, format_version,
                         row_number() over (partition by k1, k2 order by event_id desc) rn
                  from evidence_events where version <= ?`;
  const rows = [];
  let historyRowsRead = 0;
  if (filterKeys && filterKeys.length) {
    const list = [...filterKeys];
    for (let s = 0; s < list.length; s += 400) {
      const part = list.slice(s, s + 400);
      const ph = part.map(() => '?').join(',');
      const countRow = await db.all(
        `select count(*) c from evidence_events where version <= ? and (k1 in (${ph}) or k2 in (${ph}))`,
        [version, ...part, ...part]
      );
      historyRowsRead += Number(countRow[0].c);
      const got = await db.all(
        `${base} and (k1 in (${ph}) or k2 in (${ph}))
                ) q where q.rn = 1 and q.outcome in ('joined', 'cut')`,
        [version, ...part, ...part]
      );
      rows.push(...got);
    }
  } else {
    const countRow = await db.all(
      'select count(*) c from evidence_events where version <= ?',
      [version]
    );
    historyRowsRead = Number(countRow[0].c);
    rows.push(
      ...(await db.all(
        `${base}) q where q.rn = 1 and q.outcome in ('joined', 'cut')`,
        [version]
      ))
    );
  }
  const byToken = new Map();
  for (const r of rows) {
    const parsed = parseEvidenceRow(r);
    byToken.set(`${parsed.k1}#${parsed.k2}`, parsed);
  }
  return { edges: byToken, examined: rows.length, historyRowsRead };
}

// 证据完整性：升级前（format_version 旧）或该馆藏未被完整跟踪的版本 ⇒ 缺证。
// 老库仍可查询，只是把无法证实的部分标为缺证。
async function evidenceCompleteness(db, version, pubRow, gid) {
  const stateRows = await db.all('select since_version from group_evidence_state where gid = ?', [gid]);
  const since = stateRows.length ? Number(stateRows[0].since_version) : null;
  const versionFormat = pubRow ? Number(pubRow.format_version) : null;
  const reasons = [];
  if (versionFormat === null || versionFormat < CURRENT_FORMAT) {
    reasons.push('该发布版早于证据历史升级，边级解释不完整');
  }
  if (since === null) {
    reasons.push('该馆藏升级前已存在，未被完整跟踪证据历史');
  } else if (since > version) {
    reasons.push('该馆藏在此版本尚未被完整跟踪证据历史');
  }
  return { complete: reasons.length === 0, reasons, evidenceSinceVersion: since };
}

// 单馆藏解释：促成归并的匹配边、与该馆藏成员相接的被拒匹配边及当时阻断它的判异批次。
function explainGroup(gid, members, edgeMap, completeness) {
  const memberSet = new Set(members);
  const contributing = [];
  const internal = [];
  const rejected = [];
  for (const e of edgeMap.values()) {
    if (e.outcome === 'joined') {
      if (memberSet.has(e.k1) && memberSet.has(e.k2)) {
        internal.push(e);
        if (e.contributed) contributing.push(e);
      }
      continue;
    }
    if (e.outcome === 'cut') {
      if (memberSet.has(e.k1) || memberSet.has(e.k2)) {
        rejected.push({
          ...e,
          // 阻断它的判异批次（direct 直判异 / indirect 间接阻断）
          blockedBy: {
            kind: e.blockKind,
            pairs: e.blockingPairs.map((p) => ({
              k1: p.k1,
              k2: p.k2,
              batchId: p.batchId || null,
            })),
          },
          blockedByBatches: [...new Set(e.blockingPairs.map((p) => p.batchId).filter(Boolean))],
        });
      }
    }
  }
  const sortEdge = (a, b) =>
    a.k1 !== b.k1 ? (a.k1 < b.k1 ? -1 : 1) : a.k2 < b.k2 ? -1 : a.k2 > b.k2 ? 1 : 0;
  contributing.sort(sortEdge);
  internal.sort(sortEdge);
  rejected.sort(sortEdge);
  return {
    contributingEdges: contributing,
    internalEdges: internal,
    rejectedEdges: rejected,
    evidenceStatus: completeness,
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

// 按版本重建某一版的全部馆藏（关系事件回放，用于版本详情/全量审计）
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
      const g = groups.get(e.gid);
      if (g) {
        const payload = e.fields ? JSON.parse(e.fields) : {};
        g.fields = payload.fields || {};
        g.fieldSources = payload.fieldSources || {};
      }
    } else if (e.op === 'close') {
      groups.delete(e.gid);
    }
  }
  for (const e of memberEv) {
    if (e.op === 'leave') {
      const g = groups.get(e.gid);
      if (g) g.members.delete(e.k);
    } else if (e.op === 'join') {
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

// 按版本重建“单个馆藏”：只读该 gid 自身的生命周期事件与成员加入/离开事件。
// 读取量只随该馆藏的历史增长，不随无关发布/其他馆藏增长。
async function buildGroupAt(db, gid, version) {
  const openEv = await db.all(
    'select * from group_events where gid = ? and version <= ? order by event_id',
    [gid, version]
  );
  if (!openEv.length) return null;
  const open = openEv.find((e) => e.op === 'open');
  if (!open) return null;
  const closed = openEv.some((e) => e.op === 'close');
  if (closed) return null;
  // 该馆藏在目标版本时是否仍打开：最后一条生命周期事件必须是 open/change
  const lastLife = openEv[openEv.length - 1];
  if (lastLife.op === 'close') return null;
  let fields = {};
  let fieldSources = {};
  for (const e of openEv) {
    if (e.op === 'open' || e.op === 'change') {
      const payload = e.fields ? JSON.parse(e.fields) : {};
      fields = payload.fields || {};
      fieldSources = payload.fieldSources || {};
    }
  }
  const members = new Set(open.members ? JSON.parse(open.members) : []);
  const memberEv = await db.all(
    'select k, op from membership_events where gid = ? and version <= ? order by version, event_id',
    [gid, version]
  );
  for (const e of memberEv) {
    if (e.op === 'leave') members.delete(e.k);
    else if (e.op === 'join') members.add(e.k);
  }
  const sorted = [...members].sort();
  if (!sorted.length) return null;
  return { gid, members: sorted, fields, fieldSources };
}

// 单个馆藏：默认最新发布，可指定 atVersion 复核历史版。
// 返回实际促成归并的匹配边、与该馆藏成员相接的被拒匹配边及阻断它的判异批次。
async function getGroup(db, gid, atVersion) {
  const ver = atVersion ? await getVersionRow(db, atVersion) : await latestVersionRow(db);
  if (!ver) return null;
  let g;
  if (!atVersion) {
    // 最新版直接读物化当前态（不重放全量历史），单馆藏复核读取量不随无关发布增长。
    const rows = await db.all('select * from live_groups where gid = ?', [gid]);
    if (!rows.length) return null;
    const members = await db.all('select k from live_members where gid = ? order by k', [gid]);
    const shaped = shapeGroup(rows[0]);
    g = { gid, members: members.map((m) => m.k), fields: shaped.fields, fieldSources: shaped.fieldSources };
  } else {
    g = await buildGroupAt(db, gid, ver.version);
    if (!g) return null;
  }
  const { edges, examined, historyRowsRead } = await loadEvidence(db, ver.version, g.members);
  const completeness = await evidenceCompleteness(db, ver.version, ver, gid);
  const explanation = explainGroup(gid, g.members, edges, completeness);
  return {
    version: ver.version,
    requestedVersion: ver.version,
    group: {
      gid,
      members: g.members,
      fields: g.fields,
      fieldSources: g.fieldSources,
      matchEvidence: explanation.internalEdges,
      contributingEdges: explanation.contributingEdges,
      rejectedEdges: explanation.rejectedEdges,
      evidenceStatus: explanation.evidenceStatus,
    },
    evidenceRead: { edgesExamined: examined, historyRowsRead },
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
  const memberKeys = members.map((m) => m.k);
  const { edges } = await loadEvidence(db, ver.version, memberKeys);
  const completeness = await evidenceCompleteness(db, ver.version, ver, gid);
  const explanation = explainGroup(gid, memberKeys, edges, completeness);
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
      members: memberKeys,
      matchEvidence: explanation.internalEdges,
      contributingEdges: explanation.contributingEdges,
      rejectedEdges: explanation.rejectedEdges,
      evidenceStatus: explanation.evidenceStatus,
    },
  };
}

// 版本详情：馆藏、字段出处、合并/拆分依据、逐馆藏证据解释与被剪开的边。
async function versionDetail(db, version) {
  const row = await getVersionRow(db, version);
  if (!row) return null;
  const groups = await buildVersionSnapshot(db, version);
  const prevGroups = version > 1 ? await buildVersionSnapshot(db, version - 1) : [];
  const allKeys = [...new Set(groups.flatMap((g) => g.members))];
  const { edges: edgeMap } = await loadEvidence(db, version, allKeys);
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
    const explanation = explainGroup(g.gid, g.members, edgeMap, null);
    return {
      ...g,
      lineageBasis: basis,
      contributingEdges: explanation.contributingEdges,
      rejectedEdges: explanation.rejectedEdges,
    };
  });
  const completeness = await evidenceCompletenessForAll(db, version, row, groups);
  const cutEdges = [];
  for (const e of edgeMap.values()) {
    if (e.outcome !== 'cut') continue;
    cutEdges.push({
      k1: e.k1,
      k2: e.k2,
      confidence: e.confidence,
      evidence: e.evidence,
      blockKind: e.blockKind,
      blockingPairs: e.blockingPairs,
      blockedByBatches: [...new Set(e.blockingPairs.map((p) => p.batchId).filter(Boolean))],
      reason:
        e.blockKind === 'indirect'
          ? '合并会使另一条有效异件判定两端同组，该匹配边被间接阻断'
          : e.blockKind === 'direct'
            ? '异件强判该匹配边，直接剪开'
            : '该版早于证据历史升级，未记录阻断它的判异批次（缺证）',
    });
  }
  return {
    version,
    createdAt: row.created_at,
    reason: row.reason,
    stats: JSON.parse(row.stats),
    formatVersion: Number(row.format_version),
    evidenceStatus: completeness,
    groups: enriched,
    cutEdges,
  };
}

async function evidenceCompletenessForAll(db, version, pubRow, groups) {
  const gids = groups.map((g) => g.gid);
  if (!gids.length) return { complete: true, reasons: [], incompleteGroups: [] };
  const rows = await db.allIn(
    'select gid, since_version from group_evidence_state',
    'gid',
    gids
  );
  const sinceByGid = new Map(rows.map((r) => [r.gid, Number(r.since_version)]));
  const versionFormat = Number(pubRow.format_version);
  const incomplete = [];
  if (versionFormat < CURRENT_FORMAT) {
    incomplete.push({ gid: null, reason: '该发布版早于证据历史升级，边级解释不完整' });
  }
  for (const g of gids) {
    const since = sinceByGid.has(g) ? sinceByGid.get(g) : null;
    if (since === null || since > version) {
      incomplete.push({ gid: g, reason: '该馆藏在此版本尚未被完整跟踪证据历史' });
    }
  }
  return {
    complete: incomplete.length === 0,
    reasons: [...new Set(incomplete.map((x) => x.reason))],
    incompleteGroups: incomplete.filter((x) => x.gid),
  };
}

// 旧馆藏追查：逐条成员 → 当前归属或已撤回，及其跨版本归属链；附该版证据解释。
// 归属链只按成员自身的 membership 事件推导（与无关发布无关），不逐版全量重放。
async function traceGroup(db, gid, atVersion) {
  const ver = atVersion
    ? await getVersionRow(db, atVersion)
    : await latestVersionRow(db);
  if (!ver) return null;
  // 目标馆藏当时的成员：最新版直接读当前态；历史版按成员事件定位曾加入该馆藏的键。
  let memberKeys;
  if (!atVersion) {
    const rows = await db.all('select k from live_members where gid = ? order by k', [gid]);
    if (!rows.length) return { found: false, gid };
    memberKeys = rows.map((r) => r.k);
  } else {
    const at = await buildGroupAt(db, gid, ver.version);
    if (!at) return { found: false, gid };
    memberKeys = at.members;
  }
  const curVer = await latestVersionRow(db);
  const members = await Promise.all(
    memberKeys.map(async (k) => {
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
      // 归属链：仅取该成员自己的归属事件，逐版推导当时 gid（同一编号沿用或关闭改属一目了然）。
      // 覆盖全部已发布版本（不仅是复核版），以便看清此后的改属/撤回。
      const evs = await db.all(
        'select version, gid, op from membership_events where k = ? order by version, event_id',
        [k]
      );
      const chain = [];
      let cur = null;
      let ei = 0;
      const versions = await db.all('select version from publications order by version');
      for (const v of versions) {
        while (ei < evs.length && evs[ei].version <= v.version) {
          cur = evs[ei].op === 'leave' ? null : evs[ei].gid;
          ei += 1;
        }
        chain.push({ version: v.version, gid: cur });
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
  const { edges, examined, historyRowsRead } = await loadEvidence(db, ver.version, memberKeys);
  const completeness = await evidenceCompleteness(db, ver.version, ver, gid);
  const explanation = explainGroup(gid, memberKeys, edges, completeness);
  return {
    found: true,
    gid,
    atVersion: ver.version,
    members,
    explanation,
    evidenceRead: { edgesExamined: examined, historyRowsRead },
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
