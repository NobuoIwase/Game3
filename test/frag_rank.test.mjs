// オススメフラグメント（§49）の評価エンジン
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as FR from '../js/frag_rank.js';

const effectMap = JSON.parse(readFileSync(new URL('../game_data/effect_map.json', import.meta.url), 'utf8'));
const line = (text, max, min = max, extra = {}) => ({ text, value: max, value_min: min, ...extra });
const frag = (id, slots, extra = {}) => ({
  id, name: `F${id}`, rarity: 'gold', equip_char_ids: [], ...extra,
  slots: slots.map((lines, i) => ({ label: `SLOT ${i + 1}`, star7: false, lines })),
});
const entry = (f) => ({ frag: f, profile: FR.fragmentProfile(f, effectMap) });

test('§49 ❸の伸び率: 素の状態では基礎あり≒基礎なし、アビリティ補正が大きいほど基礎なしが強い', () => {
  const r = 0.11;
  const baseSolo = FR.statGainPct(0, 0, r, 18, 0), nbSolo = FR.statGainPct(0, 0, r, 0, 18);
  assert.ok(Math.abs(baseSolo - nbSolo) < 2, `素: ${baseSolo} ≒ ${nbSolo}`);
  const baseBuild = FR.statGainPct(285, 0, r, 18, 0), nbBuild = FR.statGainPct(285, 0, r, 0, 18);
  assert.ok(Math.abs(nbBuild - 18) < 1e-9, '基礎なしは補正に関係なく額面どおり');
  assert.ok(nbBuild > baseBuild * 3.5, `育成後は基礎なしが約4倍: ${nbBuild} vs ${baseBuild}`);
});

test('§49 fragmentProfile: 選択式スロット・固定行・条件つき（人数比例は最大人数）を数値化', () => {
  const f = frag(1, [
    [line('基礎打撃防御力', 15, 6)],
    [line('基礎体力', 8, 4), line('基礎打撃攻撃力', 15, 5, { option: 1 }), line('基礎射撃攻撃力', 15, 5, { option: 2 })],
    [line('打撃攻撃力', 5, 5, { cond: [[{ tag: 1 }]], cond_per_member: true, cond_exclude_self: false }), { raw: '説明文' }],
  ]);
  const p = FR.fragmentProfile(f, effectMap);
  assert.equal(p.slots[1].options.length, 2);
  assert.deepEqual(p.slots[1].options.map((o) => o.lines.map((l) => l.text)),
    [['基礎体力', '基礎打撃攻撃力'], ['基礎体力', '基礎射撃攻撃力']], '固定行はどの選択肢にも付く');
  assert.equal(p.slots[2].options[0].lines[0].mult, 3, '1人につき → バトル3体ぶん');
  assert.equal(p.conditional, true);
  assert.equal(p.hasRaw, true);
  assert.equal(p.slots[0].options[0].lines[0].min, 6);
});

test('§49 evaluateSet: 軸ごとに最良の選択肢を選ぶ（打撃なら打撃、射撃なら射撃）', () => {
  const f = frag(1, [[line('基礎打撃攻撃力', 15, 5, { option: 1 }), line('基礎射撃攻撃力', 15, 5, { option: 2 })]]);
  const p = FR.fragmentProfile(f, effectMap);
  const ctx = FR.makeContext({ abilityPct: 0 });
  assert.deepEqual(FR.evaluateSet([p], ctx, 'strike_atk').choice, [0]);
  assert.deepEqual(FR.evaluateSet([p], ctx, 'blast_atk').choice, [1]);
  const tot = FR.evaluateSet([p], ctx, 'total');
  assert.ok(['strike', 'blast'].includes(tot.side));
});

test('§49 装備ランク: 参照サイトと同じ（3スロット最大=99.9 Godly、2スロット最大=100.0）', () => {
  const f3 = frag(1, [[line('基礎体力', 15, 6)], [line('基礎打撃攻撃力', 12.5, 5)], [line('基礎打撃攻撃力', 18, 5)]]);
  const p3 = FR.fragmentProfile(f3, effectMap);
  assert.deepEqual(FR.equipRank(p3, FR.maxRoll(p3)), { score: 99.9, rank: 'Godly' });
  const f2 = frag(2, [[line('基礎体力', 15, 6)], [line('基礎打撃攻撃力', 12.5, 5)]]);
  const p2 = FR.fragmentProfile(f2, effectMap);
  assert.deepEqual(FR.equipRank(p2, FR.maxRoll(p2)), { score: 100, rank: 'Godly' });
  // 最小: 6/15=0.4, 5/12.5=0.4, 5/18=0.278 → 13.3+13.3+9.3 = 35.9 → C
  const minRoll = p3.slots.map((s) => ({ opt: 0, vals: s.options[0].lines.map((l) => l.min) }));
  assert.deepEqual(FR.equipRank(p3, minRoll), { score: 35.9, rank: 'C' });
});

test('§49 ランキング: 基礎なし主体のフラグは単体では下位でも実戦で大きく順位を上げる', () => {
  const baseHeavy = frag(1, [[line('基礎打撃攻撃力', 30)], [line('基礎打撃攻撃力', 25)]]);   // 基礎あり計55
  const nbOnly = frag(2, [[line('打撃攻撃力', 20)]]);                                     // 基礎なし20
  const mid = frag(3, [[line('基礎打撃攻撃力', 40)]]);                                    // 基礎あり40
  const { rows } = FR.rankFragments([baseHeavy, nbOnly, mid].map(entry), { axis: 'strike_atk', abilityPct: 285 });
  const by = Object.fromEntries(rows.map((r) => [r.frag.id, r]));
  assert.equal(by[2].soloRank, 3, '単体では最下位');
  assert.equal(by[2].buildRank, 1, '実戦では1位');
  assert.ok(by[2].jump > 0);
  assert.ok(by[2].retain > 0.85 && by[1].retain < 0.5, `目減り: 基礎なし ${by[2].retain} / 基礎あり ${by[1].retain}`);
});

test('§49 総合は打撃・射撃それぞれの相方で評価する（混ぜると射撃が不当に低くなる）', () => {
  // 打撃のフラグが多数・射撃は2枚。相方（上位2枚）は側ごとに作る
  const strikes = [1, 2, 3, 4].map((i) => frag(i, [[line('基礎打撃攻撃力', 30)], [line('打撃攻撃力', 10)]]));
  const blasts = [9, 10].map((i) => frag(i, [[line('基礎射撃攻撃力', 30)], [line('射撃攻撃力', 10)]]));
  const blast = blasts[0];
  const { rows, partners } = FR.rankFragments([...strikes, ...blasts].map(entry), { axis: 'total', abilityPct: 285, partnerTop: 2 });
  assert.ok(partners.strike_total && partners.blast_total);
  assert.ok(partners.blast_total.base.blast_atk > 0 && !partners.blast_total.base.strike_atk, '射撃の相方は射撃のフラグ');
  const s = rows.find((r) => r.frag.id === 1), b = rows.find((r) => r.frag.id === 9);
  assert.equal(b.build.side, 'blast');
  assert.ok(Math.abs(s.build.score - b.build.score) < 1e-6, `同じ形なら打撃と射撃は同点: ${s.build.score} / ${b.build.score}`);
});

test('§49 厳選の目安: 選択肢スロットは外れの落ち幅、固定値スロットは0', () => {
  const f = frag(1, [
    [line('基礎打撃攻撃力', 15, 15)],   // 固定値
    [line('基礎打撃攻撃力', 18, 5, { option: 1 }), line('基礎射撃防御力', 18, 5, { option: 2 })],
  ]);
  const p = FR.fragmentProfile(f, effectMap);
  const imp = FR.slotImportance(p, FR.makeContext({ abilityPct: 285 }), 'strike_atk');
  assert.equal(imp[0].minLoss, 0, '固定値は厳選不要');
  assert.ok(imp[1].minLoss > 0);
  assert.equal(imp[1].bestOpt, 0, '打撃火力なら選択1（基礎打撃攻撃力）が当たり');
  assert.ok(imp[1].worstOptLoss > imp[1].minLoss, '外れ選択肢は最小値より痛い');
});

test('§49 canPair: 同じフラグ・覚醒前後の同一種・装備キャラが重ならない組は不可', () => {
  const a = { id: 1, icon: '/x/EqIco_1.webp', rarity: 'gold', equip_char_ids: [10, 11] };
  assert.equal(FR.canPair(a, { ...a }), false, '同じフラグ');
  assert.equal(FR.canPair(a, { id: 50001, icon: '/x/EqIco_1.webp', rarity: 'awakenedgold', equip_char_ids: [10] }), false, '覚醒前後');
  assert.equal(FR.canPair(a, { id: 2, icon: '/x/EqIco_2.webp', rarity: 'gold', equip_char_ids: [12] }), false, '装備キャラが重ならない');
  assert.equal(FR.canPair(a, { id: 3, icon: '/x/EqIco_3.webp', rarity: 'gold', equip_char_ids: [] }), true, '空=全キャラ');
});

test('§49 実戦の想定は実データから作る（Z・ZENKAIの補正分布・ソウルブースト比）', () => {
  const chars = JSON.parse(readFileSync(new URL('../game_data/characters.json', import.meta.url), 'utf8'));
  const a = FR.abilityContextFromData(chars, effectMap);
  assert.ok(a.battle > 0 && a.battle < a.full && a.full <= a.high, JSON.stringify(a));
  assert.ok(a.full > 150 && a.full < 500, `育成済みの補正が常識的な範囲: ${a.full}`);
  assert.ok(a.boostRatio.strike_atk > 0.05 && a.boostRatio.strike_atk < 0.3);
});

test('§49 条件つきの効果を数えない評価（noCond）', () => {
  const f = frag(1, [[line('基礎打撃攻撃力', 10)], [line('打撃攻撃力', 20, 20, { cond: [[{ tag: 1 }]], cond_count: 2 })]]);
  const p = FR.fragmentProfile(f, effectMap);
  const withCond = FR.evaluateSet([p], FR.makeContext({ abilityPct: 285 }), 'strike_atk').score;
  const noCond = FR.evaluateSet([p], FR.makeContext({ abilityPct: 285, noCond: true }), 'strike_atk').score;
  assert.ok(withCond > noCond && noCond > 0, `${withCond} > ${noCond}`);
  // 装備ランク（厳選の出来）は条件と関係なく全行で数える
  assert.deepEqual(FR.equipRank(p, FR.maxRoll(p)).rank, 'Godly');
});

test('§49 専用判定: カード番号つきの装備条件は、装備キャラが2体でも専用', () => {
  assert.equal(FR.isExclusive({ equip_char_ids: [1, 2], equip_cond: [[{ tag: 1, name: 'シャロット' }, { tag: 60001, name: 'DBL-EVT-38U' }]] }), true);
  assert.equal(FR.isExclusive({ equip_char_ids: [5] }), true);
  assert.equal(FR.isExclusive({ equip_char_ids: [1, 2, 3], equip_cond: [[{ tag: 13002, name: '打撃タイプ' }]] }), false);
  assert.equal(FR.isExclusive({ equip_char_ids: [] }), false);
});
