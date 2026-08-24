// DESIGN.md §2-4 の検算用テストケース。
// 対象: 超サイヤ人4 孫悟空 (DBL81-04S) の打撃攻撃力。
// ❸ が小数第2位まで一致することを担保する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStat, marginalValues, baseStat, boostRatio } from '../js/calc.js';

const COMMON = {
  total: 273_617,
  boost: 42_080,
  z: 149,
  zenkai: 0,
  ll: 30,
};

// | ケース | 基礎あり | 基礎なし | ❷ | ❸(期待値) | ❺ | ❻ |
const CASES = [
  { name: '(1) 基礎あり+110% / 基礎なし0%',  fragBase: 110, fragNonBase: 0,  corr: 289, final: 942_758.93,   corr5: 307, frag6: 110 },
  { name: '(2) 基礎あり+60% / 基礎なし+30%', fragBase: 60,  fragNonBase: 30, corr: 239, final: 1_075_087.56, corr5: 364, frag6: 167 },
  { name: '(3) 基礎あり+15% / 基礎なし+40%', fragBase: 15,  fragNonBase: 40, corr: 194, final: 1_011_918.29, corr5: 337, frag6: 140 },
];

test('❶ 基本ステータス = 合計ステ − ブースト値', () => {
  assert.equal(baseStat(COMMON.total, COMMON.boost), 231_537);
});

test('❹ ブースト倍率 = 42,080 ÷ 231,537 = 0.18173…', () => {
  const ratio = boostRatio(231_537, 42_080);
  assert.ok(Math.abs(ratio - 0.18174) < 1e-5, `ratio=${ratio}`);
});

for (const c of CASES) {
  test(`検算ケース ${c.name}`, () => {
    const r = computeStat({ ...COMMON, fragBase: c.fragBase, fragNonBase: c.fragNonBase });
    assert.equal(r.base, 231_537, '❶');
    assert.equal(r.corr, c.corr, '❷');
    // ❸ は小数第2位まで一致（§2-4）
    assert.ok(Math.abs(r.final - c.final) < 0.005, `❸ expected=${c.final} actual=${r.final}`);
    // ❺ ❻ は「約」表記なので四捨五入で一致を確認
    assert.equal(Math.round(r.corr5), c.corr5, `❺ actual=${r.corr5}`);
    assert.equal(Math.round(r.fragTotal), c.frag6, `❻ actual=${r.fragTotal}`);
  });
}

test('❻ は基礎なし0%のとき基礎あり合計と厳密に一致する', () => {
  const r = computeStat({ ...COMMON, fragBase: 110, fragNonBase: 0 });
  assert.ok(Math.abs(r.fragTotal - 110) < 1e-9, `❻=${r.fragTotal}`);
});

test('§2-5 限界価値の比: ケース(2)では基礎なしが約2.75倍効率が良い', () => {
  // ❷（フラグメント込み 239%）と基礎なし 30% の状態での比
  const { basePlus1, nonBasePlus1 } = marginalValues({
    base: 231_537, boost: 42_080, corr: 239, nonBase: 30,
  });
  const ratio = nonBasePlus1 / basePlus1;
  // (3.39 × 231,537 + 42,080) ÷ (231,537 × 1.3) = 2.7475 ≒ 約2.75倍（DESIGN.md の記述と一致）
  const expected = (3.39 * 231_537 + 42_080) / (231_537 * 1.3);
  assert.ok(Math.abs(ratio - expected) < 1e-9, `ratio=${ratio}`);
  assert.ok(Math.abs(ratio - 2.75) < 0.005, `約2.75倍のはず: ${ratio}`);
});

test('境界: ❶=0 でも 0 除算にならない', () => {
  const r = computeStat({ total: 1000, boost: 1000, fragBase: 50 });
  assert.equal(r.base, 0);
  assert.equal(r.ratio, 0);
  assert.ok(Number.isFinite(r.final));
  assert.ok(Number.isFinite(r.corr5));
});
