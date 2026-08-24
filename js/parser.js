// 参照サイト HTML のパーサ（DESIGN.md §5-3）
//
// HTML 構造は変わりうるので、パーサはこのモジュールに隔離して差し替えやすくする。
// 正規表現ベースにして Node（更新スクリプト）とブラウザ（貼り付け取り込み）の両方で使う。
//
// 対象1: キャラ一覧の <a href="character/738" data-charaname="..." data-tags="7 1 40 ..."> 群
// 対象2: タグ対応表 <select id="filterTAGS"><option value="50010">…</option></select>

/** <a ...> タグ1個分の属性を取り出す */
function parseAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tag)) !== null) {
    attrs[m[1].toLowerCase()] = m[2];
  }
  return attrs;
}

/** HTML エンティティの最低限のデコード */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * キャラ一覧ページの HTML からキャラ配列を取り出す。
 * @returns {{characters: Array<object>, skipped: number}}
 *   characters … {id, name, element, rarity, tags:[number], zenkai:boolean, lf:boolean}
 *   skipped    … data-charaname はあるが ID を特定できず読み飛ばした件数（§1-4: 黙って捨てない）
 */
export function parseCharacterListHTML(html) {
  const characters = [];
  let skipped = 0;
  const tagRe = /<a\b[^>]*\bdata-charaname\s*=\s*"[^>]*>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const attrs = parseAttrs(m[0]);
    const href = attrs['href'] || '';
    const idMatch = href.match(/character\/(\d+)/);
    if (!idMatch) { skipped++; continue; }
    const id = Number(idMatch[1]);
    const tags = (attrs['data-tags'] || '')
      .trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
    characters.push({
      id,
      name: decodeEntities(attrs['data-charaname'] || ''),
      element: attrs['data-element'] || '',
      rarity: attrs['data-rarity'] || '',
      zenkai: attrs['data-zenkai'] === '1',
      lf: attrs['data-lf'] === '1',
      tags,
    });
  }
  return { characters, skipped };
}

/**
 * <select id="filterTAGS"> からタグID→名前の対応表を取り出す。
 * @returns {Object<string,string>} 例 { "50010": "..." }
 */
export function parseTagSelectHTML(html) {
  const tags = {};
  const selMatch = html.match(/<select\b[^>]*\bid\s*=\s*"filterTAGS"[^>]*>([\s\S]*?)<\/select>/i);
  if (!selMatch) return tags;
  const optRe = /<option\b[^>]*\bvalue\s*=\s*"(\d+)"[^>]*>([\s\S]*?)<\/option>/g;
  let m;
  while ((m = optRe.exec(selMatch[1])) !== null) {
    const name = decodeEntities(m[2].replace(/<[^>]*>/g, '').trim());
    if (name) tags[m[1]] = name;
  }
  return tags;
}
