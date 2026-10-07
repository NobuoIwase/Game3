import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { indexData, resolveWeapon, resolveArmor } from '../js/data.js';
import { computeDamage } from '../js/calc.js';
import { compileEvaluator } from '../js/fasteval.js';
import { searchBuilds, evaluateBuild, isRelevant } from '../js/search.js';
import { SKILL_EFFECTS, PARTS } from '../js/model.js';
import { extractIslandProps } from '../tools/build_data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const j = (n) => JSON.parse(readFileSync(join(ROOT, 'data', `${n}.json`), 'utf8'));
const sk = j('skills');
const D = indexData({ weapons: j('weapons'), armor: j('armor'), skills: sk.skills, driftstones: sk.driftstones, meta: j('meta') });

const W = (over = {}) => ({ type: 'LONG_SWORD', element: 'NO_ELEMENT', atk: 1000, elem: 0, crit: 0, skills: [], ...over });

test('データ: 公式の数値が読める（鉱石片手剣 10-5 は攻撃力1912）', () => {
  const w = D.weaponById.ORE_SWORDSHIELD;
  assert.equal(resolveWeapon(w, 10, 5).atk, 1912);
  assert.equal(resolveWeapon(w, 10, 1).atk, 1596);
  assert.equal(D.skills.ATTACK_BOOST.eff[4][0], 300);
  assert.ok(D.weapons.length > 700 && D.armor.length > 350);
  for (const a of D.armor) assert.ok(PARTS.includes(a.part), a.id);
});

test('データ: 防具の錬成枠はグレードで変わる', () => {
  const a = D.armorById.ORE_HEAD;
  assert.equal(resolveArmor(a, 4).slots, 0);
  assert.equal(resolveArmor(a, 10).slots, 1);
});

test('計算: 攻撃Lv5は+300、見切りLv5で会心40%', () => {
  const r = computeDamage(W(), { ATTACK_BOOST: 5, CRITICAL_EYE: 5 }, D.skills, {});
  assert.equal(r.phys, 1300);
  assert.equal(r.critRate, 40);
  assert.equal(r.expected, 1300 * 0.6 + 1300 * 1.25 * 0.4);
});

test('計算: 攻撃・境地は攻撃Lv5のときだけ有効', () => {
  assert.equal(computeDamage(W(), { ATTACK_BOOST: 4, ATTACK_BOOST_SECRET: 2 }, D.skills, {}).phys, 1200);
  assert.equal(computeDamage(W(), { ATTACK_BOOST: 5, ATTACK_BOOST_SECRET: 2 }, D.skills, {}).phys, 1650);
});

test('計算: 属性は武器属性と一致するスキルだけ、弱点倍率0なら加算しない', () => {
  const w = W({ element: 'FIRE', elem: 300 });
  assert.equal(computeDamage(w, { FIRE_ATTACK: 5, WATER_ATTACK: 5 }, D.skills, {}).elemNorm, 800);
  assert.equal(computeDamage(w, { FIRE_ATTACK: 5 }, D.skills, { elemWeakMul: 0 }).elemNorm, 0);
  // 状態異常武器の属性値はダメージにならない
  assert.equal(computeDamage(W({ element: 'POISON', elem: 300 }), {}, D.skills, {}).elemNorm, 0);
});

test('計算: マイナス会心は0.75倍', () => {
  const r = computeDamage(W({ crit: -20 }), {}, D.skills, {});
  assert.equal(r.expected, 1000 * 0.8 + 1000 * 0.75 * 0.2);
});

test('高速評価器は computeDamage と同じ値を返す', () => {
  const kinds = Object.keys(SKILL_EFFECTS);
  const settings = { rates: { BURST: 70 }, elemWeakMul: 1.5, extraAtk: 30 };
  const weapons = [
    W({ element: 'FIRE', elem: 400, crit: 10 }),
    W({ type: 'BOW', element: 'ICE', elem: 500, crit: -15 }),
    W({ type: 'CHARGE_BLADE', element: 'POISON', elem: 300, crit: 5 }),
  ];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (const weapon of weapons) {
    const ev = compileEvaluator(weapon, D.skills, settings, kinds);
    for (let n = 0; n < 200; n++) {
      const lv = new Int16Array(kinds.length);
      const levels = {};
      for (let i = 0; i < kinds.length; i++) {
        if (rnd() < 0.15) {
          lv[i] = 1 + Math.floor(rnd() * 6);
          levels[kinds[i]] = Math.min(lv[i], D.skills[kinds[i]].max);
        }
      }
      const a = ev.evaluate(lv);
      const b = computeDamage(weapon, levels, D.skills, settings).expected;
      assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
      // 差分評価も一致する
      const i = Math.floor(rnd() * kinds.length);
      const st = ev.stateOf(lv);
      const mv = ev.moveValue(st, lv, i, 1);
      lv[i] += 1;
      assert.ok(Math.abs(mv - ev.evaluate(lv)) < 1e-6, `move ${kinds[i]}`);
    }
  }
});

const ctxFor = (weapon, extra = {}) => ({
  skillDefs: D.skills,
  settings: {},
  required: {},
  freeKinds: D.driftable,
  relevantKinds: Object.keys(SKILL_EFFECTS).filter((k) => isRelevant(k, weapon, {})),
  ...extra,
});
const armor = (id, grade, drift) => ({ ...resolveArmor(D.armorById[id], grade), drift });

test('錬成: 1枠=1Lv、所持リストの防具はリストのスキルしか使わない', () => {
  const weapon = resolveWeapon(D.weaponById.ORE_LONGSWORD || D.weapons.find((w) => w.type === 'LONG_SWORD'), 10, 5);
  const head = armor('ORE_HEAD', 10, { mode: 'owned', tokens: [['DEFENSE_BOOST', 1]] });
  const r = evaluateBuild(weapon, { head }, ctxFor(weapon));
  // 防御はダメージに関係ないので、所持リストに防御しか無ければ錬成は付かない
  assert.equal(r.drifts.length, 0);

  const head2 = armor('ORE_HEAD', 10, { mode: 'owned', tokens: [['WEAKNESS_EXPLOIT', 2], ['DEFENSE_BOOST', 1]] });
  const r2 = evaluateBuild(weapon, { head: head2 }, ctxFor(weapon));
  assert.deepEqual(r2.drifts.map((d) => [d.kind, d.lv]), [['WEAKNESS_EXPLOIT', 1]]); // 枠1なので1Lvまで

  const head3 = armor('ORE_HEAD', 10, { mode: 'free' });
  const r3 = evaluateBuild(weapon, { head: head3 }, ctxFor(weapon));
  assert.equal(r3.drifts.reduce((s, d) => s + d.lv, 0), 1);
  assert.ok(r3.value >= r2.value);

  const head4 = armor('ORE_HEAD', 10, { mode: 'fixed', fixed: [['CRITICAL_EYE', 3]] });
  const r4 = evaluateBuild(weapon, { head: head4 }, ctxFor(weapon));
  assert.equal(r4.levels.CRITICAL_EYE, 1 + 1); // 防具の見切り1 + 固定錬成1（枠1）
});

test('探索: 弱い装備を固定しても必ず結果が返る（必須スキル未達でも空にしない）', () => {
  const weapon = resolveWeapon(D.weaponById.ORE_SWORDSHIELD, 1, 1);
  const partOptions = {};
  for (const p of PARTS) partOptions[p] = [armor(D.armor.find((a) => a.part === p).id, 1, { mode: 'none' })];
  const out = searchBuilds([weapon], partOptions, {
    skillDefs: D.skills, settings: {}, required: { LOCK_ON: 1 }, freeKinds: D.driftable, topN: 5,
  });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].unmet.LOCK_ON, 1);
});

test('探索: 所持リストの錬成で必須スキルを満たせる', () => {
  const weapon = resolveWeapon(D.weaponById.ORE_SWORDSHIELD, 10, 5);
  const partOptions = { head: [armor('ORE_HEAD', 10, { mode: 'owned', tokens: [['LOCK_ON', 1]] })] };
  // LOCK_ON は錬成では付かないスキルだが、所持リストに登録すれば使える
  const out = searchBuilds([weapon], partOptions, {
    skillDefs: D.skills, settings: {}, required: { LOCK_ON: 1 }, freeKinds: D.driftable, topN: 5,
  });
  assert.deepEqual(out.results[0].unmet, {});
  assert.equal(out.results[0].eval.levels.LOCK_ON, 1);
});

test('探索: 上位結果は高速評価と詳細計算で同じ順位になる程度に一致する', () => {
  const weapons = D.weapons.filter((w) => w.type === 'HAMMER' && w.element === 'THUNDER').slice(0, 2).map((w) => resolveWeapon(w, 10, 5));
  const partOptions = {};
  for (const p of PARTS) partOptions[p] = D.armor.filter((a) => a.part === p).map((a) => armor(a.id, 10, { mode: 'free' }));
  const out = searchBuilds(weapons, partOptions, {
    skillDefs: D.skills, settings: {}, freeKinds: D.driftable, topN: 5, maxCombos: 20000, timeLimitMs: 20000,
  });
  assert.equal(out.results.length, 5);
  for (const r of out.results) {
    assert.ok(Math.abs(r.damage - r.value) / r.value < 0.02, `${r.damage} vs ${r.value}`);
    assert.ok(r.eval.drifts.reduce((s, d) => s + d.lv, 0) <= r.eval.slotsTotal);
  }
});

test('取り込みツール: root-island の props を読める', () => {
  const html = '<root-island component="X" props="{&quot;a&quot;:1,&quot;b&quot;:&quot;&amp;&quot;}"></root-island>';
  assert.deepEqual(extractIslandProps(html), { X: { a: 1, b: '&' } });
});
