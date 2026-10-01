// 編成の配置ルール（DESIGN.md §12-4 / §47 / §48）。DOM に依存しない純粋関数だけを置く。
//
// プラウドバトル（ユーザー確認済み — §48）:
// - パーティは6体（1戦目=枠0〜2 / 2戦目=枠3〜5）。1戦目と2戦目は同じキャラを選べない
// - 3戦目（枠6〜8）は「1戦目と2戦目のキャラ（パーティの6体）から、各戦2体まで編成できる3体での戦い」。
//   6体の外からは選べない。1戦目だけ・2戦目だけで3体は組めない
// - リーダーは常に1体、左上（枠0）のみ。2戦目の先頭はリーダーではない。
//   3戦目は左上のキャラを選んだときだけリーダー付き
// スタンダードは枠0〜5（バトル3体＋ゼンカイ枠3体）で重複なし。枠6〜8は使わない。

export const PROUD_PER_TEAM_MAX = 2;
const TEAM_NAMES = ['1戦目', '2戦目'];

const norm = (x) => (x === '' || x == null ? '' : String(x));
const copy9 = (ids) => Array.from({ length: 9 }, (_, i) => norm(ids[i]));

/** パーティ6体の中での所属（0=1戦目 / 1=2戦目 / -1=6体の外） */
function originOf(ids, cid) {
  const j = ids.slice(0, 6).indexOf(norm(cid));
  return j < 0 ? -1 : (j < 3 ? 0 : 1);
}

/** 3戦目にいる [1戦目のキャラ数, 2戦目のキャラ数] */
export function thirdTeamCounts(ids) {
  const out = copy9(ids);
  const per = [0, 0];
  for (const c of out.slice(6, 9)) {
    const t = c ? originOf(out, c) : -1;
    if (t >= 0) per[t]++;
  }
  return per;
}

/**
 * 3戦目をルールに合わせて正す。6体の外のキャラ・3戦目内の重複・各戦2体を超えた分を
 * 左から順に見て空ける。1・2戦目の編集後と、旧ルールで保存されたデータの読み込み時に使う。
 * @returns {{ids: Array<string>, cleared: Array<string>}}
 */
export function sanitizeThird(ids) {
  const out = copy9(ids);
  const seen = new Set();
  const per = [0, 0];
  const cleared = [];
  for (let k = 6; k < 9; k++) {
    const c = out[k];
    if (!c) continue;
    const t = originOf(out, c);
    if (t < 0 || seen.has(c) || per[t] >= PROUD_PER_TEAM_MAX) {
      cleared.push(c);
      out[k] = '';
      continue;
    }
    seen.add(c);
    per[t]++;
  }
  return { ids: out, cleared };
}

/**
 * キャラ cid を枠 slot に置いた後の並びを返す。
 * - 1・2戦目（スタンダードは枠0〜5）: 既にいれば入れ替え。プラウドなら3戦目を正し、空けたキャラを cleared で返す
 * - 3戦目: パーティの6体からのみ。3戦目の中に既にいれば入れ替え。各戦2体まで
 * @returns {{ids: Array<string>, error?: string, cleared?: Array<string>}}
 */
export function placeChar(ids, slot, cid, mode) {
  const orig = copy9(ids);
  const out = copy9(ids);
  const sid = norm(cid);
  if (!sid) return { ids: out };
  if (mode === 'proud' && slot >= 6) {
    const t = originOf(out, sid);
    if (t < 0) return { ids: orig, error: '3戦目は1戦目・2戦目のパーティ6体から選んでください。' };
    const k = out.findIndex((x, i) => i >= 6 && i < 9 && i !== slot && x === sid);
    if (k >= 0) out[k] = out[slot];
    out[slot] = sid;
    if (thirdTeamCounts(out)[t] > PROUD_PER_TEAM_MAX) {
      return {
        ids: orig,
        error: `3戦目に入れられる${TEAM_NAMES[t]}のキャラは${PROUD_PER_TEAM_MAX}体までです`
          + '（1戦目と2戦目から合わせて3体。同じ戦のキャラだけで3体は組めません）。',
      };
    }
    return { ids: out };
  }
  const j = out.findIndex((x, k) => k < 6 && k !== slot && x === sid);
  if (j >= 0) out[j] = out[slot];
  out[slot] = sid;
  if (mode === 'proud') return sanitizeThird(out);
  return { ids: out };
}

/** そのキャラが今のモードの枠のどこかに残っているか（枠を空けたときに装備を消してよいかの判定） */
export function stillInParty(ids, cid, mode) {
  const n = mode === 'proud' ? 9 : 6;
  return ids.slice(0, n).some((x) => norm(x) === norm(cid));
}

/**
 * プラウドのチーム別リーダー [1戦目, 2戦目, 3戦目]（§48）。
 * リーダーは常に1体・左上のみ（l1 で上書き可 — 最適化のリーダー探索用）。
 * 2戦目はリーダー無し。3戦目は左上のキャラを選んだときだけそのキャラがリーダー。
 */
export function proudLeadersOf(ids, l1 = norm(ids[0]) || null) {
  const lead = l1 ? norm(l1) : '';
  const third = lead && ids.slice(6, 9).some((x) => norm(x) === lead) ? l1 : null;
  return [l1 || null, null, third];
}
