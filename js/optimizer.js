// フラグメント割当の最適化（DESIGN.md §4 / §11-7）
//
// 装備ルール（実機仕様）:
//   - 同一フラグメントを同じキャラに重複装備することはできない
//   - 別のキャラ同士なら同じフラグメントを同時に装備できる（奪い合いは存在しない）
//   → キャラ間の結合が無いため、キャラごとに独立して厳密最適化できる。
//
// 構成:
//   - memberAbilityGroups      … キャラのZ/ZENKAI/出撃Zアビリティを解決して補正グループにする
//   - abilityCorrections       … 1パーティ分のアビリティ補正合算（編成が決まれば定数）
//   - partyAbilityCorrections  … スタンダード（6体1パーティ）/プラウド（3体×2チーム）の振り分け
//   - bestForCharacter         … キャラ1体に対する最適な N 枚の選出
//   - optimizeParty            … 対象キャラ全員をそれぞれ独立に厳密最適化
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
 * @returns {{z:Array, zenkai:Array, deploy:Array, unknown:Array<string>}}
 *   z      … Zアビリティ。パーティ全員に乗る（リーダー特殊ルールの対象）
 *   zenkai … ZENKAIアビリティ。パーティ全員に乗る
 *   deploy … 出撃Zアビ / LLアビ。発生源がバトルメンバーのときだけバトルメンバーに乗る（§2-2）
 */
export function memberAbilityGroups({ character, my, effectMap }) {
  const name = character.name || character.id;
  const stars = my?.stars ?? 0;
  const unknown = [];

  const resolve = (abilityEntry, label) => {
    if (!abilityEntry) return [];
    const r = resolveAbilityGroups(abilityEntry.groups, effectMap, `${name} の${abilityEntry.name || label}`);
    unknown.push(...r.unknown);
    return r.groups.filter((g) => g.effects.length > 0);
  };

  const z = resolve(pickAbilityLevel(character.z_ability, my?.z_level, stars), 'Zアビリティ');
  const zenkai = (character.zenkai_ability?.length && my?.zenkai_level !== 0)
    ? resolve(pickAbilityLevel(character.zenkai_ability, my?.zenkai_level, stars), 'ZENKAIアビリティ')
    : [];
  const deploy = resolve(pickAbilityLevel(character.deploy_z_ability, my?.deploy_z_level, stars), '出撃Zアビリティ');

  // 手入力の追加分（§1-1: 手入力でのオーバーライド経路）
  z.push(...manualToGroups(my?.z_ability));
  zenkai.push(...manualToGroups(my?.zenkai_ability));
  deploy.push(...manualToGroups(my?.ll_ability));

  return { z, zenkai, deploy, unknown };
}

/**
 * Z/ZENKAIアビリティの「関係数」（ゲームの◎×N表示に相当）。
 * 対象キャラごとに、条件に一致する（発生源キャラ × 種別 z/zenkai）の組を数える。
 * 出撃Zアビリティは数えない（実機の表示仕様）。リーダー特殊ルールも数えない。
 * @returns {Object<string, number>} キャラID → 関係数
 */
export function zRelationCounts(members, effectMap) {
  const resolved = members.map((m) => ({ m, ab: memberAbilityGroups({ ...m, effectMap }) }));
  const out = {};
  for (const target of members) {
    const tid = String(target.character.id);
    let n = 0;
    for (const { ab } of resolved) {
      for (const kind of ['z', 'zenkai']) {
        if ((ab[kind] || []).some((g) => g.effects.length > 0 && conditionMatches(g.cond, target.character))) n++;
      }
    }
    out[tid] = n;
  }
  return out;
}

/**
 * パーティのアビリティ補正を合算する（§2-2 / §4-3 / §11-7）。
 * - Zアビ / ZENKAIアビ … パーティ全員 → 条件に一致する全員に乗る
 * - 出撃Zアビ / LLアビ … 発生源がバトルメンバーのときのみ、バトルメンバーに乗る
 * - リーダー特殊ルール（opts.leaderId、選出=バトルメンバー時に限り）:
 *     1. リーダーは他の全キャラのZアビリティを「タグを無視して」受ける
 *     2. リーダーのZアビリティは他の選出キャラに「タグを無視して」乗る
 *   ※対象はZアビリティのみ（ZENKAI・出撃Zは対象外 — 実機未検証の仮定は§11-7参照）
 * - 基礎なし(base:false)の補正は §2-3 の式に存在しない未検証項目のため extNonBase に分離して警告
 *
 * @returns {Object<string, {z, zenkai, ll, extNonBase, warnings, unknown}>} キャラID → 補正
 */
export function abilityCorrections(members, battleIds, effectMap, opts = {}) {
  const battleSet = new Set((battleIds || []).map(String));
  const zero = () => Object.fromEntries(STATS.map((s) => [s, 0]));
  const out = {};
  for (const m of members) {
    out[String(m.character.id)] = { z: zero(), zenkai: zero(), ll: zero(), extNonBase: zero(), warnings: [], unknown: [] };
  }
  const resolved = members.map((m) => ({ m, ab: memberAbilityGroups({ ...m, effectMap }) }));

  const applyEffectsTo = (effects, tid, bucket, srcMember) => {
    for (const e of effects) {
      if (e.base === false) {
        out[tid].extNonBase[e.stat] += e.value;
        out[tid].warnings.push(
          `${srcMember.character.name || srcMember.character.id} のアビリティ「基礎なし ${e.stat} +${e.value}%」は検証済みの計算式に無い形式のため、基礎なし補正として乗算しています（実機で要確認）`
        );
      } else {
        out[tid][bucket][e.stat] += e.value;
      }
    }
  };

  for (const { m, ab } of resolved) {
    const srcId = String(m.character.id);
    for (const u of ab.unknown) out[srcId].unknown.push(u);
    const apply = (groups, bucket, targetsBattleOnly) => {
      for (const g of groups) {
        for (const target of members) {
          const tid = String(target.character.id);
          if (targetsBattleOnly && !battleSet.has(tid)) continue;
          if (!conditionMatches(g.cond, target.character)) continue;
          applyEffectsTo(g.effects, tid, bucket, m);
        }
      }
    };
    apply(ab.z, 'z', false);
    apply(ab.zenkai, 'zenkai', false);
    if (battleSet.has(srcId)) apply(ab.deploy, 'll', true);
  }

  // リーダー特殊ルール（選出時に限り）
  const leaderId = opts.leaderId != null && opts.leaderId !== '' ? String(opts.leaderId) : null;
  if (leaderId && battleSet.has(leaderId) && out[leaderId]) {
    const leader = members.find((m) => String(m.character.id) === leaderId);
    for (const { m, ab } of resolved) {
      const srcId = String(m.character.id);
      if (srcId === leaderId) {
        // リーダーのZアビを、条件に一致しない選出キャラにもタグ無視で付与
        for (const g of ab.z) {
          for (const target of members) {
            const tid = String(target.character.id);
            if (tid === leaderId || !battleSet.has(tid)) continue;
            if (conditionMatches(g.cond, target.character)) continue; // 通常適用済み
            applyEffectsTo(g.effects, tid, 'z', m);
          }
        }
      } else if (leader) {
        // リーダーは他キャラのZアビを、条件に一致しなくてもタグ無視で受ける
        for (const g of ab.z) {
          if (conditionMatches(g.cond, leader.character)) continue; // 通常適用済み
          applyEffectsTo(g.effects, leaderId, 'z', m);
        }
      }
    }
  }
  return out;
}

/**
 * バトル形式に応じたアビリティ補正の振り分け。
 * - スタンダード: パーティ6体（バトル3体＋ゼンカイ枠3体）を1つのパーティとして合算。
 *   Zアビ/ZENKAIアビは6体全員から、出撃Zアビはバトル3体から（§2-2 / §11-3）
 * - プラウド（teams 指定時）: 各チーム3体を独立したパーティとして合算する。
 *   チームをまたいだ補正は乗らない（1戦ごとに場にいるのはそのチームの3体だけのため）。
 *   チーム全員がバトルメンバー扱い（出撃Zアビも3体全員が発生源・対象）。
 *
 * @param {object} p {members, battleIds, teams?, effectMap, leaderId?, leaders?}
 *   teams   … プラウド時: キャラIDの配列の配列（例 [[1,2,3],[4,5,6]]）
 *   leaderId … スタンダード時のリーダー（省略可）
 *   leaders  … プラウド時のチーム別リーダー（teams と同じ並び。省略時は各チーム先頭）
 */
export function partyAbilityCorrections({ members, battleIds, teams, effectMap, leaderId, leaders }) {
  if (Array.isArray(teams) && teams.length > 0) {
    const zero = () => Object.fromEntries(STATS.map((s) => [s, 0]));
    const out = {};
    for (const m of members) {
      out[String(m.character.id)] = { z: zero(), zenkai: zero(), ll: zero(), extNonBase: zero(), warnings: [], unknown: [] };
    }
    teams.forEach((teamIds, i) => {
      const idSet = new Set(teamIds.map(String));
      const teamMembers = members.filter((m) => idSet.has(String(m.character.id)));
      if (teamMembers.length === 0) return;
      // leaders が渡されている場合はその値に従う（null = リーダー枠が空 → 特殊ルールなし）。
      // leaders 省略時のみ各チーム先頭へフォールバックする
      const teamLeader = leaders ? (leaders[i] ?? null) : teamIds[0];
      Object.assign(out, abilityCorrections(teamMembers, teamIds, effectMap, { leaderId: teamLeader }));
    });
    return out;
  }
  return abilityCorrections(members, battleIds, effectMap, { leaderId });
}

// ---------------------------------------------------------------- ステータス基礎値

/**
 * キャラの ❶（基本ステータス）とブースト値を決める。優先順:
 * 1. my.total_override = 実機のステータス画面で見た合計ステ（§1-1 の手入力経路）。
 *    ❶ = 合計ステ − ブースト。限界突破が最大でないキャラはこれで実測に合わせる
 * 2. character.stats = 取り込みデータの Lv5000 完全限界突破時の基本値（❶ 相当・理論値）
 * 3. character.base_stats = 旧形式（合計ステ）
 */
export function statBase(character, my, stat) {
  const boost = Number(my?.boost?.[stat]) || 0;
  const override = Number(my?.total_override?.[stat]) || 0;
  if (override > 0) return { base: override - boost, boost, total: override };
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

/** 力の大会専用フラグメントか（通常バトルでは装備不可 — §11-7） */
export function isTournamentOnly(fragment) {
  return fragment.top === true;
}

/** 探索前の候補数上限。超えた場合は単体スコア上位に絞る（結果に truncated を立てる） */
const MAX_ITEMS_PER_CHAR = 150;

function prepareItems(candidates, counts, effectMap, weightedStats, stars, context, includeTournament, allWarnings) {
  const items = [];
  for (const frag of candidates) {
    if (isTournamentOnly(frag) && !includeTournament) continue;
    const count = counts[String(frag.id)] || 0;
    if (count <= 0) continue;
    const { effects, unknown } = fragmentStatEffects(frag, effectMap, { stars, context });
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

/** 候補が多すぎる場合に単体スコア上位へ絞る。{items, truncated} を返す */
function limitItems(items, ctx) {
  if (items.length <= MAX_ITEMS_PER_CHAR) return { items, truncated: false };
  const scored = items.map((it) => ({ it, s: scoreOf(ctx, it.base, it.nonBase) }));
  scored.sort((a, b) => b.s - a.s);
  return { items: scored.slice(0, MAX_ITEMS_PER_CHAR).map((x) => x.it), truncated: true };
}

/**
 * 最良の1組合せだけを直接探索する（組合せリストを保持しない）。
 * 奪い合いが起こりえない場合（全候補の所持数 >= 対象キャラ数）はこれで厳密解になる。
 * 上界枝刈り: 残り枠 × 各ステータスの後続最大値で楽観スコアを見積もり、最良を下回る枝を捨てる。
 * ❸ は基礎あり・基礎なしのどちらにも単調増加なのでこの見積もりは正しい上界になる。
 */
function enumerateBest(items, slots, ctx) {
  const nStats = ctx.stats.length;
  const n = items.length;
  // 単体スコアの高い順に並べると最良解が早く見つかり枝刈りが効く
  const zero = new Float64Array(nStats);
  const sorted = [...items].sort((a, b) => {
    const sa = scoreOf(ctx, a.base, a.nonBase);
    const sb = scoreOf(ctx, b.base, b.nonBase);
    return sb - sa;
  });
  // 後続アイテムのステータス別最大値（上界計算用）
  const sufMaxBase = new Float64Array((n + 1) * nStats);
  const sufMaxNonBase = new Float64Array((n + 1) * nStats);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = 0; j < nStats; j++) {
      sufMaxBase[i * nStats + j] = Math.max(sufMaxBase[(i + 1) * nStats + j], sorted[i].base[j]);
      sufMaxNonBase[i * nStats + j] = Math.max(sufMaxNonBase[(i + 1) * nStats + j], sorted[i].nonBase[j]);
    }
  }
  const fragBase = new Float64Array(nStats);
  const fragNonBase = new Float64Array(nStats);
  const optBase = new Float64Array(nStats);
  const optNonBase = new Float64Array(nStats);
  const chosen = [];
  let best = { ids: [], score: scoreOf(ctx, zero, zero) };
  const EPS = 1e-12;
  const dfs = (idx, remaining) => {
    const score = scoreOf(ctx, fragBase, fragNonBase);
    if (score > best.score) best = { ids: chosen.slice(), score };
    if (remaining === 0 || idx >= n) return;
    // 上界: 残り remaining 枠すべてに後続最大値が入ったと仮定
    for (let j = 0; j < nStats; j++) {
      optBase[j] = fragBase[j] + remaining * sufMaxBase[idx * nStats + j];
      optNonBase[j] = fragNonBase[j] + remaining * sufMaxNonBase[idx * nStats + j];
    }
    if (scoreOf(ctx, optBase, optNonBase) <= best.score + EPS) return;
    for (let i = idx; i < n; i++) {
      const item = sorted[i];
      for (let j = 0; j < nStats; j++) {
        fragBase[j] += item.base[j];
        fragNonBase[j] += item.nonBase[j];
      }
      chosen.push(item.id);
      dfs(i + 1, remaining - 1);
      chosen.pop();
      for (let j = 0; j < nStats; j++) {
        fragBase[j] -= item.base[j];
        fragNonBase[j] -= item.nonBase[j];
      }
    }
  };
  dfs(0, Math.max(0, slots));
  return best;
}

// 同一フラグメントは同じキャラに重複装備できない（実機仕様）ため、各アイテムは1回まで
function enumerateCombos(items, slots, ctx, maxCombos) {
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
      for (let j = 0; j < nStats; j++) {
        fragBase[j] += item.base[j];
        fragNonBase[j] += item.nonBase[j];
      }
      chosen.push(item.id);
      dfs(i + 1, remaining - 1);
      chosen.pop();
      for (let j = 0; j < nStats; j++) {
        fragBase[j] -= item.base[j];
        fragNonBase[j] -= item.nonBase[j];
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
  const prepared = prepareItems(candidates, p.counts, p.effectMap, weightedStats, stars, p.context, p.includeTournament === true, warnings);
  const { items, truncated } = limitItems(prepared, ctx);
  if (truncated) warnings.messages.push('候補が多いため単体スコア上位に絞って探索しました（厳密解でない可能性があります）');
  const slots = Number(p.member.my && p.member.my.equip_slots) || 3;
  const best = enumerateBest(items, slots, ctx);
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
  const ext = partyAbilityCorrections({
    members: p.members, battleIds: p.battleIds, teams: p.teams,
    effectMap: p.effectMap, leaderId: p.leaderId, leaders: p.leaders,
  });
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

  // 各キャラの候補を準備。
  // items（フラグメント側の寄与）はリーダー・ext に依存しないため、リーダー総当たり間で
  // p.itemsCache により再利用できる（キャッシュは同一の重み・文脈で使うこと）
  const prepared = targets.map((member) => {
    const cid = String(member.character.id);
    const ctx = makeScoreContext(member, ext[cid], weights, weightedStats, warnings);
    if (!ctx) return { cid, member, ctx: null, items: [], slots: 0 };
    let items = p.itemsCache && p.itemsCache[cid];
    if (!items) {
      const candidates = equippableFragments(member.character, p.fragmentsById);
      const stars = member.my?.stars ?? 7;
      const context = p.contexts ? p.contexts[cid] : undefined;
      items = prepareItems(candidates, p.counts, p.effectMap, weightedStats, stars, context, p.includeTournament === true, warnings);
      if (p.itemsCache) p.itemsCache[cid] = items;
    }
    const slots = Number(member.my && member.my.equip_slots) || 3;
    return { cid, member, ctx, items, slots };
  });

  // 奪い合いの有無を判定: あるフラグメントを使い得るキャラ数が所持数を超えるものがあるか。
  // 超えるものが無ければキャラごとに独立で厳密解が出せる（既定の所持数6ではこちらになる）
  const usableBy = {};
  for (const pc of prepared) {
    for (const item of pc.items) usableBy[item.id] = (usableBy[item.id] || 0) + 1;
  }
  const contended = Object.entries(usableBy).some(([fid, n]) => n > (Number(p.counts[fid]) || 0));
  if (!contended) {
    const assignments = {};
    let totalScore = 0;
    let anyTruncated = false;
    for (const pc of prepared) {
      let best = { ids: [], score: 0 };
      if (pc.ctx) {
        const lim = limitItems(pc.items, pc.ctx);
        anyTruncated = anyTruncated || lim.truncated;
        best = enumerateBest(lim.items, pc.slots, pc.ctx);
      }
      assignments[pc.cid] = { ids: best.ids, score: best.score };
      totalScore += best.score;
    }
    if (anyTruncated) {
      warnings.messages.push('候補が多いキャラは単体スコア上位に絞って探索しました（厳密解でない可能性があります）');
    }
    return { assignments, totalScore, exact: !anyTruncated, contended: false, ext, warnings: warnings.messages, unknown: warnings.unknown };
  }

  // 奪い合いあり（所持数を減らしている場合）→ 組合せ列挙＋分枝限定法
  const perChar = [];
  for (const pc of prepared) {
    if (!pc.ctx) {
      perChar.push({ cid: pc.cid, member: pc.member, combos: [{ ids: [], score: 0 }] });
      continue;
    }
    const { combos, truncated } = enumerateCombos(pc.items, pc.slots, pc.ctx, maxCombos);
    if (truncated) {
      exact = false;
      warnings.messages.push(
        `${pc.member.character.name || pc.cid} の装備組合せが多すぎるため上位 ${maxCombos} 通りに絞りました（厳密解でない可能性があります）`
      );
    }
    perChar.push({ cid: pc.cid, member: pc.member, combos });
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
  return { assignments, totalScore: bestScore, exact, contended: true, ext, warnings: warnings.messages, unknown: warnings.unknown };
}

/**
 * 表示用: キャラ1体 × 装備フラグメント一覧から、各ステータスの ❶〜❻ を計算する。
 * @returns {{stats:Object<string,object>, unknown:Array, conditionalOff:Array}}
 */
export function characterDetail({ member, ext, fragmentList, effectMap, context }) {
  const e = ext || { z: {}, zenkai: {}, ll: {}, extNonBase: {} };
  const stars = member.my?.stars ?? 7;
  const unknown = [];
  const conditionalOff = [];
  const basePct = Object.fromEntries(STATS.map((s) => [s, 0]));
  const nonBasePct = Object.fromEntries(STATS.map((s) => [s, 0]));
  for (const frag of fragmentList) {
    const r = fragmentStatEffects(frag, effectMap, { stars, context });
    unknown.push(...r.unknown);
    conditionalOff.push(...r.conditionalOff.map((c) => ({ ...c, fragmentName: frag.name })));
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
  return { stats, unknown, conditionalOff };
}
