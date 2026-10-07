// 探索を UI スレッドから切り離して実行する Web Worker
import { searchBuilds } from './search.js';

let skillDefs = null;

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (!skillDefs) {
      const res = await fetch(new URL('../data/skills.json', import.meta.url));
      skillDefs = (await res.json()).skills;
    }
    const out = searchBuilds(msg.weapons, msg.partOptions, {
      skillDefs,
      settings: msg.settings,
      required: msg.required,
      freeKinds: new Set(msg.freeKinds),
      topN: msg.topN,
      timeLimitMs: msg.timeLimitMs,
      maxCombos: msg.maxCombos,
      onProgress: (p) => self.postMessage({ type: 'progress', ...p }),
    });
    // 結果は構造化複製できる形だけ返す
    const results = out.results.map((r) => ({
      damage: r.damage,
      weaponId: r.weapon.id,
      weapon: r.weapon,
      pieces: r.pieces,
      unmet: r.unmet,
      drifts: r.eval.drifts,
      levels: r.eval.levels,
      slotsTotal: r.eval.slotsTotal,
      critRate: r.eval.result.critRate,
    }));
    self.postMessage({ type: 'done', results, evaluated: out.evaluated, timedOut: out.timedOut, approximated: out.approximated, elapsed: out.elapsed });
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e && e.stack || e) });
  }
};
