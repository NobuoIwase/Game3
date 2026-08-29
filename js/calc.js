// ステータス計算エンジン（DESIGN.md §2）
// 純粋関数のみ。ブラウザ／Node 両方から import できるようにする。
//
// 用語（§2-1）:
//   合計ステ   … ゲームのステータス画面で左に出る数値（ブースト込み）
//   ブースト値 … 同画面で右に括弧付きで出る数値
//   基礎あり補正 … 効果名が「基礎」で始まる補正。加算プール（❷）に入る
//   基礎なし補正 … 「基礎」が付かない補正。最後に乗算される

/** 内部ステータスキー一覧（表示順） */
export const STATS = [
  'hp',
  'strike_atk',
  'blast_atk',
  'strike_def',
  'blast_def',
  'critical',
  'ki_recovery',
];

/** 表示名（表示専用。照合には絶対に使わない — DESIGN.md §1-2） */
export const STAT_LABELS = {
  hp: '体力',
  strike_atk: '打撃攻撃力',
  blast_atk: '射撃攻撃力',
  strike_def: '打撃防御力',
  blast_def: '射撃防御力',
  critical: 'クリティカル',
  ki_recovery: '気力回復',
  heal_received: '体力被回復量',
};

/**
 * 擬似ステータス（§25）: キャラの❶を持たない%効果（体力被回復量など）を最適化の
 * 評価対象にするための仮想ステータス。❶=PSEUDO_STAT_BASE の仮想キャラステとして
 * ❸式に乗せる（+1% = +1,000点）。percent プリセットの正規化定数 100000 と一致させて
 * あるので、%等価プリセットでも重みをそのまま使える。実キャラのステ表示には出さない。
 */
export const PSEUDO_STATS = ['heal_received'];
export const ALL_STATS = [...STATS, ...PSEUDO_STATS];
export const PSEUDO_STAT_BASE = 100000;

/** ❶ 基本ステータス = 合計ステ − ブースト値 */
export function baseStat(total, boost) {
  return total - boost;
}

/**
 * ❷ 基礎ステータス補正 (+%)
 *   = Zアビ合計 + ZENKAIアビ合計 + LLアビ合計 + フラグメント基礎あり合計
 */
export function baseCorrection({ z = 0, zenkai = 0, ll = 0, fragBase = 0 } = {}) {
  return z + zenkai + ll + fragBase;
}

/**
 * ❸ 最終ステータス ★最適化の目的関数
 *   = { (❷ × 0.01 + 1) × ❶ + ブースト値 } × ( 基礎なし合計 × 0.01 + 1 )
 */
export function finalStat({ base, boost, corr, nonBase = 0 }) {
  return ((corr * 0.01 + 1) * base + boost) * (nonBase * 0.01 + 1);
}

/** ❹ ブースト倍率 = ブースト値 ÷ ❶（❶=0 のときは 0 とする） */
export function boostRatio(base, boost) {
  return base === 0 ? 0 : boost / base;
}

/**
 * ❺ 最終ステータス補正 (+%) ※表示用
 *   = ( { ❷ × 0.01 + 1 + ❹ } × { 基礎なし合計 × 0.01 + 1 } − 1 ) × 100
 */
export function finalCorrectionPct({ corr, ratio, nonBase = 0 }) {
  return ((corr * 0.01 + 1 + ratio) * (nonBase * 0.01 + 1) - 1) * 100;
}

/**
 * ❻ 合計フラグメント補正 (+%) ※表示用
 *   = ❺ − (Zアビ + ZENKAIアビ + LLアビの合計) − (❹ × 100)
 * 基礎なし補正を「基礎あり相当」に換算した比較用の値。
 */
export function totalFragmentCorrectionPct({ corr5, abilitySum, ratio }) {
  return corr5 - abilitySum - ratio * 100;
}

/**
 * 1ステータス分の一括計算（§2-3 ❶〜❻）。
 *
 * @param {object} p
 * @param {number} p.total       合計ステ
 * @param {number} p.boost       ブースト値
 * @param {number} [p.z]         Zアビ補正合計（パーティ6体、%）
 * @param {number} [p.zenkai]    ZENKAIアビ補正合計（パーティ6体、%）
 * @param {number} [p.ll]        LLアビ補正合計（バトル3体、%）
 * @param {number} [p.fragBase]    フラグメント基礎あり補正合計（%）
 * @param {number} [p.fragNonBase] フラグメント基礎なし補正合計（%）
 * @param {number} [p.extNonBase]  アビリティ由来の基礎なし補正合計（%）。
 *   設計上 §2-3 の式には存在しない未検証の拡張で、通常は 0。
 *   基礎なしアビリティを入力した場合のみ乗算側に合流する（呼び出し側で警告を出すこと）。
 * @returns {object} { base:❶, corr:❷, final:❸, ratio:❹, corr5:❺, fragTotal:❻, ... }
 */
export function computeStat(p) {
  const {
    total, boost,
    z = 0, zenkai = 0, ll = 0,
    fragBase = 0, fragNonBase = 0, extNonBase = 0,
  } = p;
  const base = baseStat(total, boost);                       // ❶
  const corr = baseCorrection({ z, zenkai, ll, fragBase });  // ❷
  const nonBase = fragNonBase + extNonBase;
  const final = finalStat({ base, boost, corr, nonBase });   // ❸
  const ratio = boostRatio(base, boost);                     // ❹
  const corr5 = finalCorrectionPct({ corr, ratio, nonBase }); // ❺
  const abilitySum = z + zenkai + ll;
  const fragTotal = totalFragmentCorrectionPct({ corr5, abilitySum, ratio }); // ❻
  return { base, corr, nonBase, final, ratio, corr5, fragTotal, abilitySum };
}

/**
 * §2-5 の限界価値（参考表示用）。
 * 固定の優先ルールには決して使わない（必ず ❸ を直接比較する）。
 */
export function marginalValues({ base, boost, corr, nonBase = 0 }) {
  const basePlus1 = 0.01 * base * (1 + nonBase / 100);
  const nonBasePlus1 = 0.01 * ((corr * 0.01 + 1) * base + boost);
  return { basePlus1, nonBasePlus1 };
}
