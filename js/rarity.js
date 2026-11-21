// フラグメントのレアリティ判定（DESIGN.md §6 / §50）。DOM に依存しない純粋関数。
//
// 未知のレアリティは計算を中止する（§1-4: 未知の値を黙って扱わない）。ただし
// 「awakened + 既知のレアリティ」は既知とみなす。計算でレアリティが効くのは
// 「覚醒前後の同一種は同時装備できない」（接頭辞 awakened で判定）だけなので、
// 既知の土台に awakened が付いたものは意味が確定している（§50: awakenedplatinum で全計算が止まった）。

const AWAKENED = 'awakened';

/** レアリティが既知か。known が空ならチェックしない（常に true） */
export function isKnownRarity(rarity, known) {
  if (!Array.isArray(known) || known.length === 0) return true;
  const r = String(rarity || '');
  if (r === '' || known.includes(r)) return true;
  return r.startsWith(AWAKENED) && known.includes(r.slice(AWAKENED.length));
}

/** フラグメント一覧のうち未知レアリティのもの [{id, name, rarity}] */
export function unknownRarities(fragments, known) {
  return Object.values(fragments || {})
    .filter((f) => f && !isKnownRarity(f.rarity, known))
    .map((f) => ({ id: f.id, name: f.name, rarity: f.rarity }));
}
