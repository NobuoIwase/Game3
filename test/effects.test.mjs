// 効果文言の解決（DESIGN.md §1-3, §1-4, §2-1）のテスト。
// 最重要: 未知の効果は絶対に黙って 0 として扱わない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  lookupEffectName, resolveEffect, fragmentStatEffects, sumFragmentEffects, conditionMatches,
} from '../js/effects.js';

const effectMap = JSON.parse(
  readFileSync(new URL('../game_data/effect_map.json', import.meta.url), 'utf8')
);

test('entries の完全一致で解決できる（新旧両表記）', () => {
  assert.deepEqual(lookupEffectName('基礎打撃攻撃力', effectMap), { stats: ['strike_atk'], base: true });
  assert.deepEqual(lookupEffectName('基礎打撃攻撃力アップ', effectMap), { stats: ['strike_atk'], base: true });
  assert.deepEqual(lookupEffectName('打撃攻撃力', effectMap), { stats: ['strike_atk'], base: false });
});

test('複合表記「基礎打撃・射撃攻撃力」は2ステータスに展開される', () => {
  assert.deepEqual(lookupEffectName('基礎打撃・射撃攻撃力', effectMap), { stats: ['strike_atk', 'blast_atk'], base: true });
  const r = resolveEffect({ text: '基礎打撃・射撃防御力', value: 60 }, effectMap);
  assert.equal(r.ok, true);
  assert.deepEqual(r.effects, [
    { stat: 'strike_def', base: true, value: 60 },
    { stat: 'blast_def', base: true, value: 60 },
  ]);
});

test('§2-1 規則パース: entries に無くても「基礎」接頭辞で加算/乗算を判別する', () => {
  const ruleOnly = { entries: {}, _stat_keywords: effectMap._stat_keywords };
  assert.deepEqual(lookupEffectName('基礎射撃防御力', ruleOnly), { stats: ['blast_def'], base: true });
  assert.deepEqual(lookupEffectName('射撃防御力アップ', ruleOnly), { stats: ['blast_def'], base: false });
  assert.deepEqual(lookupEffectName('基礎打撃・射撃攻撃力', ruleOnly), { stats: ['strike_atk', 'blast_atk'], base: true });
});

test('計算対象外と確認済みの効果（other）は警告なしで除外される', () => {
  assert.deepEqual(lookupEffectName('与ダメージ', effectMap), { other: true });
  const r = resolveEffect({ text: 'ダメージガード', value: 250 }, effectMap);
  assert.deepEqual(r, { ok: true, effects: [], other: true });
});

test('未知の効果文言は未対応として返る（黙って0にしない — §1-4）', () => {
  const r = resolveEffect({ text: '会心威力', value: 10 }, effectMap);
  assert.equal(r.ok, false);
  assert.match(r.reason, /未対応の効果文言/);
});

test('気力回復速度: 基礎付きはステータス、基礎なしは戦闘バフ（計算対象外）', () => {
  assert.deepEqual(lookupEffectName('基礎気力回復速度', effectMap), { stats: ['ki_recovery'], base: true });
  assert.deepEqual(lookupEffectName('気力回復速度', effectMap), { other: true });
});

test('「特攻：○○」「特防：○○」はパターンで計算対象外になる（§1-3: パターンもデータ側）', () => {
  assert.deepEqual(lookupEffectName('特攻：ピッコロ', effectMap), { other: true });
  assert.deepEqual(lookupEffectName('特防：人造人間', effectMap), { other: true });
});

test('fragmentStatEffects v2: SLOT構造・star7条件・raw行の扱い', () => {
  const frag = {
    id: 32012, name: 'プラチナ',
    slots: [
      { label: 'SLOT 1', star7: false, lines: [
        { text: '基礎体力', value: 30 },
        { text: '基礎打撃・射撃攻撃力', value: 60 },
      ] },
      { label: 'SLOT 2', star7: false, lines: [
        { text: '与ダメージ', value: 220 },
        { raw: '場に出た時、以下の効果を発動する' },
      ] },
      { label: 'SLOT 4', star7: true, lines: [{ text: '基礎打撃攻撃力', value: 10 }] },
    ],
  };
  const r7 = fragmentStatEffects(frag, effectMap, { stars: 7 });
  assert.equal(r7.unknown.length, 0);
  assert.deepEqual(r7.others, ['与ダメージ']);
  const strike7 = r7.effects.filter((e) => e.stat === 'strike_atk').reduce((a, e) => a + e.value, 0);
  assert.equal(strike7, 70, '★7ならSLOT4も有効 (60+10)');
  const r3 = fragmentStatEffects(frag, effectMap, { stars: 3 });
  const strike3 = r3.effects.filter((e) => e.stat === 'strike_atk').reduce((a, e) => a + e.value, 0);
  assert.equal(strike3, 60, '★7未満はSLOT4を除外');
});

test('fragmentStatEffects v1（手入力・旧形式）も引き続き動く', () => {
  const frag = { id: 1, name: 'A', effects: [
    { stat: 'strike_atk', base: true, value: 110 },
    { text: '打撃攻撃力アップ', value: 20 },
  ] };
  const r = fragmentStatEffects(frag, effectMap);
  assert.deepEqual(r.effects, [
    { stat: 'strike_atk', base: true, value: 110 },
    { stat: 'strike_atk', base: false, value: 20 },
  ]);
});

test('sumFragmentEffects: 合算と未対応リストの分離', () => {
  const frags = [
    { id: 1, name: 'A', effects: [{ stat: 'strike_atk', base: true, value: 110 }] },
    { id: 2, name: 'B', slots: [{ label: 'SLOT 1', star7: false, lines: [
      { text: '基礎打撃攻撃力', value: 18 },
      { text: '謎の新効果', value: 5 },
    ] }] },
  ];
  const r = sumFragmentEffects(frags, effectMap);
  assert.equal(r.basePct.strike_atk, 128);
  assert.equal(r.unknown.length, 1);
  assert.equal(r.unknown[0].fragmentName, 'B');
  assert.match(r.unknown[0].reason, /謎の新効果/);
});

test('conditionMatches: OR条件・属性AND条件・未解決トークン', () => {
  const goku = { tags: [7, 40, 56], element: 'PUR' };
  // タグOR
  assert.equal(conditionMatches([[{ tag: 56 }], [{ tag: 99 }]], goku), true);
  assert.equal(conditionMatches([[{ tag: 99 }]], goku), false);
  // 属性 AND タグ
  assert.equal(conditionMatches([[{ element: 'PUR' }, { tag: 7 }]], goku), true);
  assert.equal(conditionMatches([[{ element: 'RED' }, { tag: 7 }]], goku), false);
  // 未解決トークンは一致しない
  assert.equal(conditionMatches([[{ name: '未知タグ' }]], goku), false);
  // 条件なしは全員一致
  assert.equal(conditionMatches([], goku), true);
});

test('タッグキャラの2属性: どちらの属性でも色限定条件に一致する', () => {
  const dual = { tags: [25], element: 'BLU', elements: ['BLU', 'GRN'] };
  assert.equal(conditionMatches([[{ element: 'BLU' }]], dual), true);
  assert.equal(conditionMatches([[{ element: 'GRN' }]], dual), true, '第2属性でも一致');
  assert.equal(conditionMatches([[{ element: 'RED' }]], dual), false);
  const single = { tags: [], element: 'PUR' };
  assert.equal(conditionMatches([[{ element: 'PUR' }]], single), true, 'elements 無しでも従来通り');
});

test('人数比例の効果条件: 該当メンバー数×効果値で適用される', () => {
  const frag = {
    id: 90, name: '人数比例',
    slots: [{ label: 'SLOT 3', star7: false, lines: [
      { text: '打撃攻撃力', value: 5, value_min: 2, cond: [[{ tag: 5 }]], cond_count: 1,
        cond_exclude_self: false, cond_per_member: true, cond_scope: 'battle', cond_raw: '…1人につき、' },
    ] }],
  };
  const mk = (n) => ({ selfId: 1, members: Array.from({ length: 3 }, (_, i) =>
    ({ id: i + 1, tags: i < n ? [5] : [], element: 'RED' })) });
  const r0 = fragmentStatEffects(frag, effectMap, { context: mk(0) });
  assert.equal(r0.effects.length, 0);
  assert.equal(r0.conditionalOff.length, 1, '該当0人 → 未発動');
  const r2 = fragmentStatEffects(frag, effectMap, { context: mk(2) });
  assert.deepEqual(r2.effects, [{ stat: 'strike_atk', base: false, value: 10 }], '2人 → 5%×2');
  const r3 = fragmentStatEffects(frag, effectMap, { context: mk(3) });
  assert.equal(r3.effects[0].value, 15, '3人 → 5%×3');
});

test('resolveAbilityGroups: 条件行が未解析のグループは無条件適用しない（原則1-4）', async () => {
  const { resolveAbilityGroups, conditionMatches } = await import('../js/effects.js');
  const groups = [{
    cond: [],
    unresolved: ['バトル時、「属性：GRN」かつ「タグ：未知タグ」の以下のステータスをアップ'],
    effects: [{ text: '基礎打撃攻撃力', value: 35 }],
    raw: '',
  }];
  const map = { entries: { '基礎打撃攻撃力': { stat: 'strike_atk', base: true } } };
  const r = resolveAbilityGroups(groups, map, 'テストキャラ');
  // 効果は解決されるが、条件未解析なので「絶対に一致しない条件」が付く
  assert.equal(r.groups[0].effects.length, 1);
  assert.ok(r.groups[0].cond.length > 0, '条件が付与される');
  assert.equal(conditionMatches(r.groups[0].cond, { tags: [15003, 31], element: 'GRN' }), false);
  assert.ok(r.unknown.some((u) => u.includes('条件行が未解析')), '警告が出る');
});

test('resolveAbilityGroups: ICN形式の未解析条件行もフェイルセーフで全員適用を防ぐ', async () => {
  const { resolveAbilityGroups, conditionMatches } = await import('../js/effects.js');
  const groups = [{
    cond: [],
    unresolved: ['{{ICN:Mystery}}謎条件'],
    effects: [{ text: '基礎打撃攻撃力', value: 10 }],
    raw: '',
  }];
  const map = { entries: { '基礎打撃攻撃力': { stat: 'strike_atk', base: true } } };
  const r = resolveAbilityGroups(groups, map, 'テスト');
  assert.ok(r.groups[0].cond.length > 0);
  assert.equal(conditionMatches(r.groups[0].cond, { tags: [1, 2, 3], element: 'RED' }), false);
  assert.ok(r.unknown.some((u) => u.includes('条件行が未解析')));
});

test('fragmentStatEffects: cond_scope=self は装備キャラ自身のタグで判定する', async () => {
  const { fragmentStatEffects } = await import('../js/effects.js');
  const map = { entries: { '打撃攻撃力': { stat: 'strike_atk', base: false } } };
  const frag = { slots: [{ label: 'SLOT 1', star7: false, lines: [
    { text: '打撃攻撃力', value: 15, value_min: 8, cond: [[{ tag: 13002 }]], cond_count: 1, cond_exclude_self: false, cond_scope: 'self', cond_raw: '自身が「バトルスタイル：打撃タイプ」の場合、' },
  ] }] };
  const ctxOf = (selfTags) => ({ selfId: 1, self: { id: 1, tags: selfTags, element: 'RED' }, members: [{ id: 2, tags: [13002], element: 'GRN' }] });
  // 自身が打撃タイプ → 適用（バトルメンバーに打撃タイプがいても自身で判定）
  const on = fragmentStatEffects(frag, map, { stars: 7, context: ctxOf([13002]) });
  assert.equal(on.effects.length, 1);
  assert.equal(on.effects[0].value, 15);
  // 自身が打撃タイプでない → 未適用（メンバー2が打撃タイプでも乗らない）
  const off = fragmentStatEffects(frag, map, { stars: 7, context: ctxOf([13003]) });
  assert.equal(off.effects.length, 0);
  assert.equal(off.conditionalOff.length, 1);
});
