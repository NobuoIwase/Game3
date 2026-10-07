// 装備構成の探索。
//
// 本家との違い:
//  - どんなに弱い組み合わせでも、ロックした装備がある限り必ず結果を返す（上位N件に入らなくても
//    「ロックした構成そのもの」の評価を常に出す）。
//  - 錬成（漂移錬成）は防具ごとに
//      free  … 錬成可能スキルから自由に付けられる（=フル錬成）
//      owned … その防具が実際に持っている錬成スキル（所持リスト）からだけ選ぶ
//      fixed … 付けている錬成スキルを固定
//      none  … 錬成なし
//    を選べる。1スロット = スキル1Lv。
//
// 探索は「部位ごとに候補を絞る（優越する防具の除去）→ 深さ優先 + 上界による枝刈り」。
// 錬成の割り当ては、まず必須スキルを満たし、残りを 1スロットあたりの期待値上昇が最大になる
// 「スキル×Lv数」のまとまりから貪欲に選ぶ。

import { computeDamage, sumSkills, rateOf } from './calc.js';
import { SKILL_EFFECTS, DAMAGE_ELEMENTS, PARTS } from './model.js';
import { compileEvaluator } from './fasteval.js';

const NON_MONOTONE = new Set(['ATTACK_UP_CRITICAL_DOWN', 'BRUTAL_STRIKE', 'POWERHOUSE_CRITICAL']);

// その武器でダメージに影響しうるスキルか
export function isRelevant(kind, weapon, settings) {
  const effs = SKILL_EFFECTS[kind];
  if (!effs) return false;
  const dmgElem = DAMAGE_ELEMENTS.includes(weapon.element);
  return effs.some((e) => {
    if (e.elem && e.elem !== weapon.element) return false;
    if (e.elemAny && !e.elemAny.includes(weapon.element)) return false;
    if (e.types && !e.types.includes(weapon.type)) return false;
    if (['elemFlat', 'elemPct', 'critElem', 'elder'].includes(e.term) && !dmgElem) return false;
    if (e.rate !== undefined || e.rateFrom) return rateOf(e.rateFrom || kind, settings, weapon.type) > 0;
    return true;
  });
}

function addPairs(target, pairs, sign = 1) {
  for (const [k, lv] of pairs) target[k] = (target[k] || 0) + lv * sign;
}

function capLevels(raw, skillDefs) {
  const out = {};
  for (const [k, lv] of Object.entries(raw)) {
    if (lv <= 0) continue;
    out[k] = Math.min(lv, skillDefs[k] ? skillDefs[k].max : lv);
  }
  return out;
}

// 錬成の割り当て
// raw: 錬成前のスキル合計（上限カット前）
// sources: [{ cap, tokens: {kind: count} | null(=自由), allowed: Set|null, pieceId }]
// returns { raw, drifts: [{pieceId, kind, lv}], value, result }
export function allocateDrifts(weapon, raw0, sources, ctx) {
  const { skillDefs, settings, required, relevantKinds, freeKinds } = ctx;
  const raw = { ...raw0 };
  const srcs = sources.map((s) => ({ ...s, left: s.cap, tokens: s.tokens ? { ...s.tokens } : null }));
  const drifts = [];
  const evalRaw = (r) => computeDamage(weapon, capLevels(r, skillDefs), skillDefs, settings);
  const kindsFor = (s, list) => (s.tokens ? list.filter((k) => (s.tokens[k] || 0) > 0) : list.filter((k) => freeKinds.has(k)));
  const place = (s, kind, n) => {
    raw[kind] = (raw[kind] || 0) + n;
    s.left -= n;
    if (s.tokens) s.tokens[kind] -= n;
    const last = drifts.find((d) => d.pieceId === s.pieceId && d.kind === kind);
    if (last) last.lv += n; else drifts.push({ pieceId: s.pieceId, kind, lv: n });
  };

  // 1) 必須スキルを満たす（所持リストの防具 → 自由錬成の防具の順）
  const unmet = {};
  for (const [kind, need] of Object.entries(required || {})) {
    let deficit = need - (raw[kind] || 0);
    if (deficit <= 0) continue;
    const ordered = [...srcs].sort((a, b) => (a.tokens ? 0 : 1) - (b.tokens ? 0 : 1));
    for (const s of ordered) {
      if (deficit <= 0) break;
      const avail = s.tokens ? Math.min(s.left, s.tokens[kind] || 0) : (freeKinds.has(kind) ? s.left : 0);
      const n = Math.min(avail, deficit);
      if (n > 0) { place(s, kind, n); deficit -= n; }
    }
    if (deficit > 0) unmet[kind] = deficit;
  }

  // 2) 残りの枠を期待値が最も伸びるように埋める
  let cur = evalRaw(raw).expected;
  for (let guard = 0; guard < 40; guard++) {
    let best = null;
    for (const s of srcs) {
      if (s.left <= 0) continue;
      for (const kind of kindsFor(s, relevantKinds)) {
        const max = skillDefs[kind] ? skillDefs[kind].max : 5;
        const have = raw[kind] || 0;
        const room = Math.min(s.left, max - have, s.tokens ? s.tokens[kind] : Infinity);
        for (let n = 1; n <= room; n++) {
          raw[kind] = have + n;
          const v = evalRaw(raw).expected;
          const gain = (v - cur) / n;
          if (gain > 1e-9 && (!best || gain > best.gain)) best = { s, kind, n, gain, v };
        }
        raw[kind] = have;
        if (!have) delete raw[kind];
      }
    }
    if (!best) break;
    place(best.s, best.kind, best.n);
    cur = best.v;
  }
  const levels = capLevels(raw, skillDefs);
  const result = computeDamage(weapon, levels, skillDefs, settings);
  return { raw, levels, drifts, value: result.expected, result, unmet };
}

// 1つの構成を評価する
// pieces: { head: option, ... } option = { id, name, grade, slots, skills, drift: {mode, tokens, fixed} }
export function evaluateBuild(weapon, pieces, ctx) {
  const raw = {};
  addPairs(raw, weapon.skills);
  const sources = [];
  const freePieces = [];
  for (const part of PARTS) {
    const p = pieces[part];
    if (!p) continue;
    addPairs(raw, p.skills);
    const d = p.drift || { mode: 'none' };
    if (!p.slots) continue;
    if (d.mode === 'fixed') {
      let left = p.slots;
      for (const [k, lv] of d.fixed || []) {
        const n = Math.min(left, lv);
        if (n > 0) { raw[k] = (raw[k] || 0) + n; left -= n; }
      }
    } else if (d.mode === 'free') {
      freePieces.push(p);
    } else if (d.mode === 'owned') {
      sources.push({ cap: p.slots, tokens: Object.fromEntries(d.tokens || []), pieceId: p.id });
    }
  }
  // 自由錬成の枠は1つにまとめて割り当て（Lv2→5 のようなまとめての伸びを評価できるように）、
  // 結果を各防具の枠数に振り分ける
  const freeCap = freePieces.reduce((n, p) => n + p.slots, 0);
  if (freeCap > 0) sources.push({ cap: freeCap, tokens: null, pieceId: '_free' });
  const out = allocateDrifts(weapon, raw, sources, ctx);
  const pooled = out.drifts.filter((d) => d.pieceId === '_free');
  out.drifts = out.drifts.filter((d) => d.pieceId !== '_free');
  let fi = 0;
  let left = freePieces.length ? freePieces[0].slots : 0;
  for (const d of pooled) {
    let n = d.lv;
    while (n > 0 && fi < freePieces.length) {
      if (left === 0) { fi++; left = fi < freePieces.length ? freePieces[fi].slots : 0; continue; }
      const take = Math.min(n, left);
      out.drifts.push({ pieceId: freePieces[fi].id, kind: d.kind, lv: take });
      n -= take;
      left -= take;
    }
  }
  // fixed の錬成も表示用に drifts に含める
  for (const part of PARTS) {
    const p = pieces[part];
    if (p && p.drift && p.drift.mode === 'fixed' && p.slots) {
      let left = p.slots;
      for (const [k, lv] of p.drift.fixed || []) {
        const n = Math.min(left, lv);
        if (n > 0) { out.drifts.push({ pieceId: p.id, kind: k, lv: n, fixed: true }); left -= n; }
      }
    }
  }
  const slotsTotal = PARTS.reduce((s, part) => s + ((pieces[part] && pieces[part].slots) || 0), 0);
  return { ...out, slotsTotal };
}

// ---- 高速探索 ----------------------------------------------------------------

// 自由錬成どうしの優越判定:
//   A が B 以上 ⇔ 錬成できないスキルはすべて A ≥ B、かつ
//   錬成できるスキルで B が上回る分の合計 ≤ A の錬成枠 − B の錬成枠
//   （A の余った枠でその差を埋めれば、B を使った構成を必ず再現できる）
function makeGeq(K, driftableMask, nonMono) {
  return (a, b) => {
    if (a.owned || b.owned) return false; // 所持リスト付きの防具は常に残す
    const slackSlots = a.free - b.free;
    if (slackSlots < 0) return false;
    let deficit = 0;
    for (let i = 0; i < K; i++) {
      const x = a.v[i];
      const y = b.v[i];
      if (nonMono[i]) { if (x !== y) return false; continue; }
      if (x >= y) continue;
      if (a.free > 0 && driftableMask[i]) { deficit += y - x; if (deficit > slackSlots) return false; } else return false;
    }
    return true;
  };
}

export function pruneFast(items, geq) {
  const kept = [];
  for (let i = 0; i < items.length; i++) {
    let dominated = false;
    let dupOf = -1;
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      if (geq(items[j], items[i])) {
        if (geq(items[i], items[j])) { if (j < i && dupOf < 0) dupOf = j; } else { dominated = true; break; }
      }
    }
    if (dominated) continue;
    if (dupOf >= 0) {
      const host = kept.find((k) => k.src === dupOf);
      if (host) { host.alternatives.push(items[i].o.name); continue; }
    }
    kept.push({ ...items[i], src: i, alternatives: [] });
  }
  return kept;
}

// weapons: 解決済み武器の配列（1本ならロック）
// partOptions: { head: [option...], ... }（1つだけならロック）
// opts: { skillDefs, settings, required, freeKinds:Set, topN, timeLimitMs, onProgress, maxCombos }
export function searchBuilds(weapons, partOptions, opts) {
  const { skillDefs, settings = {}, required = {}, topN = 30, timeLimitMs = 20000, onProgress } = opts;
  const maxCombos = opts.maxCombos || 150000;
  const freeKinds = opts.freeKinds || new Set();
  const t0 = Date.now();
  const top = [];
  let evaluated = 0;
  let timedOut = false;
  let approximated = false;
  const threshold = () => (top.length >= topN ? top[top.length - 1].score : -Infinity);
  const pushTop = (e) => {
    top.push(e);
    top.sort((a, b) => b.score - a.score);
    if (top.length > topN) top.length = topN;
  };

  for (let wi = 0; wi < weapons.length && !timedOut; wi++) {
    const weapon = weapons[wi];
    const kindSet = new Set(Object.keys(SKILL_EFFECTS).filter((k) => isRelevant(k, weapon, settings)));
    for (const k of Object.keys(required)) kindSet.add(k);
    for (const k of [...kindSet]) {
      for (const e of SKILL_EFFECTS[k] || []) {
        if (e.needs) kindSet.add(e.needs[0]);
        if (e.perHp) kindSet.add('HEALTH_BOOST');
      }
    }
    const kinds = [...kindSet];
    const K = kinds.length;
    const ev = compileEvaluator(weapon, skillDefs, settings, kinds);
    const evOpt = compileEvaluator(weapon, skillDefs, { ...settings, optimistic: true }, kinds);
    const driftableMask = kinds.map((k) => freeKinds.has(k));
    const nonMono = kinds.map((k) => NON_MONOTONE.has(k));
    const reqArr = kinds.map((k) => required[k] || 0);
    const freeIdx = kinds.map((k, i) => i).filter((i) => driftableMask[i] && SKILL_EFFECTS[kinds[i]]);

    const toVec = (pairs, extra) => {
      const v = new Int16Array(K);
      for (const [k, lv] of pairs) { const i = ev.index[k]; if (i !== undefined) v[i] += lv; }
      if (extra) for (const [k, lv] of extra) { const i = ev.index[k]; if (i !== undefined) v[i] += lv; }
      return v;
    };
    const baseVec = toVec(weapon.skills);

    const parts = [];
    for (const part of PARTS) {
      const list = partOptions[part] || [];
      if (!list.length) continue;
      const items = list.map((o) => {
        const d = o.drift || { mode: 'none' };
        const fixed = d.mode === 'fixed' ? (d.fixed || []) : null;
        return {
          o,
          v: toVec(o.skills, fixed),
          free: d.mode === 'free' ? (o.slots || 0) : 0,
          owned: d.mode === 'owned' && o.slots ? { cap: o.slots, tokens: kinds.map((k) => { const t = (d.tokens || []).find((x) => x[0] === k); return t ? t[1] : 0; }) } : null,
        };
      });
      const cand = items.length > 1 ? pruneFast(items, makeGeq(K, driftableMask, nonMono)) : items.map((x) => ({ ...x, alternatives: [] }));
      parts.push({ part, cand });
    }

    // 組み合わせが多すぎる場合は、各部位を単体評価の上位に絞って総当たりし（近似）、
    // その後「1部位ずつ全候補と入れ替える」山登りで改善する。
    for (const p of parts) p.all = p.cand.slice();
    const budget = Math.max(2000, Math.floor(maxCombos / weapons.length));
    let combos = parts.reduce((x, p) => x * p.cand.length, 1);
    if (combos > budget) {
      approximated = true;
      const solo = (c) => {
        const lv = Int16Array.from(baseVec);
        for (let i = 0; i < K; i++) lv[i] += c.v[i];
        return fillDrifts(lv, c.free, c.owned ? [{ ...c.owned, id: c.o.id }] : [], ev, evOpt, freeIdx, reqArr, false).value;
      };
      for (const p of parts) for (const c of p.cand) c.solo = solo(c);
      for (const p of parts) p.cand.sort((x, y) => y.solo - x.solo);
      while (combos > budget) {
        const big = parts.reduce((x, y) => (x.cand.length >= y.cand.length ? x : y));
        big.cand = big.cand.slice(0, Math.max(1, big.cand.length - 1));
        combos = parts.reduce((x, p) => x * p.cand.length, 1);
      }
    }
    parts.sort((a, b) => a.cand.length - b.cand.length);
    if (opts.debug) console.log('K', K, 'free', freeIdx.length, parts.map((p) => p.part + ':' + p.cand.length + '/' + p.all.length).join(' '));

    const memo = new Map();
    const seen = new Set();
    const evalChoice = (choice) => {
      const lv = Int16Array.from(baseVec);
      let freeSlots = 0;
      const owned = [];
      for (const c of choice) {
        for (let k = 0; k < K; k++) lv[k] += c.v[k];
        freeSlots += c.free;
        if (c.owned) owned.push({ ...c.owned, id: c.o.id });
      }
      const key = lv.join(',') + '|' + freeSlots + '|' + owned.map((o) => o.id).join(',');
      let r = memo.get(key);
      if (!r) {
        r = fillDrifts(lv, freeSlots, owned, ev, evOpt, freeIdx, reqArr, false);
        if (memo.size < 200000) memo.set(key, r);
      }
      evaluated++;
      return r.unmet > 0 ? r.value - 1e9 * r.unmet : r.value;
    };
    const consider = (choice) => {
      const id = wi + '|' + choice.map((c) => c.o.id).join(',');
      if (seen.has(id)) return null;
      seen.add(id);
      const score = evalChoice(choice);
      if (score > threshold()) {
        pushTop({ score, weapon, choice: choice.slice(), pieces: Object.fromEntries(parts.map((p, j) => [p.part, { ...choice[j].o, alternatives: choice[j].alternatives }])) });
      }
      if ((evaluated & 2047) === 0) {
        if (onProgress) onProgress({ evaluated, elapsed: Date.now() - t0, weapon: wi + 1, weapons: weapons.length });
        if (Date.now() - t0 > timeLimitMs) timedOut = true;
      }
      return score;
    };

    const chosen = new Array(parts.length);
    const dfs = (i) => {
      if (timedOut) return;
      if (i === parts.length) { consider(chosen); return; }
      for (const c of parts[i].cand) {
        chosen[i] = c;
        dfs(i + 1);
        if (timedOut) break;
      }
    };
    dfs(0);

    // 山登り: この武器の上位構成から、1部位ずつ全候補と入れ替えを試す
    if (approximated) {
      for (let round = 0; round < 4 && !timedOut; round++) {
        let improved = false;
        const base = top.filter((e) => e.weapon === weapon).map((e) => e.choice);
        for (const choice of base) {
          for (let i = 0; i < parts.length && !timedOut; i++) {
            for (const c of parts[i].all) {
              if (c === choice[i]) continue;
              const next = choice.slice();
              next[i] = c;
              const before = threshold();
              const sc = consider(next);
              if (sc !== null && sc > before) improved = true;
            }
          }
        }
        if (!improved) break;
      }
    }
  }

  // 上位の構成は、表示用に詳細計算（計算過程・錬成の割り当て）をやり直す
  const ctxFor = (weapon) => {
    const relevantKinds = Object.keys(SKILL_EFFECTS).filter((k) => isRelevant(k, weapon, settings));
    return { skillDefs, settings, required, relevantKinds, freeKinds };
  };
  const results = top.map((e) => {
    const detail = evaluateBuild(e.weapon, e.pieces, ctxFor(e.weapon));
    return { ...e, value: e.score, damage: detail.value, eval: detail, unmet: detail.unmet };
  });
  results.sort((a, b) => (Object.keys(a.unmet).length - Object.keys(b.unmet).length) || (b.damage - a.damage));
  return { results, evaluated, timedOut, approximated, elapsed: Date.now() - t0 };
}

// 錬成の割り当て（高速版）。lv は書き換える。
// owned: [{cap, tokens: 長さKの配列}]
export function fillDrifts(lv, freeSlots, owned, ev, evOpt, freeIdx, reqArr, optimistic) {
  const E = optimistic ? evOpt : ev;
  const srcs = [];
  if (freeSlots > 0) srcs.push({ left: freeSlots, tokens: null });
  for (const o of owned) srcs.push({ left: o.cap, tokens: Array.from(o.tokens) });
  let unmet = 0;
  // 必須スキル
  for (let i = 0; i < lv.length; i++) {
    let deficit = reqArr[i] - lv[i];
    if (deficit <= 0) continue;
    for (let s = srcs.length - 1; s >= 0 && deficit > 0; s--) {
      const src = srcs[s];
      const avail = src.tokens ? Math.min(src.left, src.tokens[i]) : (freeIdx.includes(i) ? src.left : 0);
      const n = Math.min(avail, deficit);
      if (n > 0) { lv[i] += n; src.left -= n; if (src.tokens) src.tokens[i] -= n; deficit -= n; }
    }
    if (deficit > 0) unmet += deficit;
  }
  let st = E.stateOf(lv);
  let cur = E.evaluate(lv);
  for (let guard = 0; guard < 40; guard++) {
    let bestGain = 1e-9;
    let bs = -1;
    let bi = -1;
    let bn = 0;
    let bv = cur;
    for (let s = 0; s < srcs.length; s++) {
      const src = srcs[s];
      if (src.left <= 0) continue;
      const cands = src.tokens ? null : freeIdx;
      const n0 = cands ? cands.length : lv.length;
      for (let q = 0; q < n0; q++) {
        const i = cands ? cands[q] : q;
        if (src.tokens && src.tokens[i] <= 0) continue;
        const have = lv[i];
        let room = Math.min(src.left, E.max[i] - have);
        if (src.tokens) room = Math.min(room, src.tokens[i]);
        for (let n = 1; n <= room; n++) {
          const v = E.moveValue(st, lv, i, n);
          const g = (v - cur) / n;
          if (g > bestGain) { bestGain = g; bs = s; bi = i; bn = n; bv = v; }
        }
      }
    }
    if (bs < 0) break;
    lv[bi] += bn;
    srcs[bs].left -= bn;
    if (srcs[bs].tokens) srcs[bs].tokens[bi] -= bn;
    st = E.stateOf(lv);
    cur = bv;
  }
  return { value: optimistic ? cur : ev.evaluate(lv), unmet };
}

export { sumSkills };
