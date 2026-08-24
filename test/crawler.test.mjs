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
