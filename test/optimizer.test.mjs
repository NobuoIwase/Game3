// 最適化ロジック（DESIGN.md §4）のテスト。
// 特に §2-5「固定の基礎あり/なし優先ルールを実装しない（必ず ❸ を評価する）」と、
// フラグメントの奪い合い（§4-3）で貪欲法が誤る局面の厳密解を検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canEquip, statBase, autoAbilityLevel, memberAbilityGroups, abilityCorrections,
  partyAbilityCorrections, zRelationCounts, isTournamentOnly,
  bestForCharacter, optimizeParty, characterDetail,
} from '../js/optimizer.js';

const effectMap = JSON.parse(
  readFileSync(new URL('../game_data/effect_map.json', import.meta.url), 'utf8')
);

// v1形式（合計ステ = base_stats）のキャラ
const charaV1 = (id, tags, statOverrides = {}) => ({
  id, name: `キャラ${id}`, tags,
  base_stats: {
    hp: 0, strike_atk: 100_000, blast_atk: 0,
    strike_def: 0, blast_def: 0, critical: 0, ki_recovery: 0,
    ...statOverrides,
  },
});
// v2形式（❶ = stats、取り込みデータ相当）のキャラ
const charaV2 = (id, tags, statOverrides = {}, extra = {}) => ({
  id, name: `キャラ${id}`, tags, element: 'PUR',
  stats: {
    hp: 0, strike_atk: 100_000, blast_atk: 0,
    strike_def: 0, blast_def: 0, critical: 0, ki_recovery: 0,
    ...statOverrides,
  },
  z_ability: [], deploy_z_ability: [], zenkai_ability: [],
  ...extra,
});
const myOf = (slots = 3, extra = {}) => ({
  stars: 7, equip_slots: slots,
  boost: { hp: 0, strike_atk: 0, blast_atk: 0, strike_def: 0, blast_def: 0, critical: 0, ki_recovery: 0 },
  z_ability: [], ll_ability: [], zenkai_ability: [],
  ...extra,
});
const frag = (id, effects, cond = {}) => ({
  id, name: `フラグ${id}`, rarity: '',
  equip_conditions: { require_tags_any: [], require_tags_all: [], ...cond },
  effects,
});

test('canEquip: v2 は equip_char_ids、v1 はタグ条件で判定', () => {
  const c = charaV1(1, [7, 40]);
  assert.equal(canEquip(c, { equip_char_ids: [1, 5] }), true);
  assert.equal(canEquip(c, { equip_char_ids: [5] }), false);
  assert.equal(canEquip(c, frag(1, [], { require_tags_any: [7, 99] })), true);
  assert.equal(canEquip(c, frag(2, [], { require_tags_any: [99] })), false);
  assert.equal(canEquip(c, frag(3, [], { require_tags_all: [7, 99] })), false);
  assert.equal(canEquip(c, frag(4, [])), true, '条件なしは誰でも装備可');
});

test('statBase: v2 は stats を ❶ として、v1 は 合計ステ−ブースト', () => {
  const my = { boost: { strike_atk: 42_080 } };
  const v2 = statBase(charaV2(1, [], { strike_atk: 231_537 }), my, 'strike_atk');
  assert.deepEqual(v2, { base: 231_537, boost: 42_080, total: 273_617 });
  const v1 = statBase(charaV1(1, [], { strike_atk: 273_617 }), my, 'strike_atk');
  assert.deepEqual(v1, { base: 231_537, boost: 42_080, total: 273_617 });
  assert.equal(statBase(charaV2(1, [], { strike_atk: 0 }), my, 'strike_atk'), null, '未入力はnull');
});

test('statBase: 合計ステの実測オーバーライドが理論値より優先される（§1-1）', () => {
  // 取り込み理論値 268,841 でも、実測の合計ステ 273,617 を入れると ❶ = 231,537 になる
  const my = { boost: { strike_atk: 42_080 }, total_override: { strike_atk: 273_617 } };
  const r = statBase(charaV2(1, [], { strike_atk: 268_841 }), my, 'strike_atk');
  assert.deepEqual(r, { base: 231_537, boost: 42_080, total: 273_617 });
});

test('autoAbilityLevel: 星→アビリティレベルの既定対応（未検証の仮定・上書き可）', () => {
  assert.equal(autoAbilityLevel(0), 1);
  assert.equal(autoAbilityLevel(2), 2);
  assert.equal(autoAbilityLevel(5), 3);
  assert.equal(autoAbilityLevel(7), 4);
});

// クローラ出力相当のZアビリティ定義
const zAbility = (values) => values.map((v, i) => ({
  id: i, name: `Zアビリティ${'IIIIIV'.slice(0, i + 1)}`,
  groups: [{ cond: [[{ tag: 7 }]], effects: [{ text: '基礎打撃攻撃力', value: v }], unresolved: [], raw: '' }],
}));

test('memberAbilityGroups: 星でZアビレベルを自動選択し、my.z_level で上書きできる', () => {
  const character = charaV2(1, [7], {}, { z_ability: zAbility([22, 26, 30, 38]) });
  const auto7 = memberAbilityGroups({ character, my: myOf(3, { stars: 7 }), effectMap });
  assert.equal(auto7.z[0].effects[0].value, 38, '★7 → IV');
  const auto3 = memberAbilityGroups({ character, my: myOf(3, { stars: 3 }), effectMap });
  assert.equal(auto3.z[0].effects[0].value, 26, '★3 → II');
  const forced = memberAbilityGroups({ character, my: myOf(3, { stars: 7, z_level: 1 }), effectMap });
  assert.equal(forced.z[0].effects[0].value, 22, 'z_level=1 で上書き');
});

test('abilityCorrections v2: Zアビは6体全員、出撃Zアビは発生源も対象もバトル3体のみ', () => {
  const deployAbility = [{
    id: 0, name: '出撃ZアビリティI',
    groups: [{ cond: [], effects: [{ text: '基礎打撃攻撃力', value: 10 }], unresolved: [], raw: '' }],
  }];
  const A = { character: charaV2(1, [7], {}, { z_ability: zAbility([20, 20, 20, 20]), deploy_z_ability: deployAbility }), my: myOf() };
  const B = { character: charaV2(2, [7], {}, { deploy_z_ability: deployAbility }), my: myOf() };
  const C = { character: charaV2(3, [8]), my: myOf() }; // タグ7なし
  // バトル = A, C。B はベンチ
  const ext = abilityCorrections([A, B, C], [1, 3], effectMap);
  assert.equal(ext['1'].z.strike_atk, 20, 'AのZアビ(タグ7)はAに乗る');
  assert.equal(ext['2'].z.strike_atk, 20, 'ベンチのBにもZアビは乗る');
  assert.equal(ext['3'].z.strike_atk, 0, 'タグ不一致のCには乗らない');
  assert.equal(ext['1'].ll.strike_atk, 10, 'Aの出撃Zアビ(バトル)はバトルのAに乗る');
  assert.equal(ext['3'].ll.strike_atk, 10, 'バトルのCにも乗る（条件なし）');
  assert.equal(ext['2'].ll.strike_atk, 0, 'ベンチのBには乗らない');
  // B はベンチなので B の出撃Zアビは発生しない → A の ll は自分の分の10のみ
  assert.equal(ext['1'].ll.strike_atk, 10, 'ベンチBの出撃Zアビは発生源にならない');
});

test('abilityCorrections: 手入力アビリティ（旧形式）も合算される（§1-1）', () => {
  const A = { character: charaV2(1, [7]), my: myOf(3, {
    z_ability: [{ stat: 'strike_atk', base: true, value: 30, condition_tags: [7] }],
  }) };
  const B = { character: charaV2(2, [8]), my: myOf() };
  const ext = abilityCorrections([A, B], [1], effectMap);
  assert.equal(ext['1'].z.strike_atk, 30);
  assert.equal(ext['2'].z.strike_atk, 0, 'タグ7を持たないBには乗らない');
});

test('§2-5: ❷が高いとき、数値の小さい基礎なしが数値の大きい基礎ありに勝つ', () => {
  const member = { character: charaV1(1, []), my: myOf(1) };
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
  const member = { character: charaV1(1, []), my: myOf(1) };
  const fragments = {
    10: frag(10, [{ stat: 'strike_atk', base: true, value: 20 }]),
    11: frag(11, [{ stat: 'strike_atk', base: false, value: 10 }]),
  };
  const r = bestForCharacter({
    member, fragmentsById: fragments,
    counts: { 10: 1, 11: 1 }, weights: { strike_atk: 1 }, effectMap,
  });
  assert.deepEqual(r.ids, ['10'], '❷=0 なら基礎あり+20%を選ぶべき');
});

test('bestForCharacter: SLOT4(★7解放)は星が足りないと評価に入らない', () => {
  const slotFrag = (id, s4value) => ({
    id, name: `装備${id}`,
    equip_char_ids: [1],
    slots: [
      { label: 'SLOT 1', star7: false, lines: [{ text: '基礎打撃攻撃力', value: 10 }] },
      { label: 'SLOT 4', star7: true, lines: [{ text: '基礎打撃攻撃力', value: s4value }] },
    ],
  });
  const fragments = { 10: slotFrag(10, 0), 11: slotFrag(11, 50) };
  const pick = (stars) => bestForCharacter({
    member: { character: charaV2(1, []), my: myOf(1, { stars }) },
    fragmentsById: fragments, counts: { 10: 1, 11: 1 },
    weights: { strike_atk: 1 }, effectMap,
  }).ids;
  assert.deepEqual(pick(7), ['11'], '★7ならSLOT4の+50が効く方を選ぶ');
  // ★3では両者同値(+10)になる → どちらを選んでもスコアは同じ。スコアで検証する
  const r3a = bestForCharacter({
    member: { character: charaV2(1, []), my: myOf(1, { stars: 3 }) },
    fragmentsById: { 11: fragments[11] }, counts: { 11: 1 },
    weights: { strike_atk: 1 }, effectMap,
  });
  const r3b = bestForCharacter({
    member: { character: charaV2(1, []), my: myOf(1, { stars: 3 }) },
    fragmentsById: { 10: fragments[10] }, counts: { 10: 1 },
    weights: { strike_atk: 1 }, effectMap,
  });
  assert.ok(Math.abs(r3a.score - r3b.score) < 1e-12, '★3ではSLOT4が無効なので同スコア');
});

test('同一フラグメントは同じキャラに重複装備できない（実機仕様）', () => {
  const member = { character: charaV1(1, []), my: myOf(2) };
  const fragments = { 10: frag(10, [{ stat: 'strike_atk', base: true, value: 10 }]) };
  const r1 = bestForCharacter({
    member, fragmentsById: fragments, counts: { 10: 2 },
    weights: { strike_atk: 1 }, effectMap,
  });
  assert.deepEqual(r1.ids, ['10'], '所持2枚でも同キャラには1枚だけ');
});

test('別のキャラ同士なら同じフラグメントを同時装備できる（所持数の範囲で）', () => {
  const A = { character: charaV1(1, []), my: myOf(1) };
  const B = { character: charaV1(2, []), my: myOf(1) };
  const fragments = { 10: frag(10, [{ stat: 'strike_atk', base: true, value: 50 }]) };
  // 所持2枚 → 両方に装備できる
  const r2 = optimizeParty({
    members: [A, B], battleIds: [1, 2],
    fragmentsById: fragments, counts: { 10: 2 },
    weights: { strike_atk: 1 }, effectMap,
  });
  assert.deepEqual(r2.assignments['1'].ids, ['10']);
  assert.deepEqual(r2.assignments['2'].ids, ['10']);
  // 所持1枚 → どちらか片方だけ（奪い合い）
  const r1 = optimizeParty({
    members: [A, B], battleIds: [1, 2],
    fragmentsById: fragments, counts: { 10: 1 },
    weights: { strike_atk: 1 }, effectMap,
  });
  const equipped = [r1.assignments['1'].ids.length, r1.assignments['2'].ids.length];
  assert.deepEqual(equipped.sort(), [0, 1], '1枚なら1体だけが装備');
});

test('力の大会専用フラグメントは通常の最適化候補から除外される', () => {
  const member = { character: charaV1(1, []), my: myOf(1) };
  const fragments = {
    10: { ...frag(10, [{ stat: 'strike_atk', base: true, value: 100 }]), top: true, name: '【力の大会】強いやつ' },
    11: frag(11, [{ stat: 'strike_atk', base: true, value: 10 }]),
  };
  assert.equal(isTournamentOnly(fragments[10]), true);
  const r = bestForCharacter({
    member, fragmentsById: fragments, counts: { 10: 1, 11: 1 },
    weights: { strike_atk: 1 }, effectMap,
  });
  assert.deepEqual(r.ids, ['11'], '数値が高くても力の大会フラグは選ばれない');
  const r2 = bestForCharacter({
    member, fragmentsById: fragments, counts: { 10: 1, 11: 1 },
    weights: { strike_atk: 1 }, effectMap, includeTournament: true,
  });
  assert.deepEqual(r2.ids, ['10'], 'includeTournament なら候補に入る');
});

test('効果条件付き効果: パーティ編成が条件を満たすときだけ計算に入る', () => {
  const condFrag = {
    id: 20, name: '条件付き', equip_char_ids: [1],
    slots: [{ label: 'SLOT 1', star7: false, lines: [
      { text: '基礎打撃攻撃力', value: 30 },
      { text: '打撃攻撃力', value: 20, cond: [[{ tag: 26 }]], cond_count: 2, cond_exclude_self: false, cond_scope: 'battle', cond_raw: '「タグ：未来」が2人いると、' },
    ] }],
  };
  const member = { character: charaV2(1, [26]), my: myOf(1) };
  const fragments = { 20: condFrag };
  const base = { member, fragmentsById: fragments, counts: { 20: 1 }, weights: { strike_atk: 1 }, effectMap };
  // 文脈なし → 条件効果は入らない（基礎30のみ）
  const rNo = bestForCharacter(base);
  assert.deepEqual(rNo.ids, ['20']);
  // 未来2体の文脈 → 条件効果込みでスコアが上がる
  const ctx2 = { selfId: 1, members: [{ id: 1, tags: [26], element: 'PUR' }, { id: 2, tags: [26], element: 'RED' }] };
  const rYes = bestForCharacter({ ...base, context: ctx2 });
  assert.ok(rYes.score > rNo.score, `条件成立でスコア増: ${rYes.score} > ${rNo.score}`);
  // characterDetail でも同様（conditionalOff に記録される）
  const dNo = characterDetail({ member, fragmentList: [condFrag], effectMap });
  assert.equal(dNo.conditionalOff.length, 1);
  assert.ok(Math.abs(dNo.stats.strike_atk.fragTotal - 30) < 1e-9, '未成立: 基礎30のみ');
  const dYes = characterDetail({ member, fragmentList: [condFrag], effectMap, context: ctx2 });
  assert.equal(dYes.conditionalOff.length, 0);
  assert.ok(dYes.stats.strike_atk.final > dNo.stats.strike_atk.final);
});

test('効果条件: 自身以外の（cond_exclude_self）は自分を数えない', () => {
  const line = { text: '打撃攻撃力', value: 10, cond: [[{ tag: 25 }]], cond_count: 1, cond_exclude_self: true };
  const fragX = { id: 21, name: 'X', equip_char_ids: [1], slots: [{ label: 'SLOT 1', star7: false, lines: [line] }] };
  const member = { character: charaV2(1, [25]), my: myOf(1) };
  const selfOnly = { selfId: 1, members: [{ id: 1, tags: [25], element: 'PUR' }] };
  const withOther = { selfId: 1, members: [{ id: 1, tags: [25], element: 'PUR' }, { id: 2, tags: [25], element: 'RED' }] };
  const d1 = characterDetail({ member, fragmentList: [fragX], effectMap, context: selfOnly });
  assert.equal(d1.conditionalOff.length, 1, '自分しかいない → 未成立');
  const d2 = characterDetail({ member, fragmentList: [fragX], effectMap, context: withOther });
  assert.equal(d2.conditionalOff.length, 0, '他に人造人間がいる → 成立');
});

test('リーダー特殊ルール: リーダーはタグ無視でZアビを送受する（Zのみ・選出時のみ）', () => {
  // A(リーダー, タグ7): Zアビ「タグ7の基礎打撃+30」/ B(タグ8): Zアビ「タグ8の基礎打撃+20」
  const A = { character: charaV2(1, [7], {}, { z_ability: [{ id: 0, name: 'ZアビリティI', groups: [{ cond: [[{ tag: 7 }]], effects: [{ text: '基礎打撃攻撃力', value: 30 }], unresolved: [], raw: '' }] }] }), my: myOf() };
  const B = { character: charaV2(2, [8], {}, { z_ability: [{ id: 0, name: 'ZアビリティI', groups: [{ cond: [[{ tag: 8 }]], effects: [{ text: '基礎打撃攻撃力', value: 20 }], unresolved: [], raw: '' }] }] }), my: myOf() };
  // リーダーなし: タグ不一致なので相互に乗らない
  const plain = abilityCorrections([A, B], [1, 2], effectMap);
  assert.equal(plain['1'].z.strike_atk, 30, 'A自身の30のみ');
  assert.equal(plain['2'].z.strike_atk, 20, 'B自身の20のみ');
  // Aをリーダーに: Aは Bの20 をタグ無視で受け、Aの30 はBにタグ無視で乗る
  const led = abilityCorrections([A, B], [1, 2], effectMap, { leaderId: 1 });
  assert.equal(led['1'].z.strike_atk, 50, 'リーダーは他キャラのZアビを全て受ける');
  assert.equal(led['2'].z.strike_atk, 50, 'リーダーのZアビは選出キャラ全員に乗る');
  // リーダーが選出（バトルメンバー）でなければ発動しない
  const bench = abilityCorrections([A, B], [2], effectMap, { leaderId: 1 });
  assert.equal(bench['2'].z.strike_atk, 20, '非選出リーダーは特殊ルールなし');
});

test('リーダー特殊ルール: ZENKAIアビリティは対象外', () => {
  const A = { character: charaV2(1, [7], {}, { zenkai_ability: [{ id: 0, name: 'ZENKAIアビリティI', groups: [{ cond: [[{ tag: 7 }]], effects: [{ text: '基礎打撃攻撃力', value: 25 }], unresolved: [], raw: '' }] }] }), my: myOf() };
  const B = { character: charaV2(2, [8]), my: myOf() };
  const led = abilityCorrections([A, B], [1, 2], effectMap, { leaderId: 1 });
  assert.equal(led['2'].zenkai.strike_atk, 0, 'ZENKAIアビはタグ無視で配られない');
  assert.equal(led['1'].zenkai.strike_atk, 25, '自身には通常条件で乗る');
});

test('partyAbilityCorrections: プラウドはチーム内で完結する（チーム跨ぎの補正なし）', () => {
  const mk = (id, tags, z) => ({
    character: charaV2(id, tags, {}, { z_ability: [{ id: 0, name: 'ZアビリティI', groups: [{ cond: [], effects: [{ text: '基礎打撃攻撃力', value: z }], unresolved: [], raw: '' }] }] }),
    my: myOf(),
  });
  const members = [mk(1, [7], 10), mk(2, [7], 10), mk(3, [7], 10), mk(4, [7], 40), mk(5, [7], 40), mk(6, [7], 40)];
  const ext = partyAbilityCorrections({
    members, battleIds: [1, 2, 3, 4, 5, 6],
    teams: [[1, 2, 3], [4, 5, 6]], effectMap,
  });
  assert.equal(ext['1'].z.strike_atk, 30, 'チーム1: 10×3体のみ');
  assert.equal(ext['4'].z.strike_atk, 120, 'チーム2: 40×3体のみ');
});

test('zRelationCounts: 条件に一致する(発生源×種別)を数える。出撃Zは数えない', () => {
  const A = { character: charaV2(1, [7], {}, {
    z_ability: [{ id: 0, name: 'ZアビリティI', groups: [{ cond: [[{ tag: 7 }]], effects: [{ text: '基礎打撃攻撃力', value: 30 }], unresolved: [], raw: '' }] }],
    zenkai_ability: [{ id: 0, name: 'ZENKAIアビリティI', groups: [{ cond: [[{ tag: 7 }]], effects: [{ text: '基礎打撃攻撃力', value: 20 }], unresolved: [], raw: '' }] }],
    deploy_z_ability: [{ id: 0, name: '出撃ZアビリティI', groups: [{ cond: [], effects: [{ text: '基礎打撃攻撃力', value: 3 }], unresolved: [], raw: '' }] }],
  }), my: myOf() };
  const B = { character: charaV2(2, [7], {}, { z_ability: [{ id: 0, name: 'ZアビリティI', groups: [{ cond: [[{ tag: 8 }]], effects: [{ text: '基礎打撃攻撃力', value: 20 }], unresolved: [], raw: '' }] }] }), my: myOf() };
  const rel = zRelationCounts([A, B], effectMap);
  // A(タグ7): AのZ(タグ7)◯ + AのZENKAI(タグ7)◯ + BのZ(タグ8)× = 2（出撃Zは数えない）
  assert.equal(rel['1'], 2);
  // B(タグ7): AのZ◯ + AのZENKAI◯ = 2
  assert.equal(rel['2'], 2);
});

test('未知の効果を持つフラグメントは計算から除外しつつ unknown で報告する', () => {
  const member = { character: charaV1(1, []), my: myOf(1) };
  const fragments = {
    10: frag(10, [{ text: '会心威力', value: 50 }]),
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
  const A = { character: charaV1(1, [7]), my: myOf(1) };
  const B = { character: charaV1(2, []), my: myOf(1) };
  const fragments = {
    100: frag(100, [{ stat: 'strike_atk', base: true, value: 50 }]),
    101: frag(101, [{ stat: 'strike_atk', base: true, value: 45 }], { require_tags_any: [7] }),
  };
  const r = optimizeParty({
    members: [A, B], battleIds: [1, 2],
    fragmentsById: fragments, counts: { 100: 1, 101: 1 },
    weights: { strike_atk: 1 }, effectMap,
  });
  assert.equal(r.exact, true);
  assert.deepEqual(r.assignments['1'].ids, ['101'], 'A は代替の101を装備');
  assert.deepEqual(r.assignments['2'].ids, ['100'], 'B が100を装備');
  assert.ok(Math.abs(r.totalScore - 2.95) < 1e-9, `total=${r.totalScore}`);
});

test('characterDetail: §2-4 ケース(2) を v2 データ形式のフルパイプラインで再現', () => {
  const member = {
    character: charaV2(1, [], { strike_atk: 231_537 }),
    my: { ...myOf(3), boost: { ...myOf().boost, strike_atk: 42_080 } },
  };
  const ext = { z: { strike_atk: 149 }, zenkai: {}, ll: { strike_atk: 30 }, extNonBase: {} };
  const fragList = [{
    id: 1, name: 'テスト装備',
    slots: [
      { label: 'SLOT 1', star7: false, lines: [{ text: '基礎打撃攻撃力', value: 60, value_min: 30 }] },
      { label: 'SLOT 2', star7: false, lines: [{ text: '打撃攻撃力', value: 30 }] },
    ],
  }];
  const { stats, unknown } = characterDetail({ member, ext, fragmentList: fragList, effectMap });
  assert.equal(unknown.length, 0);
  const s = stats.strike_atk;
  assert.equal(s.corr, 239);
  assert.ok(Math.abs(s.final - 1_075_087.56) < 0.005, `❸=${s.final}`);
  assert.equal(Math.round(s.corr5), 364);
  assert.equal(Math.round(s.fragTotal), 167);
});
