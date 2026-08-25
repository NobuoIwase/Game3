// クローラの純粋関数（tools/crawl_dblegends.mjs）のテスト。
// ページ取得は行わず、文言パースだけを検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLine, parseAbilityText } from '../tools/crawl_dblegends.mjs';

test('classifyLine: 固定値・レンジ（最大値採用 §3-2）・説明行', () => {
  assert.deepEqual(classifyLine('基礎体力 +30%'), { text: '基礎体力', value: 30 });
  assert.deepEqual(classifyLine('基礎打撃攻撃力 8.00% ~ 18.00%'),
    { text: '基礎打撃攻撃力', value: 18, value_min: 8 });
  assert.deepEqual(classifyLine('与ダメージ -5.00% ~ +10.00%'),
    { text: '与ダメージ', value: 10, value_min: -5 });
  assert.deepEqual(classifyLine('場に出た時、体力15％回復'), { raw: '場に出た時、体力15％回復' });
});

const TAGS = { '宇宙代表': 56, '神の気': 40, 'サイヤ人': 7, 'DAIMA': 59, '未来': 26, 'BLU': 15004, 'HERO': 12000, '劇場版編': 20015 };

test('parseAbilityText: Zアビ形式（タグOR条件 + 空行区切りの複数グループ）', () => {
  const text = '{{ICN:ChaTag}}宇宙代表 or {{ICN:ChaTag}}神の気 or {{ICN:ChaTag}}サイヤ人\r\n' +
    '○基礎打撃攻撃力38%{{ICN:UpBlue}}\r\n○基礎打撃防御力38%{{ICN:UpBlue}}\r\n\r\n' +
    '{{ICN:ChaTag}}宇宙代表\r\n○基礎射撃攻撃力18%{{ICN:UpBlue}}';
  const g = parseAbilityText(text, TAGS);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].cond, [[{ tag: 56, name: '宇宙代表' }], [{ tag: 40, name: '神の気' }], [{ tag: 7, name: 'サイヤ人' }]]);
  assert.deepEqual(g[0].effects, [{ text: '基礎打撃攻撃力', value: 38 }, { text: '基礎打撃防御力', value: 38 }]);
  assert.deepEqual(g[1].cond, [[{ tag: 56, name: '宇宙代表' }]]);
});

test('parseAbilityText: 属性ANDタグ条件（{{ICN:RED}} & {{ICN:ChaTag}}DAIMA）', () => {
  const text = '{{ICN:RED}} & {{ICN:ChaTag}}DAIMA\r\n○基礎打撃攻撃力20%{{ICN:UpBlue}}';
  const g = parseAbilityText(text, TAGS);
  assert.deepEqual(g[0].cond, [[{ element: 'RED' }, { tag: 59, name: 'DAIMA' }]]);
});

test('parseAbilityText: 出撃Zアビ形式（・…を3%アップ）', () => {
  const text = '自身がバトルメンバー時、味方の以下のステータスをアップ\r\n・基礎打撃攻撃力を3%アップ\r\n・基礎射撃攻撃力を3%アップ';
  const g = parseAbilityText(text, TAGS);
  assert.deepEqual(g[0].effects, [
    { text: '基礎打撃攻撃力', value: 3 },
    { text: '基礎射撃攻撃力', value: 3 },
  ]);
});

test('parseAbilityText: インライン条件形式（バトル時、「タグ：…」の…をX%アップ）', () => {
  const g = parseAbilityText(
    'バトル時、「タグ：未来」または「レアリティ：HERO」または「属性：BLU」の基礎打撃・射撃攻撃力を30%アップ', TAGS);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].cond, [[{ tag: 26, name: '未来' }], [{ tag: 12000, name: 'HERO' }], [{ tag: 15004, name: 'BLU' }]]);
  assert.deepEqual(g[0].effects, [{ text: '基礎打撃・射撃攻撃力', value: 30 }]);
});

test('parseAbilityText: 未解決の条件名は unresolved に記録される（§1-4）', () => {
  const g = parseAbilityText('バトル時、「タグ：謎の新タグ」の基礎体力最大値を25%アップ', TAGS);
  assert.deepEqual(g[0].cond, [[{ name: '謎の新タグ' }]]);
  assert.ok(g[0].unresolved.includes('条件:謎の新タグ'));
});

test('parseConditionalSlot: 折り返された効果条件ブロックを解析する', async () => {
  const { parseConditionalSlot } = await import('../tools/crawl_dblegends.mjs');
  const TAGS2 = { '人造人間': 25, 'RED': 15000, 'BLU': 15004, 'GT': 32 };
  const r1 = parseConditionalSlot([
    'バトルメンバーに「属性：RED」または',
    '「タグ：GT」がいると、',
    '自身の打撃攻撃力が6.00% ~ 12.50%アップ',
  ], TAGS2);
  assert.equal(r1.length, 1);
  assert.deepEqual(r1[0].cond, [[{ tag: 15000, name: 'RED' }], [{ tag: 32, name: 'GT' }]]);
  assert.equal(r1[0].value, 12.5);
  assert.equal(r1[0].value_min, 6);
  assert.equal(r1[0].text, '打撃攻撃力');

  const r2 = parseConditionalSlot([
    'バトルメンバーに自身以外の',
    '「タグ：人造人間」がいると、',
    '自身の打撃攻撃力を8.00% ~ 15.00%アップ',
  ], TAGS2);
  assert.equal(r2[0].cond_exclude_self, true);

  // アビリティ文（発動系）は解析しない
  const r3 = parseConditionalSlot([
    '場に出た時、自身以外のバトルメンバーに',
    '「タグ：GT」が1人以上編成時、以下の効果を発動する',
    '・敵全体に待機カウント3付与',
  ], TAGS2);
  assert.equal(r3, null);
});

test('parseConditionalSlot: 人数比例形式（1人につき〜ずつアップ）', async () => {
  const { parseConditionalSlot } = await import('../tools/crawl_dblegends.mjs');
  const T = { 'フリーザ軍': 5, 'GT': 32 };
  const r = parseConditionalSlot([
    'バトルメンバーの「タグ：フリーザ軍」または「タグ：GT」1人につき、',
    '自身の打撃攻撃力を2.00% ~ 5.00%ずつアップ',
  ], T);
  assert.equal(r.length, 1);
  assert.equal(r[0].cond_per_member, true);
  assert.equal(r[0].value, 5);
  assert.equal(r[0].value_min, 2);
  assert.deepEqual(r[0].cond, [[{ tag: 5, name: 'フリーザ軍' }], [{ tag: 32, name: 'GT' }]]);
});

test('parseAbilityText: 「〜%アップする」節と%を持たない節の混在', () => {
  const g = parseAbilityText('基礎打撃攻撃力を20%アップする&必殺アーツコストを5ダウン', TAGS);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].effects, [{ text: '基礎打撃攻撃力', value: 20 }]);
  assert.ok(g[0].unresolved.some((u) => u.includes('必殺アーツコスト')), '%なし節はunresolvedへ');
});

test('parseAbilityText: 箇条書き型ZENKAI（「…かつ…」の以下のステータスをアップ）', () => {
  const T = { GRN: 15003, '再生': 31 };
  const text = 'バトル時、「属性：GRN」かつ「タグ：再生」の以下のステータスをアップ\r\n・基礎打撃攻撃力を35%アップ\r\n・基礎射撃攻撃力を40%アップ';
  const g = parseAbilityText(text, T);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].cond, [[{ tag: 15003, name: 'GRN' }, { tag: 31, name: '再生' }]]);
  assert.deepEqual(g[0].effects, [
    { text: '基礎打撃攻撃力', value: 35 },
    { text: '基礎射撃攻撃力', value: 40 },
  ]);
  assert.equal(g[0].unresolved.length, 0);
});

test('parseAbilityText: 【対象キャラクター】ブロックの条件が効果グループに適用される', () => {
  const T = { PUR: 15002, '孫一族': 1, 'ベジータ一族': 2 };
  const text = 'バトル時、以下のステータスをアップ\r\n\r\n・基礎打撃攻撃力を7%アップ\r\n・基礎射撃攻撃力を7%アップ\r\n\r\n【対象キャラクター】\r\n・「属性：PUR」かつ「タグ：孫一族」\r\nまたは\r\n・「属性：PUR」かつ「タグ：ベジータ一族」';
  const g = parseAbilityText(text, T);
  const eff = g.find((x) => x.effects.length > 0);
  assert.ok(eff, '効果グループが存在する');
  assert.deepEqual(eff.cond, [
    [{ tag: 15002, name: 'PUR' }, { tag: 1, name: '孫一族' }],
    [{ tag: 15002, name: 'PUR' }, { tag: 2, name: 'ベジータ一族' }],
  ]);
  // 【対象キャラクター】ブロック自体は消費され、条件だけが移る
  assert.ok(!g.some((x) => x.raw.includes('【対象キャラクター】') && x.effects.length === 0 && x.cond.length === 0 && x.unresolved.length === 0));
});

test('parseAbilityText: レアリティ条件の箇条書き型（RED かつ EXTREME）', () => {
  const T = { RED: 15000, EXTREME: 12001 };
  const text = 'バトル時、「属性：RED」かつ「レアリティ：EXTREME」の以下のステータスをアップ\r\n・基礎打撃攻撃力を30%アップ';
  const g = parseAbilityText(text, T);
  assert.deepEqual(g[0].cond, [[{ tag: 15000, name: 'RED' }, { tag: 12001, name: 'EXTREME' }]]);
});
