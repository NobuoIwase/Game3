// 効果文言 → 内部表現の解決（DESIGN.md §1-3, §1-4, §2-1, §3-3）
//
// 方針:
//   1. effect_map の entries を完全一致で引く（最優先）
//   2. 外れたら §2-1 の規則（「基礎」で始まるか否か）＋ _stat_keywords でパースを試みる
//   3. それでも解決できない場合は「未対応」として呼び出し元に返す。
//      絶対に黙って 0 として扱わない（§1-4）。

import { STATS } from './calc.js';

/**
 * 効果1件を内部表現へ解決する。
 * entry は次のいずれかの形:
 *   { stat: "strike_atk", base: true, value: 110 }   … 構造化済み（そのまま検証して使う）
 *   { text: "基礎打撃攻撃力アップ", value: 110 }      … 文言。effect_map で解決する
 *
 * @returns {{ok:true, effect:{stat,base,value}} | {ok:false, reason:string, raw:object}}
 */
export function resolveEffect(entry, effectMap) {
  if (entry == null || typeof entry !== 'object') {
    return { ok: false, reason: '効果の形式が不正です', raw: entry };
  }
  const value = Number(entry.value);
  if (!Number.isFinite(value)) {
    return { ok: false, reason: '数値がありません', raw: entry };
  }

  // 構造化済みエントリ
  if (typeof entry.stat === 'string') {
    if (!STATS.includes(entry.stat)) {
      return { ok: false, reason: `未知のステータス種別「${entry.stat}」`, raw: entry };
    }
    return { ok: true, effect: { stat: entry.stat, base: entry.base === true, value } };
  }

  // 文言エントリ
  if (typeof entry.text === 'string') {
    const parsed = parseEffectText(entry.text, effectMap);
    if (parsed) {
      return { ok: true, effect: { ...parsed, value } };
    }
    return { ok: false, reason: `未対応の効果文言「${entry.text}」`, raw: entry };
  }

  return { ok: false, reason: '効果の形式が不正です（stat も text もありません）', raw: entry };
}

/**
 * 効果文言をパースする。解決できなければ null。
 * @returns {{stat:string, base:boolean} | null}
 */
export function parseEffectText(text, effectMap) {
  if (typeof text !== 'string' || !effectMap) return null;
  const t = text.trim();

  // 1. 完全一致（entries が正）
  const hit = effectMap.entries && effectMap.entries[t];
  if (hit && STATS.includes(hit.stat)) {
    return { stat: hit.stat, base: hit.base === true };
  }

  // 2. 規則パース: 「基礎」で始まるかが加算/乗算の唯一の判別基準（§2-1）
  //    「〜アップ」で終わる文言のみ対象。ダウン系・特殊効果は未対応として扱う。
  if (!t.endsWith('アップ')) return null;
  const base = t.startsWith('基礎');
  const body = base ? t.slice('基礎'.length) : t;
  const keywords = effectMap._stat_keywords || {};
  for (const [word, stat] of Object.entries(keywords)) {
    // 完全一致のみ。「気力回復速度アップ」を「気力回復」に誤ヒットさせない（§6 の未対応例）
    if (body === word + 'アップ' && STATS.includes(stat)) {
      return { stat, base };
    }
  }
  return null;
}

/**
 * フラグメント1個の effects を解決する。
 * @returns {{effects:Array<{stat,base,value}>, unknown:Array<{fragmentId,fragmentName,reason,raw}>}}
 */
export function resolveFragmentEffects(fragment, effectMap) {
  const effects = [];
  const unknown = [];
  for (const entry of fragment.effects || []) {
    const r = resolveEffect(entry, effectMap);
    if (r.ok) {
      effects.push(r.effect);
    } else {
      unknown.push({
        fragmentId: fragment.id,
        fragmentName: fragment.name || String(fragment.id),
        reason: r.reason,
        raw: r.raw,
      });
    }
  }
  return { effects, unknown };
}

/**
 * 複数フラグメントの補正合計を作る。
 * @param {Array<object>} fragments フラグメント定義の配列
 * @returns {{basePct:Object<string,number>, nonBasePct:Object<string,number>, unknown:Array}}
 *   basePct[stat]    … 基礎あり補正の合計（❷ に加算）
 *   nonBasePct[stat] … 基礎なし補正の合計（最後に乗算）
 */
export function sumFragmentEffects(fragments, effectMap) {
  const basePct = {};
  const nonBasePct = {};
  const unknown = [];
  for (const s of STATS) { basePct[s] = 0; nonBasePct[s] = 0; }
  for (const frag of fragments) {
    const r = resolveFragmentEffects(frag, effectMap);
    for (const e of r.effects) {
      if (e.base) basePct[e.stat] += e.value;
      else nonBasePct[e.stat] += e.value;
    }
    unknown.push(...r.unknown);
  }
  return { basePct, nonBasePct, unknown };
}
