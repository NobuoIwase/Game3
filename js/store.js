// 永続化層（DESIGN.md §1-5, §7）
//
// - game_data/*.json … 外部由来。同一オリジンから fetch する（CORS 回避 — §5-2）
// - my_data          … IndexedDB に保存（localStorage は容量が心許ない — §7）
// - 手入力オーバーライド（§1-1）… game_data への上書きも IndexedDB に保存し、
//   読み込み時にファイル由来のデータへマージする。取り込みが壊れてもアプリは動き続ける。

const DB_NAME = 'dbl-fragment-optimizer';
const DB_VERSION = 1;
const STORE = 'kv';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('ブラウザのデータベース（IndexedDB）を開けませんでした。プライベートブラウズ中は保存できない場合があります。'));
  });
  return dbPromise;
}

export async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('データの読み込みに失敗しました'));
  });
}

export async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error('データの保存に失敗しました'));
  });
}

export async function idbDelete(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error('データの削除に失敗しました'));
  });
}

/** my_data の空形（§3-4） */
export function emptyMyData() {
  return { fragments: {}, characters: {}, parties: [] };
}

/** game_data オーバーライドの空形（§1-1） */
export function emptyOverrides() {
  return { characters: {}, fragments: {}, tags: {} };
}

async function fetchJSON(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path} の読み込みに失敗しました (HTTP ${res.status})`);
  return res.json();
}

function stripMeta(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith('_')) continue;
    out[k] = v;
  }
  return out;
}

/**
 * game_data 一式を読み込み、オーバーライドをマージして返す。
 * オーバーライド値が null のエントリは「削除」として扱う。
 * ファイルの読み込みに失敗しても、失敗した部分を空にして動き続ける（§6）。
 */
export async function loadGameData() {
  const errors = [];
  const load = async (path, fallback) => {
    try { return await fetchJSON(path); }
    catch (e) { errors.push(e.message); return fallback; }
  };
  const [characters, fragments, effectMap, tags, config, meta, transformTags] = await Promise.all([
    load('./game_data/characters.json', {}),
    load('./game_data/fragments.json', {}),
    load('./game_data/effect_map.json', { entries: {}, _stat_keywords: {} }),
    load('./game_data/tags.json', {}),
    load('./game_data/config.json', { known_rarities: [], asset_base: '' }),
    load('./game_data/meta.json', null),
    load('./game_data/transform_tags.json', {}),
  ]);
  const overrides = (await idbGet('game_overrides')) || emptyOverrides();
  const merge = (fileData, over) => {
    const out = stripMeta(fileData);
    for (const [k, v] of Object.entries(over || {})) {
      if (v === null) delete out[k];
      else out[k] = v;
    }
    return out;
  };
  const mergedCharacters = merge(characters, overrides.characters);
  // 変身後にのみ付与されるタグ（transform_tags.json — 手動管理の補正データ、DESIGN §24）。
  // サイトは変身前後のタグを区別しないため、ここで tags から transform_tags へ分離する。
  // 分離後の tags（=変身前）が装備可否・効果条件・アビリティ条件・◎×N すべての判定に使われる
  for (const [cid, tids] of Object.entries(transformTags || {})) {
    const ch = mergedCharacters[String(cid)];
    if (!ch || !Array.isArray(tids) || tids.length === 0) continue;
    ch.transform_tags = tids.map(Number);
    ch.tags = (ch.tags || []).filter((t) => !ch.transform_tags.includes(Number(t)));
  }
  return {
    characters: mergedCharacters,
    fragments: merge(fragments, overrides.fragments),
    tags: merge(tags, overrides.tags),
    effectMap,
    config,
    meta,
    errors,
  };
}

export async function loadMyData() {
  const data = await idbGet('my_data');
  if (!data) return emptyMyData();
  return { ...emptyMyData(), ...data };
}

export async function saveMyData(myData) {
  await idbSet('my_data', myData);
}

export async function loadOverrides() {
  return (await idbGet('game_overrides')) || emptyOverrides();
}

export async function saveOverrides(overrides) {
  await idbSet('game_overrides', overrides);
}

const EXPORT_VERSION = 1;

/** JSON エクスポート（§7: my_data は復旧不能なため必須） */
export async function exportAll(opts = {}) {
  const [myData, overrides] = await Promise.all([loadMyData(), loadOverrides()]);
  const out = {
    app: 'dbl-fragment-optimizer',
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    my_data: myData,
    game_overrides: overrides,
  };
  // データ取り込み用GitHubトークン（§26）: 希望したときだけ含める（他端末への引き継ぎ用）。
  // 含めたファイルの取り扱いには注意（対象リポジトリ限定・Actions権限のみの限定トークン）
  if (opts.includeToken) {
    const t = await idbGet('gh_token');
    if (t) out.gh_token = String(t);
  }
  return out;
}

/** JSON インポート。形式が違う場合は日本語の理由付きで投げる */
export async function importAll(obj) {
  if (!obj || typeof obj !== 'object') {
    throw new Error('インポートできません: JSON の形式が不正です');
  }
  if (obj.app !== 'dbl-fragment-optimizer' || !obj.my_data) {
    throw new Error('インポートできません: このアプリのエクスポートファイルではありません');
  }
  if (Number(obj.version) > EXPORT_VERSION) {
    throw new Error('インポートできません: 新しいバージョンのアプリで作られたファイルです。アプリの更新が必要です。');
  }
  await saveMyData({ ...emptyMyData(), ...obj.my_data });
  await saveOverrides({ ...emptyOverrides(), ...(obj.game_overrides || {}) });
  // バックアップにトークンが含まれていれば、この端末にも保存する（§26）
  if (typeof obj.gh_token === 'string' && obj.gh_token.trim()) {
    await idbSet('gh_token', obj.gh_token.trim());
  }
}

export async function clearAll() {
  await idbDelete('my_data');
  await idbDelete('game_overrides');
}
