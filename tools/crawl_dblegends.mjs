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
    const m = part.match(/「(?:タグ|エピソード|属性|レアリティ|キャラクター)[:：]([^」]+)」/);
    if (!m) return null;
    const name = m[1].trim();
    const id = tagNameToId[name] ?? tagNameToId[name.normalize('NFKC')];
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
export function parseAbilityText(text, tagNameToId) {
  const iconRe = /\{\{ICN:([^}]+)\}\}/;
  const isConditionLine = (line) => {
    const tokens = line.match(/\{\{ICN:[^}]+\}\}/g) || [];
    return tokens.some((t) => {
      const icn = t.match(iconRe)[1];
      return icn === 'ChaTag' || ELEMENT_CODES.includes(icn);
    });
  };
  const groups = [];
  for (const block of String(text).split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const g = { cond: [], unresolved: [], effects: [], raw: block };
    for (const line of lines) {
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
      // 各節の形式: [バトル時、][「タグ：X」または「…」かつ「…」の]<効果名>[を]<値>%[アップ]
      const clauseRe = /^(?:バトル時、)?((?:「[^」]+」(?:または|かつ)?)*)の?(.+?)[をが]?\s*\+?([\d.]+)\s*[%％](?:アップ)?$/;
      const clauses = body.split('&').map((s) => s.trim()).filter(Boolean);
      const parsed = clauses.map((c) => {
        const m = c.match(clauseRe);
        if (!m || m[2].includes('「')) return null;
        return { condText: m[1] || '', text: m[2].trim(), value: Number(m[3]) };
      });
      if (parsed.length > 0 && parsed.every(Boolean)) {
        for (const p of parsed) {
          if (p.condText) {
            // 条件付きの節は独立グループにする
            const unresolved = [];
            const cond = parseInlineConditions(p.condText, tagNameToId, unresolved);
            groups.push({ cond, unresolved, effects: [{ text: p.text, value: p.value }], raw: body });
          } else {
            g.effects.push({ text: p.text, value: p.value });
          }
        }
        continue;
      }
      g.unresolved.push(body);
    }
    if (g.effects.length > 0 || g.cond.length > 0 || g.unresolved.length > 0) groups.push(g);
  }
  return groups;
}

// ---------------------------------------------------------------- キャラページ

export function parseCharacterPage(html, id) {
  const data = scriptJSON(html, 'data');
  const ab = scriptJSON(html, 'ab') || {};
  const tr = scriptJSON(html, 'tr') || {};
  const eq = scriptJSON(html, 'eq') || [];
  const d = data && data[String(id)];
  if (!d) throw new Error('script#data にキャラ情報がありません');

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
    equip_ids: eq.map((e) => Number(e[0])).filter(Number.isFinite),
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
      // 選択式効果はどれが付くか不定のため計算対象にせず、原文のまま表示用に保存する
      lines = effLines.flatMap((ls, i) => ls.map((l) => ({ raw: `【選択${i + 1}】${l}` })));
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

// ---------------------------------------------------------------- マージ

const STATS = ['hp', 'strike_atk', 'blast_atk', 'strike_def', 'blast_def', 'critical', 'ki_recovery'];

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

  // tags.json: 一覧の filterTAGS ＋ 各キャラページの tr を統合
  const tags = { ...listMeta.tags };
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

  const charactersOut = {};
  for (const meta of listMeta.chars) {
    const detail = chars[String(meta.id)];
    if (detail) {
      detail.z_ability = reparse(detail.z_ability);
      detail.deploy_z_ability = reparse(detail.deploy_z_ability);
      detail.zenkai_ability = reparse(detail.zenkai_ability);
    }
    charactersOut[String(meta.id)] = {
      id: meta.id,
      card_no: detail?.card_no || meta.card_no,
      name: detail?.name || meta.name,
      element: meta.element,
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
      equip_ids: detail?.equip_ids || [],
    };
  }

  const fragmentsOut = {};
  for (const [id, e] of Object.entries(equips)) fragmentsOut[id] = e;

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
  await mkdir(join(CRAWL, 'char'), { recursive: true });
  await mkdir(join(CRAWL, 'equip'), { recursive: true });
  await mkdir(join(CRAWL, 'failed'), { recursive: true });

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
