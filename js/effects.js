// 効果文言 → 内部表現の解決（DESIGN.md §1-3, §1-4, §2-1, §3-3）
//
// 方針:
//   1. effect_map の entries を完全一致で引く（最優先）
//   2. 外れたら §2-1 の規則（「基礎」で始まるか否か）＋ _stat_keywords でパースを試みる
//   3. それでも解決できない場合は「未対応」として呼び出し元に返す。
//      絶対に黙って 0 として扱わない（§1-4）。
//
// entries の値の形式（3種類）:
//   { "stat": "strike_atk", "base": true }            … 単一ステータス
//   { "stats": ["strike_atk","blast_atk"], "base": true } … 複合表記（打撃・射撃 等）
//   { "other": true }                                  … ステータス計算対象外と確認済みの効果
//                                                        （与ダメージ等。警告は出さないが計算にも入れない）

import { STATS } from './calc.js';

/**
 * 効果名の1成分（「打撃攻撃力」「クリティカル値」「被回復量」等）を解決する。
 * @returns {{stat:string} | {other:true} | null}
 */
function resolvePart(part, effectMap) {
  const keywords = effectMap._stat_keywords || {};
  const entries = effectMap.entries || {};
  let p = part.trim();
  if (p.startsWith('基礎')) p = p.slice('基礎'.length); // 成分ごとの「基礎」接頭辞（例: 基礎打撃攻撃力・基礎クリティカル値）
  if (keywords[p] && STATS.includes(keywords[p])) return { stat: keywords[p] };
  const e = entries[p] || entries[part.trim()];
  if (e && e.other === true) return { other: true };
  if (e && e.stat && STATS.includes(e.stat) && !e.stats) return { stat: e.stat };
  return null;
}

/**
 * 効果名（「基礎打撃攻撃力」「打撃・射撃攻撃力」「基礎射撃攻撃・打撃防御力」等）を解決する。
 * @returns {{stats:string[], base:boolean} | {other:true} | null}
 */
export function lookupEffectName(text, effectMap) {
  if (typeof text !== 'string' || !effectMap) return null;
  const t = text.trim();

  // 1. 完全一致（entries が正）
  const hit = (effectMap.entries || {})[t];
  if (hit) {
    if (hit.other === true) return { other: true };
    const stats = hit.stats || (hit.stat ? [hit.stat] : []);
    if (stats.length > 0 && stats.every((s) => STATS.includes(s))) {
      return { stats, base: hit.base === true };
    }
    return null; // entries の記述が壊れている → 未対応扱い
  }

  // 1.5 計算対象外のパターン（「特攻：○○」等。パターンもデータ側に置く — §1-3）
  for (const pat of effectMap._other_patterns || []) {
    try { if (new RegExp(pat).test(t)) return { other: true }; }
    catch { /* 不正なパターンは無視 */ }
  }

  // 2. 規則パース（§2-1: 「基礎」で始まるかが加算/乗算の唯一の判別基準）
  const base = t.startsWith('基礎');
  let body = base ? t.slice('基礎'.length) : t;
  if (body.endsWith('アップ')) body = body.slice(0, -'アップ'.length); // 旧表記「〜アップ」
  const keywords = effectMap._stat_keywords || {};

  // 単一成分。完全一致のみ（「気力回復速度」を「気力回復」に誤ヒットさせない — §6 の未対応例）
  if (keywords[body] && STATS.includes(keywords[body])) {
    return { stats: [keywords[body]], base };
  }

  // 複合表記「A・B」。表記の省略パターンを補完しながら成分ごとに解決する:
  //   打撃・射撃攻撃力     = 打撃[攻撃力] + 射撃攻撃力   （後成分の接尾語を前に配る）
  //   打撃攻撃・防御力     = 打撃攻撃[力] + [打撃]防御力 （前成分の種別を後に配る）
  //   射撃攻撃・打撃防御力 = 射撃攻撃[力] + 打撃防御力
  //   基礎打撃攻撃力・基礎クリティカル値 = そのまま2成分
  const mm = body.match(/^(.+?)・(.+)$/);
  if (mm) {
    const [a, b] = [mm[1], mm[2]];
    const sfx = (b.match(/(攻撃力|防御力)$/) || [])[1];
    const head = (a.match(/^(打撃|射撃)/) || [])[1];
    const candidates = [
      [a, b],
      [`${a}力`, b],
      sfx ? [a + sfx, b] : null,
      head && !/^(打撃|射撃)/.test(b) ? [a, head + b] : null,          // 射撃攻撃力・防御力
      head && !/^(打撃|射撃)/.test(b) ? [`${a}力`, head + b] : null,   // 打撃攻撃・防御力
      sfx && head && !/^(打撃|射撃)/.test(b) ? [a + sfx, head + b] : null,
    ].filter(Boolean);
    for (const parts of candidates) {
      const resolved = parts.map((p) => resolvePart(p, effectMap));
      if (resolved.every(Boolean)) {
        const stats = resolved.filter((r) => r.stat).map((r) => r.stat);
        if (stats.length === 0) return { other: true }; // 全成分が計算対象外
        return { stats, base };
      }
    }
  }
  return null;
}

/**
 * 効果1件を内部表現へ解決する。
 * entry は次のいずれかの形:
 *   { stat: "strike_atk", base: true, value: 110 } … 構造化済み（手入力・旧データ）
 *   { text: "基礎打撃攻撃力", value: 18 }           … 文言（取り込みデータ・effect_map で解決）
 * @returns {{ok:true, effects:Array<{stat,base,value}>, other:boolean} | {ok:false, reason:string, raw:object}}
 */
export function resolveEffect(entry, effectMap) {
  if (entry == null || typeof entry !== 'object') {
    return { ok: false, reason: '効果の形式が不正です', raw: entry };
  }
  const value = Number(entry.value);
  if (!Number.isFinite(value)) {
    return { ok: false, reason: '数値がありません', raw: entry };
  }
  if (typeof entry.stat === 'string') {
    if (!STATS.includes(entry.stat)) {
      return { ok: false, reason: `未知のステータス種別「${entry.stat}」`, raw: entry };
    }
    return { ok: true, effects: [{ stat: entry.stat, base: entry.base === true, value }], other: false };
  }
  if (typeof entry.text === 'string') {
    const hit = lookupEffectName(entry.text, effectMap);
    if (hit && hit.other) return { ok: true, effects: [], other: true };
    if (hit) {
      return { ok: true, effects: hit.stats.map((stat) => ({ stat, base: hit.base, value })), other: false };
    }
    return { ok: false, reason: `未対応の効果文言「${entry.text}」`, raw: entry };
  }
  return { ok: false, reason: '効果の形式が不正です（stat も text もありません）', raw: entry };
}

/**
 * 効果条件（「バトルメンバーに「タグ：X」がN人いると〜」）の判定。
 * @param {object} line 条件付き効果行（cond / cond_count / cond_exclude_self を持つ）
 * @param {object|null} context { selfId, members: [{id, tags, element}] }
 *   members はスコープ内のバトルメンバー（スタンダード=バトル3体 / プラウド=そのチーム3体）。
 *   context が無い場合（パーティ文脈の外での計算）は条件不成立として扱う。
 * @returns {boolean}
 */
/** 条件に一致するバトルメンバー数を数える。文脈が無ければ null */
export function fragmentConditionCount(line, context) {
  if (!context || !Array.isArray(context.members)) return null;
  let n = 0;
  for (const m of context.members) {
    if (line.cond_exclude_self && String(m.id) === String(context.selfId)) continue;
    if (conditionMatches(line.cond, m)) n++;
  }
  return n;
}

export function fragmentConditionSatisfied(line, context) {
  if (!line.cond) return true;
  const n = fragmentConditionCount(line, context);
  if (n == null) return false;
  return line.cond_per_member ? n > 0 : n >= (line.cond_count || 1);
}

/**
 * フラグメント1個のステータス効果を解決する。
 * 対応形式:
 *   v2: { slots: [{label, star7, lines:[{text,value[,cond]}|{raw}]}] } … 取り込みデータ。
 *       star7 スロットは stars>=7 のときだけ有効。raw 行（アビリティ文）は計算対象外。
 *       cond 付きの行は context（パーティ編成）で条件を満たすときだけ有効。
 *   v1: { effects: [{stat,base,value}|{text,value}] }           … 手入力・旧データ
 * @param {object} opts { stars: 装備キャラの限界突破数（既定 7）, context: 効果条件の判定文脈 }
 * @returns {{effects:Array, unknown:Array, others:Array<string>, conditionalOff:Array}}
 *   conditionalOff … 条件を満たしていない（または文脈が無い）ため適用しなかった条件付き効果
 */
export function fragmentStatEffects(fragment, effectMap, opts = {}) {
  const stars = opts.stars ?? 7;
  const effects = [];
  const unknown = [];
  const others = [];
  const conditionalOff = [];
  const push = (entry) => {
    const r = resolveEffect(entry, effectMap);
    if (r.ok) {
      effects.push(...r.effects);
      if (r.other && entry.text) others.push(entry.text);
    } else {
      unknown.push({
        fragmentId: fragment.id,
        fragmentName: fragment.name || String(fragment.id),
        reason: r.reason,
        raw: r.raw,
      });
    }
  };
  if (Array.isArray(fragment.slots)) {
    for (const slot of fragment.slots) {
      if (slot.star7 && stars < 7) continue;
      for (const line of slot.lines || []) {
        if (line.raw != null) continue; // アビリティ文（%値を持たない行）は計算対象外
        if (line.cond) {
          const n = fragmentConditionCount(line, opts.context);
          // 人数比例（1人につき〜ずつ）は該当人数を掛ける。通常条件は成立時に1倍
          const mult = line.cond_per_member
            ? (n || 0)
            : ((n != null && n >= (line.cond_count || 1)) ? 1 : 0);
          if (mult <= 0) {
            conditionalOff.push({ text: line.text, value: line.value, cond_raw: line.cond_raw });
            continue;
          }
          push({ text: line.text, value: line.value * mult });
          continue;
        }
        push(line);
      }
    }
  } else {
    for (const entry of fragment.effects || []) push(entry);
  }
  return { effects, unknown, others, conditionalOff };
}

/**
 * 複数フラグメントの補正合計を作る。
 * @returns {{basePct:Object<string,number>, nonBasePct:Object<string,number>, unknown:Array, others:Array<string>}}
 */
export function sumFragmentEffects(fragments, effectMap, opts = {}) {
  const basePct = {};
  const nonBasePct = {};
  const unknown = [];
  const others = [];
  for (const s of STATS) { basePct[s] = 0; nonBasePct[s] = 0; }
  for (const frag of fragments) {
    const r = fragmentStatEffects(frag, effectMap, opts);
    for (const e of r.effects) {
      if (e.base) basePct[e.stat] += e.value;
      else nonBasePct[e.stat] += e.value;
    }
    unknown.push(...r.unknown);
    others.push(...r.others);
  }
  return { basePct, nonBasePct, unknown, others };
}

/**
 * アビリティのグループ列（クローラの parseAbilityText 出力）を解決する。
 * @param {Array<{cond:Array<Array<object>>, effects:Array<{text,value}>, unresolved:string[]}>} groups
 * @returns {{groups:Array<{cond, effects:Array<{stat,base,value}>}>, unknown:Array<string>}}
 *   unknown には「%値を持つのに解決できなかった行」だけを入れる（説明文は含めない — §1-4 の警告対象を絞る）
 */
export function resolveAbilityGroups(groups, effectMap, sourceName = '') {
  const out = [];
  const unknown = [];
  for (const g of groups || []) {
    const effects = [];
    for (const ef of g.effects || []) {
      const r = resolveEffect(ef, effectMap);
      if (r.ok) effects.push(...r.effects);
      else unknown.push(`${sourceName}: ${r.reason}`);
    }
    for (const u of g.unresolved || []) {
      // 「基礎…%」らしき行が解決できていない場合のみ警告（説明行は無視）
      if (/基礎.*[\d.]+\s*[%％]/.test(u)) unknown.push(`${sourceName}: 未解析の行「${u}」`);
      if (u.startsWith('条件:')) unknown.push(`${sourceName}: 未解決の${u}`);
    }
    // フェイルセーフ（原則1-4）: 効果があるのに条件らしき行が未解析のままのグループは、
    // 「無条件＝全員に適用」と誤解釈せず、絶対に一致しない条件を付けて警告する。
    const CONDLIKE = /「(?:タグ|属性|エピソード|レアリティ|キャラクター|バトルスタイル)[:：]|【対象キャラクター】|\{\{ICN:/;
    let cond = g.cond || [];
    if (effects.length > 0 && cond.length === 0) {
      const suspect = (g.unresolved || []).find((u) => CONDLIKE.test(u));
      if (suspect) {
        unknown.push(`${sourceName}: 条件行が未解析のため適用しません「${suspect}」`);
        cond = [[{ name: '未解析条件' }]];
      }
    }
    out.push({ cond, effects, raw: g.raw });
  }
  return { groups: out, unknown };
}

/**
 * アビリティ条件（OR のリスト、各要素は AND トークン列）がキャラに一致するか。
 * token: {tag:<id>} | {element:"RED"} | {name:<未解決>}（未解決トークンは一致しない）
 * タッグキャラは2属性を持ちうる（elements 配列）。どちらの属性でも色限定効果が乗る。
 */
export function conditionMatches(cond, character) {
  if (!cond || cond.length === 0) return true;
  const tags = character.tags || [];
  const elements = (character.elements && character.elements.length
    ? character.elements
    : [character.element]).filter(Boolean).map((e) => String(e).toUpperCase());
  return cond.some((andTokens) => andTokens.every((tok) => {
    if (tok.tag != null) return tags.includes(tok.tag);
    if (tok.element) return elements.includes(tok.element);
    return false; // 未解決トークン
  }));
}
