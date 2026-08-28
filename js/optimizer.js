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
// スコアは「重み付き絶対値」: Σ weight[stat] × ❸。
// （相対値 ❸/❸₀ は絶対値の小さいステータスを過大評価するため使わない — §17）
// 固定の「基礎あり優先/基礎なし優先」ルールは実装しない（§2-5）。必ず ❸ を評価して比較する。

import { STATS, finalStat, computeStat } from './calc.js';
import { fragmentStatEffects, resolveAbilityGroups, conditionMatches, conditionElementMatches } from './effects.js';

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
 * 出撃Zアビリティは数えない（実機の表示仕様）。
 * 実機表示に合わせた追加ルール（§23: 実機スクショとの完全一致で確認）:
 *   1. リーダーのZアビリティはタグ無視で全員に「関係あり」と数える
 *   2. ZENKAIアビリティは属性(element)条項が一致すれば「関係あり」と数える
 *      （※実効果の適用は従来どおり タグ&属性 の完全一致のみ。あくまで表示上の関係数）
 * @param {object} [opts] { leaderId } リーダーのキャラID（スタンダード=1枠目）
 * @returns {Object<string, number>} キャラID → 関係数
 */
export function zRelationCounts(members, effectMap, opts = {}) {
  const leaderId = opts.leaderId != null ? String(opts.leaderId) : null;
  const resolved = members.map((m) => ({ m, ab: memberAbilityGroups({ ...m, effectMap }) }));
  const out = {};
  for (const target of members) {
    const tid = String(target.character.id);
    let n = 0;
    for (const { m: src, ab } of resolved) {
      const leaderGive = leaderId != null && String(src.character.id) === leaderId;
      for (const kind of ['z', 'zenkai']) {
        const groups = (ab[kind] || []).filter((g) => g.effects.length > 0);
        if (!groups.length) continue;
        const hit = (kind === 'z' && leaderGive) || groups.some((g) =>
          conditionMatches(g.cond, target.character)
          || (kind === 'zenkai' && conditionElementMatches(g.cond, target.character)));
        if (hit) n++;
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

/**
 * ゼンカイ枠（スタンダード下段3枠）の自動選出。
 * 各候補を「バトル3体の重み付き補正増分」で採点し、増分が正の上位3体を返す。
 * アビリティ補正はキャラごとの加算が主で、候補同士に相互作用はほぼ無く、
 * 上位3体を選べば3枠合計もほぼ最大になる（基礎あり補正のみなら厳密。
 * 手入力由来の基礎なし補正 extNonBase は乗算のため交差項があり、その場合は近似）。
 * リーダーの「他キャラのZアビをタグ無視で受ける」特殊ルールも採点に含まれる。
 * 補正+1%の価値は ≈ 0.01×❶ で近似する（フラグメント配分が未確定の段階のため）。
 *
 * @param {object} p {battleMembers, candidates, weights, effectMap, leaderId?}
 *   battleMembers … バトル出撃3体（{character, my}）
 *   candidates    … 候補キャラ（{character, my}。所持キャラからパーティ外を渡す想定）
 * @returns {Array<{id, delta}>} 採点降順・最大3体
 */
export function pickZenkaiMembers({ battleMembers, candidates, weights, weightsById, effectMap, leaderId }) {
  if (!battleMembers || battleMembers.length === 0) return [];
  const leader = leaderId != null && leaderId !== '' ? String(leaderId) : null;
  // 候補はベンチ（非出撃）なので、候補の Z/ZENKAI アビがバトル3体の補正を
  // どれだけ増やすかだけを直接計算する（バトル3体自身の補正は候補間で一定なので不要）。
  // 全キャラを候補にしても高速に済むよう、abilityCorrections の全再計算は行わない
  const scored = [];
  for (const c of candidates) {
    const ab = memberAbilityGroups({ ...c, effectMap });
    let delta = 0;
    for (const m of battleMembers) {
      const mid = String(m.character.id);
      const wm = (weightsById && weightsById[mid]) || weights;
      const corr = {};
      const nonBase = {};
      const add = (effects) => {
        for (const e of effects) {
          if (e.base === false) nonBase[e.stat] = (nonBase[e.stat] || 0) + e.value;
          else corr[e.stat] = (corr[e.stat] || 0) + e.value;
        }
      };
      for (const g of ab.z) {
        // リーダーは他キャラのZアビをタグ無視で受ける（§12-3）
        if (conditionMatches(g.cond, m.character) || (leader && mid === leader)) add(g.effects);
      }
      for (const g of ab.zenkai) {
        if (conditionMatches(g.cond, m.character)) add(g.effects);
      }
      for (const s of STATS) {
        const w = wm[s] || 0;
        if (!w || (!(corr[s] > 0) && !(nonBase[s] > 0))) continue;
        const sb = statBase(m.character, m.my, s);
        if (!sb || sb.base <= 0) continue;
        delta += w * sb.base * ((((corr[s] || 0) * 0.01 + 1) * ((nonBase[s] || 0) * 0.01 + 1)) - 1);
      }
    }
    if (delta > 1e-9) scored.push({ id: c.character.id, delta });
  }
  scored.sort((a, b) => b.delta - a.delta);
  return scored.slice(0, 3);
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

// スコア = Σ 重み × ❸（絶対値）。
// 以前は ❸/❸₀ の相対値だったが、相対値だと絶対値の小さいステータス
// （クリティカル・気力回復など）の+X%が打撃攻撃力の+X%と同点になり、
// 多ステータス目標（総合ステ最大等）で比率の安い弱フラグが選ばれてしまう。
// 単一ステータス目標では選択結果は同じ（単調変換）。
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
    score += c.weight * final;
  }
  return score;
}

/** 力の大会専用フラグメントか（通常バトルでは装備不可 — §11-7） */
export function isTournamentOnly(fragment) {
  return fragment.top === true;
}

/** 探索前の候補数上限。超えた場合は単体スコア上位に絞る（結果に truncated を立てる） */
const MAX_ITEMS_PER_CHAR = 150;

/**
 * フラグメントの「種」。覚醒版はベース版のアイコンID（EqIco_<ベースID>）を共有するため、
 * アイコンIDを種キーとして使う（無ければ自身のID）。
 * 覚醒前と覚醒後の同一種は同じキャラに同時装備できない（実機仕様）。
 */
export function fragSpecies(frag) {
  const m = String(frag?.icon || '').match(/EqIco_(\d+)\./);
  return m ? m[1] : String(frag?.id ?? '');
}
const isAwakened = (frag) => String(frag?.rarity || '').startsWith('awakened');
/** 同一キャラに同時装備できない組か（同一種で覚醒/非覚醒が異なる） */
export function fragsConflict(a, b) {
  return fragSpecies(a) === fragSpecies(b) && isAwakened(a) !== isAwakened(b);
}

function prepareItems(candidates, counts, effectMap, weightedStats, stars, context, includeTournament, allWarnings, avoidUnmetCond, unmetPenalty) {
  const items = [];
  for (const frag of candidates) {
    if (isTournamentOnly(frag) && !includeTournament) continue;
    const count = counts[String(frag.id)] || 0;
    if (count <= 0) continue;
    const { effects, unknown, conditionalOff } = fragmentStatEffects(frag, effectMap, { stars, context });
    allWarnings.unknown.push(...unknown);
    const unmetCount = (conditionalOff || []).length;
    // 「効果条件を満たせないフラグは選ばない」: 未達の条件付き効果を持つ候補を除外する
    if (avoidUnmetCond && unmetCount > 0) continue;
    // 全発動の気持ちよさ優先: 未達の条件行1つにつき有効効果を unmetPenalty 倍に減点して評価する。
    // 明確に強いフラグは残り、僅差なら全発動のフラグが選ばれる（既定 0.95、実ステには影響しない選定用の重みダウン）
    const penalty = unmetCount > 0 && unmetPenalty != null && unmetPenalty < 1
      ? Math.pow(unmetPenalty, unmetCount)
      : 1;
    const base = new Float64Array(weightedStats.length);
    const nonBase = new Float64Array(weightedStats.length);
    let relevant = false;
    for (const e of effects) {
      const i = weightedStats.indexOf(e.stat);
      if (i < 0) continue;
      if (e.base) base[i] += e.value * penalty; else nonBase[i] += e.value * penalty;
      if (e.value !== 0) relevant = true;
    }
    if (!relevant) continue;
    items.push({
      id: String(frag.id), name: frag.name || String(frag.id), count, base, nonBase,
      species: fragSpecies(frag), awakened: isAwakened(frag),
    });
  }
  return items;
}

/** 覚醒前後の同一種は同じキャラに同時装備できない（species 同一かつ覚醒フラグが異なる） */
function conflictsWithChosen(item, chosenItems) {
  for (const c of chosenItems) {
    if (c.species === item.species && c.awakened !== item.awakened) return true;
  }
  return false;
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
  const chosenItems = [];
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
      if (conflictsWithChosen(item, chosenItems)) continue; // 覚醒前後の同一種は排他
      for (let j = 0; j < nStats; j++) {
        fragBase[j] += item.base[j];
        fragNonBase[j] += item.nonBase[j];
      }
      chosen.push(item.id);
      chosenItems.push(item);
      dfs(i + 1, remaining - 1);
      chosen.pop();
      chosenItems.pop();
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
  const chosenItems = [];
  const record = () => {
    combos.push({ ids: chosen.slice(), score: scoreOf(ctx, fragBase, fragNonBase) });
  };
  const dfs = (idx, remaining) => {
    record();
    if (remaining === 0) return;
    for (let i = idx; i < items.length; i++) {
      const item = items[i];
      if (conflictsWithChosen(item, chosenItems)) continue; // 覚醒前後の同一種は排他
      for (let j = 0; j < nStats; j++) {
        fragBase[j] += item.base[j];
        fragNonBase[j] += item.nonBase[j];
      }
      chosen.push(item.id);
      chosenItems.push(item);
      dfs(i + 1, remaining - 1);
      chosen.pop();
      chosenItems.pop();
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
  const prepared = prepareItems(candidates, p.counts, p.effectMap, weightedStats, stars, p.context, p.includeTournament === true, warnings, p.avoidUnmetCond === true, p.unmetPenalty);
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
  // タイプ別特化（p.weightsById）: キャラごとに重みを上書きできる。
  // 未指定のキャラは p.weights を使う。キャラ間で ❸ の桁が異なるため、
  // weightsById 指定時の奪い合い裁定は ❸₀ で正規化してから合算する（後述・§17）
  const weightsAllFor = (cid) => (p.weightsById && p.weightsById[cid]) || p.weights;
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
    const wAll = weightsAllFor(cid);
    const wStats = STATS.filter((s) => (wAll[s] || 0) > 0);
    const w = Object.fromEntries(wStats.map((s) => [s, wAll[s]]));
    const ctx = wStats.length ? makeScoreContext(member, ext[cid], w, wStats, warnings) : null;
    if (!ctx) return { cid, member, ctx: null, items: [], slots: 0 };
    let items = p.itemsCache && p.itemsCache[cid];
    if (!items) {
      const candidates = equippableFragments(member.character, p.fragmentsById);
      const stars = member.my?.stars ?? 7;
      const context = p.contexts ? p.contexts[cid] : undefined;
      items = prepareItems(candidates, p.counts, p.effectMap, wStats, stars, context, p.includeTournament === true, warnings, p.avoidUnmetCond === true, p.unmetPenalty);
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
    perChar.push({ cid: pc.cid, member: pc.member, combos, ctx: pc.ctx });
  }

  // キャラ別重み（weightsById）併用時の奪い合い裁定は、キャラ間で ❸ の桁が異なる
  // （体力特化 vs 打撃特化など）ため、フラグ無し基準値 ❸₀ で正規化してから合算する。
  // キャラ内の組合せ順位は定数除算なので不変（絶対値評価のまま）。
  if (p.weightsById) {
    for (const pc of perChar) {
      if (!pc.ctx) continue;
      const n = pc.ctx.stats.length;
      const base0 = scoreOf(pc.ctx, new Float64Array(n), new Float64Array(n));
      if (base0 > 0) for (const cmb of pc.combos) cmb.score /= base0;
    }
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
