// 探索用の高速評価器。calc.js の computeDamage と同じ式を、
// 「スキル×Lv → 各項への寄与」の表を前計算して数値配列だけで計算する。
// （computeDamage と結果が一致することはテストで確認している）

import { SKILL_EFFECTS, DAMAGE_ELEMENTS } from './model.js';
import { effectValue, rateOf, BASE_CRIT_MUL, NEG_CRIT_MUL } from './calc.js';

const TERMS = ['atkPct', 'atkFlat', 'atkActive', 'dmgPct', 'crit', 'elemFlat', 'elemPct', 'critElem', 'elder'];
const TI = Object.fromEntries(TERMS.map((t, i) => [t, i]));
const NT = TERMS.length;

export function compileEvaluator(weapon, skillDefs, settings, kinds) {
  const K = kinds.length;
  const index = Object.fromEntries(kinds.map((k, i) => [k, i]));
  const isDamageElem = DAMAGE_ELEMENTS.includes(weapon.element);
  const max = kinds.map((k) => (skillDefs[k] ? skillDefs[k].max : 5));
  // contrib[k][lv*NT + t]、hpContrib は体力比例分（体力を掛ける前の値）
  const contrib = [];
  const hpContrib = [];
  const critMulAt = [];
  const brutalAt = [];
  const brutalChanceAt = [];
  const needs = [];
  for (let i = 0; i < K; i++) {
    const kind = kinds[i];
    const def = skillDefs[kind];
    const m = max[i];
    const c = new Float64Array((m + 1) * NT);
    const h = new Float64Array((m + 1) * NT);
    const cm = new Float64Array(m + 1);
    const br = new Float64Array(m + 1);
    const bc = new Float64Array(m + 1);
    let need = null;
    for (const e of SKILL_EFFECTS[kind] || []) {
      if (e.elem && e.elem !== weapon.element) continue;
      if (e.elemAny && !e.elemAny.includes(weapon.element)) continue;
      if (e.types && !e.types.includes(weapon.type)) continue;
      if ((e.term === 'elemFlat' || e.term === 'elemPct' || e.term === 'critElem' || e.term === 'elder') && !isDamageElem) continue;
      if (e.needs) need = [index[e.needs[0]], e.needs[1]];
      const rate = (e.rate !== undefined || e.rateFrom) ? rateOf(e.rateFrom || kind, settings, weapon.type) / 100 : 1;
      for (let lv = 1; lv <= m; lv++) {
        let v = effectValue(def, lv, e.idx || 0);
        if (e.stacksFromCond !== undefined) {
          const cc = def.cond[Math.min(lv, def.cond.length) - 1] || [];
          v *= Number(cc[e.stacksFromCond] || 1);
        }
        if (e.stacksFromEff !== undefined) v *= effectValue(def, lv, e.stacksFromEff) || 1;
        if (e.perWeaponCrit) v *= Math.max(0, weapon.crit);
        if (e.mul) v *= e.mul;
        if (e.term === 'critMul') { cm[lv] = Math.max(cm[lv], v); continue; }
        if (e.term === 'brutal') { br[lv] = Math.max(br[lv], v); bc[lv] = effectValue(def, lv, 1); continue; }
        if (settings.optimistic && v < 0) continue;
        if (rate <= 0) continue;
        if (e.perHp) h[lv * NT + TI[e.term]] += v * rate;
        else c[lv * NT + TI[e.term]] += v * rate;
      }
    }
    contrib.push(c); hpContrib.push(h); critMulAt.push(cm); brutalAt.push(br); brutalChanceAt.push(bc);
    needs.push(need && need[0] !== undefined ? need : (need ? [-1, need[1]] : null));
  }
  const hbIdx = index.HEALTH_BOOST;
  const hbDef = skillDefs.HEALTH_BOOST;
  const hpBonus = Number(settings.hpBonus) || 0;
  const extraAtk = Number(settings.extraAtk) || 0;
  const weak = Number.isFinite(Number(settings.elemWeakMul)) && settings.elemWeakMul !== undefined && settings.elemWeakMul !== '' ? Number(settings.elemWeakMul) : 1;
  const deps = kinds.map(() => []);
  needs.forEach((nd, j) => { if (nd && nd[0] >= 0) deps[nd[0]].push(j); });
  const perHpKinds = hpContrib.map((h) => h.some((x) => x !== 0));

  // 状態: 項ベクトル t、会心倍率、凶会心、体力
  function hpOf(lv) {
    return 100 + (hbIdx !== undefined ? effectValue(hbDef, Math.min(lv[hbIdx], max[hbIdx])) : 0) + hpBonus;
  }
  function addKind(T, lv, i, l, hp, sign) {
    if (l <= 0) return;
    if (l > max[i]) l = max[i];
    const nd = needs[i];
    if (nd && (nd[0] < 0 || lv[nd[0]] < nd[1])) return;
    const c = contrib[i];
    const h = hpContrib[i];
    const o = l * NT;
    for (let j = 0; j < NT; j++) T[j] += sign * (c[o + j] + h[o + j] * hp);
  }
  function stateOf(lv) {
    const T = new Float64Array(NT);
    let critMul = BASE_CRIT_MUL;
    let brutal = 0;
    let brutalChance = 0;
    const hp = hpOf(lv);
    for (let i = 0; i < K; i++) {
      let l = lv[i];
      if (l <= 0) continue;
      if (l > max[i]) l = max[i];
      addKind(T, lv, i, l, hp, 1);
      if (critMulAt[i][l] > critMul) critMul = critMulAt[i][l];
      if (brutalAt[i][l] > brutal) { brutal = brutalAt[i][l]; brutalChance = brutalChanceAt[i][l]; }
    }
    return { T, critMul, brutal, brutalChance, hp };
  }
  function valueOf(T, critMul, brutal, brutalChance) {
    const phys = Math.floor((weapon.atk * (1 + T[0] / 100) + T[1] + extraAtk) * (1 + T[2] / 100));
    let elemNorm = 0;
    let elemCrit = 0;
    if (isDamageElem && (weapon.elem > 0 || T[5] > 0)) {
      const elder = 1 + T[8] / 100;
      elemNorm = Math.floor(Math.floor((weapon.elem * (1 + T[6] / 100) + T[5]) * elder) * weak);
      elemCrit = Math.floor(Math.floor((weapon.elem * (1 + (T[6] + T[7]) / 100) + T[5]) * elder) * weak);
    }
    const dmgMul = 1 + T[3] / 100;
    let cr = weapon.crit + T[4];
    if (cr > 100) cr = 100;
    if (cr < -100) cr = -100;
    const normal = (phys + elemNorm) * dmgMul;
    if (cr >= 0) {
      const p = cr / 100;
      return normal * (1 - p) + (phys + elemCrit) * dmgMul * critMul / 100 * p;
    }
    const q = brutal > 0 ? Math.min(1, brutalChance / 100) : 0;
    const neg = NEG_CRIT_MUL * (1 - q) + brutal * q;
    const p = -cr / 100;
    return normal * (1 - p) + normal * neg / 100 * p;
  }
  function evaluate(lv) {
    const s = stateOf(lv);
    return valueOf(s.T, s.critMul, s.brutal, s.brutalChance);
  }
  const tmp = new Float64Array(NT);
  // 状態 st（lv に対応）から、スキル i を n Lv 上げたときの値（lv は変更しない）
  function moveValue(st, lv, i, n) {
    if (i === hbIdx && perHpKinds.some(Boolean)) {
      lv[i] += n; const v = evaluate(lv); lv[i] -= n; return v;
    }
    tmp.set(st.T);
    const old = lv[i];
    const before = deps[i].length ? deps[i].map((j) => (lv[j] > 0)) : null;
    if (before) for (const j of deps[i]) addKind(tmp, lv, j, lv[j], st.hp, -1);
    addKind(tmp, lv, i, old, st.hp, -1);
    lv[i] = old + n;
    addKind(tmp, lv, i, old + n, st.hp, 1);
    if (before) for (const j of deps[i]) addKind(tmp, lv, j, lv[j], st.hp, 1);
    const l = Math.min(old + n, max[i]);
    const cm = critMulAt[i][l] > st.critMul ? critMulAt[i][l] : st.critMul;
    let br = st.brutal;
    let bc = st.brutalChance;
    if (brutalAt[i][l] > br) { br = brutalAt[i][l]; bc = brutalChanceAt[i][l]; }
    lv[i] = old;
    return valueOf(tmp, cm, br, bc);
  }

  return { kinds, index, max, evaluate, stateOf, moveValue, K };
}
