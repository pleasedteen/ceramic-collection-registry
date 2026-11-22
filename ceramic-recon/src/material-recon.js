'use strict';
const { ApiError } = require('./engine');
const queries = require('./queries');

// “含未知”材质盘点：空值（null/空串/'null'）统一归入未知类，未知类的查询参数为 unknown
const UNKNOWN = 'unknown';
const UNKNOWN_LABEL = '未知';
const isBlank = (v) => v === null || v === undefined || v === '' || v === 'null';

/**
 * 馆藏的实际归类是否属于指定材质类。
 * 以该版实际物化的 fields.material 为准（成员未变但改了材质，归类随之改变）。
 * @param {string | null} material
 * @param {string} target
 */
function inMaterialClass(material, target) {
  if (target === UNKNOWN) return isBlank(material);
  return !isBlank(material) && material === target;
}

// 成员签名 -> 馆藏，用于跨版本按成员集合对齐（同编号馆藏）
function indexByMembers(groups) {
  const m = new Map();
  for (const g of groups) m.set(g.members.slice().sort().join(','), g);
  return m;
}

// 汇总当版该材质类内每个来源记录所属馆藏
function membersOfClass(groups) {
  const set = new Set();
  for (const g of groups) for (const k of g.members) set.add(k);
  return set;
}

/**
 * 两个发布版本之间按指定材质（含未知）核对馆藏件数与换入换出。
 * 以两版实际归类为准：同编号（同成员集合）馆藏改了材质同样计入换入/换出；
 * 净差为零时，归入与离开明细仍逐条可核对。
 *
 * @param {any} db
 * @param {number} versionA
 * @param {number} versionB
 * @param {string} material 具体材质名，或 'unknown' 表示未知（空材质）类
 */
async function reconcileMaterial(db, versionA, versionB, material) {
  const target = material === undefined || material === null ? '' : String(material);
  if (!target) throw new ApiError(400, '缺少材质参数 material（未知类请使用 unknown）');
  const versions = await queries.listVersions(db);
  const known = new Set(versions.map((v) => v.version));
  for (const v of [versionA, versionB]) {
    if (!Number.isInteger(v) || !known.has(v)) {
      throw new ApiError(404, `版本不存在: ${v}`);
    }
  }
  if (versionA === versionB) {
    throw new ApiError(400, '请选择两个不同的发布版本进行核对');
  }

  const snapA = await queries.buildVersionSnapshot(db, versionA);
  const snapB = await queries.buildVersionSnapshot(db, versionB);
  const classA = snapA.filter((g) => inMaterialClass(g.fields.material, target));
  const classB = snapB.filter((g) => inMaterialClass(g.fields.material, target));
  const byMembersA = indexByMembers(classA);
  const byMembersB = indexByMembers(classB);

  // 旧版该类成员 -> 旧馆藏；新版该类成员 -> 新馆藏（用于换入换出时定位当版成员）
  const memberGidA = new Map();
  for (const g of classA) for (const k of g.members) memberGidA.set(k, g.gid);
  const memberGidB = new Map();
  for (const g of classB) for (const k of g.members) memberGidB.set(k, g.gid);

  const joined = [];
  const left = [];
  const sameGidMaterialChanged = [];

  // ---- 归入：新版在类内、旧版不在类内（含同编号改材质）----
  for (const g of classB) {
    const sig = g.members.join(',');
    const old = byMembersA.get(sig);
    if (old) continue; // 两版都在类内
    // 同成员馆藏旧版是否存在、当时什么材质
    const oldSameMembers = snapA.find((x) => x.members.join(',') === sig) || null;
    const prevForMembers = [];
    for (const k of g.members) {
      const prevGid = memberGidA.get(k) || null;
      prevForMembers.push({
        key: k,
        gid: prevGid,
        material: prevGid
          ? (classA.find((x) => x.gid === prevGid) || {}).fields.material ?? null
          : null,
      });
    }
    let reason;
    if (oldSameMembers) {
      reason = 'material-changed'; // 同编号馆藏改材质后进入该类
      sameGidMaterialChanged.push({
        gid: g.gid,
        oldGid: oldSameMembers.gid,
        oldMaterial: oldSameMembers.fields.material,
        newMaterial: g.fields.material,
        members: g.members,
      });
    } else if (g.members.some((k) => memberGidA.has(k))) {
      reason = 'regroup'; // 成员来自旧版该类内的其他馆藏（拆并导致换入）
    } else {
      reason = 'new'; // 该版新出现的馆藏（新记录或从类外其他馆藏并入）
    }
    joined.push({
      gid: g.gid,
      material: g.fields.material,
      fieldSources: g.fieldSources,
      members: g.members,
      reason,
      previousSameMembersGid: oldSameMembers ? oldSameMembers.gid : null,
      previousMaterial: oldSameMembers ? oldSameMembers.fields.material : null,
      previousMembership: prevForMembers,
    });
  }

  // ---- 离开：旧版在类内、新版不在类内（含同编号改材质）----
  for (const g of classA) {
    const sig = g.members.join(',');
    if (byMembersB.has(sig)) continue; // 两版都在类内
    const newSameMembers = snapB.find((x) => x.members.join(',') === sig) || null;
    const nextForMembers = [];
    for (const k of g.members) {
      const nextGid = memberGidB.get(k) || null;
      nextForMembers.push({
        key: k,
        gid: nextGid,
        material: nextGid
          ? (classB.find((x) => x.gid === nextGid) || {}).fields.material ?? null
          : null,
      });
    }
    let reason;
    if (newSameMembers) {
      reason = 'material-changed'; // 同编号馆藏改材质后离开该类
      if (!sameGidMaterialChanged.some((c) => c.gid === newSameMembers.gid)) {
        sameGidMaterialChanged.push({
          gid: newSameMembers.gid,
          oldGid: g.gid,
          oldMaterial: g.fields.material,
          newMaterial: newSameMembers.fields.material,
          members: g.members,
        });
      }
    } else if (g.members.some((k) => memberGidB.has(k))) {
      reason = 'regroup'; // 拆分/合并后归入新版该类内其他馆藏
    } else {
      // 成员全部离开该类：可能整体进入类外馆藏，或记录已撤回/消失
      const stillExists = g.members.some((k) => snapB.some((x) => x.members.includes(k)));
      reason = stillExists ? 'moved-out' : 'withdrawn';
    }
    left.push({
      gid: g.gid,
      material: g.fields.material,
      fieldSources: g.fieldSources,
      members: g.members,
      reason,
      nextSameMembersGid: newSameMembers ? newSameMembers.gid : null,
      nextMaterial: newSameMembers ? newSameMembers.fields.material : null,
      nextMembership: nextForMembers,
    });
  }

  // ---- 两版都在类内：同编号沿用（成员签名一致），仅材质可能变化（已在上面记账）----
  const stable = [];
  for (const g of classA) {
    const now = byMembersB.get(g.members.join(','));
    if (now) {
      stable.push({
        gid: g.gid,
        material: now.fields.material,
        members: now.members,
        materialChanged: g.fields.material !== now.fields.material,
      });
    }
  }

  const countA = classA.length;
  const countB = classB.length;
  const checks = {
    // 净差核对：件数差 = 归入数 - 离开数（按整组口径）
    netDelta: countB - countA,
    joinedMinusLeft: joined.length - left.length,
    netDeltaConsistent: countB - countA === joined.length - left.length,
    // 成员口径核对：两版该类来源记录数之差 = 换入成员数 - 换出成员数
    memberCountA: membersOfClass(classA).size,
    memberCountB: membersOfClass(classB).size,
  };
  const membersJoined = joined.flatMap((g) => g.members);
  const membersLeft = left.flatMap((g) => g.members);
  checks.memberJoined = membersJoined.length;
  checks.memberLeft = membersLeft.length;
  checks.memberNetConsistent =
    checks.memberCountB - checks.memberCountA === membersJoined.length - membersLeft.length;

  return {
    material: target === UNKNOWN ? UNKNOWN_LABEL : target,
    materialQuery: target,
    unknown: target === UNKNOWN,
    versions: { from: versionA, to: versionB },
    counts: { from: countA, to: countB, delta: countB - countA },
    joined,
    left,
    sameGidMaterialChanged,
    stableCount: stable.length,
    stableMaterialChangedCount: stable.filter((s) => s.materialChanged).length,
    stable,
    checks,
  };
}

module.exports = { reconcileMaterial, inMaterialClass, UNKNOWN, UNKNOWN_LABEL };
