// HTML パーサ（DESIGN.md §5-3）のテスト。属性順に依存しないこと・タグ表の抽出を確認する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCharacterListHTML, parseTagSelectHTML } from '../js/parser.js';

const SAMPLE = `
<div class="list">
<a href="character/738"
   data-charaname="超サイヤ人ゴッドSS界王拳 孫悟空"
   data-element="PUR" data-rarity="LEGEND"
   data-zenkai="0" data-lf="1"
   data-tags="7 1 40 45 56 9140 10000 12004 13002 15002 20018 50010">x</a>
<a data-tags="7 1" data-rarity="SPARKING" data-element="GRN"
   data-charaname="超サイヤ人4 孫悟空 &amp; 仲間" data-zenkai="1" data-lf="0"
   href="https://example.invalid/character/812?x=1">x</a>
<a href="character/" data-charaname="壊れた行">x</a>
<a href="other/999">パース対象外</a>
</div>
<select id="filterTAGS">
  <option value="">すべて</option>
  <option value="7">孫悟空</option>
  <option value="50010">タグ50010の名前</option>
</select>
`;

test('キャラ一覧: data-* 属性を属性順に依存せず取り出す', () => {
  const { characters, skipped } = parseCharacterListHTML(SAMPLE);
  assert.equal(characters.length, 2);
  const [c1, c2] = characters;
  assert.equal(c1.id, 738);
  assert.equal(c1.name, '超サイヤ人ゴッドSS界王拳 孫悟空');
  assert.equal(c1.element, 'PUR');
  assert.equal(c1.rarity, 'LEGEND');
  assert.equal(c1.lf, true);
  assert.deepEqual(c1.tags, [7, 1, 40, 45, 56, 9140, 10000, 12004, 13002, 15002, 20018, 50010]);
  assert.equal(c2.id, 812);
  assert.equal(c2.name, '超サイヤ人4 孫悟空 & 仲間', 'HTMLエンティティをデコードする');
  assert.equal(c2.zenkai, true);
  assert.equal(skipped, 1, 'IDを特定できない行は読み飛ばし件数として報告する');
});

test('filterTAGS からタグID→名前の対応表を取り出す', () => {
  const tags = parseTagSelectHTML(SAMPLE);
  assert.deepEqual(tags, { 7: '孫悟空', 50010: 'タグ50010の名前' });
});

test('対象が無いHTMLでは空の結果を返す（落ちない）', () => {
  assert.deepEqual(parseCharacterListHTML('<p>hello</p>').characters, []);
  assert.deepEqual(parseTagSelectHTML('<p>hello</p>'), {});
});
