// 編成の配置ルール（DESIGN.md §12-4 / §47）。DOM に依存しない純粋関数だけを置く。
//
// プラウドバトルは 1戦目・2戦目・3戦目 の各3体。
// - 1戦目と2戦目（枠0〜5）は同じキャラを選べない
// - 3戦目（枠6〜8）は 1・2戦目のキャラを **2体まで** 再選出できる（3体とも再選出は不可）
// - 3戦目の中で同じキャラは選べない
// スタンダードは枠0〜5（バトル3体＋ゼンカイ枠3体）で重複なし。枠6〜8は使わない。

export const PROUD_REUSE_MAX = 2;

const norm = (x) => (x === '' || x == null ? '' : String(x));

/** 3戦目のうち、1・2戦目にもいるキャラの数 */
export function reuseCount(ids) {
  const front = new Set(ids.slice(0, 6).map(norm).filter(Boolean));
  const third = new Set(ids.slice(6, 9).map(norm).filter(Boolean));
  let n = 0;
  for (const c of third) if (front.has(c)) n++;
  return n;
}

/**
 * キャラ cid を枠 slot に置いた後の並びを返す。
 * 同じグループ（スタンダード=枠0〜5 / プラウド=1・2戦目 or 3戦目）に既にいれば入れ替える。
 * プラウドで3戦目の再選出が上限を超える配置は拒否する。
 *
 * @param {Array<string>} ids  9枠のキャラID（空は ''）
 * @param {number} slot
 * @param {string} cid
 * @param {'standard'|'proud'} mode
 * @returns {{ids: Array<string>, error?: string, reused?: boolean}}
 */
export function placeChar(ids, slot, cid, mode) {
  const out = Array.from({ length: 9 }, (_, i) => norm(ids[i]));
  const sid = norm(cid);
  if (!sid) return { ids: out };
  // 入れ替えの対象範囲（同じ枠グループ内でだけ重複を禁止する）
  const [lo, hi] = mode === 'proud'
    ? (slot < 6 ? [0, 6] : [6, 9])
    : [0, 6];
  const j = out.findIndex((x, k) => k >= lo && k < hi && k !== slot && x === sid);
  if (j >= 0) out[j] = out[slot];
  out[slot] = sid;
  if (mode === 'proud') {
    const n = reuseCount(out);
    if (n > PROUD_REUSE_MAX) {
      return {
        ids: Array.from({ length: 9 }, (_, i) => norm(ids[i])),
        error: `3戦目に再選出できるのは1・2戦目のキャラ${PROUD_REUSE_MAX}体までです（3体とも再選出は不可）。`,
      };
    }
    const reused = slot >= 6
      ? out.slice(0, 6).includes(sid)
      : out.slice(6, 9).includes(sid);
    return { ids: out, reused };
  }
  return { ids: out };
}

/** そのキャラが今のモードの枠のどこかに残っているか（枠を空けたときに装備を消してよいかの判定） */
export function stillInParty(ids, cid, mode) {
  const n = mode === 'proud' ? 9 : 6;
  return ids.slice(0, n).some((x) => norm(x) === norm(cid));
}

/**
 * プラウドのチーム別リーダー [1戦目, 2戦目, 3戦目]（§47）。
 * 1戦目・2戦目は各チームの先頭枠（l1/l2 で上書き可 — 最適化のリーダー探索用）。
 * 3戦目のリーダー枠は固定で選べず、**1戦目のリーダー（左上）を3戦目に再選出したときだけ**
 * そのキャラがリーダーになる。選ばなければ3戦目はリーダー無し（null）。
 */
export function proudLeadersOf(ids, l1 = norm(ids[0]) || null, l2 = norm(ids[3]) || null) {
  const lead = l1 ? norm(l1) : '';
  const third = lead && ids.slice(6, 9).some((x) => norm(x) === lead) ? l1 : null;
  return [l1 || null, l2 || null, third];
}
