// フラグメント割当の最適化（DESIGN.md §4）
//
// 構成:
//   - abilityCorrections … Z/ZENKAI/LLアビの合算（編成が決まれば定数 — §4-3）
//   - bestForCharacter   … キャラ1体に対する最適な N 枚の選出（v1）
//   - optimizeParty      … 所持数の奪い合いを含む全体最適化（v2）。
//                          貪欲法で初期解を作り、分枝限定法で厳密解を探索する。
//                          探索が打ち切られた場合は結果に exact:false を立てる。
//
// スコアは「重み付き相対値」: Σ weight[stat] × (❸ / フラグメント無しの❸)。
// ステータスごとの絶対値の桁差（体力 vs クリティカル）に引きずられないための正規化。
// 単一ステータス最大化は one-hot の重みと同値（argmax は ❸ 直接比較と一致する）。
// 固定の「基礎あり優先/基礎なし優先」ルールは実装しない（§2-5）。必ず ❸ を評価して比較する。

import { STATS, finalStat, computeStat } from './calc.js';
import { resolveFragmentEffects } from './effects.js';

/** 装備条件（タグ）の判定。§4-1 */
export function canEquip(character, fragment) {
  const tags = character.tags || [];
  const cond = fragment.equip_conditions || {};
  const any = cond.require_tags_any || [];
  const all = cond.require_tags_all || [];
  if (any.length > 0 && !any.some((t) => tags.includes(t))) return false;
  if (all.length > 0 && !all.every((t) => tags.includes(t))) return false;
  return true;
}

/** キャラが装備可能なフラグメント定義の一覧 */
export function equippableFragments(character, fragmentsById) {
  return Object.values(fragmentsById).filter((f) => canEquip(character, f));
}

/**
 * アビリティがこのキャラに乗るか。condition_tags が空なら全員に乗る。
 * 1つでも一致するタグがあれば乗る。
 */
export function abilityApplies(ability, character) {
  const cond = ability.condition_tags || [];
  if (cond.length === 0) return true;
  const tags = character.tags || [];
  return cond.some((t) => tags.includes(t));
}

/**
 * パーティのアビリティ補正を合算する（§2-2 / §4-3）。
 * 編成が決まればフラグメントに依存しない定数になる。
 *
 * @param {Array<{character:object, my:object}>} members パーティ（最大6体）
 *   character … game_data のキャラ定義（tags を使う）
 *   my        … my_data のキャラ情報（z_ability / zenkai_ability / ll_ability）
 * @param {Array<number|string>} battleIds バトル出撃する3体のキャラID
 * @returns {Object<string, {z:Object, zenkai:Object, ll:Object, extNonBase:Object, warnings:Array<string>}>}
 *   キャラID → ステータスごとの補正合計(%)。
 *   z / zenkai はパーティ6体全員に、ll はバトル3体のみに乗る。
 *   基礎なし(base:false)のアビリティは §2-3 の式に存在しない未検証項目のため、
 *   extNonBase に分離して警告を付ける（§1-4: 黙って無視しない）。
 */
export function abilityCorrections(members, battleIds) {
  const battleSet = new Set((battleIds || []).map(String));
  const out = {};
  for (const m of members) {
    const zero = () => Object.fromEntries(STATS.map((s) => [s, 0]));
    out[String(m.character.id)] = { z: zero(), zenkai: zero(), ll: zero(), extNonBase: zero(), warnings: [] };
  }
  const sources = [
    { key: 'z', list: 'z_ability', battleOnly: false, label: 'Zアビリティ' },
    { key: 'zenkai', list: 'zenkai_ability', battleOnly: false, label: 'ZENKAIアビリティ' },
    { key: 'll', list: 'll_ability', battleOnly: true, label: 'LLアビリティ' },
  ];
  for (const src of sources) {
    for (const owner of members) {
      const abilities = (owner.my && owner.my[src.list]) || [];
      for (const ab of abilities) {
        if (!STATS.includes(ab.stat)) {
          for (const m of members) {
            out[String(m.character.id)].warnings.push(
              `${owner.character.name || owner.character.id} の${src.label}に未知のステータス種別「${ab.stat}」があり、計算に含めていません`
            );
          }
          continue;
        }
        for (const target of members) {
          const tid = String(target.character.id);
          if (src.battleOnly && !battleSet.has(tid)) continue;
          if (!abilityApplies(ab, target.character)) continue;
          const value = Number(ab.value) || 0;
          if (ab.base === false) {
            // 基礎なしアビリティ: §2-3 の式では全アビリティが ❷（加算プール）扱い。
            // 乗算側に合流させるが、未検証である旨を警告する。
            out[tid].extNonBase[ab.stat] += value;
            out[tid].warnings.push(
              `${owner.character.name || owner.character.id} の${src.label}「基礎なし ${ab.stat} +${value}%」は検証済みの計算式に無い形式のため、基礎なし補正として乗算しています（実機で要確認）`
            );
          } else {
            out[tid][src.key][ab.stat] += value;
          }
        }
      }
    }
  }
  return out;
}

/**
 * 最適化用にフラグメントを前処理する。
 * 効果を解決し、ステータス別の base/nonBase 配列（weightedStats 順）を持たせる。
 */
function prepareItems(candidates, counts, effectMap, weightedStats, allWarnings) {
  const items = [];
  for (const frag of candidates) {
    const count = counts[String(frag.id)] || 0;
    if (count <= 0) continue;
    const { effects, unknown } = resolveFragmentEffects(frag, effectMap);
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
    if (!relevant) continue; // 評価対象ステに効果が無い → 候補から外す（未対応効果は上で警告済み）
    items.push({ id: String(frag.id), name: frag.name || String(frag.id), count, base, nonBase });
  }
  return items;
}

/**
 * キャラ1体のスコア計算コンテキストを作る。
 * @returns {null|object} 評価対象ステが1つも計算できない場合は null（警告は warnings に積む）
 */
function makeScoreContext(member, ext, weights, weightedStats, warnings) {
  const stats = [];
  const charName = member.character.name || member.character.id;
  for (const s of weightedStats) {
    const total = Number((member.character.base_stats || {})[s]) || 0;
    const boost = Number((member.my && member.my.boost ? member.my.boost[s] : 0)) || 0;
    if (total <= 0) {
      warnings.messages.push(
        `${charName} の「${s}」は合計ステが未入力のため、このステータスを評価から除外しました`
      );
      stats.push(null);
      continue;
    }
    const e = ext || { z: {}, zenkai: {}, ll: {}, extNonBase: {} };
    const extBase = (e.z[s] || 0) + (e.zenkai[s] || 0) + (e.ll[s] || 0);
    const extNonBase = e.extNonBase ? (e.extNonBase[s] || 0) : 0;
    const base = total - boost;
    const final0 = finalStat({ base, boost, corr: extBase, nonBase: extNonBase });
    stats.push({
      stat: s,
      weight: weights[s],
      total, boost, base, extBase, extNonBase,
      final0: final0 !== 0 ? final0 : 1,
    });
  }
  if (stats.every((c) => c === null)) return null;
  return { stats };
}

/** コンテキスト＋フラグメント補正合計からスコアを出す */
function scoreOf(ctx, fragBase, fragNonBase) {
  let score = 0;
  for (let i = 0; i < ctx.stats.length; i++) {
    const c = ctx.stats[i];
    if (!c) continue;
    const final = finalStat({
      base: c.base,
      boost: c.boost,
      corr: c.extBase + fragBase[i],
      nonBase: c.extNonBase + fragNonBase[i],
    });
    score += c.weight * (final / c.final0);
  }
  return score;
}

/**
 * キャラ1体分の全装備組合せを列挙し、スコア降順で返す。
 * @returns {Array<{ids:Array<string>, score:number}>} 先頭が最良。空装備も含む。
 */
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
        // k+1 個目へ（ループ継続）。後始末は下でまとめて行う
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

/**
 * v1: キャラ1体に対する最適な N 枚を選ぶ。
 *
 * @param {object} p
 * @param {{character:object, my:object}} p.member 対象キャラ
 * @param {object} [p.ext] abilityCorrections の該当キャラ分（省略時はアビリティ補正なし）
 * @param {object} p.fragmentsById フラグメント定義（ID→定義）
 * @param {object} p.counts 所持個数（ID→個数）
 * @param {object} p.weights ステータス重み（例 {strike_atk:1}）
 * @param {object} p.effectMap effect_map.json の中身
 * @param {boolean} [p.allowDuplicates=false] 同一フラグメントを同キャラに複数装備できるとみなすか（実機未確認のため既定は不可）
 * @returns {{ids:Array<string>, score:number, warnings:Array<string>, unknown:Array}}
 */
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
  const items = prepareItems(candidates, p.counts, p.effectMap, weightedStats, warnings);
  const slots = Number(p.member.my && p.member.my.equip_slots) || 3;
  const { combos } = enumerateCombos(items, slots, ctx, p.allowDuplicates === true, 0);
  const best = combos[0] || { ids: [], score: scoreOf(ctx, new Float64Array(weightedStats.length), new Float64Array(weightedStats.length)) };
  return { ids: best.ids, score: best.score, warnings: warnings.messages, unknown: warnings.unknown };
}

/**
 * v2: パーティ全体の最適化。フラグメントの奪い合い（所持数制約）だけがキャラ間の結合（§4-3）。
 *
 * @param {object} p
 * @param {Array<{character:object, my:object}>} p.members パーティ（最大6体）
 * @param {Array<number|string>} p.battleIds バトル出撃3体のID
 * @param {object} p.fragmentsById フラグメント定義
 * @param {object} p.counts 所持個数（ID→個数）
 * @param {object} p.weights ステータス重み
 * @param {object} p.effectMap effect_map.json
 * @param {'battle'|'all'} [p.targets='battle'] スコア対象（バトル3体のみ or パーティ6体）
 * @param {boolean} [p.allowDuplicates=false]
 * @param {number} [p.maxCombosPerChar=20000] キャラごとの組合せ上限（超過時は上位のみ・exact:false）
 * @param {number} [p.nodeBudget=2000000] 分枝限定法の探索ノード上限（超過時は exact:false）
 * @returns {{assignments:Object<string,{ids:Array<string>,score:number}>, totalScore:number,
 *            exact:boolean, ext:object, warnings:Array<string>, unknown:Array}}
 */
export function optimizeParty(p) {
  const warnings = { messages: [], unknown: [] };
  const weightedStats = STATS.filter((s) => (p.weights[s] || 0) > 0);
  if (weightedStats.length === 0) {
    return { assignments: {}, totalScore: 0, exact: true, ext: {}, warnings: ['評価するステータスの重みがすべて 0 です'], unknown: [] };
  }
  const weights = Object.fromEntries(weightedStats.map((s) => [s, p.weights[s]]));
  const ext = abilityCorrections(p.members, p.battleIds);
  for (const id of Object.keys(ext)) warnings.messages.push(...ext[id].warnings);

  const targets = p.targets === 'all'
    ? p.members
    : p.members.filter((m) => (p.battleIds || []).map(String).includes(String(m.character.id)));
  if (targets.length === 0) {
    return { assignments: {}, totalScore: 0, exact: true, ext, warnings: [...warnings.messages, '最適化対象のキャラがいません（バトル出撃3体を選択してください）'], unknown: warnings.unknown };
  }

  const maxCombos = p.maxCombosPerChar ?? 20000;
  let exact = true;

  // 各キャラの組合せ列挙（スコア降順）
  const perChar = [];
  for (const member of targets) {
    const cid = String(member.character.id);
    const ctx = makeScoreContext(member, ext[cid], weights, weightedStats, warnings);
    if (!ctx) {
      perChar.push({ cid, member, combos: [{ ids: [], score: 0 }] });
      continue;
    }
    const candidates = equippableFragments(member.character, p.fragmentsById);
    const items = prepareItems(candidates, p.counts, p.effectMap, weightedStats, warnings);
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

  // 奪い合いの解決: 貪欲法で初期解 → 分枝限定法で厳密解を探索
  // ベスト組合せのスコアが大きいキャラから確定していく方が上界が締まりやすい
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
    if (acc + suffixBest[i] <= bestScore + EPS) return; // 上界による枝刈り
    for (const combo of perChar[i].combos) {
      if (++nodes > nodeBudget) { aborted = true; return; }
      if (acc + combo.score + suffixBest[i + 1] <= bestScore + EPS) break; // 降順なので以降も無理
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
  const unknown = [];
  const basePct = Object.fromEntries(STATS.map((s) => [s, 0]));
  const nonBasePct = Object.fromEntries(STATS.map((s) => [s, 0]));
  for (const frag of fragmentList) {
    const r = resolveFragmentEffects(frag, effectMap);
    unknown.push(...r.unknown);
    for (const ef of r.effects) {
      if (ef.base) basePct[ef.stat] += ef.value;
      else nonBasePct[ef.stat] += ef.value;
    }
  }
  const stats = {};
  for (const s of STATS) {
    const total = Number((member.character.base_stats || {})[s]) || 0;
    const boost = Number((member.my && member.my.boost ? member.my.boost[s] : 0)) || 0;
    if (total <= 0) continue;
    stats[s] = computeStat({
      total, boost,
      z: e.z[s] || 0,
      zenkai: e.zenkai[s] || 0,
      ll: e.ll[s] || 0,
      fragBase: basePct[s],
      fragNonBase: nonBasePct[s],
      extNonBase: e.extNonBase ? (e.extNonBase[s] || 0) : 0,
    });
  }
  return { stats, unknown };
}
