// オススメフラグメント（DESIGN.md §49）。キャラに依存しない「フラグそのものの強さ」の評価。
//
// ❸ = {(❷×0.01+1)×❶ + ブースト} × (基礎なし×0.01+1)（§2-4）なので、同じ +18% でも
//   基礎あり … ❷（アビリティ・ZENKAI・他のフラグの基礎あり）に足されるだけ。❷が大きいほど目減りする
//   基礎なし … 最後に全体へ掛かる。❷が大きいほど相対的に強くなる
// このため「フラグ1枚を素の状態で見た強さ（単体）」と「育成済みのキャラに他のフラグと一緒に
// 載せた強さ（実戦）」は順位が大きく入れ替わる。両方を同じ物差し（❸の伸び率%）で出す。
//
// 実戦の想定は実データから作る（固定値を埋めない）:
//   - アビリティ補正: 最新キャラが Z・ZENKAI から受けられる基礎あり補正の分布（中央値など）
//   - ソウルブースト: 最新キャラの soul_max / ❶ の中央値
//   - 他のフラグ2枚: その評価軸で単体上位のフラグの平均（基礎あり・基礎なし）
//
// 値はランダム（最小〜最大）で付き、選択式スロットは選択肢のどれか1つが付く（厳選）。
// ランキングは「最大値・その軸で最良の選択肢」で評価し、厳選チェッカーで実際の個体を評価する。

import { resolveEffect } from './effects.js';
import { memberAbilityGroups, sumGroupsFor, statBase, fragsConflict, isTournamentOnly } from './optimizer.js';

export const MAIN_STATS = ['hp', 'strike_atk', 'blast_atk', 'strike_def', 'blast_def'];

/** 評価軸（すべて ❸ の伸び率 % で、耐久は3種の平均） */
export const AXES = {
  total: { label: '総合', note: '打撃総合と射撃総合の高い方（そのフラグが向いている側で評価）' },
  strike_total: { label: '打撃総合', note: '（打撃攻撃力の伸び＋耐久の伸び）÷2' },
  blast_total: { label: '射撃総合', note: '（射撃攻撃力の伸び＋耐久の伸び）÷2' },
  strike_atk: { label: '打撃火力', note: '打撃攻撃力の伸び' },
  blast_atk: { label: '射撃火力', note: '射撃攻撃力の伸び' },
  durability: { label: '耐久', note: '体力・打撃防御力・射撃防御力の伸びの平均' },
};

/** 装備ランク（参照サイトのランク計算と同じ閾値。score×10 で判定） */
export const EQUIP_RANKS = [
  { name: 'F', min: 0 }, { name: 'E', min: 100 }, { name: 'D', min: 200 }, { name: 'C', min: 300 },
  { name: 'B', min: 400 }, { name: 'A', min: 600 }, { name: 'S', min: 800 }, { name: 'Z', min: 900 },
  { name: 'Z+', min: 940 }, { name: 'Godly', min: 975 },
];

const median = (arr) => {
  const s = arr.filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (arr, p) => {
  const s = arr.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) * p)] : 0;
};

/**
 * フラグのスロット構造を数値化する（値はまだ掛けない）。
 * 条件つきの行は「条件達成時」で扱い（人数比例はバトル3体の最大人数）、conditional を立てる。
 * @returns {{id, slots: Array<{label, star7, scored, options: Array<{key, lines: Array}>}>,
 *            conditional, star7, hasRaw, others: Array<string>}}
 */
export function fragmentProfile(frag, effectMap) {
  const slots = [];
  let conditional = false, star7 = false, hasRaw = false;
  const others = new Set();
  for (const slot of frag.slots || []) {
    if (slot.star7) star7 = true;
    const fixed = [];
    const byOpt = new Map();
    let numeric = 0;
    for (const l of slot.lines || []) {
      if (l.raw != null) { hasRaw = true; if (l.option != null && !byOpt.has(l.option)) byOpt.set(l.option, []); continue; }
      const r = resolveEffect({ text: l.text, value: 1 }, effectMap);
      const eff = r.ok ? r.effects.filter((e) => !e.damage && MAIN_STATS.includes(e.stat)) : [];
      if (r.ok && (r.other || r.effects.length !== eff.length)) others.add(l.text);
      let mult = 1;
      if (l.cond) {
        conditional = true;
        if (l.cond_per_member) mult = l.cond_exclude_self ? 2 : 3;
      }
      const max = Number(l.value) || 0;
      const min = Number.isFinite(Number(l.value_min)) ? Number(l.value_min) : max;
      const line = { text: l.text, min, max, mult, cond: !!l.cond, cond_raw: l.cond_raw || '', effects: eff.map((e) => ({ stat: e.stat, base: e.base })) };
      numeric++;
      if (l.option != null) {
        if (!byOpt.has(l.option)) byOpt.set(l.option, []);
        byOpt.get(l.option).push(line);
      } else fixed.push(line);
    }
    const options = byOpt.size
      ? [...byOpt.entries()].map(([key, ls]) => ({ key, lines: [...fixed, ...ls] }))
      : [{ key: null, lines: fixed }];
    // fixedCount: 各選択肢の lines の先頭 fixedCount 行はどの選択肢にも付く固定行
    slots.push({ label: slot.label, star7: !!slot.star7, scored: numeric > 0, options, fixedCount: byOpt.size ? fixed.length : 0 });
  }
  return { id: String(frag.id), slots, conditional, star7, hasRaw, others: [...others] };
}

/**
 * ❸ の伸び率（%）。B=1 に正規化した ❸ = ((1+c/100)+r)×(1+n/100) を、
 * フラグの基礎あり b・基礎なし m を足す前後で比べる。
 */
export function statGainPct(c, n, r, b, m) {
  const f0 = ((1 + c / 100) + r) * (1 + n / 100);
  const f1 = ((1 + (c + b) / 100) + r) * (1 + (n + m) / 100);
  return f0 > 0 ? (f1 / f0 - 1) * 100 : 0;
}

/** 各ステの伸び率から軸のスコアを作る */
export function axisScore(axis, g) {
  const dur = ((g.hp || 0) + (g.strike_def || 0) + (g.blast_def || 0)) / 3;
  switch (axis) {
    case 'strike_atk': return { score: g.strike_atk || 0 };
    case 'blast_atk': return { score: g.blast_atk || 0 };
    case 'durability': return { score: dur };
    case 'strike_total': return { score: ((g.strike_atk || 0) + dur) / 2 };
    case 'blast_total': return { score: ((g.blast_atk || 0) + dur) / 2 };
    default: {
      const st = ((g.strike_atk || 0) + dur) / 2, bt = ((g.blast_atk || 0) + dur) / 2;
      return st >= bt ? { score: st, side: 'strike' } : { score: bt, side: 'blast' };
    }
  }
}

/** 選択肢の組（スロットごとの選択肢添字の直積）。組が多すぎるときは打ち切る */
function optionCombos(profiles) {
  const dims = profiles.flatMap((p) => p.slots.map((s) => s.options.length));
  let combos = [[]];
  for (const d of dims) {
    const next = [];
    for (const c of combos) for (let i = 0; i < d; i++) next.push([...c, i]);
    combos = next;
    if (combos.length > 4096) break;
  }
  return combos;
}

/**
 * 1枚以上のフラグを、文脈 ctx（{c:{stat}, n:{stat}, r:{stat}}）の上に載せたときの軸スコア。
 * roll（[{opt, vals}] スロット順・厳選チェッカー用）が無ければ最大値で、選択肢は軸にとって最良を選ぶ。
 * @returns {{score, side?, gains, base, nonBase, choice: Array<number>}}
 */
export function evaluateSet(profiles, ctx, axis, rolls = null) {
  const allSlots = profiles.flatMap((p, pi) => p.slots.map((s, si) => ({ s, roll: rolls?.[pi]?.[si] })));
  const combos = rolls ? [allSlots.map(({ roll }) => roll?.opt ?? 0)] : optionCombos(profiles);
  let best = null;
  for (const combo of combos) {
    const b = {}, m = {};
    allSlots.forEach(({ s, roll }, k) => {
      const opt = s.options[combo[k]] || s.options[0];
      opt.lines.forEach((ln, li) => {
        // ctx.noCond: 条件つきの効果を数えない（条件を満たせない編成で見たいとき）
        const mult = ln.cond && ctx.noCond ? 0 : ln.mult;
        if (mult === 0) return;
        const v = (roll && roll.opt === combo[k] && Number.isFinite(roll.vals?.[li]) ? roll.vals[li] : ln.max) * mult;
        for (const e of ln.effects) {
          if (e.base) b[e.stat] = (b[e.stat] || 0) + v; else m[e.stat] = (m[e.stat] || 0) + v;
        }
      });
    });
    const gains = {};
    for (const st of MAIN_STATS) {
      gains[st] = (b[st] || m[st]) ? statGainPct(ctx.c[st] || 0, ctx.n[st] || 0, ctx.r[st] || 0, b[st] || 0, m[st] || 0) : 0;
    }
    const a = axisScore(axis, gains);
    if (!best || a.score > best.score) best = { ...a, gains, base: b, nonBase: m, choice: combo };
  }
  return best || { score: 0, gains: {}, base: {}, nonBase: {}, choice: [] };
}

/**
 * 専用フラグか。装備条件にカード番号（「DBL40-02S」等）が入るものはそのカード専用
 * （別バージョンのカードがあると装備できるキャラが2体になるため、人数だけでは判定できない）。
 * 装備できるキャラが1体だけのものも専用扱い。
 */
export function isExclusive(frag) {
  if (Array.isArray(frag.equip_char_ids) && frag.equip_char_ids.length === 1) return true;
  return (frag.equip_cond || []).some((alt) => (alt || []).some((tk) => /^DBL[\w-]+$/.test(String(tk?.name || ''))));
}
/** 装備できるキャラ数（空 = 全キャラ） */
export function equipCount(frag, totalChars) {
  return Array.isArray(frag.equip_char_ids) && frag.equip_char_ids.length ? frag.equip_char_ids.length : totalChars;
}
/** ステータスを上げる通常のフラグか（イベント用・力の大会専用を除く） */
export function isStatFragment(frag, profile) {
  if (isTournamentOnly(frag) || frag.rarity === 'event') return false;
  return profile.slots.some((s) => s.options.some((o) => o.lines.some((l) => l.effects.length)));
}

/**
 * 実データから「実戦」の想定を作る（重いので1回だけ計算してキャッシュする想定）。
 * 最新 sample 体それぞれについて、主攻撃ステに Z・ZENKAI から受けられる基礎あり補正を
 *   battle … 自身のZ ＋ 他2体（バトル3体だけ）
 *   full   … 自身のZ ＋ 他5体（ゼンカイ枠まで育成）
 * として数え、分布の中央値・上位25%を返す。ソウルブースト比はステごとの中央値。
 */
export function abilityContextFromData(characters, effectMap, sample = 60) {
  const my = { stars: 10, zenkai_lv: 7 };
  const all = Object.values(characters).filter((c) => c && c.id != null);
  const groups = new Map(all.map((c) => [c.id, memberAbilityGroups({ character: c, my, effectMap })]));
  const recent = [...all].sort((a, b) => b.id - a.id).slice(0, sample);
  const battle = [], full = [];
  for (const t of recent) {
    const sb = statBase(t, my, 'strike_atk')?.base || 0, bb = statBase(t, my, 'blast_atk')?.base || 0;
    const stat = sb >= bb ? 'strike_atk' : 'blast_atk';
    const own = sumGroupsFor(groups.get(t.id).z, t).base[stat] || 0;
    const gains = [];
    for (const c of all) {
      if (c.id === t.id) continue;
      const g = groups.get(c.id);
      gains.push((sumGroupsFor(g.z, t).base[stat] || 0) + (sumGroupsFor(g.zenkai, t).base[stat] || 0));
    }
    gains.sort((a, b) => b - a);
    battle.push(own + gains[0] + gains[1]);
    full.push(own + gains.slice(0, 5).reduce((a, b) => a + b, 0));
  }
  const r = {};
  for (const st of MAIN_STATS) {
    r[st] = median(recent.map((c) => (c.stats?.[st] > 0 && c.soul_max?.[st] ? c.soul_max[st] / c.stats[st] : NaN)));
  }
  return {
    sample: recent.length,
    battle: Math.round(median(battle)),
    full: Math.round(median(full)),
    high: Math.round(quantile(full, 0.75)),
    boostRatio: r,
  };
}

/**
 * 文脈を作る。abilityPct は基礎あり補正の想定、partner は {base:{stat}, nonBase:{stat}}、
 * noCond は条件つきの効果を数えないとき true
 */
export function makeContext({ abilityPct = 0, boostRatio = {}, partner = null, noCond = false }) {
  const c = {}, n = {}, r = {};
  for (const st of MAIN_STATS) {
    c[st] = abilityPct + (partner?.base?.[st] || 0);
    n[st] = partner?.nonBase?.[st] || 0;
    r[st] = boostRatio[st] || 0;
  }
  return { c, n, r, noCond };
}

/**
 * 「他のフラグ2枚」の想定: その軸で単体上位 top 枚の、基礎あり・基礎なしの平均 × 2枚。
 * 実戦では残り2枠もその軸の強いフラグで埋まるので、その分も ❷・基礎なしに乗る。
 */
export function partnerProfile(entries, axis, boostRatio, top = 30, noCond = false) {
  const solo = makeContext({ abilityPct: 0, boostRatio, noCond });
  const scored = entries.map((e) => ({ e, v: evaluateSet([e.profile], solo, axis) }))
    .sort((a, b) => b.v.score - a.v.score).slice(0, top);
  const base = {}, nonBase = {};
  for (const { v } of scored) {
    for (const st of MAIN_STATS) {
      base[st] = (base[st] || 0) + (v.base[st] || 0) * 2 / scored.length;
      nonBase[st] = (nonBase[st] || 0) + (v.nonBase[st] || 0) * 2 / scored.length;
    }
  }
  return { base, nonBase, count: scored.length };
}

/**
 * ランキング。entries は {frag, profile} の配列（呼び出し側で絞り込み済み）。
 * 単体（素の状態）と実戦（アビリティ補正＋他のフラグ2枚の上）の両方で評価し、
 * 順位の差（育つほど化ける度合い）も付ける。
 */
export function rankFragments(entries, { axis = 'total', abilityPct = 285, boostRatio = {}, partnerTop = 30, partnerEntries = null, noCond = false } = {}) {
  const soloCtx = makeContext({ abilityPct: 0, boostRatio, noCond });
  // 「総合」は打撃と射撃で相方の顔ぶれが違う（打撃パの残り2枠は打撃のフラグ）ので、
  // 側ごとに相方を作って評価し、高い方を採る。混ぜると射撃のフラグが不当に低く出る
  const sides = axis === 'total' ? ['strike_total', 'blast_total'] : [axis];
  // 相方は汎用のフラグから作る（専用フラグを表示に含めても、残り2枠の想定は変えない）
  const partners = Object.fromEntries(sides.map((a) => [a, partnerProfile(partnerEntries || entries, a, boostRatio, partnerTop, noCond)]));
  const buildCtxs = Object.fromEntries(sides.map((a) => [a, makeContext({ abilityPct, boostRatio, partner: partners[a], noCond })]));
  const evalSides = (profile, ctxOf) => {
    let best = null;
    for (const a of sides) {
      const v = evaluateSet([profile], ctxOf(a), a);
      if (axis === 'total') v.side = a === 'strike_total' ? 'strike' : 'blast';
      if (!best || v.score > best.score) best = { ...v, axis: a };
    }
    return best;
  };
  const rows = entries.map(({ frag, profile }) => ({
    frag, profile,
    solo: evalSides(profile, () => soloCtx),
    build: evalSides(profile, (a) => buildCtxs[a]),
  }));
  [...rows].sort((a, b) => b.solo.score - a.solo.score).forEach((r, i) => { r.soloRank = i + 1; });
  rows.sort((a, b) => b.build.score - a.build.score).forEach((r, i) => {
    r.buildRank = i + 1;
    r.jump = r.soloRank - r.buildRank;
    // 実戦で残る割合（基礎ありはアビリティ補正に埋もれて目減りし、基礎なしはほぼ残る）
    r.retain = r.solo.score > 0 ? r.build.score / r.solo.score : 0;
  });
  return { rows, partners, soloCtx, buildCtxs, sides };
}

/** 2枚が同じキャラに同時装備できるか（装備できるキャラが重なる・同一種の覚醒前後でない・同じフラグでない） */
export function canPair(a, b) {
  if (String(a.id) === String(b.id) || fragsConflict(a, b)) return false;
  const ea = a.equip_char_ids || [], eb = b.equip_char_ids || [];
  if (ea.length === 0 || eb.length === 0) return true;
  const s = new Set(ea.map(String));
  return eb.some((x) => s.has(String(x)));
}

/**
 * 相性の良い相方。アビリティ補正の上（他のフラグは相方以外にもう1枚ぶんの想定）で
 * 2枚を一緒に載せた伸びを比べる。相乗 = 2枚一緒 − (それぞれ単独の和)。
 * 基礎なしの多いフラグは基礎ありの多い相方と組むと相乗が大きい（掛け算になるため）。
 */
export function bestPartners(target, entries, { axis = 'total', abilityPct = 285, boostRatio = {}, partner = null, top = 5, noCond = false } = {}) {
  const half = partner ? {
    base: Object.fromEntries(MAIN_STATS.map((s) => [s, (partner.base[s] || 0) / 2])),
    nonBase: Object.fromEntries(MAIN_STATS.map((s) => [s, (partner.nonBase[s] || 0) / 2])),
  } : null;
  const ctx = makeContext({ abilityPct, boostRatio, partner: half, noCond });
  const alone = evaluateSet([target.profile], ctx, axis).score;
  const out = [];
  for (const e of entries) {
    if (!canPair(target.frag, e.frag)) continue;
    const pair = evaluateSet([target.profile, e.profile], ctx, axis);
    const other = evaluateSet([e.profile], ctx, axis).score;
    out.push({ frag: e.frag, profile: e.profile, pair: pair.score, alone, other, synergy: pair.score - alone - other, choice: pair.choice });
  }
  return out.sort((a, b) => b.pair - a.pair).slice(0, top);
}

/**
 * 装備ランク（参照サイトのランク計算と同じ）。各スロットの品質 = Σ値/Σ最大（数値の無いスロットは満点）、
 * スロットごとに (品質 × 100/スロット数) を小数1桁に丸めて合計 → score（0〜100）。score×10 で閾値判定。
 * rolls: スロット順の {opt, vals}
 */
export function equipRank(profile, rolls) {
  const n = profile.slots.length;
  if (n === 0) return { score: 0, rank: EQUIP_RANKS[0].name };
  const per = 100 / n;
  let score = 0;
  profile.slots.forEach((s, i) => {
    const roll = rolls?.[i];
    const opt = s.options[roll?.opt ?? 0] || s.options[0];
    let sv = 0, sm = 0;
    opt.lines.forEach((ln, li) => {
      const v = Number.isFinite(roll?.vals?.[li]) ? roll.vals[li] : ln.max;
      sv += v; sm += ln.max;
    });
    const q = sm > 0 ? sv / sm : 1;
    score += Math.round(q * per * 10) / 10;
  });
  score = Math.round(score * 10) / 10;
  let rank = EQUIP_RANKS[0].name;
  for (const r of EQUIP_RANKS) if (score * 10 >= r.min) rank = r.name;
  return { score, rank };
}

/** 最大値・その軸で最良の選択肢の個体（厳選チェッカーの初期値） */
export function maxRoll(profile, choice) {
  return profile.slots.map((s, i) => {
    const opt = choice?.[i] ?? 0;
    return { opt, vals: (s.options[opt] || s.options[0]).lines.map((l) => l.max) };
  });
}

/**
 * 厳選の目安: スロットごとに「値が最小だったら」「外れの選択肢だったら」何%落ちるか（実戦の軸スコア比）。
 * 落ち幅の大きいスロットほど厳選で粘る価値がある。
 */
export function slotImportance(profile, ctx, axis) {
  const best = evaluateSet([profile], ctx, axis);
  const top = maxRoll(profile, best.choice);
  const full = best.score || 0;
  return profile.slots.map((s, i) => {
    if (!s.scored) return { label: s.label, minLoss: 0, worstOptLoss: 0, bestOpt: null, options: [] };
    const atMin = top.map((r, k) => (k === i
      ? { opt: r.opt, vals: (s.options[r.opt] || s.options[0]).lines.map((l) => l.min) }
      : r));
    const minScore = evaluateSet([profile], ctx, axis, [atMin]).score;
    const optScores = s.options.map((o, oi) => {
      const rr = top.map((r, k) => (k === i ? { opt: oi, vals: o.lines.map((l) => l.max) } : r));
      return evaluateSet([profile], ctx, axis, [rr]).score;
    });
    const worst = Math.min(...optScores);
    return {
      label: s.label,
      minLoss: full > 0 ? (1 - minScore / full) * 100 : 0,
      worstOptLoss: full > 0 && s.options.length > 1 ? (1 - worst / full) * 100 : 0,
      bestOpt: s.options.length > 1 ? best.choice[i] : null,
      options: optScores.map((v) => (full > 0 ? v / full * 100 : 0)),
    };
  });
}
