// UI 層（DESIGN.md §7, §8）。ゲームの編成画面に似せた構成。
// 計算は js/calc.js、最適化は js/optimizer.js、永続化は js/store.js に分離してある。
// エラーメッセージはすべて日本語で、原因と対処が分かる文言にする（§6）。

import { STATS, STAT_LABELS, computeStat, marginalValues } from './calc.js';
import { sumFragmentEffects, fragmentStatEffects, lookupEffectName, conditionMatches } from './effects.js';
import {
  optimizeParty, partyAbilityCorrections, canEquip, characterDetail,
  statBase, autoAbilityLevel, memberAbilityGroups, isTournamentOnly, zRelationCounts,
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
    preset: 'attack', weights: Object.fromEntries(STATS.map((s) => [s, 0])),
    optimizeLeader: true,
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
      case 'stars': return isOwned(d.id) ? (Number(charMy(d.id).stars) || 0) : -1;
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
const PRESETS = {
  attack: { label: '攻撃特化', weights: { strike_atk: 1, blast_atk: 1 } },
  defense: { label: '耐久特化', weights: { hp: 1, strike_def: 0.7, blast_def: 0.7 } },
  balance: { label: 'バランス', weights: { hp: 0.6, strike_atk: 0.8, blast_atk: 0.8, strike_def: 0.5, blast_def: 0.5, critical: 0.2, ki_recovery: 0.1 } },
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
function charMy(id) { return state.my.characters[String(id)]; }
function isOwned(id) { return !!charMy(id); }
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
/** プラウド時のチーム分け（1戦目=枠1-3 / 2戦目=枠4-6） */
function proudTeams() {
  if (ui.party.mode !== 'proud') return null;
  return [
    ui.party.memberIds.slice(0, 3).filter((id) => id && charDef(id)),
    ui.party.memberIds.slice(3, 6).filter((id) => id && charDef(id)),
  ].filter((t) => t.length > 0);
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
        ctxs[String(m.character.id)] = { selfId: m.character.id, members: teamMembers.map(info) };
      }
    }
  } else {
    const bs = battleIds().map(String);
    const bm = members.filter((m) => bs.includes(String(m.character.id)));
    for (const m of members) {
      ctxs[String(m.character.id)] = { selfId: m.character.id, members: bm.map(info) };
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
    member_ids: ui.party.memberIds.map(Number),
    battle_ids: battleIds().map(Number),
    equips: ui.party.equips,
    display_stat: ui.displayStat,
    opt: ui.opt,
  }];
}
function restorePartyFromMyData() {
  const p = state.my.parties?.[0];
  if (!p) return;
  const ids = (p.member_ids || []).map((x) => (x ? String(x) : ''));
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
    class: `frag-tile fr-${f.rarity || 'default'}${count > 0 ? '' : ' not-owned'}${opts.disabled ? ' disabled' : ''}`,
    onclick: opts.onclick,
    title: f.name,
  },
    lazyImg(f.icon, f.name),
    used > 0 ? el('div', { class: 'equipped-badge' }, '装備中') : null,
    isTournamentOnly(f) ? el('div', { class: 'top-badge' }, '力の大会') : null,
    el('div', { class: 'count-badge' }, opts.showRemaining ? `残${Math.max(0, count - used)}` : `×${count}`));
}

// ---------------------------------------------------------------- 編成タブ

function renderParty() {
  const root = $('#party-view');
  const proud = ui.party.mode === 'proud';
  const members = partyMembers();
  const bIds = battleIds();
  const teams = proudTeams();
  const ext = members.length
    ? partyAbilityCorrections({
        members, battleIds: bIds, teams, effectMap: state.game.effectMap,
        leaderId: ui.party.memberIds[0] || null,
        leaders: proud ? [ui.party.memberIds[0] || null, ui.party.memberIds[3] || null] : undefined,
      })
    : {};
  const contexts = battleContexts(members);

  // Z/ZENKAIアビリティの関係数（◎×N。スタンダード=パーティ6体 / プラウド=チーム内）
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
        el('div', { class: 'm-name' }, m.character.name, memberBadge(cid)),
        el('div', { class: 'm-sub', style: 'display:flex;align-items:center;gap:6px' },
          m.character.card_no,
          el('span', {}, starsSelectCompact(cid, m.my)),
          `Zアビ${['I', 'II', 'III', 'IV'][((m.my.z_level && m.my.z_level !== 'auto') ? m.my.z_level : autoAbilityLevel(m.my.stars)) - 1] || '—'}`),
        el('div', { class: 'frag-slots' },
          equips.map((fid, idx) => {
            const f = fid ? fragDef(fid) : null;
            return el('div', {
              class: `frag-slot${f ? ` fr-${f.rarity || 'default'}` : ''}`,
              onclick: () => openFragPicker(cid, idx),
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
    el('button', { class: 'btn', onclick: runOptimize }, '最適化を実行'),
    el('p', { class: 'small-note' },
      '同一フラグメントは同じキャラに重複装備できません（別キャラは所持数の範囲で同時装備可）。' +
      '所持数は「フラグ」タブで調整できます（初期値6枚）。結果は上の装備枠に反映されます。'));
}

function currentWeights() {
  const m = ui.opt;
  if (m.mode === 'single') return { [m.stat]: 1 };
  if (m.mode === 'preset') return { ...PRESETS[m.preset].weights };
  return { ...m.weights };
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
  Object.assign(ui.opt, s.optPatch);
  for (const [cid, asg] of Object.entries(s.assignments)) {
    const slots = Number(charMy(cid)?.equip_slots) || 3;
    const arr = asg.ids.slice(0, slots);
    while (arr.length < slots) arr.push(null);
    ui.party.equips[cid] = arr;
  }
  ui.suggestion = null;
  await persistMy();
  renderParty();
  showMsg('ok', '提案の最適化を適用しました。');
}

function renderSuggestionCard() {
  const s = ui.suggestion;
  if (!s) return null;
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
                if (!isOwned(cid)) state.my.characters[cid] = defaultCharMy(charDef(cid));
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
  const baseParams = {
    members, battleIds: bIds, teams, contexts,
    fragmentsById: state.game.fragments, counts,
    weights, effectMap: state.game.effectMap,
    targets: proud ? 'all' : ui.opt.targets,
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

  let best = null;
  for (const combo of leaderCombos) {
    const r = optimizeParty({
      ...baseParams,
      leaderId: proud ? undefined : combo[0],
      leaders: proud ? combo : undefined,
    });
    if (!best || r.totalScore > best.result.totalScore) best = { result: r, leaders: combo };
  }
  const result = best.result;

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
    ui.suggestion = computeStyleSuggestion(members, baseParams, best, result);
  } catch (e) {
    console.warn('提案の計算に失敗:', e);
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
  showMsg(result.exact ? 'ok' : 'warn',
    (result.exact ? '最適化が完了しました（厳密解）。装備枠に反映しました。'
      : '最適化を打ち切りで終えました（暫定解）。装備枠に反映しました。') +
    (leaderChanged.length ? `\nリーダー枠を ${leaderChanged.join(' / ')} に変更しました（Zアビ特殊ルールで最も高くなる配置）。` : ''));
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
          if (!isOwned(d.id)) {
            state.my.characters[sid] = defaultCharMy(d);
          }
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
        if (line.raw != null) return el('div', { class: 'line raw' }, line.raw);
        const valueText = `${line.text} +${line.value}%${line.value_min != null ? `（最大値。${line.value_min}〜${line.value}%）` : ''}`;
        if (line.cond) {
          return el('div', { class: 'line' },
            el('span', { style: 'color:var(--accent2)' }, `【条件】${line.cond_raw || ''} `), valueText,
            el('span', { class: 'raw' }, '（編成が条件を満たすときだけ計算に含まれます）'));
        }
        return el('div', { class: 'line' }, valueText);
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
        class: `frag-slot${f ? ` fr-${f.rarity || 'default'}` : ''}`,
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
      const noneLeft = usedElsewhere >= count;
      return fragTile(f, {
        exclude: { cid, idx: slotIdx },
        showRemaining: true,
        disabled: dupInChar || (noneLeft && !isCurrent),
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
      if (!isOwned(cid)) state.my.characters[String(cid)] = my;
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
    const { party, deploy } = memberAbilityGroups({ character: def, my, effectMap: state.game.effectMap });
    const lines = [];
    for (const [label, groups] of [['パーティ全員に', party], ['バトル3体に', deploy]]) {
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
    const m2 = charMy(cid);
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

  body.append(
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
    el('h3', {}, 'アビリティ補正（現在の設定で有効な値）'),
    abilityPreview(),
    el('details', {},
      el('summary', {}, 'アビリティ原文を表示'),
      [...(def.z_ability || []), ...(def.deploy_z_ability || []), ...(def.zenkai_ability || [])].map((a) =>
        el('div', { class: 'slot-eff' },
          el('div', { class: 'sl' }, a.name),
          el('div', { class: 'line raw', style: 'white-space:pre-wrap' }, (a.groups || []).map((g) => g.raw).join('\n\n').replace(/\{\{ICN:[^}]+\}\}/g, ''))))));
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

function openFragSheet(fid) {
  const f = fragDef(fid);
  if (!f) return;
  const body = el('div', {});

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

  body.append(
    el('div', { style: 'display:flex;gap:10px;align-items:flex-start' },
      el('div', { style: 'width:74px;flex:none' }, fragTile(f, {})),
      el('div', {},
        el('div', { class: 'item-title' }, f.name),
        el('div', { class: 'item-desc' }, f.rarity_label || RARITY_LABELS[f.rarity] || f.rarity || ''),
        isTournamentOnly(f) ? el('div', { class: 'item-desc', style: 'color:var(--warn)' }, '力の大会専用（通常バトルの最適化からは除外されます）') : null,
        f.condition_text ? el('div', { class: 'item-desc' }, `装備条件: ${f.condition_text}`) : null)),
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
      : el('p', { class: 'small-note' }, '装備条件なし（全キャラ装備可）'));
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
        '更新するには PC で `node tools/crawl_dblegends.mjs` を実行してコミットします（README参照）。画像は参照サイトから表示時に読み込みます。')),
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
        'このアプリは個人利用を前提にしています。入力データはすべてこの端末に保存され、外部には送信されません。画像はデータ取得元サイトから表示時に読み込まれます。')));
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
