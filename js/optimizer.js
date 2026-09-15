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

import { STATS, ALL_STATS, PSEUDO_STATS, PSEUDO_STAT_BASE, finalStat, computeStat } from './calc.js';
import { fragmentStatEffects, resolveAbilityGroups, conditionMatches } from './effects.js';

// ---------------------------------------------------------------- 装備条件

/**
 * 装備可否の判定。
 * v2（取り込みデータ）: equip_char_ids（参照サイトが解決済みの装備可能キャラ一覧）で判定。
 * v1（手入力データ）  : equip_conditions のタグ条件で判定。
 */
export function canEquip(character, fragment) {
  // 変身後タグを持つキャラ（transform_tags — §24）は、サイトの解決済みキャラ一覧が
  // 変身前後のタグを区別せず作られているため、解析済みの装備条件（equip_cond）が
  // あれば現タグ（変身前 = transform_tags 除去済み）で装備可否を再判定する。
  // フラグは基本的に変身前にしか付けられない（実機仕様）ので、変身後タグ頼みの装備は不可
  if (Array.isArray(character.transform_tags) && character.transform_tags.length > 0
      && Array.isArray(fragment.equip_cond) && fragment.equip_cond.length > 0
      && !conditionMatches(fragment.equip_cond, character)) {
    return false;
  }
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
 * 実機仕様（ユーザー確認済み — DESIGN.md §10-2 / §32）:
 *   ★0〜2 → I / ★3〜5 → II / ★6〜13 → III / ★14 → IV
 * キャラごとに my.z_level 等で上書きできる。
 */
export function autoAbilityLevel(stars) {
  const s = Number(stars) || 0;
  if (s >= 14) return 4;
  if (s >= 6) return 3;
  if (s >= 3) return 2;
  return 1;
}

function pickAbilityLevel(list, override, stars) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const level = (override && override !== 'auto') ? Number(override) : autoAbilityLevel(stars);
  const idx = Math.min(Math.max(level, 1), list.length) - 1;
  return list[idx];
}

/**
 * ZENKAI覚醒の前提: 本体の限界突破が★7以上（§38）。
 * ★6以下のキャラは ZENKAIアビリティ自体が無い。
 */
export const ZENKAI_MIN_STARS = 7;

/**
 * ZENKAIレベル(1〜7) → ZENKAIアビリティレベル(1〜4) の対応表（§38・ユーザー提供）。
 * **星（限界突破）とは連動しない。** ZENKAI覚醒は本体★7以上が前提で、そこから先は
 * ZENKAIソウルの取得で ZENKAIレベルが上がる。したがって「★7のまま ZENKAIレベル7 =
 * ZENKAIアビリティIV」がありうる。Zアビ・出撃Zアビの autoAbilityLevel（星依存）とは別物。
 * 対応表を直すときはこの配列だけ変えればよい。
 */
export const ZENKAI_ABILITY_BY_LEVEL = [1, 1, 2, 2, 3, 3, 4]; // 添字 = ZENKAIレベル-1

/** 未入力は最大（Lv7 = アビリティIV）として扱う — ユーザー指定の既定 */
export const ZENKAI_DEFAULT_LEVEL = 7;

export function zenkaiAbilityLevel(zenkaiLv) {
  const n = Number(zenkaiLv);
  const lv = Number.isFinite(n) && n > 0 ? Math.round(n) : ZENKAI_DEFAULT_LEVEL;
  const i = Math.min(Math.max(lv, 1), ZENKAI_ABILITY_BY_LEVEL.length);
  return ZENKAI_ABILITY_BY_LEVEL[i - 1];
}

/** ZENKAIアビリティの採用レベル。手入力の上書きがあればそれ、無ければ ZENKAIレベルから */
function pickZenkaiAbility(list, override, zenkaiLv) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const level = (override && override !== 'auto') ? Number(override) : zenkaiAbilityLevel(zenkaiLv);
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
  // ZENKAIアビリティは星ではなく ZENKAIレベルで決まる（§38）。
  // 本体★7以上がZENKAI覚醒の前提なので、★6以下では発動しない
  const zenkaiOn = character.zenkai_ability?.length
    && my?.zenkai_level !== 0
    && stars >= ZENKAI_MIN_STARS;
  const zenkai = zenkaiOn
    ? resolve(pickZenkaiAbility(character.zenkai_ability, my?.zenkai_level, my?.zenkai_lv), 'ZENKAIアビリティ')
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
 * 出撃Zアビリティは数えない（実機の表示仕様）。リーダー特殊ルールも数えない
 * （実機確認: リーダーのタグ無視は選出時のみで、編成画面の◎×Nには影響しない — §23）。
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
  const zero = () => Object.fromEntries(ALL_STATS.map((s) => [s, 0]));
  const out = {};
  for (const m of members) {
    out[String(m.character.id)] = { z: zero(), zenkai: zero(), ll: zero(), extNonBase: zero(), damage: zero(), warnings: [], unknown: [] };
  }
  const resolved = members.map((m) => ({ m, ab: memberAbilityGroups({ ...m, effectMap }) }));

  const applyEffectsTo = (effects, tid, bucket, srcMember) => {
    for (const e of effects) {
      // 与ダメージ（§37）は最終火力への乗算。ゲームのステータス画面には出ないので
      // 表示用の ❸ に混ぜず専用バケツへ入れる（スコア側では乗算項として効かせる）
      if (e.damage) {
        out[tid].damage[e.stat] += e.value;
      } else if (e.base === false) {
        out[tid].extNonBase[e.stat] += e.value;
        // 擬似ステータス（体力被回復量など — §25）は元々%加算の効果で
        // 基礎あり/なしの区別が無いため、未検証形式の警告は出さない
        if (!PSEUDO_STATS.includes(e.stat)) {
          out[tid].warnings.push(
            `${srcMember.character.name || srcMember.character.id} のアビリティ「基礎なし ${e.stat} +${e.value}%」は検証済みの計算式に無い形式のため、基礎なし補正として乗算しています（実機で要確認）`
          );
        }
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
    const zero = () => Object.fromEntries(ALL_STATS.map((s) => [s, 0]));
    const out = {};
    for (const m of members) {
      out[String(m.character.id)] = { z: zero(), zenkai: zero(), ll: zero(), extNonBase: zero(), damage: zero(), warnings: [], unknown: [] };
    }
    teams.forEach((teamIds, i) => {
      const idSet = new Set(teamIds.map(String));
      const teamMembers = members.filter((m) => idSet.has(String(m.character.id)));
      if (teamMembers.length === 0) return;
      // leaders が渡されている場合はその値に従う（null = リーダー枠が空 → 特殊ルールなし）。
      // leaders 省略時のみ各チーム先頭へフォールバックする
      const teamLeader = leaders ? (leaders[i] ?? null) : teamIds[0];
      Object.assign(out, abilityCorrections(teamMembers, teamIds, effectMap, { leaderId: teamLeader }));
      applyResonance(out, teamMembers, teamLeader, effectMap);
    });
    return out;
  }
  const out = abilityCorrections(members, battleIds, effectMap, { leaderId });
  applyResonance(out, members, leaderId, effectMap);
  return out;
}

/**
 * ULTRAアビリティ「力の共鳴」の与ダメージを damage バケツへ足す（§43）。
 * 与ダメージは §37 の乗算チャンネルなので、ステータス表示(❸)は汚さずスコアにだけ効く。
 * 気力回復速度ぶんはステータスではない（effect_map で other）ため加えない。
 */
function applyResonance(out, members, leaderId, effectMap) {
  if (!effectMap?._ultra_resonance) return;
  for (const m of members) {
    const cid = String(m.character.id);
    if (!out[cid]) continue;
    const e = resonanceEffect(m.character, members, leaderId, effectMap);
    if (!e || !(e.pct > 0)) continue;
    // 「与ダメージ」（無印）は打撃・射撃の両方に乗る（§37 の effect_map 定義と揃える）
    out[cid].damage.strike_atk += e.pct;
    out[cid].damage.blast_atk += e.pct;
    out[cid].resonance = e;
  }
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
export function pickZenkaiMembers(p) {
  const obj = p.objective || (p.balance ? 'balance' : 'total');
  if (obj === 'balance' || (obj === 'ace' && p.aceId != null && p.aceId !== '')) {
    return pickZenkaiPooled({ ...p, objective: obj });
  }
  return scoreZenkaiCandidates(p).slice(0, 3);
}

/**
 * ゼンカイ枠を「バトル3体に行き渡らせる」選び方（§36）。
 *
 * 既定は「バトル3体の増分の合計」の最大化で、誰が受け取るかは問わない。
 * 集中が起きるのは「1体が1枠から多く貰える」からではなく、**狙える候補の数が
 * メンバーごとに全然違う**ため（§36-6）。ZENKAIアビは属性条件つきが多く、
 * 実データでは PUR のキャラを狙える候補が全705体中2体しかない一方、
 * 2属性（GRN+RED）のキャラは10体が狙える。1枠あたりの価値はほぼ互角なので、
 * 合計だけ見ると候補の多い側がわずかな差で勝ち続け、結果的に恩恵が偏る。
 * 実戦では3体とも戦うので、合計を多少落としても全員を底上げしたいことがある。
 *
 * 目的関数を「各員の伸び率（増分/❶）のうち最小のものを最大化する」に変える。
 * 同点なら合計が大きい方を採る。伸び率で見るのは、❶ の大きさが違う3体を
 * 絶対値で比べると ❶ の大きいキャラばかり優遇されてしまうため。
 *
 * 探索は「各員を単独で伸ばす上位K体の和集合」をプールにした総当たり。
 * 貪欲法は使えない（最初の1体を最小値だけで選ぶと局所解に落ち、
 * 実データで「合計 -26%・最小伸び率 50.3%」と、総当たりの
 * 「合計 -3%・最小伸び率 65.9%」より両方悪い結果になった）。
 */
function pickZenkaiPooled({ battleMembers, candidates, weights, weightsById, effectMap, leaderId, objective, aceId, aceWeight }) {
  if (!battleMembers || battleMembers.length === 0) return [];
  const table = zenkaiEffectTable({ battleMembers, candidates, effectMap, leaderId });
  if (table.length === 0) return [];
  const wOf = (m) => (weightsById && weightsById[String(m.character.id)]) || weights;
  // 各員について、重みが効くステータスの ❶ を先に引いておく（内側ループから外す）
  const perMember = battleMembers.map((m) => {
    const w = wOf(m);
    const stats = ALL_STATS.filter((s) => (w[s] || 0) && (statBase(m.character, m.my, s)?.base || 0) > 0);
    const base = stats.map((s) => statBase(m.character, m.my, s).base);
    return { stats, base, w, total: stats.reduce((a, s, i) => a + w[s] * base[i], 0) };
  });
  const gainsOf = (picked) => perMember.map((pm, i) => {
    let d = 0;
    for (let k = 0; k < pm.stats.length; k++) {
      const s = pm.stats[k];
      let corr = 0, nonBase = 0;
      for (const e of picked) {
        const pe = e.per[i];
        corr += pe.corr[s] || 0;
        nonBase += pe.nonBase[s] || 0;
      }
      if (corr <= 0 && nonBase <= 0) continue;
      d += pm.w[s] * pm.base[k] * (((corr * 0.01 + 1) * (nonBase * 0.01 + 1)) - 1);
    }
    return d;
  });
  // エース（§46）のインデックス。指定が無ければ -1
  const aceIdx = battleMembers.findIndex((m) => aceId != null && String(m.character.id) === String(aceId));
  // 他メンバーに残す下限の割合（§46）。
  // 「行き渡らせる」で達成できる最小伸び率の AW 倍を、他メンバーの最低ラインとして課し、
  // その制約の中でエースの伸び率を最大化する。1に近いほど均等、0にすると完全にエース専用
  const AW = Number.isFinite(Number(aceWeight)) ? Number(aceWeight) : 0.6;
  const evaluate = (picked) => {
    const g = gainsOf(picked);
    let minRel = Infinity, sum = 0, aceRel = 0, minOther = Infinity;
    for (let i = 0; i < g.length; i++) {
      sum += g[i];
      const rel = perMember[i].total > 0 ? g[i] / perMember[i].total : 0;
      if (perMember[i].total > 0) minRel = Math.min(minRel, rel);
      if (i === aceIdx) aceRel = rel;
      else if (perMember[i].total > 0) minOther = Math.min(minOther, rel);
    }
    return {
      minRel: Number.isFinite(minRel) ? minRel : 0,
      minOther: Number.isFinite(minOther) ? minOther : 0,
      aceRel, sum,
    };
  };
  // プール: 各員を単独で最も伸ばす上位K体の和集合 + 合計上位K体。
  // 「最小を上げる」解はここにしか現れないので、合計順の上位だけでは取りこぼす
  const K = Math.max(8, Math.ceil(90 / Math.max(1, battleMembers.length)));
  const pool = new Map();
  const single = table.map((e) => ({ e, g: gainsOf([e]) }));
  for (let i = 0; i < battleMembers.length; i++) {
    // エース重視ならエース単独で伸ばす候補を多めに拾う（解はそこに集中するため）
    const take = objective === 'ace' && i === aceIdx ? K * 2 : K;
    [...single].sort((a, b) => b.g[i] - a.g[i]).slice(0, take).forEach(({ e }) => pool.set(e.id, e));
  }
  [...single].sort((a, b) => b.g.reduce((x, y) => x + y, 0) - a.g.reduce((x, y) => x + y, 0))
    .slice(0, K).forEach(({ e }) => pool.set(e.id, e));
  const P = [...pool.values()];
  if (P.length <= 3) return P.map((e) => ({ id: e.id, delta: 0, zenkai: e.zenkai }));
  // 総当たり（プールは概ね 90〜120 体 = 12万〜28万通り。内側は加算だけなので十分速い）
  const EPS = 1e-9;
  const useAce = objective === 'ace' && aceIdx >= 0;
  // 1周目: 「行き渡らせる」最適（＝他メンバーが取り得る最小伸び率の上限）を求める。
  // エース重視ではこれを下限の基準に使う（§46: “そこそこ”を数値で担保する）
  let best = null, bestScore = { minRel: -Infinity, sum: -Infinity };
  const trios = [];
  for (let a = 0; a < P.length; a++) {
    for (let b = a + 1; b < P.length; b++) {
      for (let c = b + 1; c < P.length; c++) {
        const trio = [P[a], P[b], P[c]];
        const sc = evaluate(trio);
        if (useAce) trios.push({ trio, sc });
        if (sc.minRel > bestScore.minRel + EPS
          || (Math.abs(sc.minRel - bestScore.minRel) <= EPS && sc.sum > bestScore.sum)) {
          bestScore = sc; best = trio;
        }
      }
    }
  }
  if (useAce) {
    // 2周目: 「他メンバーの最小伸び率が、行き渡らせた場合の floor 倍以上」という
    // 制約の中でエースの伸び率を最大化する。制約を満たす解が無ければ floor を緩める。
    //
    // 下限の基準は「他メンバーが取り得る最大値」ではなく **1周目の均等解での他メンバーの最小伸び率**。
    // 前者だと floor=1 のとき「他メンバーだけを最大化する解」になり、
    // エースの伸びが均等解より小さくなる（実データで 62.3% → 41.6% に落ちた）。
    // 均等解を基準にすれば、均等解自身が必ず制約を満たすので
    // floor=1 が「均等解と同じかそれ以上」、floor=0 が「エース専用」の連続な目盛りになる。
    const bestMinAll = bestScore.minOther > 0 ? bestScore.minOther
      : trios.reduce((m, t) => Math.max(m, t.sc.minOther), 0);
    let picked = null;
    for (const floor of [AW, AW * 0.75, AW * 0.5, 0]) {
      const need = bestMinAll * floor;
      let bb = null, bs = { aceRel: -Infinity, sum: -Infinity };
      for (const t of trios) {
        if (t.sc.minOther + EPS < need) continue;
        if (t.sc.aceRel > bs.aceRel + EPS
          || (Math.abs(t.sc.aceRel - bs.aceRel) <= EPS && t.sc.sum > bs.sum)) { bs = t.sc; bb = t.trio; }
      }
      if (bb) { picked = { trio: bb, sc: bs }; break; }
    }
    if (picked) { best = picked.trio; bestScore = picked.sc; }
  }
  if (!best) return [];
  return best.map((e) => ({ id: e.id, delta: bestScore.sum / best.length, zenkai: e.zenkai }));
}

/**
 * 候補 × バトル各員の {corr, nonBase} を一度だけ作る。
 * memberAbilityGroups が候補数ぶん走るのが一番重いので、合計最大化・バランスの
 * どちらの選び方でも使い回せるようここで切り出している。
 */
function zenkaiEffectTable({ battleMembers, candidates, effectMap, leaderId }) {
  const leader = leaderId != null && leaderId !== '' ? String(leaderId) : null;
  const out = [];
  for (const c of candidates) {
    const ab = memberAbilityGroups({ ...c, effectMap });
    const per = battleMembers.map((m) => {
      const mid = String(m.character.id);
      const corr = {}, nonBase = {};
      const add = (effects) => {
        for (const e of effects) {
          if (e.damage) continue; // 与ダメージはステータス採点に入れない（§44）
          if (e.base === false) nonBase[e.stat] = (nonBase[e.stat] || 0) + e.value;
          else corr[e.stat] = (corr[e.stat] || 0) + e.value;
        }
      };
      // リーダーは他キャラのZアビをタグ無視で受ける（§12-3）
      for (const g of ab.z) if (conditionMatches(g.cond, m.character) || (leader && mid === leader)) add(g.effects);
      for (const g of ab.zenkai) if (conditionMatches(g.cond, m.character)) add(g.effects);
      return { corr, nonBase };
    });
    out.push({ id: c.character.id, per, zenkai: ab.zenkai.length > 0 ? 1 : 0 });
  }
  return out;
}

/**
 * ゼンカイ枠候補の採点（全候補を降順で返す — §29）。
 * pickZenkaiMembers はこの上位3体。提案カードも必ずこの関数を通し、
 * 「自動選出」と「提案」で採点がずれないようにする。
 */
export function scoreZenkaiCandidates({ battleMembers, candidates, weights, weightsById, effectMap, leaderId }) {
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
          if (e.damage) continue; // 与ダメージはステータス採点に入れない（§44）
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
      for (const s of ALL_STATS) {
        const w = wm[s] || 0;
        if (!w || (!(corr[s] > 0) && !(nonBase[s] > 0))) continue;
        const sb = statBase(m.character, m.my, s);
        if (!sb || sb.base <= 0) continue;
        delta += w * sb.base * ((((corr[s] || 0) * 0.01 + 1) * ((nonBase[s] || 0) * 0.01 + 1)) - 1);
      }
    }
    if (delta > 1e-9) scored.push({ id: c.character.id, delta, zenkai: ab.zenkai.length > 0 ? 1 : 0 });
  }
  // 恩恵が完全に同点なら ZENKAI 覚醒キャラを優先する（§28）。
  // リーダーはタグ無視で全Zアビを受けるため、Zアビの数値が同じ候補が同点で並ぶことがある
  scored.sort((a, b) => (b.delta - a.delta) || (b.zenkai - a.zenkai));
  return scored;
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
  // 擬似ステータス（体力被回復量など）: キャラの❶を持たないため仮想❶で評価する（§25）
  if (PSEUDO_STATS.includes(stat)) {
    return { base: PSEUDO_STAT_BASE, boost: 0, total: PSEUDO_STAT_BASE };
  }
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
    const e = ext || { z: {}, zenkai: {}, ll: {}, extNonBase: {}, damage: {} };
    const extBase = (e.z[s] || 0) + (e.zenkai[s] || 0) + (e.ll[s] || 0);
    // 与ダメージは採点に入れない（§44）。実機では与ダメージ／ダメージガードが
    // 全ソースで「加算される1つのプール」で、ステータスとは別枠の戦闘補正のため。
    // 情報としては ext.damage に保持し、表示だけで使う
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
      if (e.damage) continue; // 与ダメージはステータス採点に入れない（§44）
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
  const weightedStats = ALL_STATS.filter((s) => (p.weights[s] || 0) > 0);
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
  const weightedStats = ALL_STATS.filter((s) => (p.weights[s] || 0) > 0);
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
    const wStats = ALL_STATS.filter((s) => (wAll[s] || 0) > 0);
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
  // エース指定（§46）がある場合も、キャラ間を公平に比べてから倍率を掛けたいので正規化する。
  const aceId = p.aceId != null && p.aceId !== '' ? String(p.aceId) : null;
  if (p.weightsById || aceId) {
    for (const pc of perChar) {
      if (!pc.ctx) continue;
      const n = pc.ctx.stats.length;
      const base0 = scoreOf(pc.ctx, new Float64Array(n), new Float64Array(n));
      if (base0 > 0) for (const cmb of pc.combos) cmb.score /= base0;
    }
  }
  // エース優遇（§46）: 取り合いになったフラグメントをエースに回す。
  // 争いが無ければ全員が最良を取れるので、この倍率は結果に影響しない
  if (aceId) {
    const boost = Number(p.aceBoost) > 0 ? Number(p.aceBoost) : 2;
    for (const pc of perChar) {
      if (String(pc.cid) !== aceId) continue;
      for (const cmb of pc.combos) cmb.score *= boost;
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
  const basePct = Object.fromEntries(ALL_STATS.map((s) => [s, 0]));
  const nonBasePct = Object.fromEntries(ALL_STATS.map((s) => [s, 0]));
  // 与ダメージ（§37）は最終火力への乗算で、ゲームのステータス画面には出ない。
  // 表示用の ❸ は実機と一致させたいので、ここで分離して damagePct として別に返す。
  // （最適化スコアの側では基礎なしと同じ乗算項として効かせている）
  const damagePct = Object.fromEntries(ALL_STATS.map((s) => [s, 0]));
  for (const frag of fragmentList) {
    const r = fragmentStatEffects(frag, effectMap, { stars, context });
    unknown.push(...r.unknown);
    conditionalOff.push(...r.conditionalOff.map((c) => ({ ...c, fragmentName: frag.name })));
    for (const ef of r.effects) {
      if (ef.damage) damagePct[ef.stat] += ef.value;
      else if (ef.base) basePct[ef.stat] += ef.value;
      else nonBasePct[ef.stat] += ef.value;
    }
  }
  const stats = {};
  for (const s of ALL_STATS) {
    const sb = statBase(member.character, member.my, s);
    if (!sb || sb.base <= 0) continue;
    const abilityDmg = e.damage ? (e.damage[s] || 0) : 0;
    damagePct[s] += abilityDmg;
    stats[s] = computeStat({
      total: sb.total, boost: sb.boost,
      z: (e.z[s] || 0) + (e.zenkai[s] || 0),
      zenkai: 0,
      ll: e.ll[s] || 0,
      fragBase: basePct[s],
      fragNonBase: nonBasePct[s],
      extNonBase: e.extNonBase ? (e.extNonBase[s] || 0) : 0,
    });
    // 与ダメージは「ステータスとは別枠で全ソース加算される戦闘補正」なので %だけ情報として持つ。
    // ❸に掛けた“火力”は実機の式が別（ダメージガード等も同じプールに入る）ため出さない（§44）
    stats[s].damagePct = damagePct[s];
  }
  return { stats, unknown, conditionalOff, damagePct };
}

// ---------------------------------------------------------------- §40 逆引き・理論値

/**
 * 効果グループ列を「対象キャラに乗る分だけ」ステータス別に合算する（§40）。
 * @param groups memberAbilityGroups の z / zenkai / deploy のいずれか
 * @param target 受け取る側のキャラ定義
 * @param ignoreCond true なら条件を無視して全部乗せる（リーダー特例 §12-3 用）
 * @returns {{base:Object, nonBase:Object, damage:Object, total:number}} total は素の%の単純合計
 */
export function sumGroupsFor(groups, target, ignoreCond = false) {
  const base = {}, nonBase = {}, damage = {};
  let total = 0;
  for (const g of groups || []) {
    if (!g.effects?.length) continue;
    if (!ignoreCond && !conditionMatches(g.cond, target)) continue;
    for (const e of g.effects) {
      const bucket = e.damage ? damage : (e.base === false ? nonBase : base);
      bucket[e.stat] = (bucket[e.stat] || 0) + e.value;
      total += e.value;
    }
  }
  return { base, nonBase, damage, total };
}

/**
 * 「このキャラに ZENKAIアビリティが乗る ZENKAI覚醒キャラ」の一覧（§40）。
 * ゼンカイ枠に誰を置けるかを逆引きするための表。Zアビ分も併記する
 * （§36-7: 実際の優劣を決めているのは ZENKAIアビより Zアビであることが多い）。
 *
 * @param target 対象キャラ定義
 * @param characters 全キャラ定義の配列
 * @param opts.myOf   キャラID → my（星・ZENKAIレベル）を返す関数
 * @param opts.leaderId 対象がリーダーなら、Zアビはタグ無視で乗る（§12-3）
 * @returns 降順の配列 [{ id, character, zenkai, z, zenkaiTotal, zTotal }]
 */
export function zenkaiProvidersFor(target, characters, effectMap, opts = {}) {
  const myOf = opts.myOf || (() => ({ stars: 7 }));
  const isLeader = opts.leaderId != null && String(opts.leaderId) === String(target.id);
  const out = [];
  for (const c of characters) {
    if (!c || c.id == null) continue;
    if (String(c.id) === String(target.id)) continue;
    if (!(c.zenkai_ability || []).length) continue; // ZENKAI覚醒キャラだけ
    const ab = memberAbilityGroups({ character: c, my: myOf(c.id), effectMap });
    const zenkai = sumGroupsFor(ab.zenkai, target, false);
    if (zenkai.total <= 0) continue; // 条件に合わず1つも乗らないなら出さない
    const z = sumGroupsFor(ab.z, target, isLeader);
    out.push({ id: c.id, character: c, zenkai, z, zenkaiTotal: zenkai.total, zTotal: z.total });
  }
  out.sort((a, b) => (b.zenkaiTotal + b.zTotal) - (a.zenkaiTotal + a.zTotal));
  return out;
}

/**
 * 「ゲーム内で最も○○が高くなる組み合わせ」を概算する（§40・お遊びモード）。
 *
 * 厳密解は組合せ爆発（キャラ707体から6体 × フラグメント配分）で不可能なので、
 * 次の2段構えで求める。**近似であることを画面に明記すること。**
 *
 *   1段目: 各キャラを「リーダー兼対象」に固定し、残り5枠を埋めたときの ❷ を求める。
 *          リーダーは全キャラのZアビをタグ無視で受ける（§12-3）ので、Zアビ分は
 *          対象に依らず一定 → 先に計算して使い回せる。ZENKAI・出撃Zだけ条件判定する。
 *          枠の割り当ては「出撃Zアビは出撃3体からしか出ない」を考慮した近似
 *          （出撃Z込みで強い2体をバトル枠、残りをゼンカイ枠）。
 *   2段目: 1段目の上位 topN 体だけ、フラグメントを厳密に最適化して ❸ を出す。
 *
 * @returns {{ranking:Array, method:string}}
 */
export function theoreticalMax({
  stat, characters, fragmentsById, effectMap: rawMap, myOf, topN = 12, onProgress,
}) {
  const my = myOf || (() => ({ stars: 14, equip_slots: 4 }));
  const list = characters.filter((c) => c && c.id != null);
  // 「ゲーム内で最も○○の数値が高くなる」= ステータス画面の値（❸）の最大化。
  // 与ダメージ（§37）は最終火力への乗算でステータス画面には出ないので、
  // ここでは計算対象から外す（外さないと与ダメージ+170%の専用ユニフラを持つキャラが
  // ステータスではなく火力で1位になり、「○○の数値」として誤答になる）
  const effectMap = {
    ...rawMap,
    entries: Object.fromEntries(Object.entries(rawMap.entries || {})
      .map(([k, v]) => [k, v && v.damage ? { other: true } : v])),
  };

  // 各キャラのアビリティを1回だけ解決する（一番重い処理）
  const resolved = list.map((c) => ({ c, ab: memberAbilityGroups({ character: c, my: my(c.id), effectMap }) }));
  // Zアビはリーダーにタグ無視で乗る → 対象に依らず一定
  const zFree = resolved.map((r) => ({ r, s: sumGroupsFor(r.ab.z, null, true) }));
  onProgress?.(0.25);

  // 与ダメージはステータスではないので足さない（§44）
  const val = (sums) => (sums.base[stat] || 0) + (sums.nonBase[stat] || 0);
  const stage1 = [];
  for (const { c } of resolved) {
    const sb = statBase(c, my(c.id), stat);
    if (!sb || sb.base <= 0) continue;
    // 候補ごとの貢献（対象 = c 自身がリーダー）
    const cands = [];
    for (let i = 0; i < zFree.length; i++) {
      const { r, s } = zFree[i];
      if (String(r.c.id) === String(c.id)) continue;
      const z = val(s);
      const zk = r.ab.zenkai.length ? val(sumGroupsFor(r.ab.zenkai, c, false)) : 0;
      const dp = r.ab.deploy.length ? val(sumGroupsFor(r.ab.deploy, c, false)) : 0;
      if (z + zk + dp <= 0) continue;
      cands.push({ id: r.c.id, a: z + zk, d: dp });
    }
    // バトル枠2 = 出撃Z込みで強い2体 / ゼンカイ枠3 = 残りから強い3体（近似）
    cands.sort((x, y) => (y.a + y.d) - (x.a + x.d));
    const battle = cands.slice(0, 2);
    const used = new Set(battle.map((x) => String(x.id)));
    const bench = cands.filter((x) => !used.has(String(x.id))).sort((x, y) => y.a - x.a).slice(0, 3);
    // 自分自身のアビリティも自分に乗る
    const selfAb = resolved.find((r) => String(r.c.id) === String(c.id)).ab;
    const selfZ = val(sumGroupsFor(selfAb.z, c, true));
    const selfZk = val(sumGroupsFor(selfAb.zenkai, c, false));
    const selfDp = val(sumGroupsFor(selfAb.deploy, c, false));
    const corr = selfZ + selfZk + selfDp
      + battle.reduce((a, x) => a + x.a + x.d, 0)
      + bench.reduce((a, x) => a + x.a, 0);
    stage1.push({
      id: c.id, character: c, corr,
      base: sb.base, boost: sb.boost,
      noFrag: finalStat({ base: sb.base, boost: sb.boost, corr, nonBase: 0 }),
      party: [...battle.map((x) => x.id), ...bench.map((x) => x.id)],
    });
  }
  stage1.sort((a, b) => b.noFrag - a.noFrag);
  onProgress?.(0.6);

  // 2段目: 上位だけフラグメントを厳密最適化
  const ranking = [];
  const head = stage1.slice(0, topN);
  for (let i = 0; i < head.length; i++) {
    const e = head[i];
    const member = { character: e.character, my: my(e.id) };
    const counts = {};
    for (const f of Object.values(fragmentsById)) if (f && f.id != null) counts[String(f.id)] = 6;
    const ext = { z: { [stat]: e.corr }, zenkai: {}, ll: {}, extNonBase: {}, damage: {} };
    const best = bestForCharacter({
      member, ext, fragmentsById, counts, weights: { [stat]: 1 }, effectMap, context: null,
    });
    ranking.push({ ...e, fragIds: best.ids, final: best.score });
    onProgress?.(0.6 + (0.4 * (i + 1)) / head.length);
  }
  ranking.sort((a, b) => b.final - a.final);
  return {
    ranking,
    method: `全${list.length}体をリーダーに置いた場合の❷を算出し、上位${topN}体だけフラグメントを厳密最適化した概算`
      + '（与ダメージはステータス画面に出ないため計算から除外）',
  };
}

// ---------------------------------------------------------------- §43 ULTRAアビリティ「力の共鳴」

/**
 * 「力の共鳴」（ULTRAアビリティ）の中身を読む（§43）。パターンは effect_map に置く（§1-3）。
 *
 * 実機の仕様（データで確認した2表記・全31体）:
 *   リーダーの場合            … 与ダメージ／気力回復速度を固定値アップ（多くは30%）
 *   リーダーではない場合      … バトル／サポートメンバーの「指定タグ」1人につき N%ずつ
 *   （旧EVT版の一部はリーダー節が無く、人数×N%＋上限だけ）
 *
 * @returns {{tag:number|null, tagName:string, leaderPct:number, perPct:number, capPct:number}|null}
 */
export function parseResonance(ultraAbility, effectMap) {
  const def = effectMap?._ultra_resonance;
  if (!def || !ultraAbility) return null;
  const name = String(ultraAbility.name || '');
  if (!name.includes(def.name)) return null;
  const text = String(ultraAbility.text || '').replace(/\r\n/g, '\n');
  const num = (pat, src) => {
    if (!pat) return 0;
    try { const m = String(src).match(new RegExp(pat)); return m ? Number(m[1]) || 0 : 0; }
    catch { return 0; }
  };
  const hasLeader = def.leader_marker ? new RegExp(def.leader_marker).test(text) : false;
  // リーダー節と非リーダー節に切り分けてから数値を拾う（混ざると 30 と 5 を取り違える）
  let leaderPart = '', restPart = text;
  if (hasLeader && def.not_leader_marker) {
    const idx = text.search(new RegExp(def.not_leader_marker));
    if (idx > 0) { leaderPart = text.slice(0, idx); restPart = text.slice(idx); }
    else leaderPart = text;
  }
  const ref = (ultraAbility.ref_tags || []).find((t) => t && t.tag != null && !t.enemy);
  return {
    tag: ref ? Number(ref.tag) : null,
    tagName: ref ? String(ref.name || '') : '',
    leaderPct: hasLeader ? num(def.leader_pct, leaderPart) : 0,
    perPct: num(def.per_member_pct, restPart),
    capPct: num(def.cap_pct, text),
  };
}

/** キャラの ULTRAアビリティ一覧から「力の共鳴」を取り出す */
export function resonanceOf(character, effectMap) {
  for (const u of character?.ultra_ability || []) {
    const r = parseResonance(u, effectMap);
    if (r) return r;
  }
  return null;
}

/**
 * 今のパーティでの「力の共鳴」の効き（§43）。
 * @param character 対象（ULTRAキャラ）
 * @param members   パーティ全員 [{character, my}]（バトル3 + ゼンカイ枠3）
 * @param leaderId  リーダーのキャラID
 * @returns {{isLeader, count, pct, tagName, tag, matched:Array}|null}
 */
export function resonanceEffect(character, members, leaderId, effectMap) {
  const r = resonanceOf(character, effectMap);
  if (!r) return null;
  const isLeader = leaderId != null && String(leaderId) === String(character.id);
  if (isLeader) {
    return { isLeader: true, count: 0, pct: r.leaderPct, tagName: r.tagName, tag: r.tag, matched: [] };
  }
  const matched = (members || []).filter((m) => r.tag != null && (m.character.tags || []).includes(r.tag));
  let pct = r.perPct * matched.length;
  if (r.capPct > 0) pct = Math.min(pct, r.capPct);
  return { isLeader: false, count: matched.length, pct, tagName: r.tagName, tag: r.tag, matched };
}
