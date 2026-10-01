// 編成の配置ルール（§47 / §48: プラウド3戦目）
// 3戦目は「1戦目と2戦目のキャラ（パーティの6体）から、各戦2体まで編成できる3体での戦い」。
// リーダーは常に1体・左上のみ。2戦目の先頭はリーダーではない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  placeChar, thirdTeamCounts, sanitizeThird, stillInParty, PROUD_PER_TEAM_MAX, proudLeadersOf,
} from '../js/party_rules.js';

const E = ['', '', '', '', '', '', '', '', ''];
const ids = (...xs) => Array.from({ length: 9 }, (_, i) => (xs[i] == null ? '' : String(xs[i])));
const PARTY = [1, 2, 3, 4, 5, 6]; // 1戦目 1,2,3 / 2戦目 4,5,6

test('§48 各戦から2体まで', () => {
  assert.equal(PROUD_PER_TEAM_MAX, 2);
});

test('§48 不具合の再現: 1戦目と2戦目から1体ずつ選んだ後、どちらの2体目も選べる', () => {
  let r = placeChar(ids(...PARTY), 6, '1', 'proud');     // 1戦目から1体目
  assert.equal(r.error, undefined);
  r = placeChar(r.ids, 7, '4', 'proud');                  // 2戦目から1体目
  assert.equal(r.error, undefined);
  const a = placeChar(r.ids, 8, '2', 'proud');            // 1戦目の2体目
  assert.equal(a.error, undefined, '1戦目の2体目を選べる');
  assert.deepEqual(a.ids, ids(...PARTY, 1, 4, 2));
  const b = placeChar(r.ids, 8, '5', 'proud');            // 2戦目の2体目
  assert.equal(b.error, undefined, '2戦目の2体目を選べる');
  assert.deepEqual(thirdTeamCounts(b.ids), [1, 2]);
});

test('§48 同じ戦から3体は不可', () => {
  const base = ids(...PARTY, 1, 2);
  const r = placeChar(base, 8, '3', 'proud');
  assert.match(r.error, /1戦目.*2体まで/);
  assert.deepEqual(r.ids, base, '拒否したら元のまま');
  const r2 = placeChar(ids(...PARTY, 4, 5), 8, '6', 'proud');
  assert.match(r2.error, /2戦目.*2体まで/);
});

test('§48 3戦目はパーティの6体からのみ', () => {
  const r = placeChar(ids(...PARTY), 6, '99', 'proud');
  assert.match(r.error, /6体から/);
  assert.deepEqual(r.ids, ids(...PARTY));
});

test('§48 3戦目の中で同じキャラを別枠に置くと3戦目の中で入れ替え', () => {
  const r = placeChar(ids(...PARTY, 1, 4, 2), 8, '1', 'proud');
  assert.equal(r.error, undefined);
  assert.deepEqual(r.ids.slice(6), ['2', '4', '1']);
});

test('§48 1・2戦目の重複禁止（入れ替え）は従来どおり', () => {
  const r = placeChar(ids(...PARTY), 3, '1', 'proud');
  assert.deepEqual(r.ids.slice(0, 6), ['4', '2', '3', '1', '5', '6']);
});

test('§48 1・2戦目を変えて3戦目がルール外になったら、その枠を空けて知らせる', () => {
  // パーティから外れたキャラは3戦目からも外れる
  let r = placeChar(ids(...PARTY, 1, 4, 2), 1, '99', 'proud');   // 2 → 99 に差し替え
  assert.deepEqual(r.ids, ids(1, 99, 3, 4, 5, 6, 1, 4, ''));
  assert.deepEqual(r.cleared, ['2']);
  // 入れ替えで3戦目が1戦目のキャラだけになったら、超えた枠を空ける
  r = placeChar(ids(...PARTY, 1, 2, 4), 2, '4', 'proud');        // 4 を1戦目へ（3 は2戦目へ）
  assert.deepEqual(r.ids.slice(0, 6), ['1', '2', '4', '3', '5', '6']);
  assert.deepEqual(r.ids.slice(6), ['1', '2', ''], '3体とも1戦目になるので3体目を空ける');
  assert.deepEqual(r.cleared, ['4']);
});

test('§48 sanitizeThird: 旧ルール（v2.35）で保存された3戦目を読み込み時に正す', () => {
  // 6体外のキャラ(9)、重複(1)、3体目の1戦目(2が3体目として)…を順に除く
  const s = sanitizeThird(ids(...PARTY, 9, 1, 1));
  assert.deepEqual(s.ids.slice(6), ['', '1', '']);
  assert.deepEqual(s.cleared, ['9', '1']);
  assert.deepEqual(sanitizeThird(ids(...PARTY, 1, 2, 3)).ids.slice(6), ['1', '2', '']);
});

test('§48 リーダーは左上の1体だけ（2戦目はリーダー無し、3戦目は左上を選んだときだけ）', () => {
  assert.deepEqual(proudLeadersOf(ids(...PARTY, 4, 1, 5)), ['1', null, '1']);
  assert.deepEqual(proudLeadersOf(ids(...PARTY, 2, 4, 5)), ['1', null, null], '左上を選ばなければ3戦目はリーダー無し');
  assert.deepEqual(proudLeadersOf(ids(...PARTY, 4, 2, 5)), ['1', null, null], '2戦目の先頭(4)はリーダーではない');
  // リーダー探索で左上を差し替えると、3戦目もそれに従う
  assert.deepEqual(proudLeadersOf(ids(...PARTY, 2, 4, 5), '2'), ['2', null, '2']);
  assert.deepEqual(proudLeadersOf(ids('', '', '', 4, 5, 6)), [null, null, null]);
});

test('stillInParty / スタンダードは3戦目を見ない', () => {
  assert.equal(stillInParty(ids(...PARTY, 1), '1', 'proud'), true);
  assert.equal(stillInParty(ids(1, 2, 3, 4, 5, 6, 7), '7', 'standard'), false);
  const r = placeChar(ids(1, 2, 3, 4, 5, 6, 1, 2), 4, '1', 'standard');
  assert.deepEqual(r.ids.slice(0, 6), ['5', '2', '3', '4', '1', '6']);
  assert.equal(r.error, undefined);
  assert.deepEqual(placeChar(E, 0, '', 'proud').ids, E);
});
