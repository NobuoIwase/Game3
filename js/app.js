// UI 層（DESIGN.md §7, §8）。ゲームの編成画面に似せた構成。
// 計算は js/calc.js、最適化は js/optimizer.js、永続化は js/store.js に分離してある。
// エラーメッセージはすべて日本語で、原因と対処が分かる文言にする（§6）。

import { STATS, STAT_LABELS, computeStat, marginalValues } from './calc.js';
import { sumFragmentEffects, fragmentStatEffects, lookupEffectName, conditionMatches } from './effects.js';
import {
  optimizeParty, partyAbilityCorrections, canEquip, characterDetail,
  statBase, autoAbilityLevel, memberAbilityGroups, isTournamentOnly, zRelationCounts,
  pickZenkaiMembers, bestForCharacter, fragsConflict,
} from './optimizer.js';
import * as store from './store.js';
import { parseCharacterListHTML, parseTagSelectHTML } from './parser.js';

// ---------------------------------------------------------------- 状態

const state = { game: null, my: null, overrides: null };

const ui = {
  tab: 'party',
  // mode: 'standard'（バトル3体＋ゼンカイ枠3体） | 'proud'（プラウドバトル: 1戦目3体＋2戦目3体）
  party: { mode: 'standard', memberIds: ['', '', '', '', '', ''], equips: {} }, // equips: cid → [fragId|null,...]
  displayStat: 'strike_atk',
  opt: {
    targets: 'battle', mode: 'single', stat: 'strike_atk',
    preset: 'strike_total', weights: Object.fromEntries(STATS.map((s) => [s, 0])),
    optimizeLeader: true,
    autoZenkai: true, // 最適化時にゼンカイ枠（下段3枠）を所持キャラから自動選出する
    styleSplit: true, // 打撃/射撃タイプのキャラは自分のタイプに合わせた重みで組む
    // 条件未達の効果を持つフラグを丸ごと除外するか。既定OFF: 除外すると強フラグまで
    // 候補から消えて弱い装備になりがち（未達の効果はもともと0価値で公平に評価される）
    excludeUnmetCond: false,
    // 条件未達の効果行を持つフラグを未達1行につき5%減点して選出するか。既定ON:
    // 僅差なら全発動フラグが勝ち、未達持ちは明確に強いときだけ選ばれる（実ステには影響しない）
    penalizeUnmetCond: true,
  },
  charFilter: null, // defaultCharFilter() で初期化（boot 時）
  fragFilter: { q: '', rarity: '', ownedOnly: false },
  calc: {
    stat: 'strike_atk', total: 273617, boost: 42080,
    z: 149, zenkai: 0, ll: 30,
    mode: 'direct', fragBase: 0, fragNonBase: 0, charId: '', selected: {},
  },
};

const ELEMENTS = ['RED', 'YEL', 'PUR', 'GRN', 'BLU', 'LGT', 'DRK'];

// ---------------------------------------------------------------- キャラのソート/フィルタ（ゲームのソート・フィルタ画面準拠）

const CHAR_SORTS = [
  ['id', '入手順'], ['card_no', 'カード番号'], ['rarity', 'レアリティ'], ['element', '属性'],
  ['stars', '限界突破'], ['hp', '体力'], ['strike_atk', '打撃攻撃'], ['blast_atk', '射撃攻撃'],
  ['strike_def', '打撃防御'], ['blast_def', '射撃防御'], ['critical', 'クリティカル'], ['ki_recovery', '気力回復'],
];
const RARITY_ORDER = { ULTRA: 6, LEGEND: 5, SPARKING: 4, EXTREME: 3, HERO: 2 };
const CHAR_RARITIES = ['HERO', 'EXTREME', 'SPARKING', 'LEGEND', 'ULTRA'];
const STYLE_TAGS = [13000, 13001, 13002, 13003]; // 援護/防御/打撃/射撃タイプ

function defaultCharFilter() {
  return {
    q: '', sort: 'id', desc: true,
    els: [], rarities: [], ll: false, styles: [],
    owned: '', zenkai: false, tagName: '', zStat: '',
  };
}

/** キャラのZ/ZENKAIアビリティ（最大レベル）が指定ステータスを盛るか */
function charBoostsStat(def, stat) {
  for (const list of [def.z_ability, def.zenkai_ability]) {
    const top = list?.[list.length - 1];
    for (const g of top?.groups || []) {
      for (const e of g.effects || []) {
        const hit = lookupEffectName(e.text, state.game.effectMap);
        if (hit && hit.stats && hit.stats.includes(stat)) return true;
      }
    }
  }
  return false;
}

function applyCharSortFilter(defs, f) {
  const q = f.q.trim();
  const tagId = f.tagName
    ? Number(Object.entries(state.game.tags).find(([, n]) => n === f.tagName)?.[0])
    : null;
  let list = defs.filter((d) =>
    (!q || (d.name || '').includes(q) || (d.card_no || '').includes(q)) &&
    (f.els.length === 0 || f.els.some((e2) => (d.elements || [d.element]).includes(e2))) &&
    (f.rarities.length === 0 || f.rarities.includes(d.rarity)) &&
    (!f.ll || d.lf) &&
    (f.styles.length === 0 || f.styles.some((t) => (d.tags || []).includes(t))) &&
    (f.owned === '' || (f.owned === 'owned') === isOwned(d.id)) &&
    (!f.zenkai || d.zenkai) &&
    (tagId == null || Number.isNaN(tagId) || (d.tags || []).includes(tagId)) &&
    (!f.zStat || charBoostsStat(d, f.zStat)));

  const val = (d) => {
    switch (f.sort) {
      case 'id': return d.id;
      case 'rarity': return RARITY_ORDER[d.rarity] || 0;
      case 'element': return ELEMENTS.indexOf(d.element);
      case 'stars': return charMy(d.id) ? (Number(charMy(d.id).stars) || 0) : (isOwned(d.id) ? 7 : -1);
      case 'critical': return Number(d.soul_max?.critical) || 0;
      default: return Number(d.stats?.[f.sort]) || 0;
    }
  };
  const dir = f.desc ? -1 : 1;
  list.sort((a, b) => {
    let c;
    if (f.sort === 'card_no') c = String(a.card_no || '').localeCompare(String(b.card_no || ''));
    else c = val(a) - val(b);
    return c !== 0 ? dir * c : b.id - a.id; // 同値は入手順（新しい順）
  });
  return list;
}

/** ソート/フィルタ操作UI（キャラタブと編成のキャラ選択で共用） */
function charFilterControls(f, onChange) {
  const chip = (label, isOn, toggle) => el('button', {
    class: `chip${isOn() ? ' on' : ''}`,
    onclick: () => { toggle(); onChange(); },
  }, label);
  const toggleIn = (arr, v) => {
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1); else arr.push(v);
  };
  return el('div', {},
    el('div', { class: 'filter-row sticky-bar' },
      el('input', {
        type: 'search', value: f.q, placeholder: '名前・カード番号で検索',
        oninput: (e) => { f.q = e.target.value; onChange(); },
      }),
      el('select', {
        style: 'flex:none;width:110px',
        onchange: (e) => { f.sort = e.target.value; onChange(); },
      }, CHAR_SORTS.map(([k, label]) => el('option', { value: k, selected: f.sort === k }, label))),
      el('button', {
        class: 'chip on', style: 'flex:none',
        onclick: (e) => { f.desc = !f.desc; e.target.textContent = f.desc ? '降順▼' : '昇順▲'; onChange(); },
      }, f.desc ? '降順▼' : '昇順▲')),
    el('details', {},
      el('summary', {}, 'フィルタ'),
      el('div', { class: 'chip-row' },
        CHAR_RARITIES.map((r) => chip(r, () => f.rarities.includes(r), () => toggleIn(f.rarities, r))),
        chip('LL', () => f.ll, () => { f.ll = !f.ll; })),
      el('div', { class: 'chip-row' },
        ELEMENTS.map((e2) => chip(e2, () => f.els.includes(e2), () => toggleIn(f.els, e2)))),
      el('div', { class: 'chip-row' },
        STYLE_TAGS.map((t) => chip(tagName(t), () => f.styles.includes(t), () => toggleIn(f.styles, t))),
        chip('ZENKAI', () => f.zenkai, () => { f.zenkai = !f.zenkai; })),
      el('div', { class: 'chip-row' },
        chip('獲得済み', () => f.owned === 'owned', () => { f.owned = f.owned === 'owned' ? '' : 'owned'; }),
        chip('未獲得', () => f.owned === 'unowned', () => { f.owned = f.owned === 'unowned' ? '' : 'unowned'; })),
      el('div', { class: 'row' },
        el('label', {}, 'タグ・エピソード指定',
          el('input', {
            type: 'text', list: 'tag-datalist', value: f.tagName, placeholder: '指定なし',
            onchange: (e) => { f.tagName = e.target.value.trim(); onChange(); },
          })),
        el('label', {}, 'Z/ZENKAIアビ効果',
          el('select', { onchange: (e) => { f.zStat = e.target.value; onChange(); } },
            el('option', { value: '', selected: f.zStat === '' }, '指定なし'),
            STATS.map((s) => el('option', { value: s, selected: f.zStat === s }, STAT_LABELS[s]))))),
      el('button', {
        class: 'btn secondary small',
        onclick: () => { Object.assign(f, defaultCharFilter()); onChange(true); },
      }, 'リセット')),
    el('datalist', { id: 'tag-datalist' },
      Object.values(state.game.tags).sort().map((n) => el('option', { value: n }))));
}
// 重みは「Σ 重み × ❸（絶対値）」の空間の値（§17）。ステータスごとに ❶ の桁が大きく違う
// （体力 ≈160万 / 攻撃 ≈22万 / 防御 ≈15万）ため、「特化（総合重視）」系は桁を補正した重みにしている
// （例: 体力0.07 ≒ 相対値時代の0.5に相当）。クリティカル・気力回復は❸換算の絶対値が微小なため
// 多ステータス目標からは除外（単一ステータス指定や総合ステ最大では従来どおり扱える）。
const PRESETS = {
  strike_pure: { label: '完全打撃特化', weights: { strike_atk: 1 } },
  strike_total: { label: '打撃特化（総合重視）', weights: { strike_atk: 1, blast_atk: 0.15, hp: 0.07, strike_def: 0.5, blast_def: 0.5 } },
  balance: { label: '総合バランス', weights: { hp: 0.08, strike_atk: 0.8, blast_atk: 0.8, strike_def: 0.75, blast_def: 0.75 } },
  // 「付いている補正%の合計」を最大化する（+1%はどのステータスでも等価）。
  // percent: true のプリセットは、キャラごとに ❶ で正規化した重み（w×100000/❶）を実行時に生成する。
  // クリティカル・気力回復は%が安く稼げて評価が荒れるため対象外（主要5ステのみ）
  total: {
    label: '総合強化重視（補正%の合計を最大化）', percent: true,
    weights: { hp: 1, strike_atk: 1, blast_atk: 1, strike_def: 1, blast_def: 1 },
  },
  blast_total: { label: '射撃特化（総合重視）', weights: { blast_atk: 1, strike_atk: 0.15, hp: 0.07, strike_def: 0.5, blast_def: 0.5 } },
  blast_pure: { label: '完全射撃特化', weights: { blast_atk: 1 } },
  // 体力被回復量（heal_received）は擬似ステータス（§25: +1% = 重み×1,000点。
  // 重み1で防御+0.6〜0.8%相当）。回復役がいるパーティでは耐久に直結する
  defense: { label: '耐久特化', weights: { hp: 0.14, strike_def: 1, blast_def: 1, heal_received: 0.3 } },
  defense_heal: {
    label: '耐久特化（被回復量重視）',
    weights: { hp: 0.14, strike_def: 1, blast_def: 1, heal_received: 1 },
  },
  // ゲーム内メタの参考評価: 体力は高いほど良い / 打撃は射撃よりダメージが出るため
  // 打撃攻撃と打撃防御をやや重視。補正%等価（percent）をベースに重みだけ傾ける。
  meta: {
    label: '実戦バランス（ゲームメタ重視）', percent: true,
    weights: { hp: 1.15, strike_atk: 1.1, blast_atk: 0.95, strike_def: 1.15, blast_def: 0.85 },
  },
};

// バトルスタイル → 長所を伸ばす最適化目標（提案機能）。
// タイプに合ったステータスほど基礎値が高く、%補正の効果も大きい。
const STYLE_OBJECTIVES = [
  { tag: 13002, opt: { mode: 'single', stat: 'strike_atk' }, objLabel: '打撃攻撃力の単一最大化', metric: 'strike_atk' },
  { tag: 13003, opt: { mode: 'single', stat: 'blast_atk' }, objLabel: '射撃攻撃力の単一最大化', metric: 'blast_atk' },
  { tag: 13001, opt: { mode: 'preset', preset: 'defense' }, objLabel: '耐久特化プリセット', metric: 'hp' },
  { tag: 13000, opt: { mode: 'preset', preset: 'defense' }, objLabel: '耐久特化プリセット', metric: 'hp' },
];

// ---------------------------------------------------------------- DOM ヘルパ

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected' || k === 'readOnly') node[k] = v;
    else if (k === 'value') node.value = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(3)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** replaceChildren / append に null・false を渡すと "null" 文字列になるのを防ぐ */
function nodes(...children) {
  return children.flat(3).filter((c) => c != null && c !== false);
}

function fmt(n, digits = 2) {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
const fmt0 = (n) => fmt(n, 0);

function showMsg(type, text) {
  const box = el('div', { class: `msg msg-${type}` }, text);
  box.append(el('button', { class: 'close', onclick: () => box.remove() }, '×'));
  $('#banner').append(box);
  return box;
}
function clearMsgs() { $('#banner').replaceChildren(); }

function tagName(id) { return state.game.tags[String(id)] || `タグ${id}`; }
function tagChips(ids) { return (ids || []).map((t) => el('span', { class: 'tagchip' }, tagName(t))); }

function assetURL(path) {
  if (!path) return '';
  const base = state.game.config.asset_base || '';
  return path.startsWith('http') ? path : base + (path.startsWith('/') ? path : '/' + path);
}
function lazyImg(path, alt = '') {
  if (!path) return el('div', { class: 'noimg' });
  return el('img', {
    src: assetURL(path), alt, loading: 'lazy',
    onerror: (e) => { e.target.style.display = 'none'; },
  });
}

function labeledNum(labelText, model, key, opts = {}) {
  return el('label', {}, labelText,
    el('input', {
      type: 'number', inputmode: 'decimal', step: 'any', value: model[key],
      oninput: (e) => { model[key] = e.target.value === '' ? 0 : Number(e.target.value); opts.oninput?.(); },
    }));
}

// ---------------------------------------------------------------- 共通データアクセス

async function persistMy() {
  syncPartyToMyData();
  try { await store.saveMyData(state.my); }
  catch (e) { showMsg('error', `■ 保存に失敗しました\n${e.message}`); }
}
async function persistOverridesAndReload() {
  try {
    await store.saveOverrides(state.overrides);
    state.game = await store.loadGameData();
  } catch (e) { showMsg('error', `■ 保存に失敗しました\n${e.message}`); }
}

function charDef(id) { return state.game.characters[String(id)]; }
function fragDef(id) { return state.game.fragments[String(id)]; }
/** 覚醒フラグメント判定（rarity コードが awakened〜。ゲーム内では豪華枠で区別される） */
function isAwakenedFrag(f) { return String(f?.rarity || '').startsWith('awakened'); }
function charMy(id) { return state.my.characters[String(id)]; }
/**
 * 所持判定。既定は「全キャラ所持」（own_all !== false）。
 * 星やブーストの個別カスタマイズは charMy への登録（ensureCharMy）で行い、
 * 未登録キャラは defaultCharMy（★7・ソウルブースト最大）として扱う。
 */
function isOwned(id) { return state.my.own_all !== false || !!charMy(id); }
/** カスタマイズ保存用に my 登録を保証する（未登録なら既定値で作る） */
function ensureCharMy(id) {
  const cid = String(id);
  if (!state.my.characters[cid]) state.my.characters[cid] = defaultCharMy(charDef(cid));
  return state.my.characters[cid];
}
const zeroStats = () => Object.fromEntries(STATS.map((s) => [s, 0]));

/** フラグメント所持数。初期値は6枚（未設定時）。タップで自由に増減できる */
const DEFAULT_FRAG_COUNT = 6;
function fragCount(id) {
  const v = state.my.fragments[String(id)];
  return v == null ? DEFAULT_FRAG_COUNT : Math.max(0, Number(v) || 0);
}
async function setFragCount(id, n) {
  state.my.fragments[String(id)] = Math.max(0, Math.floor(n));
  await persistMy();
}

function defaultCharMy(def) {
  return {
    stars: 7, equip_slots: 3,
    boost: { ...zeroStats(), ...(def?.soul_max || {}) },
    total_override: {},
    z_level: 'auto', deploy_z_level: 'auto', zenkai_level: 'auto',
    z_ability: [], ll_ability: [], zenkai_ability: [],
  };
}

function partyMembers() {
  return ui.party.memberIds.filter((id) => id && charDef(id))
    .map((id) => ({ character: charDef(id), my: charMy(id) || defaultCharMy(charDef(id)) }));
}
/** バトルメンバー: スタンダード=上段3体 / プラウド=6体全員（1戦目・2戦目とも出撃） */
function battleIds() {
  const ids = ui.party.mode === 'proud' ? ui.party.memberIds : ui.party.memberIds.slice(0, 3);
  return ids.filter((id) => id && charDef(id));
}
/**
 * プラウド時のチーム分け（1戦目=枠1-3 / 2戦目=枠4-6）。
 * 空チームも位置を保持して返す（leaders 配列との添字対応を崩さないため。
 * optimizer 側が空チームを安全にスキップする）
 */
function proudTeams() {
  if (ui.party.mode !== 'proud') return null;
  return [
    ui.party.memberIds.slice(0, 3).filter((id) => id && charDef(id)),
    ui.party.memberIds.slice(3, 6).filter((id) => id && charDef(id)),
  ];
}

/** 編成＋最適化目標の署名（提案カードの陳腐化検出に使う。重み変更でも失効させる） */
function partySig() {
  return JSON.stringify([ui.party.mode, ...ui.party.memberIds, currentWeights()]);
}
/**
 * 効果条件（「バトルメンバーに〜がいると」）の判定文脈をキャラごとに作る。
 * スタンダード: 全員の文脈 = バトル3体 / プラウド: 自分のチーム3体
 */
function battleContexts(members) {
  const info = (m) => ({
    id: m.character.id, tags: m.character.tags,
    element: m.character.element, elements: m.character.elements,
  });
  const ctxs = {};
  if (ui.party.mode === 'proud') {
    for (const range of [[0, 3], [3, 6]]) {
      const teamIds = ui.party.memberIds.slice(range[0], range[1]).filter(Boolean).map(String);
      const teamMembers = members.filter((m) => teamIds.includes(String(m.character.id)));
      for (const m of teamMembers) {
        ctxs[String(m.character.id)] = { selfId: m.character.id, self: info(m), members: teamMembers.map(info) };
      }
    }
  } else {
    const bs = battleIds().map(String);
    const bm = members.filter((m) => bs.includes(String(m.character.id)));
    for (const m of members) {
      ctxs[String(m.character.id)] = { selfId: m.character.id, self: info(m), members: bm.map(info) };
    }
  }
  return ctxs;
}
function memberEquips(cid) {
  const slots = Number(charMy(cid)?.equip_slots) || 3;
  const arr = (ui.party.equips[String(cid)] || []).slice(0, slots);
  while (arr.length < slots) arr.push(null);
  return arr;
}
/** パーティ全体でのフラグメント使用数（excludeSlot: {cid, idx} を除外） */
function assignedCount(fid, exclude = null) {
  let n = 0;
  for (const cid of ui.party.memberIds) {
    if (!cid) continue;
    memberEquips(cid).forEach((f, idx) => {
      if (f === String(fid) || f === Number(fid)) {
        if (exclude && String(exclude.cid) === String(cid) && exclude.idx === idx) return;
        n++;
      }
    });
  }
  return n;
}

function syncPartyToMyData() {
  state.my.parties = [{
    name: '編成1',
    mode: ui.party.mode,
    // 空きスロットは null で位置を保持（キャラID 0 = 孫悟空 と衝突させない）
    member_ids: ui.party.memberIds.map((x) => (x === '' || x == null ? null : Number(x))),
    battle_ids: battleIds().map(Number),
    equips: ui.party.equips,
    display_stat: ui.displayStat,
    opt: ui.opt,
  }];
}
function restorePartyFromMyData() {
  const p = state.my.parties?.[0];
  if (!p) return;
  const ids = (p.member_ids || []).map((x) => (x == null || x === '' ? '' : String(x)));
  ui.party.memberIds = [0, 1, 2, 3, 4, 5].map((i) => ids[i] || '');
  ui.party.equips = p.equips || {};
  ui.party.mode = p.mode === 'proud' ? 'proud' : 'standard';
  if (p.display_stat) ui.displayStat = p.display_stat;
  if (p.opt) Object.assign(ui.opt, p.opt);
}

/** 未対応効果の一覧を §6 の文言で表示する */
function reportUnknown(unknownList) {
  if (!unknownList.length) return;
  const uniq = new Map();
  for (const u of unknownList) uniq.set(`${u.fragmentId}:${u.reason}`, u);
  const lines = [...uniq.values()]
    .map((u) => `・${u.reason}${u.fragmentName && u.fragmentName !== 'アビリティ' ? `（${u.fragmentName}）` : ''}`)
    .join('\n');
  showMsg('warn',
    `■ 未対応の効果が ${uniq.size} 件ありました\n${lines}\n` +
    'これらは計算に含まれていません。実際の数値とズレる可能性があります。\n' +
    'game_data/effect_map.json への追加が必要です。');
}

function checkRarities(fragIds) {
  const known = state.game.config.known_rarities || [];
  if (known.length === 0) return true;
  for (const id of fragIds) {
    const f = fragDef(id);
    if (f && f.rarity && !known.includes(f.rarity)) {
      showMsg('error',
        `■ 未知のレアリティ「${f.rarity}」を検出しました（フラグメント: ${f.name}）\n` +
        '計算を中止しました。game_data/config.json の known_rarities への追加が必要です。');
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- シート（オーバーレイ）

function openSheet(title, bodyNode) {
  $('#sheet-title').textContent = title;
  $('#sheet-body').replaceChildren(bodyNode);
  $('#sheet').classList.add('open');
  $('#sheet-backdrop').classList.add('open');
}
function closeSheet() {
  $('#sheet').classList.remove('open');
  $('#sheet-backdrop').classList.remove('open');
  $('#sheet-body').replaceChildren();
}

// ---------------------------------------------------------------- タブ

function switchTab(name) {
  ui.tab = name;
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
  document.querySelectorAll('#tabbar button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- 部品: キャラタイル / フラグタイル

function charTile(def, opts = {}) {
  const owned = isOwned(def.id);
  return el('div', {
    class: `char-tile el-${def.element}`,
    onclick: opts.onclick,
  },
    lazyImg(def.image, def.name),
    el('div', { class: `rarity-tag r-${def.rarity}` }, def.rarity ? def.rarity.slice(0, 2) : '?'),
    def.lf ? el('div', { class: 'll-tag' }, 'LL') : null,
    def.zenkai ? el('div', { class: 'll-tag', style: 'top:12px;background:linear-gradient(180deg,#9be08a,#3fa04f);color:#0c2a10' }, 'ZK') : null,
    owned && opts.showOwned !== false ? el('div', { class: 'owned-mark' }, '✓') : null,
    el('div', { class: 'cname' }, def.name));
}

function fragTile(f, opts = {}) {
  const count = fragCount(f.id);
  const used = assignedCount(f.id, opts.exclude);
  return el('div', {
    class: `frag-tile fr-${f.rarity || 'default'}${isAwakenedFrag(f) ? ' frag-awakened' : ''}${count > 0 ? '' : ' not-owned'}${opts.disabled ? ' disabled' : ''}`,
    onclick: opts.onclick,
    title: f.name,
  },
    lazyImg(f.icon, f.name),
    used > 0 ? el('div', { class: 'equipped-badge' }, '装備中') : null,
    isTournamentOnly(f) ? el('div', { class: 'top-badge' }, '力の大会') : null,
    el('div', { class: 'count-badge' }, opts.showRemaining ? `残${Math.max(0, count - used)}` : `×${count}`));
}

// ---------------------------------------------------------------- 編成タブ

/** 現在の編成でのアビリティ補正（編成画面・フラグ詳細で共通に使う） */
function currentPartyExt(members) {
  const proud = ui.party.mode === 'proud';
  return members.length
    ? partyAbilityCorrections({
        members, battleIds: battleIds(), teams: proudTeams(), effectMap: state.game.effectMap,
        leaderId: ui.party.memberIds[0] || null,
        leaders: proud ? [ui.party.memberIds[0] || null, ui.party.memberIds[3] || null] : undefined,
      })
    : {};
}

/**
 * このキャラの評価に実際に使われる重みと、その由来の表示名。
 * runOptimize と同じ優先順位: 個別指定 > パーティ目標固定 > タイプ自動入替 > パーティ目標
 */
function effectiveWeightsFor(cid) {
  const base = currentWeights();
  const member = { character: charDef(cid), my: charMy(cid) || defaultCharMy(charDef(cid)) };
  const pctPreset = currentPercentPreset();
  const obj = charMy(cid)?.objective;
  if (obj && obj !== 'auto') {
    if (obj !== 'party' && PRESETS[obj]) {
      return { weights: materializeWeights(PRESETS[obj], member), label: `個別指定: ${PRESETS[obj].label}` };
    }
    if (pctPreset) return { weights: materializeWeights(pctPreset, member), label: `パーティ目標（${pctPreset.label}）` };
    return { weights: base, label: 'パーティ目標（個別指定で固定）' };
  }
  if (pctPreset) return { weights: materializeWeights(pctPreset, member), label: `パーティ目標（${pctPreset.label}）` };
  if (ui.opt.styleSplit !== false) {
    const focus = (base.strike_atk || 0) > (base.blast_atk || 0) ? 'strike'
      : (base.blast_atk || 0) > (base.strike_atk || 0) ? 'blast' : null;
    const tags = charDef(cid)?.tags || [];
    if ((focus === 'blast' && tags.includes(13002)) || (focus === 'strike' && tags.includes(13003))) {
      return {
        weights: { ...base, strike_atk: base.blast_atk || 0, blast_atk: base.strike_atk || 0 },
        label: 'タイプ自動（打撃/射撃の重みを入替）',
      };
    }
  }
  return { weights: base, label: 'パーティ目標' };
}

function renderParty() {
  const root = $('#party-view');
  const proud = ui.party.mode === 'proud';
  const members = partyMembers();
  const bIds = battleIds();
  const teams = proudTeams();
  const ext = currentPartyExt(members);
  const contexts = battleContexts(members);

  // Z/ZENKAIアビリティの関係数（◎×N。スタンダード=パーティ6体 / プラウド=チーム内）
  // リーダーのタグ無視は選出時のみで編成画面の◎×Nには影響しない（実機確認 — §23）
  const relations = {};
  if (proud) {
    for (const range of [[0, 3], [3, 6]]) {
      const teamIds = ui.party.memberIds.slice(range[0], range[1]).filter(Boolean).map(String);
      const tm = members.filter((m) => teamIds.includes(String(m.character.id)));
      if (tm.length) Object.assign(relations, zRelationCounts(tm, state.game.effectMap));
    }
  } else if (members.length) {
    Object.assign(relations, zRelationCounts(members, state.game.effectMap));
  }
  if (!ui._prevRel) ui._prevRel = {};

  // 表示ステータスの合計（スタンダード=バトル3体 / プラウド=チーム別）
  const totals = [0, 0];
  const details = new Map();
  for (const m of members) {
    const cid = String(m.character.id);
    const fragList = memberEquips(cid).filter(Boolean).map(fragDef).filter(Boolean);
    const d = characterDetail({
      member: m, ext: ext[cid], fragmentList: fragList,
      effectMap: state.game.effectMap, context: contexts[cid],
    });
    details.set(cid, d);
    const st = d.stats[ui.displayStat];
    if (!st) continue;
    const slotIdx = ui.party.memberIds.findIndex((x) => String(x) === cid);
    if (proud) totals[slotIdx < 3 ? 0 : 1] += st.final;
    else if (bIds.map(String).includes(cid)) totals[0] += st.final;
  }

  const slotLabel = (i) => proud
    ? (i < 3 ? `1戦目 ${i + 1}` : `2戦目 ${i - 2}`)
    : (i < 3 ? `バトル ${i + 1}` : `ゼンカイ枠 ${i - 2}`);

  const slot = (i) => {
    const id = ui.party.memberIds[i];
    const def = id ? charDef(id) : null;
    const isLeader = def && (proud ? (i === 0 || i === 3) : i === 0);
    const rel = def ? (relations[String(id)] || 0) : 0;
    const powered = def && rel > (ui._prevRel[String(id)] || 0);
    const tile = def ? charTile(def, { onclick: () => openCharPicker(i), showOwned: false }) : null;
    if (tile && rel > 0) {
      tile.append(el('div', { class: 'rel-badge' }, `◎×${rel}`));
      if (powered) tile.classList.add('powerup');
    }
    return el('div', { class: 'party-slot' },
      isLeader ? el('div', { class: 'leader-badge' }, 'LEADER') : null,
      tile || el('div', { class: 'slot-empty', onclick: () => openCharPicker(i) }, '＋'),
      el('div', { class: 'party-label' }, slotLabel(i)));
  };

  const memberBadge = (cid) => {
    const idx = ui.party.memberIds.findIndex((x) => String(x) === cid);
    if (proud) return el('span', { class: 'badge ok' }, idx < 3 ? '1戦目' : '2戦目');
    return idx < 3 ? el('span', { class: 'badge ok' }, '出撃') : el('span', { class: 'badge ng' }, 'ゼンカイ枠');
  };

  const memberCard = (m) => {
    const cid = String(m.character.id);
    const d = details.get(cid);
    const st = d?.stats[ui.displayStat];
    const equips = memberEquips(cid);
    return el('div', { class: `member-card el-${m.character.element}${ui._flashCards ? ' flash' : ''}` },
      el('div', { class: 'portrait', onclick: () => openCharSheet(cid) }, lazyImg(m.character.image, m.character.name)),
      el('div', { class: 'm-body' },
        el('div', { class: 'm-name' }, m.character.name,
          (m.character.ultra_ability || []).length ? el('span', { class: 'ultra-badge', style: 'margin-left:4px' }, 'ULTRA') : null,
          memberBadge(cid)),
        el('div', { class: 'm-sub', style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap' },
          m.character.card_no,
          el('span', {}, starsSelectCompact(cid, m.my)),
          `Zアビ${['I', 'II', 'III', 'IV'][((m.my.z_level && m.my.z_level !== 'auto') ? m.my.z_level : autoAbilityLevel(m.my.stars)) - 1] || '—'}`,
          // キャラ個別の特化指定（自動=タイプ/パーティ目標に従う）
          el('select', {
            style: 'width:auto;display:inline-block;padding:1px 4px;margin:0;font-size:11px',
            onchange: async (e) => {
              ensureCharMy(cid).objective = e.target.value;
              await persistMy();
              renderParty();
            },
          },
            [['auto', '特化:自動'], ['party', '特化:パーティ目標'],
              ...Object.entries(PRESETS).map(([k, p]) => [k, `特化:${p.label}`])]
              .map(([v, label]) => el('option', {
                value: v, selected: (charMy(cid)?.objective || 'auto') === v,
              }, label)))),
        el('div', { class: 'frag-slots' },
          equips.map((fid, idx) => {
            const f = fid ? fragDef(fid) : null;
            return el('div', {
              class: `frag-slot${f ? ` fr-${f.rarity || 'default'}` : ''}${isAwakenedFrag(f) ? ' frag-awakened' : ''}`,
              // 装備済みはタップで詳細（条件達成状況つき）、空きスロットはピッカーを開く
              onclick: () => (f ? openFragSheet(String(fid), { cid, slotIdx: idx }) : openFragPicker(cid, idx)),
            }, f ? lazyImg(f.icon, f.name) : '＋');
          })),
        st
          ? el('div', { class: 'm-stats' },
              `${STAT_LABELS[ui.displayStat]} `,
              el('span', { class: 'v' }, fmt0(st.final)),
              ' ',
              el('span', { class: 'up' }, `フラグ換算 +${fmt(st.fragTotal, 1)}% / 補正 +${fmt(st.corr5, 0)}%`))
          : el('div', { class: 'm-stats' }, el('span', { class: 'small-note' }, 'ステータス未取得')),
        d?.conditionalOff?.length
          ? el('div', { class: 'effline' },
              el('span', { class: 'unknown', title: d.conditionalOff.map((c) => `${c.fragmentName}: ${c.cond_raw}${c.text}+${c.value}%`).join('\n') },
                `⚠ 条件未達で未発動の効果 ${d.conditionalOff.length} 件（${d.conditionalOff.map((c) => `${c.text}+${c.value}%`).join(' / ')}）`))
          : null));
  };

  const statSelect = el('select', {
    style: 'width:auto;display:inline-block;padding:2px 6px;margin:0;font-size:12px',
    onchange: (e) => { ui.displayStat = e.target.value; persistMy(); renderParty(); },
  }, STATS.map((s) => el('option', { value: s, selected: ui.displayStat === s }, STAT_LABELS[s])));

  root.replaceChildren(...nodes(
    el('div', { class: 'chip-row', style: 'margin-top:6px' },
      el('button', {
        class: `chip${!proud ? ' on' : ''}`,
        onclick: async () => { ui.party.mode = 'standard'; await persistMy(); renderParty(); },
      }, 'スタンダード'),
      el('button', {
        class: `chip${proud ? ' on' : ''}`,
        onclick: async () => { ui.party.mode = 'proud'; await persistMy(); renderParty(); },
      }, 'プラウドバトル')),
    proud
      ? el('div', { class: 'party-summary' },
          el('div', {}, statSelect, ' チーム別合計'),
          el('div', {},
            el('span', { class: 'val' }, fmt0(totals[0])),
            el('span', { class: 'small-note' }, ' / '),
            el('span', { class: 'val' }, fmt0(totals[1]))))
      : el('div', { class: 'party-summary' },
          el('div', {}, 'バトル3体 ', statSelect, ' 合計'),
          el('div', { class: 'val' }, fmt0(totals[0]))),
    el('div', { class: 'party-grid' }, [0, 1, 2].map(slot)),
    el('div', { class: 'party-grid' }, [3, 4, 5].map(slot)),
    proud
      ? el('p', { class: 'hint' },
          'プラウドバトル: 1戦目と2戦目は同一キャラを選べません（6体すべて出撃）。' +
          'アビリティ補正と効果条件はチーム内の3体だけで判定されます。' +
          '3戦目は1・2戦目のキャラを2体まで再選出できます（3体とも同一は不可）。')
      : el('p', { class: 'hint' },
          '上段がバトル出撃3体、下段はゼンカイ枠（Zアビ・ZENKAIアビがパーティ全体に乗ります。ZENKAI覚醒キャラ推奨）。'),
    members.length === 0
      ? el('p', { class: 'hint' }, '「＋」からキャラを選んでパーティを組んでください。')
      : null,
    members.map(memberCard),
    renderOptimizerPanel(),
    renderSuggestionCard(),
    renderZenkaiSuggestCard()));
  ui._prevRel = { ...relations };
  ui._flashCards = false;
}

function renderOptimizerPanel() {
  const m = ui.opt;
  // 旧バージョンで保存されたプリセット名（attack等）は balance に正規化して
  // UI表示と実際の重み（currentWeights のフォールバック）を一致させる
  if (!PRESETS[m.preset]) m.preset = 'balance';
  return el('div', { class: 'card' },
    el('h3', {}, '自動最適化'),
    el('div', { class: 'check' },
      ...[['single', '単一ステータス'], ['preset', 'プリセット'], ['custom', 'カスタム']].map(([v, label]) =>
        el('label', { class: 'check', style: 'margin-top:0' },
          el('input', {
            type: 'radio', name: 'opt-mode', checked: m.mode === v,
            onchange: () => { m.mode = v; renderParty(); },
          }), label))),
    m.mode === 'single'
      ? el('label', {}, '最大化するステータス',
          el('select', { onchange: (e) => { m.stat = e.target.value; } },
            STATS.map((s) => el('option', { value: s, selected: m.stat === s }, STAT_LABELS[s]))))
      : null,
    m.mode === 'preset'
      ? el('label', {}, 'プリセット',
          el('select', { onchange: (e) => { m.preset = e.target.value; } },
            Object.entries(PRESETS).map(([k, p]) => el('option', { value: k, selected: m.preset === k }, p.label))))
      : null,
    m.mode === 'custom'
      ? el('div', { class: 'grid2' }, STATS.map((s) => labeledNum(`${STAT_LABELS[s]} の重み`, m.weights, s)))
      : null,
    ui.party.mode === 'proud'
      ? el('p', { class: 'small-note' }, 'プラウドバトルでは6体全員に配分します。')
      : el('div', {},
          el('label', { class: 'check' },
            el('input', {
              type: 'radio', name: 'opt-targets', checked: m.targets === 'battle',
              onchange: () => { m.targets = 'battle'; },
            }), 'バトル出撃3体に配分'),
          el('label', { class: 'check' },
            el('input', {
              type: 'radio', name: 'opt-targets', checked: m.targets === 'all',
              onchange: () => { m.targets = 'all'; },
            }), 'ゼンカイ枠も含む6体全員に配分')),
    el('label', { class: 'check' },
      el('input', {
        type: 'checkbox', checked: m.optimizeLeader !== false,
        onchange: (e) => { m.optimizeLeader = e.target.checked; },
      }), 'リーダー枠も最適化する（Zアビ特殊ルールを考慮して入替え）'),
    ui.party.mode !== 'proud'
      ? el('label', { class: 'check' },
          el('input', {
            type: 'checkbox', checked: m.autoZenkai !== false,
            onchange: (e) => { m.autoZenkai = e.target.checked; },
          }), 'ゼンカイ枠も自動選出する（所持キャラからバトル3体への恩恵最大の3体。手動で選びたい場合はオフ）')
      : null,
    el('label', { class: 'check' },
      el('input', {
        type: 'checkbox', checked: m.styleSplit !== false,
        onchange: (e) => { m.styleSplit = e.target.checked; },
      }), 'キャラのタイプに合わせて特化（射撃特化パでも打撃タイプは打撃で組む。逆転時は通知）'),
    el('label', { class: 'check' },
      el('input', {
        type: 'checkbox', checked: m.penalizeUnmetCond !== false,
        onchange: (e) => { m.penalizeUnmetCond = e.target.checked; },
      }), '条件未達の効果を持つフラグを控えめに減点する（未達1行につき−5%評価。僅差なら全発動フラグを優先。実ステには影響しません）'),
    el('label', { class: 'check' },
      el('input', {
        type: 'checkbox', checked: m.excludeUnmetCond === true,
        onchange: (e) => { m.excludeUnmetCond = e.target.checked; },
      }), '条件未達の効果を持つフラグを完全に除外する（⚠を無くしたい場合のみ。強フラグまで候補から消えて結果が弱くなることがあります）'),
    el('button', { class: 'btn', onclick: runOptimize }, '最適化を実行'),
    el('p', { class: 'small-note' },
      '同一フラグメントは同じキャラに重複装備できません（別キャラは所持数の範囲で同時装備可）。' +
      '所持数は「フラグ」タブで調整できます（初期値6枚）。結果は上の装備枠に反映されます。'));
}

function currentWeights() {
  const m = ui.opt;
  if (m.mode === 'single') return { [m.stat]: 1 };
  // 保存データに旧プリセット名（attack 等）が残っていても落ちないようフォールバック
  // percent プリセットの場合、ここで返すのは名目値（実際の重みはキャラごとに materializeWeights で生成）
  if (m.mode === 'preset') return { ...(PRESETS[m.preset] || PRESETS.balance).weights };
  return { ...m.weights };
}

/** パーティ目標が percent プリセット（補正%合計の最大化）ならそれを返す */
function currentPercentPreset() {
  const m = ui.opt;
  if (m.mode === 'preset' && PRESETS[m.preset]?.percent) return PRESETS[m.preset];
  return null;
}

/**
 * プリセットをキャラの実重みへ変換する。
 * percent プリセットは「+1% = どのステータスでも等価」になるよう ❶ で正規化する
 * （w[s] = 名目重み × 100000 ÷ ❶[s]。❶未入力のステータスは除外）。
 */
function materializeWeights(preset, member) {
  if (!preset.percent) return { ...preset.weights };
  const out = {};
  for (const [s, w] of Object.entries(preset.weights)) {
    const sb = statBase(member.character, member.my, s);
    if (sb && sb.base > 0) out[s] = (w * 100000) / sb.base;
  }
  return out;
}

/**
 * 提案機能: バトルメンバーのタイプ構成（打撃/射撃/援護/防御タイプ）から
 * 「より長所を伸ばせる最適化」を計算する。ユーザー指定の目標と同じなら null。
 */
function computeStyleSuggestion(members, baseParams, best, mainResult) {
  const targetIds = new Set(Object.keys(mainResult.assignments));
  const targetMembers = members.filter((m) => targetIds.has(String(m.character.id)));
  if (targetMembers.length === 0) return null;

  // タイプ集計 → 最多タイプの目標
  const styleCount = new Map();
  for (const so of STYLE_OBJECTIVES) {
    const n = targetMembers.filter((m) => (m.character.tags || []).includes(so.tag)).length;
    if (n > 0) styleCount.set(so, n);
  }
  const ranked = [...styleCount.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  const [dominant, count] = ranked[0];

  // すでに同じ目標なら提案不要
  const same = dominant.opt.mode === 'single'
    ? (ui.opt.mode === 'single' && ui.opt.stat === dominant.opt.stat)
    : (ui.opt.mode === 'preset' && ui.opt.preset === dominant.opt.preset);
  if (same) return null;

  const sugWeights = dominant.opt.mode === 'single'
    ? { [dominant.opt.stat]: 1 }
    : { ...PRESETS[dominant.opt.preset].weights };
  const sugResult = optimizeParty({
    ...baseParams,
    weights: sugWeights,
    weightsById: undefined, // 提案はパーティ全体を提案目標で組む（タイプ別の上書きはしない）
    leaderId: ui.party.mode === 'proud' ? undefined : best.leaders[0],
    leaders: ui.party.mode === 'proud' ? best.leaders : undefined,
  });

  // 比較指標: 提案目標の主ステータスの合計 ❸（同じリーダー・同じ対象で比較）
  const totalOf = (assignments, ext) => targetMembers.reduce((acc, m) => {
    const cid = String(m.character.id);
    const ids = assignments[cid]?.ids || [];
    const d = characterDetail({
      member: m, ext: ext[cid],
      fragmentList: ids.map(fragDef).filter(Boolean),
      effectMap: state.game.effectMap,
      context: baseParams.contexts[cid],
    });
    return acc + (d.stats[dominant.metric]?.final || 0);
  }, 0);
  const sugTotal = totalOf(sugResult.assignments, sugResult.ext);
  const curTotal = totalOf(mainResult.assignments, mainResult.ext);
  if (!(sugTotal > curTotal * 1.001)) return null; // ほぼ差が無いなら提案しない

  const styleTag = tagName(dominant.tag);
  return {
    sig: partySig(), // 編成が変わったら提案は無効
    text: `このパーティは「${styleTag}」が ${count}/${targetMembers.length} 体です。` +
      `${dominant.objLabel}に切り替えると ${STAT_LABELS[dominant.metric]} 合計が ` +
      `${fmt0(curTotal)} → ${fmt0(sugTotal)}（+${fmt(((sugTotal / curTotal) - 1) * 100, 1)}%）になります。`,
    optPatch: dominant.opt,
    assignments: sugResult.assignments,
    exact: sugResult.exact,
  };
}

async function applySuggestion() {
  const s = ui.suggestion;
  if (!s) return;
  if (s.sig !== partySig()) {
    ui.suggestion = null;
    renderParty();
    showMsg('warn', '■ 編成が変わったため、この提案は無効になりました。もう一度最適化を実行してください。');
    return;
  }
  Object.assign(ui.opt, s.optPatch);
  const current = new Set(ui.party.memberIds.filter(Boolean).map(String));
  for (const [cid, asg] of Object.entries(s.assignments)) {
    if (!current.has(String(cid))) continue; // 現編成にいないキャラには書き込まない
    const slots = Number(charMy(cid)?.equip_slots) || 3;
    const arr = asg.ids.slice(0, slots);
    while (arr.length < slots) arr.push(null);
    ui.party.equips[cid] = arr;
  }
  ui.suggestion = null;
  await persistMy();
  ui._flashCards = true;
  renderParty();
  showMsg('ok', '提案の最適化を適用しました。');
}

function renderSuggestionCard() {
  const s = ui.suggestion;
  if (!s) return null;
  if (s.sig !== partySig()) { ui.suggestion = null; return null; } // 編成変更で自動失効
  return el('div', { class: 'card sub-card' },
    el('h3', {}, '💡 提案: 長所を伸ばす最適化'),
    el('p', { class: 'hint' }, s.text),
    el('button', { class: 'btn secondary', onclick: applySuggestion }, 'この提案を適用'));
}

// ---------------------------------------------------------------- ゼンカイ枠の提案（アビリティ恩恵×所持アーツ）

const RARE_ARTS = new Set(['必殺', '特殊', '究極', '覚醒']);

/**
 * ゼンカイ枠（スタンダードの下段3枠）の候補を採点する。
 * デッキは非出撃メンバーの所持アーツも含めて構成されるため、
 * アビリティ恩恵だけでなくアーツ構成（必殺・特殊などのレアアーツ／特化ステに合うアーツ）も並べる。
 */
function computeZenkaiSuggestions() {
  const battleSet = new Set(battleIds().map(String));
  const battleMembers = partyMembers().filter((m) => battleSet.has(String(m.character.id)));
  if (battleMembers.length === 0) return null;
  const weights = currentWeights();
  const partyIds = new Set(ui.party.memberIds.filter(Boolean).map(String));
  const atkFocus = (weights.strike_atk || 0) >= (weights.blast_atk || 0)
    ? ((weights.strike_atk || 0) > 0 ? '打撃' : null)
    : '射撃';

  const cands = [];
  for (const def of Object.values(state.game.characters)) {
    const cid = String(def.id);
    if (partyIds.has(cid)) continue;
    const my = charMy(cid) || defaultCharMy(def);
    const ab = memberAbilityGroups({ character: def, my, effectMap: state.game.effectMap });
    let benefit = 0;
    let hpBenefit = 0;
    for (const groups of [ab.z, ab.zenkai]) {
      for (const g of groups) {
        for (const m of battleMembers) {
          if (!conditionMatches(g.cond, m.character)) continue;
          for (const e of g.effects) {
            if (e.base === false) continue;
            benefit += (weights[e.stat] || 0) * e.value;
            if (e.stat === 'hp') hpBenefit += e.value;
          }
        }
      }
    }
    const arts = def.arts || [];
    const rare = arts.filter((a) => RARE_ARTS.has(a.type)).length;
    const focus = atkFocus ? arts.filter((a) => a.type === atkFocus).length : 0;
    if (benefit > 0 || rare > 0 || focus > 0 || hpBenefit > 0) {
      cands.push({ def, benefit, hpBenefit, rare, focus });
    }
  }
  const hasArts = Object.values(state.game.characters).some((d) => (d.arts || []).length > 0);
  const top3 = (arr) => arr.slice(0, 3);
  return {
    hasArts,
    atkFocus,
    ability: top3([...cands].sort((a, b) => b.benefit - a.benefit || b.rare - a.rare)),
    rare: top3([...cands].filter((c) => c.rare > 0).sort((a, b) => b.rare - a.rare || b.benefit - a.benefit)),
    focus: atkFocus ? top3([...cands].filter((c) => c.focus > 0).sort((a, b) => b.focus - a.focus || b.benefit - a.benefit)) : [],
    hp: top3([...cands].filter((c) => c.hpBenefit > 0).sort((a, b) => b.hpBenefit - a.hpBenefit || b.benefit - a.benefit)),
  };
}

function renderZenkaiSuggestCard() {
  if (ui.party.mode !== 'standard' || battleIds().length === 0) return null;
  const box = el('div', {});
  let computed = false;
  const details = el('details', {
    ontoggle: (e) => {
      if (!e.target.open || computed) return;
      computed = true;
      const s = computeZenkaiSuggestions();
      if (!s) { box.replaceChildren(el('p', { class: 'hint' }, 'バトルメンバーを選ぶと提案できます。')); return; }
      const row = (label, list, metric) => list.length === 0 ? null : el('div', {},
        el('div', { class: 'item-title', style: 'margin-top:8px' }, label),
        el('div', { style: 'display:flex;gap:6px;align-items:flex-start' },
          el('div', { class: 'char-grid', style: 'flex:1;grid-template-columns:repeat(3, 1fr)' },
            list.map((c) => {
              const tile = charTile(c.def, { onclick: () => openCharSheet(String(c.def.id)) });
              tile.append(el('div', { class: 'rel-badge' }, metric(c)));
              return tile;
            })),
          el('button', {
            class: 'btn secondary small', style: 'flex:none;align-self:center',
            onclick: async () => {
              const ids = list.map((c) => String(c.def.id));
              ids.forEach((cid, i) => {
                ensureCharMy(cid);
                ui.party.memberIds[3 + i] = cid;
              });
              await persistMy();
              ui._flashCards = true;
              renderParty();
              showMsg('ok', 'ゼンカイ枠に提案メンバーをセットしました。');
            },
          }, 'セット')));
      box.replaceChildren(...nodes(
        el('p', { class: 'hint' },
          'バトル3体への Z・ZENKAIアビリティ恩恵（現在の重み換算）と、デッキに入る所持アーツの構成から候補を挙げます。' +
          (s.hasArts ? '' : '（アーツデータは未取得のためアビリティ恩恵のみで並べています）')),
        row('① アビリティ恩恵 重視', s.ability, (c) => `+${fmt(c.benefit, 0)}`),
        row('② 必殺・特殊アーツ持ち', s.rare, (c) => `レア${c.rare}枚`),
        s.atkFocus ? row(`③ ${s.atkFocus}アーツで特化を伸ばす`, s.focus, (c) => `${s.atkFocus}${c.focus}枚`) : null,
        row('④ 体力アップの貴重な恩恵', s.hp, (c) => `HP+${fmt(c.hpBenefit, 0)}%`)));
    },
  },
    el('summary', {}, 'ゼンカイ枠の提案を表示（アビリティ恩恵×アーツ構成）'),
    box);
  return el('div', { class: 'card sub-card' },
    el('h3', {}, '💡 提案: ゼンカイ枠'),
    details);
}

async function runOptimize() {
  clearMsgs();
  const proud = ui.party.mode === 'proud';
  const members = partyMembers();
  if (members.length === 0) {
    showMsg('error', '■ パーティが空です\nキャラを1体以上入れてください。');
    return;
  }
  const bIds = battleIds();
  if (!proud && ui.opt.targets === 'battle' && bIds.length === 0) {
    showMsg('error', '■ バトル出撃メンバーがいません\n上段の枠に1体以上入れてください。');
    return;
  }
  // 所持数（初期値6枚・ユーザー調整分を上書き）
  const counts = {};
  for (const id of Object.keys(state.game.fragments)) counts[id] = fragCount(id);
  if (!checkRarities(Object.keys(counts).filter((id) => counts[id] > 0))) return;
  const weights = currentWeights();
  if (!Object.values(weights).some((w) => w > 0)) {
    showMsg('error', '■ 重みがすべて 0 です');
    return;
  }
  // リーダー最適化: リーダー枠のZアビ特殊ルールで総合スコアが最も高くなるリーダーを探索する
  const teams = proudTeams();
  const contexts = battleContexts(members);

  // タイプ別特化（styleSplit）: 攻撃の主軸がある目標のとき、主軸と逆のタイプのキャラは
  // 打撃/射撃の重みを入れ替えて組む（例: 射撃特化パの打撃タイプは打撃で組む）。
  // ゼンカイ枠の自動選出でメンバー集合がリーダー候補ごとに変わるため、集合ごとに導出する
  const swapAtkWeights = (w) => ({ ...w, strike_atk: w.blast_atk || 0, blast_atk: w.strike_atk || 0 });
  const focusOf = (w) => ((w.strike_atk || 0) > (w.blast_atk || 0) ? 'strike'
    : (w.blast_atk || 0) > (w.strike_atk || 0) ? 'blast' : null);
  const baseFocus = focusOf(weights);
  const pctPreset = currentPercentPreset();
  const styleOverridesFor = (memList) => {
    const wById = {};
    const swapped = []; // {cid, ownStat, partyStat}
    for (const m of memList) {
      const cid = String(m.character.id);
      // キャラ個別の特化指定（メンバーカードのセレクタ）が最優先。
      // 'party' はパーティ目標のまま（タイプ自動入替もしない）、プリセット名なら固定の重みで組む
      const obj = charMy(cid)?.objective;
      if (obj && obj !== 'auto') {
        if (obj !== 'party' && PRESETS[obj]) {
          wById[cid] = materializeWeights(PRESETS[obj], m);
          continue;
        }
        // 'party': パーティ目標に固定（percent プリセットならキャラ別重みを生成）
        if (pctPreset) wById[cid] = materializeWeights(pctPreset, m);
        continue;
      }
      // パーティ目標が percent プリセットなら全員キャラ別重み（タイプ入替は対称なので不要）
      if (pctPreset) {
        wById[cid] = materializeWeights(pctPreset, m);
        continue;
      }
      if (ui.opt.styleSplit === false || !baseFocus) continue;
      const tags = m.character.tags || [];
      const swap = (baseFocus === 'blast' && tags.includes(13002)) // 打撃タイプ
        || (baseFocus === 'strike' && tags.includes(13003));       // 射撃タイプ
      if (swap) {
        wById[cid] = swapAtkWeights(weights);
        swapped.push({
          cid,
          ownStat: baseFocus === 'blast' ? 'strike_atk' : 'blast_atk',
          partyStat: baseFocus === 'blast' ? 'blast_atk' : 'strike_atk',
        });
      }
    }
    return { wById, swapped };
  };

  const baseParams = {
    members, battleIds: bIds, teams, contexts,
    fragmentsById: state.game.fragments, counts,
    weights, effectMap: state.game.effectMap,
    targets: proud ? 'all' : ui.opt.targets,
    avoidUnmetCond: ui.opt.excludeUnmetCond === true,
    unmetPenalty: ui.opt.penalizeUnmetCond !== false ? 0.95 : undefined,
  };
  const currentLeaders = proud
    ? [ui.party.memberIds[0] || null, ui.party.memberIds[3] || null]
    : [ui.party.memberIds[0] || null];
  let leaderCombos;
  if (ui.opt.optimizeLeader !== false) {
    if (proud) {
      const t1 = ui.party.memberIds.slice(0, 3).filter(Boolean);
      const t2 = ui.party.memberIds.slice(3, 6).filter(Boolean);
      leaderCombos = (t1.length ? t1 : [null]).flatMap((a) => (t2.length ? t2 : [null]).map((b) => [a, b]));
    } else {
      leaderCombos = bIds.map((id) => [id]);
    }
    if (leaderCombos.length === 0) leaderCombos = [currentLeaders];
  } else {
    leaderCombos = [currentLeaders];
  }

  // リーダー候補の比較は「重み付きの最終ステ絶対値の合計」で行う。
  // optimizeParty の totalScore は全最適化対象（ゼンカイ枠含む）の合算なので使わず、
  // スタンダードではバトル3体だけを absScoreOf で別途合算して比較する。
  const battleSet = new Set(bIds.map(String));
  const battleMembersOnly = members.filter((m) => battleSet.has(String(m.character.id)));

  // リーダー候補の比較値。スタンダードではバトル3体だけを合算する
  // （ゼンカイ枠はリーダー候補ごとに顔ぶれが変わるため、ベンチ自身のステを混ぜると比較が汚染される）
  const absScoreOf = (r, mem, ctx, wById) => {
    let total = 0;
    for (const [cid, asg] of Object.entries(r.assignments)) {
      if (!proud && !battleSet.has(String(cid))) continue;
      const m = mem.find((x) => String(x.character.id) === cid);
      if (!m) continue;
      const d = characterDetail({
        member: m, ext: r.ext[cid],
        fragmentList: asg.ids.map(fragDef).filter(Boolean),
        effectMap: state.game.effectMap, context: ctx[cid],
      });
      const wm = (wById && wById[cid]) || weights;
      for (const [s, w] of Object.entries(wm)) {
        if (w > 0 && d.stats[s]) total += w * d.stats[s].final;
      }
    }
    return total;
  };

  // ゼンカイ枠の自動選出（スタンダードのみ）: 所持キャラからバトル3体への恩恵最大の3体。
  // リーダーの「Zアビをタグ無視で受ける」特殊ルールが採点に効くため、リーダー候補ごとに選び直す
  const autoZenkai = !proud && ui.opt.autoZenkai !== false && battleMembersOnly.length > 0;
  const battleStyle = styleOverridesFor(battleMembersOnly);
  const toMember = (cid) => {
    const def = charDef(cid);
    return def ? { character: def, my: charMy(cid) || defaultCharMy(def) } : null;
  };
  // 全キャラ所持が標準（own_all）なら全キャラが候補。オフなら登録済みキャラのみ
  const zenkaiCandidates = autoZenkai
    ? (state.my.own_all !== false
        ? Object.values(state.game.characters)
            .filter((d) => !battleSet.has(String(d.id)))
            .map((d) => ({ character: d, my: charMy(d.id) || defaultCharMy(d) }))
        : Object.keys(state.my.characters || {}).filter((cid) => !battleSet.has(String(cid))).map(toMember).filter(Boolean))
    : [];

  const computingMsg = showMsg('info', '最適化を計算中…');
  const itemsCache = {}; // フラグメント寄与はリーダー非依存なので候補間で再利用する
  const leaderResults = [];
  try {
    for (const combo of leaderCombos) {
      let mem = members;
      let ctx = contexts;
      let zPick = null;
      if (autoZenkai) {
        zPick = pickZenkaiMembers({
          battleMembers: battleMembersOnly, candidates: zenkaiCandidates,
          weights, weightsById: battleStyle.wById, effectMap: state.game.effectMap, leaderId: combo[0],
        });
        mem = [...battleMembersOnly, ...zPick.map((z) => toMember(String(z.id))).filter(Boolean)];
        ctx = battleContexts(mem);
      }
      // タイプ別特化の上書きは、確定したメンバー集合（自動選出したゼンカイ枠込み）から導出する
      const so = styleOverridesFor(mem);
      const r = optimizeParty({
        ...baseParams,
        members: mem, contexts: ctx,
        weightsById: Object.keys(so.wById).length ? so.wById : undefined,
        itemsCache,
        leaderId: proud ? undefined : combo[0],
        leaders: proud ? combo : undefined,
      });
      const abs = absScoreOf(r, mem, ctx, so.wById);
      leaderResults.push({ result: r, leaders: combo, abs, zenkai: zPick, mem, ctx, so });
      if (r.contended && leaderCombos.length > 1) {
        // 所持数を絞って奪い合いがある場合は探索が重いため、現在の配置のみで実行する
        showMsg('info', '所持数を絞っているため、リーダー探索は現在のリーダー配置のみで実行しました。');
        break;
      }
      await new Promise((res) => setTimeout(res, 0)); // UIへ描画の機会を譲る
    }
  } finally {
    computingMsg.remove();
  }
  let best = leaderResults.reduce((a, b) => (b.abs > a.abs ? b : a));
  // ULTRA優先タイブレーク（スタンダードのみ）: ❸合計が最良の 0.5% 以内なら、
  // ULTRAアビリティ（与ダメ等・❸に乗らない）が発動するULTRAキャラのリーダーを優先する
  let ultraLeaderNote = '';
  if (!proud && !(charDef(best.leaders[0])?.ultra_ability || []).length) {
    const ultraCand = leaderResults
      .filter((x) => (charDef(x.leaders[0])?.ultra_ability || []).length && x.abs >= best.abs * 0.995)
      .sort((a, b) => b.abs - a.abs)[0];
    if (ultraCand) {
      const loss = best.abs > 0 ? ((1 - ultraCand.abs / best.abs) * 100) : 0;
      ultraLeaderNote = `\nリーダーはULTRAの ${charDef(ultraCand.leaders[0])?.name} を優先しました` +
        `（重み付き合計 -${fmt(loss, 2)}% 以内。ULTRAアビリティはリーダー時に発動し❸には現れないため優先）。`;
      best = ultraCand;
    }
  }
  const result = best.result;

  // ゼンカイ枠の反映（最適化のたびに選び直す）
  let zenkaiMsg = '';
  if (autoZenkai && best.zenkai) {
    const zIds = best.zenkai.map((z) => String(z.id));
    for (let i = 0; i < 3; i++) {
      ui.party.memberIds[3 + i] = zIds[i] || '';
      if (zIds[i]) ensureCharMy(zIds[i]); // 星などを編集できるよう登録しておく
    }
    if (zIds.length) {
      zenkaiMsg = `\nゼンカイ枠を自動選出しました: ${zIds.map((id) => charDef(id)?.name || id).join(' / ')}` +
        (zIds.length < 3 ? `（バトル3体に恩恵のある候補が ${zIds.length} 体でした）` : '');
    } else {
      zenkaiMsg = '\nゼンカイ枠: バトル3体にアビリティ恩恵のある候補が見つかりませんでした。';
    }
  }

  // 選ばれたリーダーをリーダー枠（スタンダード=枠1 / プラウド=各チーム先頭）へ移動する
  const leaderChanged = [];
  const moveToFront = (leaderId, base) => {
    if (!leaderId) return;
    const idx = ui.party.memberIds.findIndex((x) => String(x) === String(leaderId));
    if (idx > base && idx < base + 3) {
      [ui.party.memberIds[base], ui.party.memberIds[idx]] = [ui.party.memberIds[idx], ui.party.memberIds[base]];
      leaderChanged.push(charDef(leaderId)?.name || leaderId);
    }
  };
  if (proud) { moveToFront(best.leaders[0], 0); moveToFront(best.leaders[1], 3); }
  else moveToFront(best.leaders[0], 0);

  // 提案: パーティのタイプ構成に合わせて、より長所を伸ばせる最適化があれば計算しておく
  ui.suggestion = null;
  try {
    ui.suggestion = computeStyleSuggestion(best.mem || members,
      { ...baseParams, members: best.mem || members, contexts: best.ctx || contexts }, best, result);
  } catch (e) {
    console.warn('提案の計算に失敗:', e);
  }

  // タイプ別特化の逆転チェック: タイプに合わせて組んだ結果が、パーティ目標のまま組んだ場合より
  // 弱いキャラがいれば通知する（§12: 打撃で組んだ打撃キャラが射撃で組むより弱いケース）
  const styleNotes = [];
  for (const sw of (best.so?.swapped || [])) {
    try {
      const asg = result.assignments[sw.cid];
      const m = (best.mem || members).find((x) => String(x.character.id) === sw.cid);
      if (!asg || !m) continue;
      const ctxOf = (best.ctx || contexts)[sw.cid];
      const detail = (ids) => characterDetail({
        member: m, ext: result.ext[sw.cid],
        fragmentList: ids.map(fragDef).filter(Boolean),
        effectMap: state.game.effectMap, context: ctxOf,
      });
      const own = detail(asg.ids).stats[sw.ownStat]?.final || 0;
      const alt = bestForCharacter({
        member: m, ext: result.ext[sw.cid], weights,
        fragmentsById: state.game.fragments, counts,
        effectMap: state.game.effectMap, context: ctxOf,
        avoidUnmetCond: ui.opt.excludeUnmetCond === true,
        unmetPenalty: ui.opt.penalizeUnmetCond !== false ? 0.95 : undefined,
      });
      const altV = detail(alt.ids || []).stats[sw.partyStat]?.final || 0;
      if (altV > own * 1.001) {
        styleNotes.push(
          `${m.character.name} はタイプに合わせて${STAT_LABELS[sw.ownStat]}で組みましたが、` +
          `${STAT_LABELS[sw.partyStat]}で組んだ方が高くなります（${fmt0(own)} → ${fmt0(altV)}、` +
          `他キャラとのフラグ奪い合いを考慮しない概算）。` +
          `「キャラのタイプに合わせて特化」をオフにするとパーティ目標のまま組めます。`);
      }
    } catch (e) {
      console.warn('タイプ別特化の比較に失敗:', e);
    }
  }
  for (const [cid, asg] of Object.entries(result.assignments)) {
    const slots = Number(charMy(cid)?.equip_slots) || 3;
    const arr = asg.ids.slice(0, slots);
    while (arr.length < slots) arr.push(null);
    ui.party.equips[cid] = arr;
  }
  await persistMy();
  ui._flashCards = true; // 反映演出
  renderParty();
  reportUnknown(result.unknown);
  for (const w of [...new Set(result.warnings)]) showMsg('warn', `■ ${w}`);
  for (const note of styleNotes) showMsg('warn', `■ ${note}`);
  // ULTRAアビリティ持ちがリーダー枠以外にいる場合の案内（発動条件がリーダー/タグ編成のため）
  if (!proud) {
    for (const bid of bIds) {
      const d = charDef(bid);
      if (!(d?.ultra_ability || []).length) continue;
      if (String(ui.party.memberIds[0]) === String(bid)) continue;
      showMsg('info', `■ ${d.name} はULTRAアビリティ持ちです。リーダー枠に置くか参照タグのキャラを編成すると発動・強化されます（キャラ詳細で内容を確認できます。与ダメージ等のため❸の比較には含まれません）。`);
    }
  }
  showMsg(result.exact ? 'ok' : 'warn',
    (result.exact ? '最適化が完了しました（厳密解）。装備枠に反映しました。'
      : '最適化を打ち切りで終えました（暫定解）。装備枠に反映しました。') +
    (leaderChanged.length ? `\nリーダー枠を ${leaderChanged.join(' / ')} に変更しました（Zアビ特殊ルールで最も高くなる配置）。` : '') +
    ultraLeaderNote +
    zenkaiMsg);
}

// ---------------------------------------------------------------- キャラ選択シート

function openCharPicker(slotIndex) {
  const filter = defaultCharFilter(); // 既定は全キャラ表示（ソートは入手順・降順）
  const body = el('div', {});
  const grid = el('div', { class: 'char-grid' });
  const controlsBox = el('div', {});

  const rerenderGrid = () => {
    const inParty = new Set(ui.party.memberIds.filter(Boolean).map(String));
    const defs = applyCharSortFilter(Object.values(state.game.characters), filter);
    grid.replaceChildren(...defs.map((d) => {
      const tile = charTile(d, {
        onclick: async () => {
          const sid = String(d.id);
          if (inParty.has(sid) && ui.party.memberIds[slotIndex] !== sid) {
            // 既にパーティにいる → 位置を入れ替える
            const j = ui.party.memberIds.findIndex((x) => String(x) === sid);
            ui.party.memberIds[j] = ui.party.memberIds[slotIndex];
          }
          ensureCharMy(sid);
          ui.party.memberIds[slotIndex] = sid;
          await persistMy();
          closeSheet(); renderParty();
        },
      });
      if (inParty.has(String(d.id))) tile.append(el('div', { class: 'equipped-badge', style: 'position:absolute;top:0;left:0;right:0;font-size:8px;font-weight:900;text-align:center;background:linear-gradient(180deg,#ffa640,#e0641e);color:#fff' }, 'パーティ'));
      return tile;
    }));
    if (defs.length === 0) grid.append(el('p', { class: 'hint' }, '該当なし。フィルタをリセットしてください。'));
  };
  const renderControls = () => {
    controlsBox.replaceChildren(charFilterControls(filter, (reset) => { if (reset) renderControls(); rerenderGrid(); }));
  };

  body.append(...nodes(
    controlsBox,
    el('p', { class: 'small-note' }, '未所持キャラを選ぶと自動で所持登録されます（ブースト値はソウルブースト最大で初期化）。'),
    ui.party.memberIds[slotIndex]
      ? el('button', {
          class: 'btn danger small',
          onclick: async () => {
            delete ui.party.equips[String(ui.party.memberIds[slotIndex])];
            ui.party.memberIds[slotIndex] = '';
            await persistMy(); closeSheet(); renderParty();
          },
        }, 'この枠を空にする')
      : null,
    grid));
  renderControls();
  rerenderGrid();
  const label = ui.party.mode === 'proud'
    ? (slotIndex < 3 ? `1戦目 ${slotIndex + 1}` : `2戦目 ${slotIndex - 2}`)
    : (slotIndex < 3 ? `バトル ${slotIndex + 1}` : `ゼンカイ枠 ${slotIndex - 2}`);
  openSheet(`${label} のキャラを選択`, body);
}

// ---------------------------------------------------------------- フラグメント選択シート

function fragSlotEffectsView(f, stars) {
  return (f.slots || []).map((slot) =>
    el('div', { class: 'slot-eff' },
      el('div', { class: 'sl' }, slot.label, slot.star7 ? `（★7で解放${stars < 7 ? '・現在の星では無効' : ''}）` : ''),
      (slot.lines || []).map((line) => {
        // 選択式スロット: どれか1つが付く。条件を満たす選択肢のうち最良の1つが計算に入る
        const optPrefix = line.option != null
          ? el('span', { style: 'color:var(--warn);font-weight:700' }, `【選択${line.option}】`)
          : null;
        if (line.raw != null) return el('div', { class: 'line raw' }, ...nodes(optPrefix, line.raw));
        const valueText = `${line.text} +${line.value}%${line.value_min != null ? `（最大値。${line.value_min}〜${line.value}%）` : ''}`;
        if (line.cond) {
          return el('div', { class: 'line' }, ...nodes(
            optPrefix,
            el('span', { style: 'color:var(--accent2)' }, `【条件】${line.cond_raw || ''} `), valueText,
            el('span', { class: 'raw' }, line.option != null
              ? '（選択式: 条件を満たす選択肢のうち最良の1つを適用）'
              : '（編成が条件を満たすときだけ計算に含まれます）')));
        }
        return el('div', { class: 'line' }, ...nodes(optPrefix, valueText));
      })));
}

function openFragPicker(cid, slotIdx) {
  const def = charDef(cid);
  const filter = { q: '', showTop: false };
  const body = el('div', {});
  const grid = el('div', { class: 'frag-grid' });
  const current = memberEquips(cid);

  const slotRow = el('div', { class: 'frag-slots', style: 'justify-content:center;margin:4px 0 2px' },
    current.map((fid, i) => {
      const f = fid ? fragDef(fid) : null;
      return el('div', {
        class: `frag-slot${f ? ` fr-${f.rarity || 'default'}` : ''}${isAwakenedFrag(f) ? ' frag-awakened' : ''}`,
        style: i === slotIdx ? 'outline:2px solid var(--accent);outline-offset:2px' : '',
      }, f ? lazyImg(f.icon, f.name) : '＋');
    }));

  const assign = async (fid) => {
    const arr = memberEquips(cid);
    arr[slotIdx] = fid;
    ui.party.equips[String(cid)] = arr;
    await persistMy();
    closeSheet(); renderParty();
  };

  const rerenderGrid = () => {
    const q = filter.q.trim();
    const list = Object.values(state.game.fragments)
      .filter((f) => canEquip(def, f))
      .filter((f) => filter.showTop || !isTournamentOnly(f))
      .filter((f) => !q || (f.name || '').includes(q))
      .sort((a, b) => fragCount(b.id) - fragCount(a.id) || b.id - a.id);
    grid.replaceChildren(...list.map((f) => {
      const sid = String(f.id);
      const count = fragCount(sid);
      const usedElsewhere = assignedCount(f.id, { cid, idx: slotIdx });
      const isCurrent = String(current[slotIdx] || '') === sid;
      // 同一フラグメントは同じキャラに重複装備できない（実機仕様）
      const dupInChar = memberEquips(cid).some((x, i) => i !== slotIdx && String(x || '') === sid);
      // 覚醒前と覚醒後の同一種も同じキャラに同時装備できない（実機仕様）
      const conflictInChar = memberEquips(cid).some((x, i) => {
        if (i === slotIdx || !x) return false;
        const other = fragDef(x);
        return other && fragsConflict(other, f);
      });
      const noneLeft = usedElsewhere >= count;
      return fragTile(f, {
        exclude: { cid, idx: slotIdx },
        showRemaining: true,
        disabled: dupInChar || conflictInChar || (noneLeft && !isCurrent),
        onclick: async () => {
          if (isCurrent) { await assign(null); return; } // タップで外す
          await assign(sid);
        },
      });
    }));
    if (list.length === 0) {
      grid.append(el('p', { class: 'hint' }, 'このキャラが装備できるフラグメントがありません。'));
    }
  };

  body.append(
    slotRow,
    el('p', { class: 'hint', style: 'text-align:center' }, `${def.name} — スロット${slotIdx + 1}${current[slotIdx] ? '（装備中のものをタップすると外せます）' : ''}`),
    el('div', { class: 'filter-row sticky-bar' },
      el('input', { type: 'search', placeholder: 'フラグメント名で検索', oninput: (e) => { filter.q = e.target.value; rerenderGrid(); } }),
      el('label', { class: 'check', style: 'margin:0;flex:none' },
        el('input', { type: 'checkbox', checked: filter.showTop, onchange: (e) => { filter.showTop = e.target.checked; rerenderGrid(); } }), '力の大会も表示')),
    grid);
  rerenderGrid();
  openSheet('フラグメントを選択', body);
}

// ---------------------------------------------------------------- キャラタブ / キャラ詳細シート

function renderChars() {
  const root = $('#chars-view');
  const f = ui.charFilter;
  const grid = el('div', { class: 'char-grid' });
  const rerenderGrid = () => {
    const defs = applyCharSortFilter(Object.values(state.game.characters), f);
    grid.replaceChildren(...defs.map((d) =>
      charTile(d, { onclick: () => openCharSheet(String(d.id)) })));
    if (defs.length === 0) grid.append(el('p', { class: 'hint' }, '該当するキャラがいません。フィルタをリセットしてください。'));
  };
  root.replaceChildren(
    el('p', { class: 'hint' }, `全 ${Object.keys(state.game.characters).length} 体 / 所持登録 ${Object.keys(state.my.characters).length} 体。タップで詳細・所持登録。`),
    charFilterControls(f, (reset) => { if (reset) renderChars(); else rerenderGrid(); }),
    grid);
  rerenderGrid();
}

/** 限界突破（星）の選択（★0〜★14。★7以上でSLOT4解放・ZアビIV等に影響） */
function starsSelect(my, onchange) {
  return el('select', {
    onchange: (e) => { my.stars = Number(e.target.value); onchange?.(); },
  }, Array.from({ length: 15 }, (_, i) =>
    el('option', { value: i, selected: Number(my.stars) === i }, `★${i}${i >= 7 ? '（SLOT4有効）' : ''}`)));
}

/** メンバーカード用のコンパクトな星セレクタ（変更すると即保存・再計算） */
function starsSelectCompact(cid, my) {
  return el('select', {
    style: 'width:auto;display:inline-block;padding:1px 4px;margin:0;font-size:11px',
    onchange: async (e) => {
      my.stars = Number(e.target.value);
      if (!charMy(cid)) state.my.characters[String(cid)] = my;
      await persistMy();
      renderParty();
    },
  }, Array.from({ length: 15 }, (_, i) =>
    el('option', { value: i, selected: Number(my.stars) === i }, `★${i}`)));
}

const LEVEL_LABELS = ['I', 'II', 'III', 'IV'];

function abilityLevelSelect(labelText, my, key, listLength, stars) {
  if (!listLength) return null;
  const cur = my[key] ?? 'auto';
  return el('label', {}, labelText,
    el('select', { onchange: (e) => { my[key] = e.target.value === 'auto' ? 'auto' : Number(e.target.value); } },
      el('option', { value: 'auto', selected: cur === 'auto' }, `自動（★${stars} → ${LEVEL_LABELS[autoAbilityLevel(stars) - 1]}）`),
      LEVEL_LABELS.slice(0, listLength).map((lab, i) =>
        el('option', { value: i + 1, selected: cur === i + 1 }, lab))));
}

function openCharSheet(cid) {
  const def = charDef(cid);
  if (!def) return;
  const body = el('div', {});
  const owned = isOwned(cid);
  const my = charMy(cid) || defaultCharMy(def);

  const statTable = el('table', {},
    el('tr', {}, el('th', {}, 'ステータス'), el('th', {}, '❶ Lv5000'), el('th', {}, 'ブースト'), el('th', {}, '合計')),
    STATS.map((s) => {
      const sb = statBase(def, my, s);
      return el('tr', {},
        el('td', {}, STAT_LABELS[s]),
        el('td', { class: 'num' }, fmt0(def.stats?.[s] || 0)),
        el('td', { class: 'num' }, fmt0(my.boost?.[s] || 0)),
        el('td', { class: 'num big' }, sb ? fmt0(sb.total) : '—'));
    }));

  const abilityPreview = () => {
    const { z, zenkai, deploy } = memberAbilityGroups({ character: def, my, effectMap: state.game.effectMap });
    const lines = [];
    for (const [label, groups] of [['Zアビ（パーティ全員に）', z], ['ZENKAIアビ（パーティ全員に）', zenkai], ['出撃Zアビ（バトル3体に）', deploy]]) {
      for (const g of groups) {
        for (const e of g.effects) {
          lines.push(`${label}: ${e.base ? '基礎' : ''}${STAT_LABELS[e.stat]} +${e.value}%${g.cond?.length ? '（条件あり）' : ''}`);
        }
      }
    }
    return lines.length
      ? el('div', {}, lines.map((l) => el('div', { class: 'effline' }, l)))
      : el('p', { class: 'small-note' }, '補正アビリティなし');
  };

  const ownedArea = el('div', {});
  const renderOwnedArea = () => {
    if (!isOwned(cid)) {
      ownedArea.replaceChildren(...nodes(
        el('button', {
          class: 'btn',
          onclick: async () => {
            state.my.characters[cid] = defaultCharMy(def);
            await persistMy(); renderChars(); openCharSheet(cid);
          },
        }, '所持キャラとして登録'),
        el('p', { class: 'small-note' }, '登録するとブースト値はソウルブースト最大で初期化されます（下で調整可）。')));
      return;
    }
    // 全キャラ所持が標準のため、未登録キャラは編集開始時に既定値（★7・ソウルブースト最大）で登録する
    const m2 = ensureCharMy(cid);
    ownedArea.replaceChildren(...nodes(
      el('div', { class: 'row' },
        el('label', {}, '限界突破（星）',
          starsSelect(m2, () => openCharSheet(cid))),
        labeledNum('装備枠', m2, 'equip_slots')),
      abilityLevelSelect('Zアビリティ', m2, 'z_level', def.z_ability?.length, m2.stars),
      abilityLevelSelect('出撃Zアビリティ', m2, 'deploy_z_level', def.deploy_z_ability?.length, m2.stars),
      abilityLevelSelect('ZENKAIアビリティ', m2, 'zenkai_level', def.zenkai_ability?.length, m2.stars),
      el('h3', {}, 'ソウルブースト値（実機に合わせて調整）'),
      el('div', { class: 'grid2' }, STATS.map((s) => labeledNum(STAT_LABELS[s], m2.boost, s))),
      el('div', { class: 'row' },
        el('button', {
          class: 'btn secondary small',
          onclick: () => { m2.boost = { ...zeroStats(), ...(def.soul_max || {}) }; openCharSheet(cid); },
        }, '最大値をセット'),
        el('button', {
          class: 'btn secondary small',
          onclick: () => { m2.boost = zeroStats(); openCharSheet(cid); },
        }, '0にする')),
      el('details', { open: Object.values(m2.total_override || {}).some((v) => v > 0) },
        el('summary', {}, '合計ステの実測値を入力（任意）'),
        el('p', { class: 'small-note' },
          '取り込みデータの ❶ は完全限界突破時の理論値です。実機のステータス画面と数値がズレる場合は、画面左の「合計ステ」をここに入力すると ❶ = 合計ステ − ブースト値 で実測に合わせて計算します（0 = 理論値を使用）。'),
        el('div', { class: 'grid2' }, STATS.map((s) => {
          if (!m2.total_override) m2.total_override = {};
          if (m2.total_override[s] == null) m2.total_override[s] = 0;
          return labeledNum(STAT_LABELS[s], m2.total_override, s);
        }))),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: async () => { await persistMy(); closeSheet(); renderChars(); renderParty(); showMsg('ok', '保存しました'); } }, '保存'),
        el('button', {
          class: 'btn danger',
          onclick: async () => {
            if (!confirm(`${def.name} の所持登録を解除しますか？（星・ブースト入力は失われます）`)) return;
            delete state.my.characters[cid];
            ui.party.memberIds = ui.party.memberIds.map((x) => String(x) === cid ? '' : x);
            delete ui.party.equips[cid];
            await persistMy(); closeSheet(); renderChars(); renderParty();
          },
        }, '登録解除'))));
  };
  renderOwnedArea();

  // ULTRAアビリティ（レアリティULTRAのみ）。与ダメージ等の戦闘効果で ❸ には乗らないため
  // 原文＋参照タグの編成充足状況を表示し、リーダー/同タグ編成の判断材料にする
  const ultraView = () => {
    const list = def.ultra_ability || [];
    if (!list.length) return null;
    const bSet = new Set(battleIds().map(String));
    const battleMembers = partyMembers().filter((m) => bSet.has(String(m.character.id)));
    return el('div', {},
      el('h3', {}, el('span', { class: 'ultra-badge' }, 'ULTRA'), ' ウルトラアビリティ'),
      el('p', { class: 'small-note' },
        '与ダメージ・気力回復などの戦闘効果のためステータス計算(❸)には含まれません。' +
        'リーダー枠に置く、または参照タグのキャラを編成すると強化される効果です。'),
      ...list.filter((u) => (u.text || '').trim() || (u.name || '').trim()).map((u) => el('div', { style: 'margin-bottom:8px' },
        el('div', { class: 'item-title' }, u.name),
        el('div', { class: 'item-desc', style: 'white-space:pre-wrap' },
          String(u.text || '')
            .replace(/\{\{ICN:ChaTag\}\}/g, 'タグ:')
            .replace(/\{\{ICN:Epi\}\}/g, 'エピソード:')
            .replace(/\{\{ICN:UpBlue\}\}/g, 'アップ')
            .replace(/\{\{ICN:[^}]+\}\}/g, '')),
        (u.ref_tags || []).length && battleMembers.length
          ? el('div', {}, (u.ref_tags || []).map((r) => {
              if (r.enemy) {
                // 「〜に対する」= 敵対象タグ。編成条件ではないので人数は数えない
                return el('span', { class: 'ultra-cond-ng', style: 'margin-right:10px;font-size:12px' },
                  `「${r.name}」（敵対象）`);
              }
              const n = r.tag != null
                ? battleMembers.filter((m) => (m.character.tags || []).includes(r.tag)).length
                : 0;
              return el('span', { class: n > 0 ? 'ultra-cond-ok' : 'ultra-cond-ng', style: 'margin-right:10px;font-size:12px' },
                `「${r.name}」出撃メンバー中 ${n} 体`);
            }))
          : null)));
  };

  body.append(...nodes(
    el('div', { style: 'display:flex;gap:10px' },
      el('div', { style: 'width:84px;flex:none' }, charTile(def, { showOwned: false })),
      el('div', {},
        el('div', { class: 'item-title' }, def.name),
        el('div', { class: 'item-desc' },
          `${def.card_no} / ${def.rarity}${def.lf ? ' / LEGENDS LIMITED' : ''}${def.zenkai ? ' / ZENKAI' : ''} / 属性 ${def.element}`),
        el('div', {}, tagChips(def.tags)))),
    ownedArea,
    el('h3', {}, 'ステータス'),
    statTable,
    ultraView(),
    el('h3', {}, 'アビリティ補正（現在の設定で有効な値）'),
    abilityPreview(),
    el('details', {},
      el('summary', {}, 'アビリティ原文を表示'),
      [...(def.z_ability || []), ...(def.deploy_z_ability || []), ...(def.zenkai_ability || [])].map((a) =>
        el('div', { class: 'slot-eff' },
          el('div', { class: 'sl' }, a.name),
          el('div', { class: 'line raw', style: 'white-space:pre-wrap' }, (a.groups || []).map((g) => g.raw).join('\n\n').replace(/\{\{ICN:[^}]+\}\}/g, '')))))));
  openSheet(def.name, body);
}

// ---------------------------------------------------------------- フラグタブ / フラグ詳細シート

const RARITY_LABELS = {
  iron: 'アイアン', bronze: 'ブロンズ', silver: 'シルバー', gold: 'ゴールド',
  platinum: 'プラチナ', unique: 'ユニーク', event: 'イベント',
  awakenedbronze: '覚醒ブロンズ', awakenedsilver: '覚醒シルバー',
  awakenedgold: '覚醒ゴールド', awakenedunique: '覚醒ユニーク', rainbow: 'レインボー',
};

function renderFrags() {
  const root = $('#frags-view');
  const f = ui.fragFilter;
  const rarities = [...new Set(Object.values(state.game.fragments).map((x) => x.rarity).filter(Boolean))];
  const grid = el('div', { class: 'frag-grid' });
  const rerenderGrid = () => {
    const q = f.q.trim();
    const list = Object.values(state.game.fragments)
      .filter((x) => f.showTop || !isTournamentOnly(x))
      .filter((x) => !f.rarity || x.rarity === f.rarity)
      .filter((x) => !q || (x.name || '').includes(q))
      .sort((a, b) => b.id - a.id);
    grid.replaceChildren(...list.map((x) =>
      fragTile(x, { onclick: () => openFragSheet(String(x.id)) })));
    if (list.length === 0) grid.append(el('p', { class: 'hint' }, '該当なし'));
  };
  root.replaceChildren(
    el('p', { class: 'hint' }, `全 ${Object.keys(state.game.fragments).length} 件。タップで詳細・所持数の調整（初期値6枚）。`),
    el('div', { class: 'filter-row sticky-bar' },
      el('input', { type: 'search', value: f.q, placeholder: 'フラグメント名で検索', oninput: (e) => { f.q = e.target.value; rerenderGrid(); } }),
      el('label', { class: 'check', style: 'margin:0;flex:none' },
        el('input', { type: 'checkbox', checked: !!f.showTop, onchange: (e) => { f.showTop = e.target.checked; rerenderGrid(); } }), '力の大会も表示')),
    el('div', { class: 'chip-row' },
      rarities.map((r) => el('button', {
        class: `chip${f.rarity === r ? ' on' : ''}`,
        onclick: () => { f.rarity = f.rarity === r ? '' : r; renderFrags(); },
      }, RARITY_LABELS[r] || r))),
    grid);
  rerenderGrid();
}

/**
 * フラグメント詳細シート。
 * opts.cid / opts.slotIdx 付き（編成の装備スロットから開いた場合）は、
 * 現在のパーティに対する効果条件の達成状況と、変更/外すボタンを表示する。
 */
function openFragSheet(fid, opts = {}) {
  const f = fragDef(fid);
  if (!f) return;
  const body = el('div', {});
  const equippedBy = opts.cid != null ? charDef(opts.cid) : null;

  // 装備者視点の効果（条件達成状況・★によるSLOT解放を反映）
  let equippedView = null;
  if (equippedBy) {
    const my = charMy(opts.cid) || defaultCharMy(equippedBy);
    const members = partyMembers();
    const ctx = battleContexts(members)[String(opts.cid)];
    const r = fragmentStatEffects(f, state.game.effectMap, { stars: my.stars ?? 7, context: ctx });

    // 「なぜこのフラグ？」— 実際に使われる重み・補正での寄与と候補比較
    const ew = effectiveWeightsFor(opts.cid);
    const extAll = currentPartyExt(members);
    const extM = extAll[String(opts.cid)];
    const memberObj = members.find((x) => String(x.character.id) === String(opts.cid)) || { character: equippedBy, my };
    const corrOf = (s) => (extM ? ((extM.z[s] || 0) + (extM.zenkai[s] || 0) + (extM.ll[s] || 0)) : 0);
    const others = memberEquips(opts.cid)
      .filter((x, i) => i !== opts.slotIdx && x).map(fragDef).filter(Boolean);
    const weightedOf = (list) => {
      const d = characterDetail({ member: memberObj, ext: extM, fragmentList: list, effectMap: state.game.effectMap, context: ctx });
      let t = 0;
      for (const [s, w] of Object.entries(ew.weights)) {
        if (w > 0 && d.stats[s]) t += w * d.stats[s].final;
      }
      return t;
    };
    const baseScore = weightedOf(others);
    const ownDelta = weightedOf([...others, f]) - baseScore;

    // 候補トップ10比較（開いたときだけ計算）
    const compareBox = el('div', {});
    let compared = false;
    const compareDetails = el('details', {
      ontoggle: (e) => {
        if (!e.target.open || compared) return;
        compared = true;
        const cands = Object.values(state.game.fragments)
          .filter((x) => canEquip(equippedBy, x))
          .filter((x) => !isTournamentOnly(x))
          .filter((x) => !others.some((o) => String(o.id) === String(x.id) || fragsConflict(o, x)));
        const scored = cands.map((x) => ({ x, d: weightedOf([...others, x]) - baseScore }))
          .sort((a, b) => b.d - a.d);
        const rank = scored.findIndex((s) => String(s.x.id) === String(f.id)) + 1;
        compareBox.replaceChildren(...nodes(
          el('p', { class: 'small-note' },
            `この装備は候補 ${scored.length} 件中 第${rank || '?'}位 の寄与です（他スロットの装備は固定して比較）。`),
          ...scored.slice(0, 10).map((s, i) => el('div', {
            class: 'effline',
            style: String(s.x.id) === String(f.id) ? 'font-weight:900;color:var(--accent)' : '',
          }, `${i + 1}. ${s.x.name.slice(0, 22)} +${fmt0(s.d)}`))));
      },
    }, el('summary', {}, 'このスロットの候補トップ10と比較'), compareBox);

    equippedView = el('div', {},
      el('h3', {}, `${equippedBy.name} に装備中の効果`),
      r.effects.length
        ? el('div', {}, r.effects.map((e2) => {
            // 基礎なし補正は最後に乗算されるため、❷が高いほど額面より価値が大きい（§2-5）。
            // 誤解を防ぐため「基礎あり換算」の目安を添える
            const note = e2.base
              ? '（基礎）'
              : `（基礎なし ≒ 基礎+${fmt(e2.value * (1 + corrOf(e2.stat) / 100), 0)}%相当）`;
            return el('div', { class: 'effline' },
              el('span', { class: 'ultra-cond-ok' }, `✓ ${STAT_LABELS[e2.stat] || e2.text || ''} +${fmt(e2.value, 2)}%`),
              el('span', { class: 'small-note', style: 'margin-left:4px' }, note));
          }))
        : el('p', { class: 'small-note' }, '現在発動中の計算対象効果はありません。'),
      el('div', { class: 'effline' },
        el('span', {}, `評価重み: ${ew.label} ／ この装備の寄与: `),
        el('span', { class: 'ultra-cond-ok', style: 'font-weight:900' }, `+${fmt0(ownDelta)}`),
        el('span', { class: 'small-note' }, '（重み付き最終ステ❸換算）')),
      compareDetails,
      r.conditionalOff.length
        ? el('div', {}, r.conditionalOff.map((c) => el('div', { class: 'effline' },
            el('span', { class: 'ultra-cond-ng' }, `⚠ 条件未達: ${c.cond_raw || ''}${c.text}+${c.value}%`))))
        : null,
      (r.others || []).length
        ? el('p', { class: 'small-note' }, `計算対象外の効果: ${r.others.join(' / ')}`)
        : null,
      el('div', { class: 'row', style: 'margin-top:8px' },
        el('button', {
          class: 'btn secondary',
          onclick: () => { closeSheet(); openFragPicker(opts.cid, opts.slotIdx); },
        }, '別のフラグに変更'),
        el('button', {
          class: 'btn danger',
          onclick: async () => {
            const arr = memberEquips(opts.cid);
            arr[opts.slotIdx] = null;
            ui.party.equips[String(opts.cid)] = arr;
            await persistMy();
            closeSheet(); renderParty();
          },
        }, '外す')));
  }

  const countRow = el('div', { class: 'row', style: 'align-items:center' });
  const renderCountRow = () => {
    countRow.replaceChildren(
      el('button', {
        class: 'btn secondary', style: 'flex:none;width:52px',
        onclick: async () => { await setFragCount(fid, fragCount(fid) - 1); renderCountRow(); renderFrags(); },
      }, '−'),
      el('div', { style: 'text-align:center;font-size:20px;font-weight:800;color:var(--accent)' }, `所持 ${fragCount(fid)}`),
      el('button', {
        class: 'btn secondary', style: 'flex:none;width:52px',
        onclick: async () => { await setFragCount(fid, fragCount(fid) + 1); renderCountRow(); renderFrags(); },
      }, '＋'));
  };
  renderCountRow();

  const equippableNames = (f.equip_char_ids || []).map((id) => charDef(id)?.name).filter(Boolean);

  body.append(...nodes(
    el('div', { style: 'display:flex;gap:10px;align-items:flex-start' },
      el('div', { style: 'width:74px;flex:none' }, fragTile(f, {})),
      el('div', {},
        el('div', { class: 'item-title' }, f.name),
        el('div', { class: 'item-desc' }, f.rarity_label || RARITY_LABELS[f.rarity] || f.rarity || ''),
        isAwakenedFrag(f) ? el('div', { class: 'item-desc', style: 'color:var(--fr-awakenedgold);font-weight:700' }, '覚醒フラグメント') : null,
        isTournamentOnly(f) ? el('div', { class: 'item-desc', style: 'color:var(--warn)' }, '力の大会専用（通常バトルの最適化からは除外されます）') : null,
        f.condition_text ? el('div', { class: 'item-desc' }, `装備条件: ${f.condition_text}`) : null)),
    equippedView,
    countRow,
    el('h3', {}, '効果（数値は最大値）'),
    Array.isArray(f.slots) && f.slots.length
      ? el('div', {}, fragSlotEffectsView(f, 7))
      : el('div', {}, (f.effects || []).map((e2) => el('div', { class: 'effline' },
          e2.text ? `${e2.text} +${e2.value}%` : `${e2.base ? '基礎' : ''}${STAT_LABELS[e2.stat] || e2.stat} +${e2.value}%`))),
    (f.equip_char_ids || []).length
      ? el('details', {},
          el('summary', {}, `装備可能キャラ ${f.equip_char_ids.length} 体`),
          el('p', { class: 'small-note' }, equippableNames.slice(0, 40).join(' / ') + (equippableNames.length > 40 ? ' …' : '')))
      : el('p', { class: 'small-note' }, '装備条件なし（全キャラ装備可）')));
  openSheet(f.name, body);
}

// ---------------------------------------------------------------- 計算タブ（v0 検証用）

const VERIFY_CASES = [
  { label: '検算(1)', fragBase: 110, fragNonBase: 0 },
  { label: '検算(2)', fragBase: 60, fragNonBase: 30 },
  { label: '検算(3)', fragBase: 15, fragNonBase: 40 },
];

function renderCalc() {
  const m = ui.calc;
  const root = $('#calc-form');

  const fillFromChar = () => {
    if (!m.charId) return;
    const def = charDef(m.charId);
    const sb = def ? statBase(def, charMy(m.charId), m.stat) : null;
    if (sb) { m.total = sb.total; m.boost = sb.boost; }
  };

  const charSelect = el('label', {}, 'キャラから合計ステ/ブースト値を読み込む（任意）',
    el('select', {
      onchange: (e) => { m.charId = e.target.value; fillFromChar(); renderCalc(); },
    },
      el('option', { value: '' }, '（手入力）'),
      Object.keys(state.my.characters).filter((id) => charDef(id)).map((id) =>
        el('option', { value: id, selected: m.charId === id }, charDef(id).name))));

  const statSelect = el('label', {}, '対象ステータス',
    el('select', {
      onchange: (e) => { m.stat = e.target.value; fillFromChar(); renderCalc(); },
    }, STATS.map((s) => el('option', { value: s, selected: m.stat === s }, STAT_LABELS[s]))));

  const modeRadio = el('div', { class: 'check' },
    ...['direct', 'frags'].map((mode) => el('label', { class: 'check', style: 'margin-top:0' },
      el('input', {
        type: 'radio', name: 'calc-mode', checked: m.mode === mode,
        onchange: () => { m.mode = mode; renderCalc(); },
      }),
      mode === 'direct' ? '補正値を直接入力' : '所持フラグメントから選択')));

  let fragArea = null;
  if (m.mode === 'direct') {
    fragArea = el('div', { class: 'grid2' },
      labeledNum('フラグメント基礎あり合計 (%)', m, 'fragBase'),
      labeledNum('フラグメント基礎なし合計 (%)', m, 'fragNonBase'));
  } else {
    const def = m.charId ? charDef(m.charId) : null;
    const list = def
      ? Object.values(state.game.fragments).filter((f) => fragCount(f.id) > 0 && canEquip(def, f) && !isTournamentOnly(f))
      : [];
    fragArea = el('div', { class: 'item-list' },
      !def
        ? el('p', { class: 'hint' }, '先に上でキャラを選ぶと、そのキャラが装備できるフラグメントから選択できます。')
        : list.map((f) => el('div', { class: 'item' },
            el('input', {
              type: 'checkbox', checked: !!m.selected[f.id],
              onchange: (e) => { m.selected[f.id] = e.target.checked; },
            }),
            el('div', { class: 'grow' },
              el('div', { class: 'item-title' }, f.name)))),
      def ? el('p', { class: 'small-note' }, '※効果条件付きの効果は、この画面ではパーティ文脈が無いため適用されません（編成タブでは考慮されます）。') : null);
  }

  root.replaceChildren(el('div', { class: 'card' },
    charSelect, statSelect,
    el('div', { class: 'grid2' },
      labeledNum('合計ステ（画面左の数値）', m, 'total'),
      labeledNum('ブースト値（括弧内の数値）', m, 'boost'),
      labeledNum('Zアビ合計 (%)（パーティ6体）', m, 'z'),
      labeledNum('ZENKAIアビ合計 (%)（6体）', m, 'zenkai'),
      labeledNum('LL/出撃Zアビ合計 (%)（バトル3体）', m, 'll')),
    el('h3', {}, 'フラグメント補正'),
    modeRadio, fragArea,
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: runCalc }, '計算する'),
      ...VERIFY_CASES.map((c) => el('button', {
        class: 'btn secondary',
        onclick: () => {
          Object.assign(m, {
            total: 273617, boost: 42080, z: 149, zenkai: 0, ll: 30,
            stat: 'strike_atk', mode: 'direct', fragBase: c.fragBase, fragNonBase: c.fragNonBase, charId: '',
          });
          renderCalc(); runCalc();
        },
      }, c.label)))));
}

function runCalc() {
  clearMsgs();
  const m = ui.calc;
  let fragBase = m.fragBase;
  let fragNonBase = m.fragNonBase;
  if (m.mode === 'frags') {
    const selected = Object.keys(m.selected).filter((id) => m.selected[id] && fragDef(id));
    if (!checkRarities(selected)) return;
    const stars = m.charId ? (charMy(m.charId)?.stars ?? 7) : 7;
    const sums = sumFragmentEffects(selected.map(fragDef), state.game.effectMap, { stars });
    fragBase = sums.basePct[m.stat];
    fragNonBase = sums.nonBasePct[m.stat];
    reportUnknown(sums.unknown);
  }
  const r = computeStat({
    total: m.total, boost: m.boost, z: m.z, zenkai: m.zenkai, ll: m.ll,
    fragBase, fragNonBase,
  });
  const mv = marginalValues({ base: r.base, boost: m.boost, corr: r.corr, nonBase: r.nonBase });
  const rows = [
    ['❶ 基本ステータス', fmt0(r.base)],
    ['❷ 基礎ステータス補正', `+${fmt(r.corr)}%`],
    ['❸ 最終ステータス ★', fmt(r.final)],
    ['❹ ブースト倍率', fmt(r.ratio, 5)],
    ['❺ 最終ステータス補正', `+${fmt(r.corr5)}%`],
    ['❻ 合計フラグメント補正', `+${fmt(r.fragTotal)}%`],
  ];
  $('#calc-result').replaceChildren(el('div', { class: 'card' },
    el('h3', {}, `${STAT_LABELS[m.stat]} の計算結果`),
    el('table', {},
      rows.map(([k, v], i) => el('tr', {},
        el('td', {}, k),
        el('td', { class: `num${i === 2 ? ' big' : ''}` }, v)))),
    el('p', { class: 'small-note' },
      `参考: いまの状態での限界価値 … 基礎あり+1% → +${fmt(mv.basePlus1)} / 基礎なし+1% → +${fmt(mv.nonBasePlus1)}`)));
}

// ---------------------------------------------------------------- データタブ

function renderData() {
  const root = $('#data-view');
  let fileInput = null;
  let htmlArea = null;
  const meta = state.game.meta;

  root.replaceChildren(
    el('div', { class: 'card' },
      el('h3', {}, 'ゲームデータ'),
      meta
        ? el('p', { class: 'hint' },
            `キャラ ${meta.characters} 体（詳細 ${meta.characters_detailed}）/ フラグメント ${meta.fragments} 件 / タグ ${meta.tags} 件\n` +
            `取得日時: ${new Date(meta.generated_at).toLocaleString('ja-JP')}（取得元: ${meta.source}）`)
        : el('p', { class: 'hint' }, '取り込みメタ情報がありません。'),
      el('p', { class: 'small-note' },
        '新キャラ・新フラグメントは毎日 14:30 と 18:00（日本時間）に自動で取り込まれます' +
        '（サーバーの混雑で多少前後することがあります）。' +
        '反映されていないときはアプリを開き直すか、下の「キャッシュを更新」を押してください。')),
    el('div', { class: 'card' },
      el('h3', {}, '所持設定'),
      el('label', { class: 'check' },
        el('input', {
          type: 'checkbox', checked: state.my.own_all !== false,
          onchange: async (e) => {
            state.my.own_all = e.target.checked;
            await persistMy(); renderChars(); renderParty();
          },
        }), '全キャラを所持として扱う（標準）'),
      el('p', { class: 'small-note' },
        'オンのとき全キャラが所持扱いになり、ゼンカイ枠の自動選出も全キャラから選びます。' +
        '未登録キャラは ★7・ソウルブースト最大として計算します（キャラ詳細で個別に調整すると保存されます）。' +
        'オフにすると従来どおり登録したキャラだけが所持になります。')),
    el('div', { class: 'card' },
      el('h3', {}, 'バックアップ（重要）'),
      el('p', { class: 'hint' }, '所持キャラ・所持フラグメント・編成（my_data）はこの端末のブラウザにのみ保存されます。消すと復旧できないため、定期的にエクスポートしてください。'),
      el('div', { class: 'row' },
        el('button', {
          class: 'btn', onclick: async () => {
            const data = await store.exportAll();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const a = el('a', {
              href: URL.createObjectURL(blob),
              download: `dbl-fragments-${new Date().toISOString().slice(0, 10)}.json`,
            });
            a.click(); URL.revokeObjectURL(a.href);
          },
        }, 'エクスポート'),
        el('button', { class: 'btn secondary', onclick: () => fileInput.click() }, 'インポート')),
      fileInput = el('input', {
        type: 'file', accept: 'application/json', hidden: true,
        onchange: async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          try {
            const obj = JSON.parse(await file.text());
            await store.importAll(obj);
            await reloadAll();
            showMsg('ok', 'インポートしました');
          } catch (err) {
            showMsg('error', `■ インポートに失敗しました\n${err.message}`);
          }
          e.target.value = '';
        },
      })),
    el('div', { class: 'card' },
      el('h3', {}, 'HTML貼り付け取り込み（予備手段）'),
      el('p', { class: 'hint' }, '参照サイトのキャラ一覧ページのHTMLを貼り付けると、キャラの基本情報とタグ名対応表だけを端末単独で取り込めます（ステータス・アビリティはPCのクローラが必要）。'),
      htmlArea = el('textarea', { placeholder: '<a href="character/738" data-charaname=... のHTMLを貼り付け' }),
      el('button', {
        class: 'btn secondary',
        onclick: async () => {
          const html = htmlArea.value;
          if (!html.trim()) return;
          const { characters, skipped } = parseCharacterListHTML(html);
          const tags = parseTagSelectHTML(html);
          if (characters.length === 0 && Object.keys(tags).length === 0) {
            showMsg('error',
              '■ 取り込みに失敗しました\n貼り付けた内容からキャラ・タグを見つけられませんでした。\n参照先のページ構造が変わった可能性があります。アプリの更新が必要です。\n（前回取り込んだデータで引き続き利用できます）');
            return;
          }
          for (const c of characters) {
            const existing = charDef(c.id) || {};
            state.overrides.characters[String(c.id)] = {
              ...existing,
              id: c.id, card_no: c.card_no || existing.card_no || '',
              name: c.name, element: c.element, rarity: c.rarity,
              zenkai: c.zenkai, lf: c.lf, tags: c.tags,
              stats: existing.stats || zeroStats(),
              soul_max: existing.soul_max || zeroStats(),
            };
          }
          for (const [id, name] of Object.entries(tags)) state.overrides.tags[id] = name;
          await persistOverridesAndReload();
          renderAll();
          showMsg('ok', `取り込みました: キャラ ${characters.length} 体 / タグ名 ${Object.keys(tags).length} 件` +
            (skipped ? `\n⚠ IDを特定できず読み飛ばした行が ${skipped} 件あります` : ''));
          htmlArea.value = '';
        },
      }, '取り込む')),
    el('div', { class: 'card' },
      el('h3', {}, '効果変換表（effect_map）'),
      el('details', {},
        el('summary', {}, `登録済み ${Object.keys(state.game.effectMap.entries || {}).length} 件を表示`),
        el('table', {},
          Object.entries(state.game.effectMap.entries || {}).map(([text, v]) =>
            el('tr', {},
              el('td', {}, text),
              el('td', {}, v.other ? '計算対象外' : (v.stats || [v.stat]).map((s) => STAT_LABELS[s] || s).join('・')),
              el('td', {}, v.other ? '' : (v.base ? '❷に加算' : '乗算'))))))),
    el('div', { class: 'card' },
      el('h3', {}, 'アプリ'),
      el('div', { class: 'row' },
        el('button', {
          class: 'btn secondary',
          onclick: async () => {
            if ('serviceWorker' in navigator) {
              const regs = await navigator.serviceWorker.getRegistrations();
              await Promise.all(regs.map((r) => r.unregister()));
            }
            if (window.caches) {
              const keys = await caches.keys();
              await Promise.all(keys.map((k) => caches.delete(k)));
            }
            location.reload();
          },
        }, 'キャッシュを更新'),
        el('button', {
          class: 'btn danger',
          onclick: async () => {
            if (!confirm('所持キャラ・所持フラグメント・編成をすべて削除します。エクスポートしていない場合は復旧できません。本当に削除しますか？')) return;
            await store.clearAll();
            ui.party = { memberIds: ['', '', '', '', '', ''], equips: {} };
            await reloadAll();
            showMsg('ok', 'すべてのローカルデータを削除しました');
          },
        }, '全データ削除')),
      el('p', { class: 'small-note' },
        'このアプリは仲間内での利用を前提にしています。入力データ（所持・編成）はすべて各自の端末に保存され、外部には送信されません（利用者同士でも共有されません）。画像はデータ取得元サイトから表示時に読み込まれます。')));
}

// ---------------------------------------------------------------- 起動

function renderAll() {
  renderParty();
  renderChars();
  renderFrags();
  renderCalc();
  renderData();
}

async function reloadAll() {
  state.game = await store.loadGameData();
  state.my = await store.loadMyData();
  state.overrides = await store.loadOverrides();
  if (!ui.charFilter) ui.charFilter = defaultCharFilter();
  restorePartyFromMyData();
  renderAll();
}

async function boot() {
  try {
    await reloadAll();
  } catch (e) {
    showMsg('error', `■ 起動に失敗しました\n${e.message}`);
    return;
  }
  for (const err of state.game.errors) {
    showMsg('warn', `■ ゲームデータの一部を読み込めませんでした\n${err}\n（読み込めた範囲で動作します）`);
  }
  document.querySelectorAll('#tabbar button').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet-backdrop').addEventListener('click', closeSheet);
  switchTab('party');
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();
