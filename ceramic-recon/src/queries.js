'use strict';
const { keyOf, parseKey, SOURCE_LABEL } = require('./db');
const { ApiError } = require('./engine');

/**
 * @typedef {Object} RetentionSwitch
 * @property {number} version 改用生效的发布版
 * @property {string|null} fromBatchId 此前有效的来源批次
 * @property {string|null} toBatchId 改用的来源批次
 * @property {number|null} seq 改用的来源版本序号
 *
 * @typedef {Object} RetentionLapse
 * @property {number} sinceVersion 自该发布版起无有效来源版本
 * @property {number|null} untilVersion 自该发布版恢复有效；期末仍无则为 null
 * @property {string|null} lostBatchId 失效前最后一个有效来源批次
 *
 * @typedef {Object} RetentionReport
 * @property {number} fromVersion 起始发布版（成员范围以该版为准）
 * @property {number} toVersion 期末发布版
 * @property {Array<{key: string, batchId: string, seq: number}>} retained 期末仍有有效来源版本的成员
 * @property {Array<{key: string, switches: RetentionSwitch[]}>} switchedBatch 期间改用过其他批次的成员
 * @property {Array<{key: string, lapses: RetentionLapse[]}>} lapsed 期间曾无有效来源版本的成员
 * @property {Array<{key: string, reason: string}>} evidenceGaps 旧数据不足、无法核对的成员
 */

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

/**
 * @typedef {Object} TraceFound
 * @property {true} found
 * @property {string} gid
 * @property {number} atVersion 起始发布版
 * @property {number} toVersion 期末发布版
 * @property {Array<Object>} members 起始版成员逐条当前归属与跨版本归属链
 * @property {number} currentVersion 最新发布版
 * @property {RetentionReport} retention 两次发布之间的留存核对
 *
 * @typedef {TraceFound | {found: false, gid: string}} TraceResult
 */

// 旧馆藏追查：以起始发布版（atVersion）的成员范围为基准，核对两次发布之间的留存。
// 只读取被追查成员自身的历史行（按 gid/k 索引点查），不扫描全量事件历史，
// 因此扫描行数不随无关馆藏与无变化发布的规模增长。
/**
 * @param {any} db
 * @param {string} gid 被追查的旧馆藏编号
 * @param {number|null} atVersion 起始发布版（缺省为最新发布版）
 * @param {number|null} toVersion 期末发布版（缺省为最新发布版）
 * @returns {Promise<TraceResult|null>} 版本不存在返回 null；起始版不在馆藏生命周期内返回 found=false
 */
async function traceGroup(db, gid, atVersion, toVersion) {
  const curVer = await latestVersionRow(db);
  const fromRow = atVersion ? await getVersionRow(db, atVersion) : curVer;
  if (!fromRow) return null;
  const toRow = toVersion ? await getVersionRow(db, toVersion) : curVer;
  if (!toRow) return null;
  const fromV = fromRow.version;
  const toV = toRow.version;
  if (toV < fromV) {
    throw new ApiError(400, `toVersion(${toV}) 不能早于 atVersion(${fromV})`);
  }
  const currentVersion = curVer ? curVer.version : toV;

  // 起始发布版的成员范围：gid 生命周期内成员恒定（成员一变即换新编号），
  // 由诞生/关闭版本确认该版在生命周期内，再点查 open 事件取成员名单。
  const lineageRows = await db.all(
    'select born_version, closed_version from group_lineage where gid = ?',
    [gid]
  );
  if (!lineageRows.length) return { found: false, gid };
  const born = lineageRows[0].born_version;
  const closed = lineageRows[0].closed_version;
  if (!(born <= fromV && (closed === null || fromV < closed))) {
    return { found: false, gid };
  }
  const openRows = await db.all(
    "select members from group_events where gid = ? and op = 'open'",
    [gid]
  );
  if (!openRows.length) return { found: false, gid };
  const memberKeys = JSON.parse(openRows[0].members).sort();

  /** @type {RetentionReport} */
  const retention = {
    fromVersion: fromV,
    toVersion: toV,
    retained: [],
    switchedBatch: [],
    lapsed: [],
    evidenceGaps: [],
  };
  const members = [];
  for (const k of memberKeys) {
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
    // 归属链：只回放该成员自身的成员事件（按 k 索引）
    const memEvents = await db.all(
      'select version, gid, op from membership_events where k = ? order by event_id',
      [k]
    );
    const chain = buildChain(memEvents, currentVersion);
    // 该成员 ≤ 期末版的已发布来源版本状态（未发布的变更不产生事件，不计入）
    const states = await db.all(
      'select version, batch_id, seq, active from record_state_events where k = ? and version <= ? order by version',
      [k, toV]
    );
    classifyMemberRetention(k, states, fromV, toV, retention);
    members.push({
      key: k,
      source,
      sourceLabel: SOURCE_LABEL[source],
      id,
      current: status,
      chain,
    });
  }
  return {
    found: true,
    gid,
    atVersion: fromV,
    toVersion: toV,
    members,
    currentVersion,
    retention,
  };
}

// 由某成员自身的 join/leave 事件回放其逐版归属（版本号自 1 起连续）
function buildChain(memberEvents, currentVersion) {
  const byVersion = new Map();
  for (const e of memberEvents) {
    const arr = byVersion.get(e.version);
    if (arr) arr.push(e);
    else byVersion.set(e.version, [e]);
  }
  const chain = [];
  let gid = null;
  for (let v = 1; v <= currentVersion; v++) {
    const evs = byVersion.get(v) || [];
    for (const e of evs) gid = e.op === 'join' ? e.gid : null;
    chain.push({ version: v, gid });
  }
  return chain;
}

// 按成员归类两次发布之间的留存，每类按成员去重，明细定位到发布版与来源批次。
// states：该成员 ≤ toV 的已发布来源版本状态事件（按 version 升序）。
/**
 * @param {string} k 成员键（source|id）
 * @param {Array<{version: number, batch_id: string|null, seq: number|null, active: boolean}>} states
 * @param {number} fromV 起始发布版
 * @param {number} toV 期末发布版
 * @param {RetentionReport} retention 归类结果（就地累积）
 */
function classifyMemberRetention(k, states, fromV, toV, retention) {
  /** @type {{version: number, batch_id: string|null, seq: number|null, active: boolean}|null} */
  let start = null;
  for (const s of states) {
    if (s.version <= fromV) start = s;
  }
  if (!start) {
    retention.evidenceGaps.push({
      key: k,
      reason: `缺少 v${fromV} 或更早的已发布来源版本状态，旧数据不足`,
    });
    return;
  }
  if (!start.active) {
    retention.evidenceGaps.push({
      key: k,
      reason: `v${fromV} 时该成员无有效来源版本，与馆藏成员身份矛盾，证据链不完整`,
    });
    return;
  }
  const startBatch = start.batch_id;
  /** @type {RetentionSwitch[]} */
  const switches = [];
  /** @type {RetentionLapse[]} */
  const lapses = [];
  let lastActiveBatch = startBatch;
  /** @type {RetentionLapse|null} */
  let lapse = null;
  let usedOtherBatch = false;
  for (const s of states) {
    if (s.version <= fromV || s.version > toV) continue;
    if (!s.active) {
      if (!lapse) {
        lapse = { sinceVersion: s.version, untilVersion: null, lostBatchId: lastActiveBatch };
      }
      continue;
    }
    if (lapse) {
      lapse.untilVersion = s.version;
      lapses.push(lapse);
      lapse = null;
    }
    if (s.batch_id !== lastActiveBatch) {
      switches.push({
        version: s.version,
        fromBatchId: lastActiveBatch,
        toBatchId: s.batch_id,
        seq: s.seq,
      });
    }
    if (s.batch_id !== startBatch) usedOtherBatch = true;
    lastActiveBatch = s.batch_id;
  }
  if (lapse) lapses.push(lapse);
  const end = states.length ? states[states.length - 1] : null;
  if (end && end.active && end.batch_id !== null && end.seq !== null) {
    retention.retained.push({ key: k, batchId: end.batch_id, seq: end.seq });
  }
  if (usedOtherBatch) retention.switchedBatch.push({ key: k, switches });
  if (lapses.length) retention.lapsed.push({ key: k, lapses });
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
