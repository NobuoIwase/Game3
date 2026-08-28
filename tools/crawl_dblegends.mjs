// 参照サイト（jp.dblegends.net）から全キャラ・全装備（フラグメント）を取得するクローラ。
// DESIGN.md §5 の方針: 個人利用・リクエスト間隔を空ける・レジューム可能・失敗はHTMLを保存して報告。
//
// 使い方:
//   node tools/crawl_dblegends.mjs           # 一覧＋未取得ページを取得（レジューム）
//   node tools/crawl_dblegends.mjs --merge   # 取得済みキャッシュから game_data/*.json を再生成のみ
//
// 出力:
//   game_data/crawl/char/<id>.json   … キャラ1体の解析結果（キャッシュ）
//   game_data/crawl/equip/<id>.json  … 装備1個の解析結果（キャッシュ）
//   game_data/crawl/failed/          … 解析失敗ページの生HTML（原因調査用）
//   game_data/characters.json        … マージ済みキャラデータ（アプリが読む）
//   game_data/fragments.json         … マージ済み装備データ（アプリが読む）
//   game_data/tags.json              … タグID→日本語名
//   game_data/effect_lines_report.json … 効果行の頻度レポート（effect_map 整備用）
//
// 注意: 画像はダウンロードしない。URLのみを保存し、表示時に参照する（公開リポジトリに
// ゲームアートを同梱しないため）。

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.DBL_BASE || 'https://jp.dblegends.net';
const DELAY_MS = Number(process.env.DBL_DELAY_MS || 2500);
const CRAWL = join(ROOT, 'game_data', 'crawl');
const UA = 'personal-fragment-tool/1.0 (individual use)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastFetch = 0;
async function politeFetch(path) {
  const wait = lastFetch + DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetch = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(BASE + path, { headers: { 'User-Agent': UA } });
      if (res.status === 404) return { status: 404, html: null };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, html: await res.text() };
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(10000 * (attempt + 1));
    }
  }
}

// ---------------------------------------------------------------- 汎用パース

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function scriptJSON(html, id) {
  const re = new RegExp(`<script id="${id}"\\s+type="application/json">`);
  const m = html.match(re);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = html.indexOf('</script>', start);
  if (end < 0) return null;
  try { return JSON.parse(html.slice(start, end)); }
  catch { return null; }
}

/**
 * 効果行を {text, value} か {raw} に分類する。
 * 値付き行の形式は2種類（値は最大値を採用する — DESIGN.md §3-2）:
 *   「<名前> +<値>%」            … プラチナ・覚醒系の固定値
 *   「<名前> <最小>% ~ <最大>%」 … 通常装備のレンジ表記
 */
export function classifyLine(line) {
  const t = line.trim();
  if (!t) return null;
  let m = t.match(/^(.+?)\s*([+-]?[\d.]+)\s*[%％]\s*[~〜～]\s*\+?(-?[\d.]+)\s*[%％]$/);
  if (m) return { text: m[1].trim(), value: Number(m[3]), value_min: Number(m[2]) };
  m = t.match(/^(.+?)\s*\+\s*([\d.]+)\s*[%％]$/);
  if (m) return { text: m[1].trim(), value: Number(m[2]) };
  return { raw: t };
}

const ELEMENT_CODES = ['RED', 'YEL', 'PUR', 'GRN', 'BLU', 'LGT', 'DRK'];

/**
 * インライン条件（ZENKAIアビ等の形式）を解析する。
 *   「タグ：未来」または「エピソード：劇場版編」かつ「属性：BLU」…
 * 「または」= OR、「かつ」= AND。属性・レアリティ・エピソード・キャラクターも
 * すべてタグ体系に含まれる（例: BLU=15004, HERO=12000, ベジット=50073）ため、
 * 名前をタグIDへ解決する。
 * @returns {Array<Array<object>>} cond（ORリスト。各要素はANDトークン列）
 */
function parseInlineConditions(condText, tagNameToId, unresolved) {
  const token = (part) => {
    const m = part.match(/「(?:タグ|エピソード|属性|レアリティ|キャラクター|バトルスタイル)[:：]([^」]+)」/);
    if (!m) return null;
    const name = m[1].trim();
    // 「キャラクター：孫悟空(DBL16-01S)」のような括弧付きは、括弧内のカード番号タグ →
    // 括弧を除いた名前タグ の順でフォールバックする
    const paren = (name.match(/[（(]([^）)]+)[）)]$/) || [])[1];
    const bare = name.replace(/[（(][^）)]*[）)]$/, '').trim();
    const id = tagNameToId[name] ?? tagNameToId[name.normalize('NFKC')]
      ?? (paren ? tagNameToId[paren] ?? tagNameToId[paren.normalize('NFKC')] : undefined)
      ?? (bare !== name ? tagNameToId[bare] ?? tagNameToId[bare.normalize('NFKC')] : undefined);
    if (id != null) return { tag: Number(id), name };
    unresolved.push(`条件:${name}`);
    return { name };
  };
  const cond = [];
  for (const orPart of condText.split('または')) {
    const andTokens = orPart.split('かつ').map(token).filter(Boolean);
    if (andTokens.length) cond.push(andTokens);
  }
  return cond;
}

/**
 * アビリティ文言（Zアビ/出撃Zアビ/ZENKAIアビ）を条件グループに分解する。
 * 形式:
 *   {{ICN:ChaTag}}タグA or {{ICN:ChaTag}}タグB\r\n○基礎打撃攻撃力22%{{ICN:UpBlue}}\r\n...
 *   {{ICN:RED}} & {{ICN:ChaTag}}DAIMA\r\n○...   … 属性 AND タグ の複合条件
 *   グループ間は空行区切り。出撃Zアビは「・基礎打撃攻撃力を3%アップ」形式。
 *
 * cond は OR のリスト。各要素は AND のトークン列:
 *   token = {tag:<id>, name} | {element:"RED"} | {name:<未解決名>}
 * @returns {Array<{cond:Array<Array<object>>, unresolved:string[], effects:Array<{text,value}>, raw:string}>}
 */
/**
 * ULTRAアビリティ本文から参照タグを抽出する。
 * 「タグ：X」形式と {{ICN:ChaTag}}X / {{ICN:Epi}}X 形式の両方に対応。
 * 「…に対する」や「敵…に」の文脈は敵対象（編成条件ではない）なので enemy フラグを付ける。
 */
export function extractUltraRefs(atext, tagNameToId) {
  const refTags = [];
  const refRe = /「(?:タグ|エピソード|キャラクター)：([^」]+)」(に対する)?|\{\{ICN:(?:ChaTag|Epi)\}\}([^\s、。（()]+)/g;
  for (const m of String(atext || '').matchAll(refRe)) {
    const nm = (m[1] || m[3] || '').trim();
    if (!nm) continue;
    const before = String(atext).slice(Math.max(0, m.index - 30), m.index);
    const enemy = m[2] != null || /敵[^\r\n]*$/.test(before);
    if (!refTags.some((r) => r.name === nm)) {
      const tid = tagNameToId[nm] ?? tagNameToId[nm.normalize('NFKC')];
      refTags.push({ name: nm, tag: tid != null ? Number(tid) : null, enemy });
    }
  }
  return refTags;
}

export function parseAbilityText(text, tagNameToId) {
  const iconRe = /\{\{ICN:([^}]+)\}\}/;
  // 条件行の目印になるアイコン: タグ・属性のほか、エピソード(Epi)・キャラクター(Chara)単独の
  // 条件行も存在する（例: ターレスのZアビ「{{ICN:Epi}}劇場版編」）。名前はタグ体系で解決できる
  const isConditionLine = (line) => {
    const tokens = line.match(/\{\{ICN:[^}]+\}\}/g) || [];
    return tokens.some((t) => {
      const icn = t.match(iconRe)[1];
      return icn === 'ChaTag' || icn === 'Epi' || icn === 'Chara' || ELEMENT_CODES.includes(icn);
    });
  };
  const groups = [];
  for (const block of String(text).split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const g = { cond: [], unresolved: [], effects: [], raw: block };
    for (const line of lines) {
      // 「(バトル時、)「属性：X」かつ「タグ：Y」の以下のステータスをアップ」
      // = ブロック全体の対象条件。後続の箇条書き効果すべてに掛かる
      const header = line.match(/^(?:バトル時、)?((?:「[^」]+」(?:かつ|または)?)+)の以下のステータスを.*アップ/);
      if (header) {
        for (const tokens of parseInlineConditions(header[1], tagNameToId, g.unresolved)) g.cond.push(tokens);
        continue;
      }
      if (isConditionLine(line)) {
        for (const orPart of line.split(/\s+or\s+/)) {
          const andTokens = [];
          for (const andPart of orPart.split(/\s*&\s*/)) {
            const icn = (andPart.match(iconRe) || [])[1] || '';
            const name = andPart.replace(/\{\{ICN:[^}]+\}\}/g, '').trim();
            if (ELEMENT_CODES.includes(icn) && !name) {
              andTokens.push({ element: icn });
            } else if (name) {
              const id = tagNameToId[name] ?? tagNameToId[name.normalize('NFKC')];
              if (id != null) andTokens.push({ tag: Number(id), name });
              else { andTokens.push({ name }); g.unresolved.push(`条件:${name}`); }
            }
          }
          if (andTokens.length) g.cond.push(andTokens);
        }
        continue;
      }
      const body = line
        .replace(/\{\{ICN:[^}]+\}\}/g, '')
        .replace(/^[○・]\s*/, '')
        .trim();
      if (!body) continue;

      // 1行に複数の効果が「&」で連結されることがある（例: ZENKAIアビIII/IV）。
      // 各節の形式: [バトル時、][「タグ：X」または「…」かつ「…」の]<効果名>[を]<値>%[アップ][する]
      const clauseRe = /^(?:バトル時、)?((?:「[^」]+」(?:または|かつ)?)*)の?(.+?)[をが]?\s*\+?([\d.]+)\s*[%％](?:アップ)?(?:する)?$/;
      const clauses = body.split('&').map((s) => s.trim()).filter(Boolean);
      const parsed = clauses.map((c) => {
        const m = c.match(clauseRe);
        if (!m || m[2].includes('「')) return null;
        return { clause: c, condText: m[1] || '', text: m[2].trim(), value: Number(m[3]) };
      });
      // 解析できた節だけ採用し、できなかった節（%を持たないダウン系等）は unresolved に残す
      if (parsed.some(Boolean)) {
        // 「&」連結の後続節は直前の節の条件を引き継ぐ（実機では条件が文全体に掛かる。
        //  例:「「タグ：X」の基礎体力最大値をN%アップ&基礎クリティカル値をN%アップ」は両方X限定）
        let lastCond = null;
        let lastCondUnresolved = [];
        parsed.forEach((p, i) => {
          if (!p) { g.unresolved.push(clauses[i]); return; }
          if (p.condText) {
            // 条件付きの節は独立グループにする
            const unresolved = [];
            const cond = parseInlineConditions(p.condText, tagNameToId, unresolved);
            lastCond = cond;
            lastCondUnresolved = unresolved;
            groups.push({ cond, unresolved, effects: [{ text: p.text, value: p.value }], raw: body });
          } else if (lastCond) {
            groups.push({ cond: lastCond, unresolved: [...lastCondUnresolved], effects: [{ text: p.text, value: p.value }], raw: body });
          } else {
            g.effects.push({ text: p.text, value: p.value });
          }
        });
        continue;
      }
      // ICNトークンを含む行はアイコンを剥がさず原文で残す。
      // 未知の条件アイコンだった場合に、フェイルセーフ（effects.js）が検知できるようにするため
      g.unresolved.push(/\{\{ICN:/.test(line) ? line : body);
    }
    if (g.effects.length > 0 || g.cond.length > 0 || g.unresolved.length > 0) groups.push(g);
  }
  // 【対象キャラクター】ブロック: 条件だけを列挙する形式。
  //   ・「属性：PUR」かつ「タグ：孫一族」 … 各行が AND 節
  //   または                             … 行間の「または」が OR
  // この条件を、同一アビリティ内の無条件の効果グループすべてに適用する。
  const targetIdx = groups.findIndex((g) => g.raw.includes('【対象キャラクター】'));
  if (targetIdx >= 0) {
    const tg = groups[targetIdx];
    const cond = [];
    const unresolved = [];
    for (const line of tg.raw.split(/\r?\n/)) {
      const t = line.trim().replace(/^・\s*/, '');
      if (!t || t === 'または' || t.startsWith('【')) continue;
      for (const tokens of parseInlineConditions(t, tagNameToId, unresolved)) cond.push(tokens);
    }
    if (cond.length) {
      groups.splice(targetIdx, 1);
      for (const g of groups) {
        if (g.cond.length === 0 && g.effects.length > 0) g.cond = cond;
      }
      if (unresolved.length) groups.push({ cond: [], unresolved, effects: [], raw: tg.raw });
    }
  }
  return groups;
}

// ---------------------------------------------------------------- キャラページ

export function parseCharacterPage(html, id) {
  const data = scriptJSON(html, 'data');
  const ab = scriptJSON(html, 'ab') || {};
  const tr = scriptJSON(html, 'tr') || {};
  const eq = scriptJSON(html, 'eq') || [];
  const ac = scriptJSON(html, 'ac') || {};
  const d = data && data[String(id)];
  if (!d) throw new Error('script#data にキャラ情報がありません');

  // 所持アーツ（デッキ構成の提案に使う）。script#ac: id → [名前, 説明, 種別コード, アイコン群]
  // 種別は名前の接頭辞（打撃/射撃/必殺/特殊/究極/覚醒）から取り、コードも参考として保存する
  const arts = (d.ac || []).map((aid) => {
    const entry = ac[String(aid)];
    const name = entry ? entry[0] : '';
    const typeMatch = String(name).match(/^(打撃|射撃|必殺|特殊|究極|覚醒)/);
    return {
      id: aid,
      name,
      type: typeMatch ? typeMatch[1] : '不明',
      type_code: entry && typeof entry[2] === 'number' ? entry[2] : null,
    };
  });

  const tagNameToId = {};
  for (const [tid, arr] of Object.entries(tr)) tagNameToId[arr[0]] = Number(tid);

  const abilityTexts = (ids) => (ids || [])
    .filter((aid) => aid != null && aid !== -1 && ab[String(aid)])
    .map((aid) => {
      const [name, text] = ab[String(aid)];
      return { id: aid, name, text, groups: parseAbilityText(text, tagNameToId) };
    });

  const st = (o, keys) => Object.fromEntries(
    [['hp', 'hp'], ['strike_atk', 'sa'], ['blast_atk', 'ba'], ['strike_def', 'sd'], ['blast_def', 'bd'],
     ['critical', 'cri'], ['ki_recovery', 'ki_rec']]
      .map(([our, site]) => [our, Number((o || {})[site]) || 0])
  );

  return {
    id: Number(id),
    name: d.name,
    card_no: d.card || '',
    rarity: d.rarity || '',
    ll: d.ll === 1,
    element: d.el || '',
    image: d.img ? `/assets/card_icons/BChaIco_${d.img}.webp` : '',
    tags: (d.tg || []).map((t) => Number(t[2])).filter(Number.isFinite),
    tag_names: tr,
    stats: st(d.max),        // Lv5000 の基本ステータス（ブースト除く想定 → ❶ に相当）
    soul_max: st(d.soul),    // ソウルブースト最大値（ブースト値の既定値に使う）
    z_ability: abilityTexts((d.ab || {}).z),        // ZアビリティI〜IV
    deploy_z_ability: abilityTexts((d.ab || {}).llz), // 出撃ZアビリティI〜IV
    zenkai_ability: abilityTexts((d.ab || {}).p),   // ZENKAI系（無ければ空）
    // ULTRAアビリティ（レアリティULTRAのみ）。d.ab.u: [[?,?,アビリティID,?],...]
    // 効果は与ダメージ等の戦闘効果でステータス式(❸)には乗らないため、
    // 原文と参照タグ（リーダー/同タグ編成判断の表示用）のみ保存する
    ultra_ability: (() => {
      const list = ((d.ab || {}).u || [])
        .map((entry) => (Array.isArray(entry) ? entry[2] : entry))
        .filter((aid) => aid != null && aid !== -1 && ab[String(aid)])
        .map((aid) => {
          const [name, atext] = ab[String(aid)];
          return { id: aid, name: String(name || ''), text: String(atext || ''), ref_tags: extractUltraRefs(atext, tagNameToId) };
        })
        .filter((u) => u.name.trim() || u.text.trim()); // ab表の空エントリを除外
      // レベル違いの同名エントリはテーブル上重複する → 最後（最高レベル）だけ残す
      const byName = new Map();
      for (const u of list) byName.set(u.name || String(u.id), u);
      return [...byName.values()];
    })(),
    equip_ids: eq.map((e) => Number(e[0])).filter(Number.isFinite),
    arts,
  };
}

// ---------------------------------------------------------------- 装備ページ

export function parseEquipPage(html, id) {
  const name = (html.match(/class="eqd-name">([^<]+)</) || [])[1];
  if (!name) throw new Error('eqd-name が見つかりません');
  const rarity = (html.match(/eqx-frame\s+([\w-]+)/) || [])[1] || '';
  const detail = (html.match(/class="eqd-detail">(.*?)<\/div>/s) || [])[1] || '';
  const rarityLabel = decodeEntities(detail.split(/<br\s*\/?\s*>/)[0] || '').trim();
  const icon = (html.match(/class="eqx-art" src="([^"]+)"/) || [])[1] || '';

  // スロット抽出。「eqd-slot」には RANK CALCULATOR / EQUIPPABLE CHARACTERS の枠も
  // 含まれるためラベルで除外する。効果なしスロット（eqd-empty）と
  // 選択式効果（eqd-option。— OR — 区切り）にも対応する。
  const slots = [];
  for (const seg of html.split(/<div class="eqd-slot(?=[ "])/).slice(1)) {
    const cls = (seg.match(/^([^"]*)"/) || [])[1] || '';
    const label = decodeEntities((seg.match(/<div class="eqd-slot-label">([^<]+)<\/div>/) || [])[1] || '').trim();
    if (!label || !/^SLOT/i.test(label)) continue;
    const isOption = seg.includes('eqd-option');
    const effLines = [];
    for (const em of seg.matchAll(/<div class="eqd-eff">([\s\S]*?)<\/div>/g)) {
      const ls = em[1].split(/<br\s*\/?\s*>/)
        .map((l) => decodeEntities(l.replace(/<[^>]+>/g, '')).trim()).filter(Boolean);
      effLines.push(ls);
    }
    const star7 = cls.includes('s4') || effLines.flat().some((l) => l.includes('【★7で解放】'));
    let lines;
    if (isOption) {
      // 選択式効果（Option 1 of N / — OR — 区切り）。ゲームでは所持個体ごとにどれか1つが付く。
      // クロール時は原文＋選択肢番号で保存し、マージ時にタグ表で選択肢ごとに解析する
      // （計算側は「条件を満たす選択肢のうち最良の1つ」を適用する）
      lines = effLines.flatMap((ls, i) => ls.map((l) => ({ raw: l, option: i + 1 })));
    } else {
      lines = effLines.flat()
        .filter((l) => !l.includes('【★7で解放】'))
        .map(classifyLine)
        .filter(Boolean);
    }
    slots.push({ label, star7, lines });
  }
  if (slots.length === 0) throw new Error('eqd-slot が見つかりません');

  // 装備条件（表示用の生テキスト）
  const condHtml = (html.match(/class="eqd-condgroups">(.*?)<\/div>\s*<\/div>/s) || [])[1] || '';
  const condition_text = decodeEntities(condHtml.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

  // 装備可能キャラID（条件のAND/ORを解析する代わりにサイトの解決済み一覧を使う）
  const charListHtml = (html.match(/id="eqdCharList"(.*?)<\/main>/s) || [])[1] || '';
  const equip_char_ids = [...new Set(
    [...charListHtml.matchAll(/href="\/?character\/(\d+)"/g)].map((x) => Number(x[1]))
  )];

  return {
    id: Number(id),
    name: decodeEntities(name).trim(),
    rarity,
    rarity_label: rarityLabel,
    icon: icon.startsWith('/') ? icon : `/${icon}`,
    condition_text,
    equip_char_ids,
    slots,
  };
}

/**
 * 装備条件テキスト（condition_text）をタグID条件（DNF: ORの配列×ANDの配列）に解析する。
 * 例: 「神の気 AND 射撃タイプ OR 神の気 AND 防御タイプ」
 *     → [[{tag:40},{tag:13003}],[{tag:40},{tag:13001}]]
 * 名前はタグ・エピソード・属性・レアリティ・バトルスタイル・キャラ名の擬似タグを含む
 * グローバルなタグ表で解決する。1つでも解決できない名前があれば null（安全側: 条件を保存しない）。
 * 用途: 変身後タグ持ちキャラの装備可否再判定（DESIGN §24）。通常の装備可否は
 * 従来どおりサイトの解決済み equip_char_ids を使う。
 */
export function parseEquipConditionText(text, tagNameToId) {
  const t = String(text || '').replace(/[\s　]+/g, ' ').trim();
  if (!t) return null;
  const cond = [];
  for (const part of t.split(/ OR /)) {
    const clause = [];
    for (const nameRaw of part.split(/ AND /)) {
      const name = nameRaw.trim();
      if (!name) return null;
      const id = tagNameToId[name] ?? tagNameToId[name.normalize('NFKC')];
      if (id == null) return null;
      clause.push({ tag: id, name });
    }
    if (clause.length === 0) return null;
    cond.push(clause);
  }
  return cond.length ? cond : null;
}

// ---------------------------------------------------------------- 一覧ページ

export function parseCharacterList(html) {
  const chars = [];
  const re = /<a href="character\/(\d+)"[^>]*>(.*?)<\/a>/gs;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = html.slice(m.index, m.index + m[0].indexOf('>') + 1);
    const attr = (name) => {
      const mm = tag.match(new RegExp(`${name}="([^"]*)"`));
      return mm ? decodeEntities(mm[1]) : '';
    };
    if (!tag.includes('data-charaname')) continue;
    const card = (m[2].match(/<div title="([^"]+)"/) || [])[1] || '';
    chars.push({
      id: Number(m[1]),
      name: attr('data-charaname'),
      element: attr('data-element'),
      rarity: attr('data-rarity'),
      zenkai: attr('data-zenkai') === '1',
      lf: attr('data-lf') === '1',
      tags: attr('data-tags').split(/\s+/).filter(Boolean).map(Number),
      card_no: card,
    });
  }
  const tags = {};
  const sel = html.match(/<select[^>]*id="filterTAGS"[^>]*>(.*?)<\/select>/s);
  if (sel) {
    for (const o of sel[1].matchAll(/<option value="(\d+)"[^>]*>(.*?)<\/option>/g)) {
      const name = decodeEntities(o[2].replace(/<[^>]+>/g, '')).trim();
      if (name) tags[o[1]] = name;
    }
  }
  return { chars, tags };
}

export function parseEquipList(html) {
  return [...new Set([...html.matchAll(/href="\/equip\/(\d+)"/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- 装備の効果条件（マージ時の再解析）

/**
 * スロット内の raw 行列から「効果条件付き効果」を解析する（DESIGN.md §11-7）。
 * 表示上の折り返しで複数行に分かれているため、行を結合してから解析する。形式:
 *   バトルメンバーに[自身以外の]「属性：RED」または「タグ：GT」が[N人[以上]]いると、
 *   自身の打撃攻撃力を5.00% ~ 10.00%アップ
 *
 * 条件のスコープは「バトルメンバー」（スタンダード=バトル3体 / プラウド=そのチーム3体）。
 * 「N人いると」は「N人以上」と解釈する（実機未検証の仮定 — §11-7）。
 *
 * @returns {Array|null} 解析できた場合は新しい lines 配列、できなければ null
 */
/**
 * 効果条件の見出し行（効果部を含まない1行）を解析して条件メタを返す。
 * 「…がN人いると、」「…1人につき、」「自身が「…」の場合、」の3形式。
 */
export function parseConditionHeader(text, tagNameToId) {
  let perMember = false;
  let selfScope = false;
  let m = text.match(/^(?:バトルメンバーに)?(自身以外の)?((?:「[^」]+」(?:または|かつ)?)+)が(?:(\d+)人(?:以上)?)?いると[、]?$/);
  if (!m) {
    const pm = text.match(/^(?:バトルメンバーの)?(自身以外の)?((?:「[^」]+」(?:または|かつ)?)+)1人につき[、]?$/);
    if (pm) { perMember = true; m = pm; }
  }
  if (!m) {
    const self = text.match(/^自身が((?:「[^」]+」(?:または|かつ)?)+)の場合[、]?$/);
    if (self) { selfScope = true; m = [self[0], undefined, self[1], undefined]; }
  }
  if (!m) return null;
  const unresolved = [];
  const cond = parseInlineConditions(m[2], tagNameToId, unresolved);
  if (cond.length === 0) return null;
  const meta = {
    cond,
    cond_count: m[3] ? Number(m[3]) : 1,
    cond_exclude_self: !!m[1],
    cond_scope: selfScope ? 'self' : 'battle',
    cond_raw: text,
  };
  if (perMember) meta.cond_per_member = true;
  if (unresolved.length) meta.cond_unresolved = unresolved;
  return meta;
}

export function parseConditionalSlot(rawLines, tagNameToId) {
  const joined = rawLines.join('');
  // 1スロットに条件文が複数連続することがある（例: 覚醒「かつての敵との共闘！」スロット3:
  // フリーザ軍→打撃攻撃 / 人造人間→打撃・射撃防御）。分割しないと2つ目の効果に
  // 1つ目の条件が付いてしまうため、条件見出しの開始位置で分割して個別に解析する
  const segments = joined
    .split(/(?=バトルメンバーに(?:自身以外の)?「|バトルメンバーの(?:自身以外の)?「|自身が「)/)
    .filter((s) => s.trim());
  if (segments.length > 1) {
    const out = [];
    for (const seg of segments) {
      const r = parseOneConditionalText(seg, tagNameToId);
      if (!r) return null; // 一部でも解析できなければ全体を諦めて raw のまま残す
      out.push(...r);
    }
    return out;
  }
  return parseOneConditionalText(joined, tagNameToId);
}

function parseOneConditionalText(joined, tagNameToId) {
  // 形式1: 「…が[N人[以上]]いると、〜アップ」 / 形式2: 「…1人につき、〜ずつアップ」（人数比例）
  let perMember = false;
  let selfScope = false;
  let m = joined.match(
    /^(?:バトルメンバーに)?(自身以外の)?((?:「[^」]+」(?:または|かつ)?)+)が(?:(\d+)人(?:以上)?)?いると[、]?(.+)$/
  );
  if (!m) {
    const pm = joined.match(
      /^(?:バトルメンバーの)?(自身以外の)?((?:「[^」]+」(?:または|かつ)?)+)1人につき[、]?(.+)$/
    );
    if (pm) { perMember = true; m = [pm[0], pm[1], pm[2], undefined, pm[3]]; }
  }
  if (!m) {
    // 形式3: 「自身が「バトルスタイル：打撃タイプ」の場合、〜アップ」= 装備キャラ自身の条件
    const self = joined.match(/^自身が((?:「[^」]+」(?:または|かつ)?)+)の場合[、]?(.+)$/);
    if (self) { selfScope = true; m = [self[0], undefined, self[1], undefined, self[2]]; }
  }
  if (!m) return null;
  const unresolved = [];
  const cond = parseInlineConditions(m[2], tagNameToId, unresolved);
  if (cond.length === 0) return null;
  const condMeta = {
    cond,
    cond_count: m[3] ? Number(m[3]) : 1,
    cond_exclude_self: !!m[1],
    cond_scope: selfScope ? 'self' : 'battle', // self = 装備キャラ自身のタグ等で判定
    cond_raw: joined.slice(0, joined.length - m[4].length),
  };
  if (perMember) condMeta.cond_per_member = true; // 効果値 × 該当人数
  // 効果部: 「自身の<名前>を/が <値>%[ ~ <値>%][ずつ]アップ」の連続
  const lines = [];
  const effRe = /(?:自身の)?([^、。]+?)[をが]\s*([+-]?[\d.]+)\s*[%％](?:\s*[~〜～]\s*\+?(-?[\d.]+)\s*[%％])?(?:ずつ)?アップ/g;
  let em;
  let matchedLen = 0;
  while ((em = effRe.exec(m[4])) !== null) {
    const line = { text: em[1].trim(), ...condMeta };
    if (em[3] != null) { line.value = Number(em[3]); line.value_min = Number(em[2]); }
    else { line.value = Number(em[2]); }
    for (const u of unresolved) line.cond_unresolved = (line.cond_unresolved || []).concat(u);
    lines.push(line);
    matchedLen += em[0].length;
  }
  if (lines.length === 0) return null;
  // 効果部に解析できない残りが多い場合は諦めて raw のまま（アビリティ文の混在を防ぐ）
  if (matchedLen < m[4].length * 0.5) return null;
  return lines;
}

// ---------------------------------------------------------------- マージ

const STATS = ['hp', 'strike_atk', 'blast_atk', 'strike_def', 'blast_def', 'critical', 'ki_recovery'];

/**
 * 公開済みの game_data/*.json からクロールキャッシュを復元する（--update モード）。
 * characters.json / fragments.json はパース済み構造（アビリティ原文 text 含む）を
 * そのまま保持しているため、キャッシュの無い環境（GitHub Actions 等）でも
 * これをシードすれば「新規ページだけを取得 → merge」の差分更新になる。
 */
async function seedCacheFromData() {
  const seed = async (file, dir, keep) => {
    const p = join(ROOT, 'game_data', file);
    if (!existsSync(p)) return 0;
    const data = JSON.parse(await readFile(p, 'utf8'));
    let n = 0;
    for (const [id, entry] of Object.entries(data)) {
      const dest = join(CRAWL, dir, `${id}.json`);
      if (existsSync(dest)) continue;
      if (keep && !keep(entry)) continue;
      await writeFile(dest, JSON.stringify(entry));
      n++;
    }
    return n;
  };
  // 詳細未取得（stats が全0）のキャラはシードせず、再取得の対象に残す
  const hasDetail = (c) => c.stats && Object.values(c.stats).some((v) => Number(v) > 0);
  const nc = await seed('characters.json', 'char', hasDetail);
  const ne = await seed('fragments.json', 'equip', null);
  if (nc || ne) console.log(`キャッシュを公開データから復元: キャラ ${nc} 体 / 装備 ${ne} 件`);
}

async function readCache(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out[f.replace('.json', '')] = JSON.parse(await readFile(join(dir, f), 'utf8')); }
    catch { /* 壊れたキャッシュは無視（再取得される） */ }
  }
  return out;
}

async function merge() {
  const chars = await readCache(join(CRAWL, 'char'));
  const equips = await readCache(join(CRAWL, 'equip'));
  const listMeta = JSON.parse(await readFile(join(CRAWL, 'list.json'), 'utf8'));

  // tags.json: 既存の tags.json ＋ 一覧の filterTAGS ＋ 各キャラページの tr を統合。
  // --update（キャッシュを公開データからシードした環境）ではキャラページ由来の tr が
  // 無いため、既存の tags.json を土台にしないと特殊タグ（特殊カバチェン等）が失われる
  let tags = {};
  try { tags = JSON.parse(await readFile(join(ROOT, 'game_data', 'tags.json'), 'utf8')); }
  catch { /* 初回は存在しない */ }
  Object.assign(tags, listMeta.tags);
  for (const c of Object.values(chars)) {
    for (const [tid, arr] of Object.entries(c.tag_names || {})) {
      if (!tags[tid] && arr[0]) tags[tid] = arr[0];
    }
  }

  // アビリティ文言はグローバルなタグ名→ID表で再パースする
  // （ページ単体では解決できない条件 —「エピソード：劇場版編」等 — をIDへ解決するため。
  //  キャッシュには原文 text が保存されているので再取得は不要）
  const tagNameToId = {};
  for (const [tid, name] of Object.entries(tags)) {
    if (tagNameToId[name] == null) tagNameToId[name] = Number(tid);
    const norm = name.normalize('NFKC'); // 全角/半角の表記ゆれ対策（Ｚ vs Z 等）
    if (tagNameToId[norm] == null) tagNameToId[norm] = Number(tid);
  }
  const reparse = (list) => (list || []).map((a) => ({ ...a, groups: parseAbilityText(a.text, tagNameToId) }));

  // 属性タグ（タッグキャラは2属性を持ちうる。両属性とも色限定効果の対象になる）
  const ELEMENT_TAG = { 15000: 'RED', 15001: 'YEL', 15002: 'PUR', 15003: 'GRN', 15004: 'BLU', 15070: 'LGT', 15072: 'DRK' };

  const charactersOut = {};
  for (const meta of listMeta.chars) {
    const detail = chars[String(meta.id)];
    if (detail) {
      detail.z_ability = reparse(detail.z_ability);
      detail.deploy_z_ability = reparse(detail.deploy_z_ability);
      detail.zenkai_ability = reparse(detail.zenkai_ability);
    }
    const tagsOf = detail?.tags?.length ? detail.tags : meta.tags;
    const elements = [
      meta.element,
      ...tagsOf.map((t) => ELEMENT_TAG[t]).filter((e) => e && e !== meta.element),
    ].filter(Boolean);
    charactersOut[String(meta.id)] = {
      id: meta.id,
      card_no: detail?.card_no || meta.card_no,
      name: detail?.name || meta.name,
      element: meta.element,
      elements,
      rarity: meta.rarity,
      zenkai: meta.zenkai,
      lf: meta.lf || detail?.ll || false,
      image: detail?.image || '',
      tags: detail?.tags?.length ? detail.tags : meta.tags,
      stats: detail?.stats || Object.fromEntries(STATS.map((s) => [s, 0])),
      soul_max: detail?.soul_max || Object.fromEntries(STATS.map((s) => [s, 0])),
      z_ability: detail?.z_ability || [],
      deploy_z_ability: detail?.deploy_z_ability || [],
      zenkai_ability: detail?.zenkai_ability || [],
      ultra_ability: (detail?.ultra_ability || []).map((u) => ({
        ...u,
        // 参照タグは本文からグローバルなタグ表で抽出し直す（抽出ロジック更新を再取得なしで反映）
        ref_tags: extractUltraRefs(u.text, tagNameToId),
      })),
      equip_ids: detail?.equip_ids || [],
      arts: detail?.arts || [],
    };
  }

  const fragmentsOut = {};
  for (const [id, e] of Object.entries(equips)) {
    // 効果条件付きスロットを原文の並び順で再解析する。
    // - 連続する raw ブロック「見出し＋効果」→ parseConditionalSlot
    // - raw の条件見出し1行＋解析済みの効果行（例: 2093「自身が「…」の場合、」→「特防：…+15%」）
    //   → 後続の解析済み行に条件メタを付与する
    for (const slot of e.slots || []) {
      const lines = slot.lines || [];
      if (lines.length === 0 || !lines.some((l) => l.raw != null)) continue;
      // 選択式スロット（option 番号付き / 旧形式の【選択N】プレフィックス）:
      // 選択肢ごとに条件付きスロットとして解析する。素の効果行の選択肢は classifyLine で解析
      const optOf = (l) => {
        if (l.option != null) return { opt: l.option, raw: l.raw };
        const m = l.raw != null && String(l.raw).match(/^【選択(\d+)】(.*)$/);
        return m ? { opt: Number(m[1]), raw: m[2] } : null;
      };
      if (lines.some((l) => optOf(l))) {
        const byOpt = new Map();
        const passthrough = [];
        for (const l of lines) {
          const o = optOf(l);
          if (o && l.raw != null) {
            if (!byOpt.has(o.opt)) byOpt.set(o.opt, []);
            byOpt.get(o.opt).push(o.raw);
          } else {
            passthrough.push(l); // 解析済み行はそのまま
          }
        }
        const out2 = [...passthrough];
        for (const [opt, raws] of [...byOpt.entries()].sort((a, b) => a[0] - b[0])) {
          const parsed = parseConditionalSlot(raws, tagNameToId);
          if (parsed) { out2.push(...parsed.map((p) => ({ ...p, option: opt }))); continue; }
          const classified = raws.map(classifyLine);
          if (classified.every((c) => c && c.raw == null)) {
            out2.push(...classified.map((p) => ({ ...p, option: opt })));
            continue;
          }
          out2.push(...raws.map((raw) => ({ raw, option: opt })));
        }
        slot.lines = out2;
        continue;
      }
      const out = [];
      let i = 0;
      while (i < lines.length) {
        if (lines[i].raw == null) { out.push(lines[i]); i++; continue; }
        const block = [];
        let j = i;
        while (j < lines.length && lines[j].raw != null) { block.push(lines[j].raw); j++; }
        const parsed = parseConditionalSlot(block, tagNameToId);
        if (parsed) { out.push(...parsed); i = j; continue; }
        const header = block.length === 1 ? parseConditionHeader(block[0], tagNameToId) : null;
        if (header && j < lines.length && lines[j].raw == null) {
          while (j < lines.length && lines[j].raw == null) { out.push({ ...lines[j], ...header }); j++; }
          i = j;
          continue;
        }
        out.push(...block.map((raw) => ({ raw })));
        i = j;
      }
      slot.lines = out;
    }
    // 力の大会専用フラグメント（通常バトルでは装備不可）。
    // サイトに構造化マーカーが無いため名前の接頭辞で判定し、データ側にフラグを持たせる
    if (String(e.name || '').startsWith('【力の大会】')) e.top = true;
    // 装備条件をタグID条件に解析する（変身後タグ持ちキャラの装備可否再判定用 — §24）
    const eqCond = parseEquipConditionText(e.condition_text, tagNameToId);
    if (eqCond) e.equip_cond = eqCond; else delete e.equip_cond;
    fragmentsOut[id] = e;
  }

  // キャラページ側の装備リスト（equip_ids）から、フラグメント側の装備可能キャラ一覧を補完する。
  // --update ではキャラページだけが再取得され既存の装備ページは再取得されないため、
  // 新キャラが既存フラグの equip_char_ids に載らず「ほぼ何も装備できない」状態になる。
  // 装備可否は双方向の和で決める（equip_char_ids が空 = 全キャラ可 のフラグはそのまま）
  for (const ch of Object.values(charactersOut)) {
    for (const eqId of ch.equip_ids || []) {
      const f = fragmentsOut[String(eqId)];
      if (!f || !Array.isArray(f.equip_char_ids) || f.equip_char_ids.length === 0) continue;
      if (!f.equip_char_ids.includes(ch.id)) f.equip_char_ids.push(ch.id);
    }
  }

  // 効果行レポート（effect_map 整備用）
  const freq = {};
  for (const e of Object.values(equips)) {
    for (const slot of e.slots || []) {
      for (const line of slot.lines || []) {
        const key = line.text != null ? `%:${line.text}` : `raw:${(line.raw || '').slice(0, 40)}`;
        freq[key] = (freq[key] || 0) + 1;
      }
    }
  }
  const abilityFreq = {};
  for (const c of Object.values(chars)) {
    for (const kind of ['z_ability', 'deploy_z_ability', 'zenkai_ability']) {
      for (const a of c[kind] || []) {
        for (const g of a.groups || []) {
          for (const ef of g.effects || []) abilityFreq[`%:${ef.text}`] = (abilityFreq[`%:${ef.text}`] || 0) + 1;
          for (const u of g.unresolved || []) abilityFreq[`?:${u.slice(0, 60)}`] = (abilityFreq[`?:${u.slice(0, 60)}`] || 0) + 1;
        }
      }
    }
  }

  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
  await writeFile(join(ROOT, 'game_data', 'meta.json'), JSON.stringify({
    source: BASE,
    generated_at: new Date().toISOString(),
    characters: Object.keys(charactersOut).length,
    characters_detailed: Object.keys(chars).length,
    fragments: Object.keys(fragmentsOut).length,
    tags: Object.keys(tags).length,
  }, null, 1) + '\n');
  await writeFile(join(ROOT, 'game_data', 'characters.json'), JSON.stringify(charactersOut) + '\n');
  await writeFile(join(ROOT, 'game_data', 'fragments.json'), JSON.stringify(fragmentsOut) + '\n');
  await writeFile(join(ROOT, 'game_data', 'tags.json'), JSON.stringify(tags, null, 1) + '\n');
  await writeFile(join(ROOT, 'game_data', 'effect_lines_report.json'),
    JSON.stringify({ equip_lines: sortObj(freq), ability_lines: sortObj(abilityFreq) }, null, 1) + '\n');
  console.log(`マージ完了: キャラ ${Object.keys(charactersOut).length} 体（詳細取得済 ${Object.keys(chars).length}） / 装備 ${Object.keys(fragmentsOut).length} 件 / タグ ${Object.keys(tags).length} 件`);
}

// ---------------------------------------------------------------- メイン

async function main() {
  const mergeOnly = process.argv.includes('--merge');
  const updateMode = process.argv.includes('--update');
  await mkdir(join(CRAWL, 'char'), { recursive: true });
  await mkdir(join(CRAWL, 'equip'), { recursive: true });
  await mkdir(join(CRAWL, 'failed'), { recursive: true });
  if (updateMode) await seedCacheFromData();

  if (!mergeOnly) {
    // 一覧（毎回取得して新キャラ・新装備を発見する）
    console.log('一覧を取得中…');
    const { html: charListHtml } = await politeFetch('/characters');
    const { chars, tags } = parseCharacterList(charListHtml);
    const { html: equipListHtml } = await politeFetch('/equipment');
    const equipIds = parseEquipList(equipListHtml);
    if (chars.length === 0 || equipIds.length === 0) {
      console.error('■ 一覧の解析に失敗しました。ページ構造が変わった可能性があります。');
      process.exit(1);
    }
    await writeFile(join(CRAWL, 'list.json'), JSON.stringify({ chars, tags, equipIds }, null, 1));
    console.log(`キャラ ${chars.length} 体 / 装備 ${equipIds.length} 件`);

    const failures = [];
    const work = [
      ...chars.map((c) => ({ kind: 'char', id: c.id, path: `/character/${c.id}`, parse: parseCharacterPage })),
      ...equipIds.map((id) => ({ kind: 'equip', id, path: `/equip/${id}`, parse: parseEquipPage })),
    ].filter((w) => !existsSync(join(CRAWL, w.kind, `${w.id}.json`)));
    console.log(`未取得 ${work.length} ページ（間隔 ${DELAY_MS}ms、推定 ${Math.round(work.length * DELAY_MS / 60000)} 分）`);

    let done = 0;
    for (const w of work) {
      try {
        // 以前の失敗ページの生HTMLが残っていれば、まず再取得なしで再パースを試みる
        const failedPath = join(CRAWL, 'failed', `${w.kind}-${w.id}.html`);
        let html = null;
        if (existsSync(failedPath)) {
          try {
            const cached = await readFile(failedPath, 'utf8');
            const parsed = w.parse(cached, w.id);
            await writeFile(join(CRAWL, w.kind, `${w.id}.json`), JSON.stringify(parsed));
            continue;
          } catch { /* 再パースも失敗 → 取得し直す */ }
        }
        const res = await politeFetch(w.path);
        if (res.status === 404) { failures.push({ ...w, error: '404' }); continue; }
        html = res.html;
        const parsed = w.parse(html, w.id);
        await writeFile(join(CRAWL, w.kind, `${w.id}.json`), JSON.stringify(parsed));
      } catch (e) {
        failures.push({ kind: w.kind, id: w.id, error: e.message });
        try {
          const { html } = await politeFetch(w.path);
          if (html) await writeFile(join(CRAWL, 'failed', `${w.kind}-${w.id}.html`), html);
        } catch { /* 保存できなければ諦める */ }
      }
      if (++done % 25 === 0) console.log(`${done}/${work.length} 完了`);
    }
    if (failures.length) {
      await writeFile(join(CRAWL, 'failures.json'), JSON.stringify(failures, null, 1));
      console.error(`⚠ ${failures.length} ページで失敗（game_data/crawl/failures.json 参照）`);
    }
  }

  await merge();
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((e) => { console.error('■ 中断:', e); process.exit(1); });
}
