// 半自動データ更新スクリプト（DESIGN.md §5）
//
// ブラウザから外部サイトを直接 fetch すると CORS でブロックされるため（§5-2）、
// この Node スクリプトで取得して game_data/*.json を更新し、アプリは同一オリジンの
// JSON を読むだけにする。GitHub Pages 配信なら、生成結果をコミットして反映する。
//
// 使い方:
//   1. tools/config.json を作る（tools/config.example.json をコピーして参照サイトのURLを設定）
//   2. node tools/update_data.mjs
//
// 方針（§5-1）:
//   - 全キャラは取得しない。config の character_ids にあるキャラだけを対象にする
//   - 取得した生 HTML は game_data/snapshots/<日付>/ に必ず保存する（§5-4）
//   - リクエスト間隔を空ける（連続アクセスで弾かれるのを防ぐ）
//   - 取り込みは初期入力の補助に過ぎない（§1-1）。失敗してもアプリは既存データで動く

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCharacterListHTML, parseTagSelectHTML } from '../js/parser.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WAIT_MS = 3000; // リクエスト間隔（§5-1）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function main() {
  const config = await readJSON(join(ROOT, 'tools', 'config.json'), null);
  if (!config || !config.list_url) {
    console.error('■ tools/config.json がありません');
    console.error('  tools/config.example.json をコピーして、参照サイトのURLを設定してください。');
    process.exitCode = 1;
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const snapDir = join(ROOT, 'game_data', 'snapshots', today);
  await mkdir(snapDir, { recursive: true });

  // ---- キャラ一覧ページ（data-* 属性に構造化済み — §5-3） ----
  console.log(`取得中: ${config.list_url}`);
  const res = await fetch(config.list_url, {
    headers: { 'User-Agent': config.user_agent || 'personal-fragment-tool (individual use)' },
  });
  if (!res.ok) {
    console.error(`■ 取得に失敗しました (HTTP ${res.status})。既存の game_data のまま利用できます。`);
    process.exitCode = 1;
    return;
  }
  const html = await res.text();
  await writeFile(join(snapDir, 'character-list.html'), html); // スナップショット保存（§5-4）

  const { characters, skipped } = parseCharacterListHTML(html);
  const tags = parseTagSelectHTML(html);
  if (characters.length === 0) {
    console.error('■ 取り込みに失敗しました: キャラを1体も見つけられませんでした。');
    console.error('  参照先のページ構造が変わった可能性があります。js/parser.js の更新が必要です。');
    console.error(`  取得した HTML は ${snapDir} に保存済みです（差分で原因を特定できます）。`);
    process.exitCode = 1;
    return;
  }

  // ---- characters.json 更新（登録対象のキャラのみ — §5-1） ----
  const targetIds = new Set((config.character_ids || []).map(Number));
  const charsPath = join(ROOT, 'game_data', 'characters.json');
  const existing = await readJSON(charsPath, {});
  let updated = 0;
  for (const c of characters) {
    if (targetIds.size > 0 && !targetIds.has(c.id)) continue;
    const prev = existing[String(c.id)] || {};
    existing[String(c.id)] = {
      id: c.id,
      card_no: prev.card_no || '',
      name: c.name,
      element: c.element,
      rarity: c.rarity,
      tags: c.tags,
      // 合計ステは一覧ページに無い。既存値を保持し、無ければ 0（アプリ側で手入力）
      base_stats: prev.base_stats || {
        hp: 0, strike_atk: 0, blast_atk: 0,
        strike_def: 0, blast_def: 0, critical: 0, ki_recovery: 0,
      },
    };
    updated++;
  }
  await writeFile(charsPath, JSON.stringify(existing, null, 2) + '\n');

  // ---- tags.json 更新 ----
  const tagsPath = join(ROOT, 'game_data', 'tags.json');
  const existingTags = await readJSON(tagsPath, {});
  Object.assign(existingTags, tags);
  await writeFile(tagsPath, JSON.stringify(existingTags, null, 2) + '\n');

  console.log(`完了: キャラ ${updated} 体を更新 / タグ名 ${Object.keys(tags).length} 件`);
  if (skipped) console.log(`⚠ IDを特定できず読み飛ばした行が ${skipped} 件あります`);
  if (targetIds.size === 0) console.log('（character_ids が空のため一覧の全キャラを取り込みました）');

  // ---- 個別ページ（ステータス詳細・フラグメント効果）は未実装 ----
  // HTML 構造が確認でき次第、ここに追加する。取得の際は必ず:
  //   await sleep(WAIT_MS);  // リクエスト間隔を空ける
  // を挟み、生 HTML を snapDir に保存してからパースすること。
  void sleep; // 未使用警告よけ（個別ページ実装時に使う）
}

main().catch((e) => {
  console.error('■ 予期しないエラーで中断しました:', e.message);
  process.exitCode = 1;
});
