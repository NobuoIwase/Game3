// フラグメント割当の最適化（DESIGN.md §4）
//
// 構成:
//   - memberAbilityGroups … キャラのZ/ZENKAI/出撃Zアビリティを解決して補正グループにする
//   - abilityCorrections  … パーティ全体のアビリティ補正合算（編成が決まれば定数 — §4-3）
//   - bestForCharacter    … キャラ1体に対する最適な N 枚の選出（v1）
//   - optimizeParty       … 所持数の奪い合いを含む全体最適化（v2）。
//                           貪欲法で初期解を作り、分枝限定法で厳密解を探索する。
//                           探索が打ち切られた場合は結果に exact:false を立てる。
//
// スコアは「重み付き相対値」: Σ weight[stat] × (❸ / フラグメント無しの❸)。
// 固定の「基礎あり優先/基礎なし優先」ルールは実装しない（§2-5）。必ず ❸ を評価して比較する。

import { STATS, finalStat, computeStat } from './calc.js';
import { fragmentStatEffects, resolveAbilityGroups, conditionMatches } from './effects.js';

// ---------------------------------------------------------------- 装備条件

/**
 * 装備可否の判定。
 * v2（取り込みデータ）: equip_char_ids（参照サイトが解決済みの装備可能キャラ一覧）で判定。
 * v1（手入力データ）  : equip_conditions のタグ条件で判定。
 */
export function canEquip(character, fragment) {
  if (Array.isArray(fragment.equip_char_ids) && fragment.equip_char_ids.length > 0) {
    return fragment.equip_char_ids.includes(Number(character.id));
  }
  const cond = fragment.equip_conditions || {};
  const tags = character.tags || [];
  const any = cond.require_tags_any || [];
  const all = cond.require_tags_all || [];
  if (any.length > 0 && !any.some((t) => tags.includes(t))) return false;
  if (all.length > 0 && !all.every((t) => tags.includes(t))) return false;
  return true;
}

export function equippableFragments(character, fragmentsById) {
  return Object.values(fragmentsById).filter((f) => canEquip(character, f));
}

// ---------------------------------------------------------------- アビリティ

/**
 * 限界突破（星）からアビリティレベル(1〜4)を自動決定する。
 * 対応表は実機未検証の仮定（DESIGN.md §10-2）。キャラごとに my.z_level 等で上書きできる。
 */
export function autoAbilityLevel(stars) {
  const s = Number(stars) || 0;
  if (s >= 6) return 4;
  if (s >= 4) return 3;
  if (s >= 2) return 2;
  return 1;
}

function pickAbilityLevel(list, override, stars) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const level = (override && override !== 'auto') ? Number(override) : autoAbilityLevel(stars);
  const idx = Math.min(Math.max(level, 1), list.length) - 1;
  return list[idx];
}

/** 手入力アビリティ（旧形式 {stat, base, value, condition_tags}）をグループ形式へ変換 */
function manualToGroups(list) {
  return (list || []).map((a) => ({
    cond: (a.condition_tags || []).length > 0 ? (a.condition_tags || []).map((t) => [{ tag: Number(t) }]) : [],
    effects: [{ stat: a.stat, base: a.base !== false, value: Number(a.value) || 0 }],
    raw: '(手入力)',
  }));
}

/**
 * キャラ1体の有効なアビリティ補正グループを解決する。
 * @returns {{party:Array, deploy:Array, unknown:Array<string>}}
 *   party  … パーティ6体全員に乗る（Zアビ＋ZENKAIアビ）
 *   deploy … 発生源がバトルメンバーのときだけ、バトル3体に乗る（出撃Zアビ / LLアビ — §2-2）
 */
export function memberAbilityGroups({ character, my, effectMap }) {
  const name = character.name || character.id;
  const stars = my?.stars ?? 0;
  const unknown = [];
  const party = [];
  const deploy = [];

  const resolve = (abilityEntry, label) => {
    if (!abilityEntry) return [];
    const r = resolveAbilityGroups(abilityEntry.groups, effectMap, `${name} の${abilityEntry.name || label}`);
    unknown.push(...r.unknown);
    return r.groups.filter((g) => g.effects.length > 0);
  };

  party.push(...resolve(pickAbilityLevel(character.z_ability, my?.z_level, stars), 'Zアビリティ'));
  if (character.zenkai_ability?.length && (my?.zenkai_level !== 0)) {
    party.push(...resolve(pickAbilityLevel(character.zenkai_ability, my?.zenkai_level, stars), 'ZENKAIアビリティ'));
  }
  deploy.push(...resolve(pickAbilityLevel(character.deploy_z_ability, my?.deploy_z_level, stars), '出撃Zアビリティ'));

  // 手入力の追加分（§1-1: 手入力でのオーバーライド経路）
  party.push(...manualToGroups(my?.z_ability));
  party.push(...manualToGroups(my?.zenkai_ability));
  deploy.push(...manualToGroups(my?.ll_ability));

  return { party, deploy, unknown };
}

/**
 * パーティのアビリティ補正を合算する（§2-2 / §4-3）。
 * - Zアビ / ZENKAIアビ … パーティ6体全員 → 全員に乗る
 * - 出撃Zアビ / LLアビ … 発生源がバトルメンバーのときのみ、バトル3体に乗る
 *   （文言「自身がバトルメンバー時」に基づく。§10-2 参照）
 * - 基礎なし(base:false)の補正は §2-3 の式に存在しない未検証項目のため extNonBase に分離して警告
 *
 * @returns {Object<string, {z, zenkai, ll, extNonBase, warnings, unknown}>} キャラID → 補正
 *   （z にZ+ZENKAI合算、ll に出撃Z/LL合算を入れる。zenkai は常に0 — 表示互換のため残す）
 */
export function abilityCorrections(members, battleIds, effectMap) {
  const battleSet = new Set((battleIds || []).map(String));
  const zero = () => Object.fromEntries(STATS.map((s) => [s, 0]));
  const out = {};
  for (const m of members) {
    out[String(m.character.id)] = { z: zero(), zenkai: zero(), ll: zero(), extNonBase: zero(), warnings: [], unknown: [] };
  }
  const resolved = members.map((m) => ({ m, ab: memberAbilityGroups({ ...m, effectMap }) }));
  for (const { m, ab } of resolved) {
    const srcId = String(m.character.id);
    for (const u of ab.unknown) out[srcId].unknown.push(u);
    const apply = (groups, bucket, targetsBattleOnly) => {
      for (const g of groups) {
        for (const target of members) {
          const tid = String(target.character.id);
          if (targetsBattleOnly && !battleSet.has(tid)) continue;
          if (!conditionMatches(g.cond, target.character)) continue;
          for (const e of g.effects) {
            if (e.base === false) {
              out[tid].extNonBase[e.stat] += e.value;
              out[tid].warnings.push(
                `${m.character.name || srcId} のアビリティ「基礎なし ${e.stat} +${e.value}%」は検証済みの計算式に無い形式のため、基礎なし補正として乗算しています（実機で要確認）`
              );
            } else {
              out[tid][bucket][e.stat] += e.value;
            }
          }
        }
      }
    };
    apply(ab.party, 'z', false);
    if (battleSet.has(srcId)) apply(ab.deploy, 'll', true);
  }
  return out;
}

// ---------------------------------------------------------------- ステータス基礎値

/**
 * キャラの ❶（基本ステータス）とブースト値を決める。
 * v2: character.stats = Lv5000 の基本値（❶）。合計ステ = ❶ + ブースト。
 * v1: character.base_stats = 合計ステ。❶ = 合計ステ − ブースト。
 */
export function statBase(character, my, stat) {
  const boost = Number(my?.boost?.[stat]) || 0;
  const v2 = Number(character.stats?.[stat]) || 0;
  if (v2 > 0) return { base: v2, boost, total: v2 + boost };
  const legacyTotal = Number(character.base_stats?.[stat]) || 0;
  if (legacyTotal > 0) return { base: legacyTotal - boost, boost, total: legacyTotal };
  return null; // 未入力
}

// ---------------------------------------------------------------- スコア計算

function makeScoreContext(member, ext, weights, weightedStats, warnings) {
  const stats = [];
  const charName = member.character.name || member.character.id;
  for (const s of weightedStats) {
    const sb = statBase(member.character, member.my, s);
    if (!sb || sb.base <= 0) {
      warnings.messages.push(
        `${charName} の「${s}」はステータス未入力のため、このステータスを評価から除外しました`
      );
      stats.push(null);
      continue;
    }
    const e = ext || { z: {}, zenkai: {}, ll: {}, extNonBase: {} };
    const extBase = (e.z[s] || 0) + (e.zenkai[s] || 0) + (e.ll[s] || 0);
    const extNonBase = e.extNonBase ? (e.extNonBase[s] || 0) : 0;
    const final0 = finalStat({ base: sb.base, boost: sb.boost, corr: extBase, nonBase: extNonBase });
    stats.push({
      stat: s, weight: weights[s],
      base: sb.base, boost: sb.boost, extBase, extNonBase,
      final0: final0 !== 0 ? final0 : 1,
    });
  }
  if (stats.every((c) => c === null)) return null;
  return { stats };
}

function scoreOf(ctx, fragBase, fragNonBase) {
  let score = 0;
  for (let i = 0; i < ctx.stats.length; i++) {
    const c = ctx.stats[i];
    if (!c) continue;
    const final = finalStat({
      base: c.base, boost: c.boost,
      corr: c.extBase + fragBase[i],
      nonBase: c.extNonBase + fragNonBase[i],
    });
    score += c.weight * (final / c.final0);
  }
  return score;
}

function prepareItems(candidates, counts, effectMap, weightedStats, stars, allWarnings) {
  const items = [];
  for (const frag of candidates) {
    const count = counts[String(frag.id)] || 0;
    if (count <= 0) continue;
    const { effects, unknown } = fragmentStatEffects(frag, effectMap, { stars });
    allWarnings.unknown.push(...unknown);
    const base = new Float64Array(weightedStats.length);
    const nonBase = new Float64Array(weightedStats.length);
    let relevant = false;
    for (const e of effects) {
      const i = weightedStats.indexOf(e.stat);
      if (i < 0) continue;
      if (e.base) base[i] += e.value; else nonBase[i] += e.value;
      if (e.value !== 0) relevant = true;
    }
    if (!relevant) continue;
    items.push({ id: String(frag.id), name: frag.name || String(frag.id), count, base, nonBase });
  }
  return items;
}

function enumerateCombos(items, slots, ctx, allowDuplicates, maxCombos) {
  const combos = [];
  const nStats = ctx.stats.length;
  const fragBase = new Float64Array(nStats);
  const fragNonBase = new Float64Array(nStats);
  const chosen = [];
  const record = () => {
    combos.push({ ids: chosen.slice(), score: scoreOf(ctx, fragBase, fragNonBase) });
  };
  const dfs = (idx, remaining) => {
    record();
    if (remaining === 0) return;
    for (let i = idx; i < items.length; i++) {
      const item = items[i];
      const maxK = Math.min(remaining, allowDuplicates ? item.count : 1);
      for (let k = 1; k <= maxK; k++) {
        for (let j = 0; j < nStats; j++) {
          fragBase[j] += item.base[j];
          fragNonBase[j] += item.nonBase[j];
        }
        chosen.push(item.id);
        dfs(i + 1, remaining - k);
      }
      for (let k = 1; k <= maxK; k++) {
        chosen.pop();
        for (let j = 0; j < nStats; j++) {
          fragBase[j] -= item.base[j];
          fragNonBase[j] -= item.nonBase[j];
        }
      }
    }
  };
  dfs(0, Math.max(0, slots));
  combos.sort((a, b) => b.score - a.score);
  let truncated = false;
  if (maxCombos && combos.length > maxCombos) {
    combos.length = maxCombos;
    truncated = true;
  }
  return { combos, truncated };
}

// ---------------------------------------------------------------- 公開API

/** v1: キャラ1体に対する最適な N 枚を選ぶ。 */
export function bestForCharacter(p) {
  const warnings = { messages: [], unknown: [] };
  const weightedStats = STATS.filter((s) => (p.weights[s] || 0) > 0);
  if (weightedStats.length === 0) {
    return { ids: [], score: 0, warnings: ['評価するステータスの重みがすべて 0 です'], unknown: [] };
  }
  const weights = Object.fromEntries(weightedStats.map((s) => [s, p.weights[s]]));
  const ctx = makeScoreContext(p.member, p.ext, weights, weightedStats, warnings);
  if (!ctx) {
    return { ids: [], score: 0, warnings: warnings.messages, unknown: warnings.unknown };
  }
  const candidates = equippableFragments(p.member.character, p.fragmentsById);
  const stars = p.member.my?.stars ?? 7;
  const items = prepareItems(candidates, p.counts, p.effectMap, weightedStats, stars, warnings);
  const slots = Number(p.member.my && p.member.my.equip_slots) || 3;
  const { combos } = enumerateCombos(items, slots, ctx, p.allowDuplicates === true, 0);
  const best = combos[0] || { ids: [], score: 0 };
  return { ids: best.ids, score: best.score, warnings: warnings.messages, unknown: warnings.unknown };
}

/** v2: パーティ全体の最適化。フラグメントの奪い合い（所持数制約）だけがキャラ間の結合（§4-3）。 */
export function optimizeParty(p) {
  const warnings = { messages: [], unknown: [] };
  const weightedStats = STATS.filter((s) => (p.weights[s] || 0) > 0);
  if (weightedStats.length === 0) {
    return { assignments: {}, totalScore: 0, exact: true, ext: {}, warnings: ['評価するステータスの重みがすべて 0 です'], unknown: [] };
  }
  const weights = Object.fromEntries(weightedStats.map((s) => [s, p.weights[s]]));
  const ext = abilityCorrections(p.members, p.battleIds, p.effectMap);
  for (const id of Object.keys(ext)) {
    warnings.messages.push(...ext[id].warnings);
    warnings.unknown.push(...(ext[id].unknown || []).map((u) => ({ fragmentId: '', fragmentName: 'アビリティ', reason: u, raw: null })));
  }

  const targets = p.targets === 'all'
    ? p.members
    : p.members.filter((m) => (p.battleIds || []).map(String).includes(String(m.character.id)));
  if (targets.length === 0) {
    return { assignments: {}, totalScore: 0, exact: true, ext, warnings: [...warnings.messages, '最適化対象のキャラがいません（バトル出撃3体を選択してください）'], unknown: warnings.unknown };
  }

  const maxCombos = p.maxCombosPerChar ?? 20000;
  let exact = true;

  const perChar = [];
  for (const member of targets) {
    const cid = String(member.character.id);
    const ctx = makeScoreContext(member, ext[cid], weights, weightedStats, warnings);
    if (!ctx) {
      perChar.push({ cid, member, combos: [{ ids: [], score: 0 }] });
      continue;
    }
    const candidates = equippableFragments(member.character, p.fragmentsById);
    const stars = member.my?.stars ?? 7;
    const items = prepareItems(candidates, p.counts, p.effectMap, weightedStats, stars, warnings);
    const slots = Number(member.my && member.my.equip_slots) || 3;
    const { combos, truncated } = enumerateCombos(items, slots, ctx, p.allowDuplicates === true, maxCombos);
    if (truncated) {
      exact = false;
      warnings.messages.push(
        `${member.character.name || cid} の装備組合せが多すぎるため上位 ${maxCombos} 通りに絞りました（厳密解でない可能性があります）`
      );
    }
    perChar.push({ cid, member, combos });
  }

  perChar.sort((a, b) => (b.combos[0]?.score || 0) - (a.combos[0]?.score || 0));

  const takeCounts = (counts, ids, sign) => {
    for (const id of ids) counts[id] = (counts[id] || 0) + sign;
  };
  const fits = (counts, ids) => {
    const need = {};
    for (const id of ids) need[id] = (need[id] || 0) + 1;
    return Object.entries(need).every(([id, n]) => (counts[id] || 0) >= n);
  };

  // 貪欲初期解
  const greedyCounts = { ...p.counts };
  const greedyPick = [];
  let greedyScore = 0;
  for (const pc of perChar) {
    const combo = pc.combos.find((c) => fits(greedyCounts, c.ids)) || { ids: [], score: 0 };
    takeCounts(greedyCounts, combo.ids, -1);
    greedyPick.push(combo);
    greedyScore += combo.score;
  }

  // 分枝限定法
  const suffixBest = new Array(perChar.length + 1).fill(0);
  for (let i = perChar.length - 1; i >= 0; i--) {
    suffixBest[i] = suffixBest[i + 1] + (perChar[i].combos[0]?.score || 0);
  }
  let bestScore = greedyScore;
  let bestPick = greedyPick.slice();
  const nodeBudget = p.nodeBudget ?? 2_000_000;
  let nodes = 0;
  let aborted = false;
  const counts = { ...p.counts };
  const pick = new Array(perChar.length).fill(null);
  const EPS = 1e-12;

  const dfs = (i, acc) => {
    if (aborted) return;
    if (i === perChar.length) {
      if (acc > bestScore + EPS) {
        bestScore = acc;
        bestPick = pick.slice();
      }
      return;
    }
    if (acc + suffixBest[i] <= bestScore + EPS) return;
    for (const combo of perChar[i].combos) {
      if (++nodes > nodeBudget) { aborted = true; return; }
      if (acc + combo.score + suffixBest[i + 1] <= bestScore + EPS) break;
      if (!fits(counts, combo.ids)) continue;
      takeCounts(counts, combo.ids, -1);
      pick[i] = combo;
      dfs(i + 1, acc + combo.score);
      takeCounts(counts, combo.ids, +1);
      pick[i] = null;
      if (aborted) return;
    }
  };
  dfs(0, 0);
  if (aborted) {
    exact = false;
    warnings.messages.push('探索が上限に達したため打ち切りました。表示している割当は暫定の最良解です');
  }

  const assignments = {};
  perChar.forEach((pc, i) => {
    const combo = bestPick[i] || { ids: [], score: 0 };
    assignments[pc.cid] = { ids: combo.ids, score: combo.score };
  });
  return { assignments, totalScore: bestScore, exact, ext, warnings: warnings.messages, unknown: warnings.unknown };
}

/**
 * 表示用: キャラ1体 × 装備フラグメント一覧から、各ステータスの ❶〜❻ を計算する。
 * @returns {{stats:Object<string,object>, unknown:Array}}
 */
export function characterDetail({ member, ext, fragmentList, effectMap }) {
  const e = ext || { z: {}, zenkai: {}, ll: {}, extNonBase: {} };
  const stars = member.my?.stars ?? 7;
  const unknown = [];
  const basePct = Object.fromEntries(STATS.map((s) => [s, 0]));
  const nonBasePct = Object.fromEntries(STATS.map((s) => [s, 0]));
  for (const frag of fragmentList) {
    const r = fragmentStatEffects(frag, effectMap, { stars });
    unknown.push(...r.unknown);
    for (const ef of r.effects) {
      if (ef.base) basePct[ef.stat] += ef.value;
      else nonBasePct[ef.stat] += ef.value;
    }
  }
  const stats = {};
  for (const s of STATS) {
    const sb = statBase(member.character, member.my, s);
    if (!sb || sb.base <= 0) continue;
    stats[s] = computeStat({
      total: sb.total, boost: sb.boost,
      z: (e.z[s] || 0) + (e.zenkai[s] || 0),
      zenkai: 0,
      ll: e.ll[s] || 0,
      fragBase: basePct[s],
      fragNonBase: nonBasePct[s],
      extNonBase: e.extNonBase ? (e.extNonBase[s] || 0) : 0,
    });
  }
  return { stats, unknown };
}
