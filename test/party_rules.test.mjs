// 編成の配置ルール（§47: プラウド3戦目の再選出）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeChar, reuseCount, stillInParty, PROUD_REUSE_MAX, proudLeadersOf } from '../js/party_rules.js';

const E = ['', '', '', '', '', '', '', '', ''];
const ids = (...xs) => Array.from({ length: 9 }, (_, i) => (xs[i] == null ? '' : String(xs[i])));

test('§47 再選出は2体まで', () => {
  assert.equal(PROUD_REUSE_MAX, 2);
  const base = ids(1, 2, 3, 4, 5, 6);
  let r = placeChar(base, 6, '1', 'proud');
  assert.equal(r.error, undefined);
  assert.equal(r.reused, true);
  r = placeChar(r.ids, 7, '4', 'proud');
  assert.equal(r.error, undefined);
  assert.equal(reuseCount(r.ids), 2);
  const before = r.ids.slice();
  r = placeChar(r.ids, 8, '5', 'proud');
  assert.match(r.error, /2体まで/);
  assert.deepEqual(r.ids, before, '拒否したら元のまま');
  // 新キャラなら3体目も置ける
  r = placeChar(before, 8, '9', 'proud');
  assert.equal(r.error, undefined);
  assert.equal(r.reused, false);
  assert.deepEqual(r.ids, ids(1, 2, 3, 4, 5, 6, 1, 4, 9));
});

test('§47 1・2戦目の中では重複禁止（入れ替え）、3戦目とは別グループ', () => {
  const base = ids(1, 2, 3, 4, 5, 6, 1);
  // 2戦目の枠に1を置く → 1戦目の1と入れ替え（1・2戦目は重複禁止）
  let r = placeChar(base, 3, '1', 'proud');
  assert.deepEqual(r.ids.slice(0, 6), ['4', '2', '3', '1', '5', '6']);
  assert.equal(r.ids[6], '1', '3戦目の再選出はそのまま');
  // 3戦目の中で同じキャラを別枠に置く → 3戦目の中で入れ替え
  r = placeChar(ids(1, 2, 3, 4, 5, 6, 7, 8), 8, '7', 'proud');
  assert.deepEqual(r.ids.slice(6), ['', '8', '7']);
});

test('§47 1・2戦目に置いた結果、3戦目の再選出が3体になるなら拒否', () => {
  const base = ids(1, 2, 3, 4, 5, 6, 1, 4, 9);   // 再選出2体（1,4）+ 新キャラ9
  const r = placeChar(base, 5, '9', 'proud');     // 9を2戦目に → 3戦目が全員再選出
  assert.match(r.error, /2体まで/);
});

test('スタンダードは枠0〜5で重複なし、3戦目の枠は関係しない', () => {
  const base = ids(1, 2, 3, 4, 5, 6, 1, 2);
  const r = placeChar(base, 4, '1', 'standard');
  assert.deepEqual(r.ids.slice(0, 6), ['5', '2', '3', '4', '1', '6']);
  assert.equal(r.error, undefined);
});

test('stillInParty: 再選出キャラは片方の枠を空けても装備を残す', () => {
  const after = ids(1, 2, 3, 4, 5, 6, '', 4);   // 枠6の1を外した後
  assert.equal(stillInParty(after, '4', 'proud'), true);
  assert.equal(stillInParty(after, '9', 'proud'), false);
  assert.equal(stillInParty(ids(1, 2, 3, 4, 5, 6, 7), '7', 'standard'), false, 'スタンダードは3戦目を見ない');
  assert.deepEqual(placeChar(E, 0, '', 'proud').ids, E);
});

test('§47 3戦目のリーダーは「1戦目のリーダー（左上）を再選出したときだけ」', () => {
  // 1戦目リーダー=1 を3戦目に再選出 → 3戦目のリーダーも1（3戦目の先頭枠かどうかは関係ない）
  assert.deepEqual(proudLeadersOf(ids(1, 2, 3, 4, 5, 6, 9, 1, 7)), ['1', '4', '1']);
  // 3戦目の先頭枠に1戦目の別キャラ（2）を置いてもリーダーにはならない
  assert.deepEqual(proudLeadersOf(ids(1, 2, 3, 4, 5, 6, 2, 8, 9)), ['1', '4', null]);
  // 2戦目のリーダー（4）を再選出しても3戦目のリーダーにはならない（左上だけ）
  assert.deepEqual(proudLeadersOf(ids(1, 2, 3, 4, 5, 6, 4, 8, 9)), ['1', '4', null]);
  // リーダー探索で1戦目のリーダーを差し替えると、3戦目もそれに従う
  assert.deepEqual(proudLeadersOf(ids(1, 2, 3, 4, 5, 6, 2, 8, 9), '2', '5'), ['2', '5', '2']);
  // 1戦目が空ならどこにもリーダーはいない
  assert.deepEqual(proudLeadersOf(ids('', '', '', 4, 5, 6, 7, 8, 9)), [null, '4', null]);
});
