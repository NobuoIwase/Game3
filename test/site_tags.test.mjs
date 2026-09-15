// サイト内タグ（DESIGN.md §33）のテスト。
// 2025年の 孫悟空：少年期 以降の「▼/○」箇条書き形式と、それ以前の文章形式の
// 両方が同じタグに分類されることを担保する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAbilityBlocks, abilityCorpus, computeSiteTags, exclusiveUniqueFragments } from '../js/site_tags.js';

const defs = JSON.parse(readFileSync(new URL('../game_data/site_tags.json', import.meta.url), 'utf8'));

const charOf = (extra = {}) => ({
  id: 1, name: 'テスト', arts: [], z_ability: [], zenkai_ability: [], deploy_z_ability: [],
  ultra_ability: [], main_ability: null, ...extra,
});
const mainOf = (text) => ({ id: 1, name: 'メイン', text });

test('parseAbilityBlocks: 新形式（▼/○）はトリガーごとのブロックになる', () => {
  const b = parseAbilityBlocks('▼場に出た時\r\n○カードを1枚ドロー\r\n○体力10%回復\r\n\r\n▼敵のアーツ攻撃を受けた時(1回)\r\n○敵の手札1枚破棄');
  assert.equal(b.length, 2);
  assert.equal(b[0].trigger, '場に出た時');
  assert.ok(b[0].body.includes('カードを1枚ドロー'));
  assert.equal(b[1].trigger, '敵のアーツ攻撃を受けた時(1回)');
  assert.ok(b[1].body.includes('敵の手札1枚破棄'));
});

test('parseAbilityBlocks: 旧形式（文章）は行ごとにトリガーを取り出す', () => {
  const b = parseAbilityBlocks('場に出た時、自身の体力を15%回復\nバトル時、打撃与ダメージを20%アップ');
  assert.equal(b.length, 2);
  assert.equal(b[0].trigger, '場に出た時');
  assert.equal(b[1].trigger, 'バトル時');
});

test('parseAbilityBlocks: トリガーなしの行は無条件ブロックになる', () => {
  const b = parseAbilityBlocks('○与ダメージ30%アップ');
  assert.equal(b.length, 1);
  assert.equal(b[0].trigger, null);
});

test('§33 被弾時に敵の手札破棄・気力減少・コストアップを分類する', () => {
  const c = charOf({ main_ability: mainOf(
    '▼敵のアーツ攻撃を受けた時(3回)\r\n○敵の手札1枚破棄\r\n○敵の気力30減少\r\n○敵全体に打撃・射撃・必殺アーツコスト20{{ICN:UpRed}}(10カウント)') });
  const tags = computeSiteTags(c, defs);
  assert.ok(tags.includes('hit_discard'), '被弾時の手札破棄');
  assert.ok(tags.includes('hit_ki_drain'), '被弾時の気力減少');
  assert.ok(tags.includes('hit_cost_up'), '被弾時のコストアップ');
  assert.ok(tags.includes('hit_debuff'), '被弾時デバフ（総合）');
  assert.ok(tags.includes('any_discard'), 'トリガー不問の手札破棄');
});

test('§33 トリガーが違えば被弾時タグは付かない（場に出た時の手札破棄）', () => {
  const c = charOf({ main_ability: mainOf('▼場に出た時\r\n○敵の手札1枚破棄') });
  const tags = computeSiteTags(c, defs);
  assert.ok(!tags.includes('hit_discard'), '被弾時ではない');
  assert.ok(tags.includes('enter_debuff'), '場に出た時のデバフとして分類される');
  assert.ok(tags.includes('any_discard'));
});

test('§33 「ずつ」を含む積み重ね型だけ repeat タグが付く', () => {
  const stack = charOf({ main_ability: mainOf('▼敵のアーツ攻撃を受けた時\r\n○敵の気力5減少ずつ') });
  assert.ok(computeSiteTags(stack, defs).includes('hit_debuff_stack'), '「ずつ」は回数依存');
  const once = charOf({ main_ability: mainOf('▼敵のアーツ攻撃を受けた時(1回)\r\n○敵の気力30減少') });
  assert.ok(!computeSiteTags(once, defs).includes('hit_debuff_stack'), '(1回)は回数依存ではない');
});

test('§33 控えに戻る時のデバフを分類する', () => {
  const c = charOf({ main_ability: mainOf('▼控えに戻る時\r\n○敵全体に待機カウント2付与ずつ') });
  const tags = computeSiteTags(c, defs);
  assert.ok(tags.includes('leave_debuff'));
  assert.ok(tags.includes('leave_debuff_stack'));
});

test('§33 旧形式の文章からも同じタグが付く', () => {
  const c = charOf({ main_ability: mainOf('場に出た時、自身の体力を15%回復し、カードを1枚ドロー') });
  const tags = computeSiteTags(c, defs);
  assert.ok(tags.includes('enter_heal'), '旧形式の「場に出た時、…回復」');
  assert.ok(tags.includes('enter_draw'));
});

test('§33 構造から判定する特別タグ（アーツ種別・ZENKAI・ユニークゲージ・専用ユニフラ）', () => {
  const c = charOf({
    arts: [{ type: '必殺' }, { type: '特殊' }],
    zenkai_ability: [{ id: 0, name: 'ZENKAIアビリティI', groups: [] }],
    ultra_ability: [{ id: 1, name: 'ユニークゲージ', text: '攻撃タイプ' }],
    main_ability: mainOf('▼場に出た時\r\n○体力10%回復'),
  });
  const frags = { 100: { id: 100, rarity: 'unique', equip_char_ids: [1], slots: [] } };
  const uniq = exclusiveUniqueFragments(1, frags);
  assert.equal(uniq.length, 1, '専用ユニークフラグメント（装備可能1体のみ）');
  const tags = computeSiteTags(c, defs, { uniqueFragments: uniq });
  assert.ok(tags.includes('arts_ultimate'));
  assert.ok(tags.includes('arts_special'));
  assert.ok(!tags.includes('arts_awaken'));
  assert.ok(tags.includes('has_zenkai'));
  assert.ok(tags.includes('has_unique_gauge'));
  assert.ok(tags.includes('has_unique_frag'));
  assert.ok(tags.includes('has_main_ability'));
});

test('§33 専用ユニフラの本文もタグ判定の対象になる', () => {
  const c = charOf({ main_ability: mainOf('▼場に出た時\r\n○体力10%回復') });
  const frags = { 100: { id: 100, rarity: 'unique', equip_char_ids: [1],
    slots: [{ label: 'SLOT 1', lines: [{ raw: 'カバーチェンジ時、敵の手札を1枚破棄' }] }] } };
  const tags = computeSiteTags(c, defs, { uniqueFragments: exclusiveUniqueFragments(1, frags) });
  assert.ok(tags.includes('any_discard'), '専用ユニフラの効果も拾う');
});

test('§33 abilityCorpus はメイン・ユニーク・Z・アーツ詳細をすべて含む', () => {
  const c = charOf({
    main_ability: mainOf('メイン本文'),
    ultra_ability: [{ id: 1, name: 'ユニーク', text: 'ユニーク本文' }],
    z_ability: [{ id: 0, name: 'ZアビリティI', groups: [{ raw: 'Z本文' }] }],
    arts_detail: [{ id: 1, name: 'アーツ', text: 'アーツ本文' }],
  });
  const corpus = abilityCorpus(c, [{ slots: [{ lines: [{ raw: 'フラグ本文' }] }] }]);
  for (const s of ['メイン本文', 'ユニーク本文', 'Z本文', 'アーツ本文', 'フラグ本文']) {
    assert.ok(corpus.includes(s), s);
  }
});

test('§33 artType: アーツIDの接頭辞から種別を判定する', async () => {
  const { artType } = await import('../js/site_tags.js');
  assert.equal(artType(675, 675), '打撃');
  assert.equal(artType(10675, 675), '射撃');
  assert.equal(artType(30675, 675), '必殺');
  assert.equal(artType(50675, 675), '特殊');
  assert.equal(artType(11000675, 675), '打撃', '変身後フォームの打撃');
  assert.equal(artType(11030675, 675), '必殺', '変身後フォームの必殺');
  assert.equal(artType(11050675, 675), '特殊', '変身後フォームの特殊');
  assert.equal(artType(70161, 675), '共有', 'キャラIDで終わらない=共有アーツ');
});

test('§33 アーツの距離は「突進」の有無で近距離/遠距離を切り分ける（推定）', () => {
  const melee = charOf({ id: 5, arts_detail: [
    { id: 305, name: '突進必殺', text: '特大ダメージ(衝撃属性)\r\n※突進時射撃アーマー' }] });
  const ranged = charOf({ id: 5, arts_detail: [
    { id: 305, name: '波動砲', text: '特大ダメージ(爆発属性)' }] });
  const mt = computeSiteTags(melee, defs);
  const rt = computeSiteTags(ranged, defs);
  assert.ok(mt.includes('arts_ultimate') && mt.includes('ult_melee'), '突進あり=近距離系');
  assert.ok(!mt.includes('ult_ranged'));
  assert.ok(rt.includes('ult_ranged'), '突進なし=遠距離系');
  assert.ok(!rt.includes('ult_melee'));
  assert.ok(mt.includes('armor_ultimate'), '射撃アーマー付き必殺');
});
