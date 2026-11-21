// フラグメントのレアリティ判定（§6 / §50）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isKnownRarity, unknownRarities } from '../js/rarity.js';

const config = JSON.parse(readFileSync(new URL('../game_data/config.json', import.meta.url), 'utf8'));
const known = config.known_rarities;

test('§50 awakenedplatinum は既知（ULTRA!! - 超ゴジータ で全計算が止まった）', () => {
  assert.equal(isKnownRarity('awakenedplatinum', known), true);
});

test('§50 「awakened + 既知のレアリティ」は一覧に無くても既知、土台が未知なら未知のまま', () => {
  const k = ['gold', 'platinum'];
  assert.equal(isKnownRarity('awakenedplatinum', k), true);
  assert.equal(isKnownRarity('awakenedgold', k), true);
  assert.equal(isKnownRarity('awakenedrainbow', k), false, '土台が未知なら未知');
  assert.equal(isKnownRarity('rainbow', k), false, '新しい土台レアリティは計算を止める（§1-4）');
  assert.equal(isKnownRarity('awakened', k), false, '接頭辞だけは未知');
  assert.equal(isKnownRarity('', k), true, 'レアリティ無しは判定しない（従来どおり）');
  assert.equal(isKnownRarity('anything', []), true, '一覧が空ならチェックしない');
});

// 自動更新（update-data.yml）は公開前に npm test を通す。ここで落ちれば
// 未知レアリティのデータは公開されず、アプリはキャッシュ済みデータで動き続ける（§6 原則）
test('§50 取り込み済みの全フラグメントのレアリティが既知（未知があれば自動更新を公開前に止める）', () => {
  const fragments = JSON.parse(readFileSync(new URL('../game_data/fragments.json', import.meta.url), 'utf8'));
  const bad = unknownRarities(fragments, known);
  assert.deepEqual(bad, [],
    `未知のレアリティ: ${bad.map((b) => `${b.rarity}（${b.id} ${b.name}）`).join(' / ')}。`
    + 'game_data/config.json の known_rarities に追加し、表示名（js/app.js の RARITY_LABELS）と枠色（css/style.css）も足すこと');
});
