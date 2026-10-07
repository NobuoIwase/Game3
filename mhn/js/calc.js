// ダメージ期待値の計算（モーション値100・肉質100あたりの値）。
//
// 物理 = floor( (武器攻撃力 × (1 + 攻撃力倍率%) + 攻撃力加算 + 追加攻撃力) × (1 + 攻撃活性%) )
// 属性 = floor( floor( (武器属性 × (1 + 属性倍率%) + 属性加算) × (1 + 古龍属性倍率%) ) × 属性弱点倍率 )
//        ※会心時は 属性倍率% に 会心撃【属性】を加える
// 通常 = (物理 + 属性) × (1 + 与ダメージ%)
// 会心 = (物理 + 会心属性) × (1 + 与ダメージ%) × 会心倍率
// 期待値 = 通常 × (1 − 会心率) + 会心 × 会心率 （会心率が負のときはマイナス会心 0.75 倍）
//
// 条件付きスキルは「効果量 × 発動率」で按分する（線形近似）。

import { SKILL_EFFECTS, DAMAGE_ELEMENTS, defaultRate } from './model.js';

export const BASE_CRIT_MUL = 125;
export const NEG_CRIT_MUL = 75;

export function effectValue(skillDef, level, idx = 0) {
  if (!skillDef || level <= 0) return 0;
  const row = skillDef.eff[Math.min(level, skillDef.eff.length) - 1] || [];
  return Number(row[idx] || 0);
}

// [[kind, level], ...] を合算してスキルLv（上限でカット）にする
export function sumSkills(pairs, skillDefs) {
  const raw = {};
  for (const [kind, lv] of pairs) raw[kind] = (raw[kind] || 0) + lv;
  const out = {};
  for (const [kind, lv] of Object.entries(raw)) {
    const max = skillDefs[kind] ? skillDefs[kind].max : lv;
    out[kind] = Math.min(lv, max);
  }
  return { levels: out, raw };
}

export function rateOf(kind, settings, weaponType) {
  const r = settings && settings.rates && settings.rates[kind];
  if (r !== undefined && r !== null && r !== '') return Math.max(0, Math.min(100, Number(r)));
  return defaultRate(kind, weaponType);
}

// weapon: { type, element, atk, elem, crit }
// levels: { kind: level }
// settings: { rates, elemWeakMul, extraAtk, hp, optimistic }
export function computeDamage(weapon, levels, skillDefs, settings = {}) {
  const t = {
    atkPct: 0, atkFlat: 0, atkActive: 0, dmgPct: 0, crit: 0, critMul: BASE_CRIT_MUL,
    elemFlat: 0, elemPct: 0, critElem: 0, elder: 0, brutal: 0, brutalChance: 0,
  };
  const isDamageElem = DAMAGE_ELEMENTS.includes(weapon.element);
  const hp = 100 + effectValue(skillDefs.HEALTH_BOOST, levels.HEALTH_BOOST || 0) + (Number(settings.hpBonus) || 0);
  const contrib = [];

  for (const [kind, lv] of Object.entries(levels)) {
    const effs = SKILL_EFFECTS[kind];
    if (!effs || lv <= 0) continue;
    const def = skillDefs[kind];
    for (const e of effs) {
      if (e.needs && (levels[e.needs[0]] || 0) < e.needs[1]) continue;
      if (e.elem && e.elem !== weapon.element) continue;
      if (e.elemAny && !e.elemAny.includes(weapon.element)) continue;
      if (e.types && !e.types.includes(weapon.type)) continue;
      if ((e.term === 'elemFlat' || e.term === 'elemPct' || e.term === 'critElem' || e.term === 'elder') && !isDamageElem) continue;
      let v = effectValue(def, lv, e.idx || 0);
      if (e.stacksFromCond !== undefined) {
        const c = def.cond[Math.min(lv, def.cond.length) - 1] || [];
        v *= Number(c[e.stacksFromCond] || 1);
      }
      if (e.stacksFromEff !== undefined) v *= effectValue(def, lv, e.stacksFromEff) || 1;
      if (e.perWeaponCrit) v *= Math.max(0, weapon.crit);
      if (e.perHp) v *= hp;
      if (e.mul) v *= e.mul;
      if (e.term === 'critMul') { t.critMul = Math.max(t.critMul, v); continue; }
      if (e.term === 'brutal') { t.brutal = Math.max(t.brutal, v); t.brutalChance = effectValue(def, lv, 1); continue; }
      // 楽観評価（探索の上界計算用）では不利な効果を無視する
      if (settings.optimistic && v < 0) continue;
      const rate = (e.rate !== undefined || e.rateFrom) ? rateOf(e.rateFrom || kind, settings, weapon.type) / 100 : 1;
      if (rate <= 0) continue;
      t[e.term] += v * rate;
      contrib.push({ kind, term: e.term, value: v * rate });
    }
  }

  const extraAtk = Number(settings.extraAtk) || 0;
  const physInner = weapon.atk * (1 + t.atkPct / 100) + t.atkFlat + extraAtk;
  const phys = Math.floor(physInner * (1 + t.atkActive / 100));

  const weak = Number.isFinite(Number(settings.elemWeakMul)) && settings.elemWeakMul !== undefined && settings.elemWeakMul !== '' ? Number(settings.elemWeakMul) : 1;
  let elemNorm = 0;
  let elemCrit = 0;
  if (isDamageElem && (weapon.elem > 0 || t.elemFlat > 0)) {
    const elder = 1 + t.elder / 100;
    elemNorm = Math.floor(Math.floor((weapon.elem * (1 + t.elemPct / 100) + t.elemFlat) * elder) * weak);
    elemCrit = Math.floor(Math.floor((weapon.elem * (1 + (t.elemPct + t.critElem) / 100) + t.elemFlat) * elder) * weak);
  }

  const dmgMul = 1 + t.dmgPct / 100;
  const critRate = Math.max(-100, Math.min(100, weapon.crit + t.crit));
  const normal = (phys + elemNorm) * dmgMul;
  let expected;
  let critHit;
  let critMul;
  if (critRate >= 0) {
    critMul = t.critMul;
    critHit = (phys + elemCrit) * dmgMul * critMul / 100;
    const p = critRate / 100;
    expected = normal * (1 - p) + critHit * p;
  } else {
    // 凶会心: マイナス会心時に一定確率で倍率が上がる（確率は公式データの2番目の値を採用・推定）
    const q = t.brutal > 0 ? Math.min(1, t.brutalChance / 100) : 0;
    critMul = NEG_CRIT_MUL * (1 - q) + t.brutal * q;
    critHit = normal * critMul / 100;
    const p = -critRate / 100;
    expected = normal * (1 - p) + critHit * p;
  }

  return {
    expected,
    normal,
    critHit,
    phys,
    physInner,
    elemNorm,
    elemCrit,
    critRate,
    critMul,
    dmgPct: t.dmgPct,
    terms: t,
    hp,
    contrib,
  };
}
