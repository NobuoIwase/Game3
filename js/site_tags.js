// サイト内タグの判定（DESIGN.md §33）。
//
// 参照サイトのタグ（サイヤ人・劇場版編…）とは別に、アビリティ本文から
// 「トリガー × 効果」で機械的に特徴を分類する独自タグ。
// 分類ルールはすべて game_data/site_tags.json 側にあり、ここにはルールを書かない（原則1-3）。
//
// 表記形式が2種類あることに注意（§33）:
//   新（2025年の 孫悟空：少年期 DBL82-03S 以降）: 「▼場に出た時」「○カードを1枚ドロー」の箇条書き
//   旧: 「場に出た時、自身の体力を5%回復」の文章
// どちらも {trigger, body} のブロック列に正規化してから突き合わせる。

/**
 * アビリティ本文を {trigger, body} のブロック列に分解する。
 * trigger が null のブロックは「無条件（常時）」を意味する。
 */
export function parseAbilityBlocks(text) {
  const groups = [];
  let cur = { trigger: null, body: [] };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('▼')) {
      if (cur.trigger != null || cur.body.length) groups.push(cur);
      cur = { trigger: line.slice(1).trim(), body: [] };
      continue;
    }
    cur.body.push(line);
  }
  if (cur.trigger != null || cur.body.length) groups.push(cur);

  const out = [];
  for (const g of groups) {
    if (g.trigger != null) { out.push({ trigger: g.trigger, body: g.body.join('\n') }); continue; }
    // 旧形式: 「〜時、…」の1行がそれ自体トリガー付きブロックになる
    for (const line of g.body) {
      const m = line.match(/^([^、。]{2,30}?時)[、,]/);
      out.push({ trigger: m ? m[1] : null, body: line });
    }
  }
  return out;
}

/** 判定対象の本文をすべて連結する（メイン/ユニーク/Z/ZENKAI/出撃Z/アーツ/専用ユニフラ） */
export function abilityCorpus(character, uniqueFragments = []) {
  const parts = [];
  const push = (t) => { const s = String(t || '').trim(); if (s) parts.push(s); };
  push(character.main_ability?.text);
  for (const u of character.ultra_ability || []) push(u.text);
  for (const list of [character.z_ability, character.zenkai_ability, character.deploy_z_ability]) {
    const arr = list || [];
    const top = arr[arr.length - 1];
    if (top) for (const g of top.groups || []) push(g.raw);
  }
  for (const a of character.arts_detail || []) push(a.text);
  for (const f of uniqueFragments) {
    for (const s of f.slots || []) for (const l of s.lines || []) push(l.raw);
  }
  return parts.join('\n');
}

// 「回数に応じて積み重なる」ことを示す表記（§33）。
// 実データでは「受けた回数に応じて」「〜ずつ」「(2回)以上の複数回発動」がそれにあたる。
// 「(1回)」は1度きりなので除外する（「※交代時、発動回数リセット」は注記であって回数依存ではない）
const REPEAT_RE = /ずつ|回数に応じて|ごとに|度に|たびに|\([2-9]\d*回\)/;

/**
 * 1キャラのサイト内タグを判定する。
 * @param {object} character characters.json のキャラ（arts_detail はあれば使う）
 * @param {object} defs      game_data/site_tags.json
 * @param {object} [opts]    { uniqueFragments: 専用ユニークフラグメントの配列 }
 * @returns {string[]} タグID（定義順）
 */
export function computeSiteTags(character, defs, opts = {}) {
  if (!character || !defs) return [];
  const uniqueFragments = opts.uniqueFragments || [];
  const blocks = parseAbilityBlocks(abilityCorpus(character, uniqueFragments));
  const test = (pats, s) => (pats || []).some((p) => {
    try { return new RegExp(p).test(s); } catch { return false; }
  });
  const out = [];
  for (const t of defs.tags || []) {
    // 構造から判定する特別タグ（本文を見ない）
    if (t.arts_type) {
      // arts_with: 本文に含む語（例「突進」= 近距離系）、arts_without: 含まない語
      const hit = artsOf(character).some((a) => a.type === t.arts_type
        && (!t.arts_with || a.text.includes(t.arts_with))
        && (!t.arts_without || !a.text.includes(t.arts_without)));
      if (hit) out.push(t.id);
      continue;
    }
    if (t.special) {
      const ok = t.special === 'unique_fragment' ? uniqueFragments.length > 0
        : t.special === 'unique_gauge' ? (character.ultra_ability || []).some((u) => /ユニークゲージ/.test(u.name || ''))
        : t.special === 'zenkai' ? (character.zenkai_ability || []).length > 0
        : t.special === 'main_ability' ? !!character.main_ability
        : false;
      if (ok) out.push(t.id);
      continue;
    }
    const trig = t.trigger ? defs.triggers?.[t.trigger] : null;
    const effPats = (t.effect_any || []).flatMap((e) => defs.effects?.[e]?.patterns || []);
    if (effPats.length === 0) continue;
    const hit = blocks.some((b) => {
      if (trig && !(b.trigger && test(trig.patterns, b.trigger))) return false;
      if (t.repeat && !REPEAT_RE.test(`${b.trigger || ''}\n${b.body}`)) return false;
      return test(effPats, b.body);
    });
    if (hit) out.push(t.id);
  }
  return out;
}

/**
 * アーツIDからアーツ種別を判定する（§33）。
 * 参照サイトの am テーブルは「<種別コード><キャラID>」でIDが振られている:
 *   <キャラID> = 打撃 / 10+ID = 射撃 / 30+ID = 必殺 / 50+ID = 特殊
 *   11xxx・12xxx は変身後フォームの同じ並び。キャラIDで終わらないものは共有アーツ（究極・覚醒等）
 */
export function artType(artId, characterId) {
  const a = String(artId ?? '');
  const c = String(characterId ?? '');
  if (!c || !a.endsWith(c)) return '共有';
  const r = a.slice(0, a.length - c.length);
  if (r === '') return '打撃';
  if (r.endsWith('50')) return '特殊';
  if (r.endsWith('30')) return '必殺';
  if (r.endsWith('10')) return '射撃';
  if (r.endsWith('00')) return '打撃';
  return '不明';
}

/** アーツ一覧を {type, text, name} に正規化する（arts_detail が無ければ arts の type を使う） */
export function artsOf(character) {
  const detail = character.arts_detail || [];
  if (detail.length) {
    return detail.map((a) => ({
      name: a.name || '', text: a.text || '', type: artType(a.id, character.id),
    }));
  }
  return (character.arts || []).map((a) => ({ name: a.name || '', text: '', type: a.type || '不明' }));
}

/** 専用ユニークフラグメント = そのキャラ専用（装備可能キャラがそのキャラ1体だけ）のユニーク */
export function exclusiveUniqueFragments(characterId, fragmentsById) {
  const cid = Number(characterId);
  return Object.values(fragmentsById || {}).filter((f) => {
    if (!/unique/.test(String(f.rarity || ''))) return false;
    const ids = f.equip_char_ids || [];
    return ids.length === 1 && Number(ids[0]) === cid;
  });
}
