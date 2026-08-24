// 効果文言の解決（DESIGN.md §1-3, §1-4, §2-1）のテスト。
// 最重要: 未知の効果は絶対に黙って 0 として扱わない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveEffect, parseEffectText, sumFragmentEffects } from '../js/effects.js';

const effectMap = JSON.parse(
  readFileSync(new URL('../game_data/effect_map.json', import.meta.url), 'utf8')
);

test('entries の完全一致で解決できる', () => {
  const r = resolveEffect({ text: '基礎打撃攻撃力アップ', value: 110 }, effectMap);
  assert.deepEqual(r, { ok: true, effect: { stat: 'strike_atk', base: true, value: 110 } });
  const r2 = resolveEffect({ text: '打撃攻撃力アップ', value: 20 }, effectMap);
  assert.equal(r2.effect.base, false);
});

test('§2-1 規則パース: 「基礎」で始まるかが加算/乗算の唯一の判別基準', () => {
  // entries を空にして規則パースだけを検証する
  const ruleOnly = { entries: {}, _stat_keywords: effectMap._stat_keywords };
  assert.deepEqual(parseEffectText('基礎射撃防御力アップ', ruleOnly), { stat: 'blast_def', base: true });
  assert.deepEqual(parseEffectText('射撃防御力アップ', ruleOnly), { stat: 'blast_def', base: false });
  assert.deepEqual(parseEffectText('基礎体力アップ', ruleOnly), { stat: 'hp', base: true });
});

test('未知の効果文言は未対応として返る（黙って0にしない — §1-4）', () => {
  const r = resolveEffect({ text: '基礎必殺技与ダメージアップ', value: 10 }, effectMap);
  assert.equal(r.ok, false);
  assert.match(r.reason, /未対応の効果文言/);
});

test('「アップ」で終わらない文言（ダウン系など）は規則パースしない', () => {
  assert.equal(parseEffectText('打撃攻撃力ダウン', effectMap), null);
});

test('構造化エントリの未知ステータス種別は未対応として返る', () => {
  const r = resolveEffect({ stat: 'sp_atk', base: true, value: 10 }, effectMap);
  assert.equal(r.ok, false);
  assert.match(r.reason, /未知のステータス種別/);
});

test('sumFragmentEffects: 合算と未対応リストの分離', () => {
  const frags = [
    {
      id: 1, name: 'A',
      effects: [
        { stat: 'strike_atk', base: true, value: 110 },
        { stat: 'strike_def', base: false, value: 20 },
      ],
    },
    {
      id: 2, name: 'B',
      effects: [
        { text: '基礎打撃攻撃力アップ', value: 30 },
        { text: '気力回復速度アップ', value: 5 }, // §6 の未対応例。「気力回復」に誤ヒットさせない
      ],
    },
  ];
  const r = sumFragmentEffects(frags, effectMap);
  assert.equal(r.basePct.strike_atk, 140);
  assert.equal(r.nonBasePct.strike_def, 20);
  // 「気力回復速度アップ」は既知の「気力回復アップ」とは別効果 → 未対応リストへ
  assert.equal(r.nonBasePct.ki_recovery, 0);
  assert.equal(r.unknown.length, 1);
  assert.match(r.unknown[0].reason, /気力回復速度アップ/);
});

test('sumFragmentEffects: 本当に未知の効果は unknown に積まれ、数値は加算されない', () => {
  const frags = [
    { id: 3, name: 'C', effects: [{ text: '会心威力アップ', value: 25 }] },
  ];
  const r = sumFragmentEffects(frags, effectMap);
  assert.equal(r.unknown.length, 1);
  assert.equal(r.unknown[0].fragmentName, 'C');
  const total = Object.values(r.basePct).reduce((a, b) => a + b, 0)
    + Object.values(r.nonBasePct).reduce((a, b) => a + b, 0);
  assert.equal(total, 0);
});

test('数値が無い効果は未対応として返る', () => {
  const r = resolveEffect({ text: '基礎打撃攻撃力アップ' }, effectMap);
  assert.equal(r.ok, false);
});
