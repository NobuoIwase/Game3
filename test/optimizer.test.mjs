// 最適化ロジック（DESIGN.md §4）のテスト。
// 特に §2-5「固定の基礎あり/なし優先ルールを実装しない（必ず ❸ を評価する）」と、
// フラグメントの奪い合い（§4-3）で貪欲法が誤る局面の厳密解を検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canEquip, abilityCorrections, bestForCharacter, optimizeParty, characterDetail,
} from '../js/optimizer.js';

const effectMap = JSON.parse(
  readFileSync(new URL('../game_data/effect_map.json', import.meta.url), 'utf8')
);

const chara = (id, tags, statOverrides = {}) => ({
  id,
  name: `キャラ${id}`,
  tags,
  base_stats: {
    hp: 0, strike_atk: 100_000, blast_atk: 0,
    strike_def: 0, blast_def: 0, critical: 0, ki_recovery: 0,
    ...statOverrides,
  },
});
const myOf = (slots = 3, abilities = {}) => ({
  stars: 0,
  equip_slots: slots,
  boost: { hp: 0, strike_atk: 0, blast_atk: 0, strike_def: 0, blast_def: 0, critical: 0, ki_recovery: 0 },
  z_ability: [], ll_ability: [], zenkai_ability: [],
  ...abilities,
});
const frag = (id, effects, cond = {}) => ({
  id,
  name: `フラグ${id}`,
  rarity: '',
  equip_conditions: { require_tags_any: [], require_tags_all: [], ...cond },
  effects,
});

test('canEquip: require_tags_any / require_tags_all', () => {
  const c = chara(1, [7, 40]);
  assert.equal(canEquip(c, frag(1, [], { require_tags_any: [7, 99] })), true);
  assert.equal(canEquip(c, frag(2, [], { require_tags_any: [99] })), false);
  assert.equal(canEquip(c, frag(3, [], { require_tags_all: [7, 40] })), true);
  assert.equal(canEquip(c, frag(4, [], { require_tags_all: [7, 99] })), false);
  assert.equal(canEquip(c, frag(5, [])), true, '条件なしは誰でも装備可');
});

test('abilityCorrections: Z/ZENKAIは6体全員、LLはバトル3体のみ（§2-2）', () => {
  const A = { character: chara(1, [7]), my: myOf(3, {
    z_ability: [{ stat: 'strike_atk', base: true, value: 30, condition_tags: [7] }],
    ll_ability: [{ stat: 'hp', base: true, value: 10, condition_tags: [] }],
  }) };
  const B = { character: chara(2, [8]), my: myOf(3, {
    z_ability: [{ stat: 'strike_atk', base: true, value: 20, condition_tags: [] }],
  }) };
  const ext = abilityCorrections([A, B], [1]); // バトル出撃は A のみ
  assert.equal(ext['1'].z.strike_atk, 50, 'A: 自分の30(タグ7一致) + Bの20(無条件)');
  assert.equal(ext['2'].z.strike_atk, 20, 'B: タグ7を持たないのでAの30は乗らない');
  assert.equal(ext['1'].ll.hp, 10, 'LLアビはバトル出撃メンバーに乗る');
  assert.equal(ext['2'].ll.hp, 0, 'ベンチにはLLアビは乗らない');
});

test('abilityCorrections: 基礎なしアビリティは extNonBase に分離し警告する（§1-4）', () => {
  const A = { character: chara(1, []), my: myOf(3, {
    zenkai_ability: [{ stat: 'strike_atk', base: false, value: 15, condition_tags: [] }],
  }) };
  const ext = abilityCorrections([A], [1]);
  assert.equal(ext['1'].extNonBase.strike_atk, 15);
  assert.equal(ext['1'].z.strike_atk, 0);
  assert.ok(ext['1'].warnings.length >= 1);
});

test('§2-5: ❷が高いとき、数値の小さい基礎なしが数値の大きい基礎ありに勝つ', () => {
  // ❷(外部)=200% の環境。基礎あり+20 → 320,000 / 基礎なし+10 → 330,000
  const member = { character: chara(1, []), my: myOf(1) };
  const ext = { z: { strike_atk: 200 }, zenkai: {}, ll: {}, extNonBase: {}, warnings: [] };
  const fragments = {
    10: frag(10, [{ stat: 'strike_atk', base: true, value: 20 }]),
    11: frag(11, [{ stat: 'strike_atk', base: false, value: 10 }]),
  };
  const r = bestForCharacter({
    member, ext, fragmentsById: fragments,
    counts: { 10: 1, 11: 1 }, weights: { strike_atk: 1 }, effectMap,
  });
  assert.deepEqual(r.ids, ['11'], '基礎なし+10%を選ぶべき');
});

test('§2-5 対照: ❷が低ければ同じ2択で基礎ありが勝つ（固定ルールでないことの証明）', () => {
  const member = { character: chara(1, []), my: myOf(1) };
  const ext = { z: {}, zenkai: {}, ll: {}, extNonBase: {}, warnings: [] };
  const fragments = {
    10: frag(10, [{ stat: 'strike_atk', base: true, value: 20 }]),
    11: frag(11, [{ stat: 'strike_atk', base: false, value: 10 }]),
  };
  const r = bestForCharacter({
    member, ext, fragmentsById: fragments,
    counts: { 10: 1, 11: 1 }, weights: { strike_atk: 1 }, effectMap,
  });
  assert.deepEqual(r.ids, ['10'], '❷=0 なら基礎あり+20%を選ぶべき');
});

test('bestForCharacter: 装備条件を満たさないフラグメントは候補に入らない', () => {
  const member = { character: chara(1, [7]), my: myOf(3) };
  const fragments = {
    10: frag(10, [{ stat: 'strike_atk', base: true, value: 50 }], { require_tags_any: [99] }),
    11: frag(11, [{ stat: 'strike_atk', base: true, value: 10 }]),
  };
  const r = bestForCharacter({
    member, fragmentsById: fragments,
    counts: { 10: 1, 11: 1 }, weights: { strike_atk: 1 }, effectMap,
  });
  assert.deepEqual(r.ids, ['11']);
});

test('同一フラグメントの重複装備は既定で不可、allowDuplicates で可（実機未確認の仮定）', () => {
  const member = { character: chara(1, []), my: myOf(2) };
  const fragments = { 10: frag(10, [{ stat: 'strike_atk', base: true, value: 10 }]) };
  const r1 = bestForCharacter({
    member, fragmentsById: fragments, counts: { 10: 2 },
    weights: { strike_atk: 1 }, effectMap,
  });
  assert.deepEqual(r1.ids, ['10']);
  const r2 = bestForCharacter({
    member, fragmentsById: fragments, counts: { 10: 2 },
    weights: { strike_atk: 1 }, effectMap, allowDuplicates: true,
  });
  assert.deepEqual(r2.ids, ['10', '10']);
});

test('未知の効果を持つフラグメントは計算から除外しつつ unknown で報告する', () => {
  const member = { character: chara(1, []), my: myOf(1) };
  const fragments = {
    10: frag(10, [{ text: '会心威力アップ', value: 50 }]),
    11: frag(11, [{ stat: 'strike_atk', base: true, value: 10 }]),
  };
  const r = bestForCharacter({
    member, fragmentsById: fragments, counts: { 10: 1, 11: 1 },
    weights: { strike_atk: 1 }, effectMap,
  });
  assert.deepEqual(r.ids, ['11']);
  assert.equal(r.unknown.length, 1);
});

test('optimizeParty: 奪い合いで貪欲法が誤る局面の厳密解（§4-3）', () => {
  // X(+50) は1個のみで両者が装備可能。A には代替 Y(+45) がある。
  // 貪欲: A が X を取り B が無装備 → 合計 1.50 + 1.00 = 2.50
  // 厳密: A が Y、B が X → 合計 1.45 + 1.50 = 2.95
  const A = { character: chara(1, []), my: myOf(1) };
  const B = { character: chara(2, []), my: myOf(1) };
  const fragments = {
    100: frag(100, [{ stat: 'strike_atk', base: true, value: 50 }]),
    101: frag(101, [{ stat: 'strike_atk', base: true, value: 45 }], { require_tags_any: [7] }),
  };
  A.character.tags = [7]; // Y は A 専用
  const r = optimizeParty({
    members: [A, B], battleIds: [1, 2],
    fragmentsById: fragments, counts: { 100: 1, 101: 1 },
    weights: { strike_atk: 1 }, effectMap,
  });
  assert.equal(r.exact, true);
  assert.deepEqual(r.assignments['1'].ids, ['101'], 'A は代替の Y を装備');
  assert.deepEqual(r.assignments['2'].ids, ['100'], 'B が X を装備');
  assert.ok(Math.abs(r.totalScore - 2.95) < 1e-9, `total=${r.totalScore}`);
});

test('optimizeParty: targets=battle ではバトル3体のみ最適化対象', () => {
  const A = { character: chara(1, []), my: myOf(1) };
  const B = { character: chara(2, []), my: myOf(1) };
  const fragments = { 100: frag(100, [{ stat: 'strike_atk', base: true, value: 50 }]) };
  const r = optimizeParty({
    members: [A, B], battleIds: [1],
    fragmentsById: fragments, counts: { 100: 1 },
    weights: { strike_atk: 1 }, effectMap,
  });
  assert.deepEqual(Object.keys(r.assignments), ['1']);
});

test('characterDetail: §2-4 ケース(2) をフルパイプラインで再現', () => {
  const member = {
    character: chara(1, [], { strike_atk: 273_617 }),
    my: { ...myOf(3), boost: { ...myOf().boost, strike_atk: 42_080 } },
  };
  const ext = { z: { strike_atk: 149 }, zenkai: {}, ll: { strike_atk: 30 }, extNonBase: {} };
  const fragList = [
    frag(1, [
      { text: '基礎打撃攻撃力アップ', value: 60 },
      { text: '打撃攻撃力アップ', value: 30 },
    ]),
  ];
  const { stats, unknown } = characterDetail({ member, ext, fragmentList: fragList, effectMap });
  assert.equal(unknown.length, 0);
  const s = stats.strike_atk;
  assert.equal(s.corr, 239);
  assert.ok(Math.abs(s.final - 1_075_087.56) < 0.005, `❸=${s.final}`);
  assert.equal(Math.round(s.corr5), 364);
  assert.equal(Math.round(s.fragTotal), 167);
});
