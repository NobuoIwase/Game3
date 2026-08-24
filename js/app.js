// UI 層（DESIGN.md §7, §8）。ゲームの編成画面に似せた構成。
// 計算は js/calc.js、最適化は js/optimizer.js、永続化は js/store.js に分離してある。
// エラーメッセージはすべて日本語で、原因と対処が分かる文言にする（§6）。

import { STATS, STAT_LABELS, computeStat, marginalValues } from './calc.js';
import { sumFragmentEffects, fragmentStatEffects } from './effects.js';
import {
  optimizeParty, abilityCorrections, canEquip, characterDetail,
  statBase, autoAbilityLevel, memberAbilityGroups,
} from './optimizer.js';
import * as store from './store.js';
import { parseCharacterListHTML, parseTagSelectHTML } from './parser.js';

// ---------------------------------------------------------------- 状態

const state = { game: null, my: null, overrides: null };

const ui = {
  tab: 'party',
  party: { memberIds: ['', '', '', '', '', ''], equips: {} }, // equips: cid → [fragId|null,...]
  displayStat: 'strike_atk',
  opt: {
    targets: 'battle', mode: 'single', stat: 'strike_atk',
    preset: 'attack', weights: Object.fromEntries(STATS.map((s) => [s, 0])),
    allowDup: false,
  },
  charFilter: { q: '', el: '', ownedOnly: false },
  fragFilter: { q: '', rarity: '', ownedOnly: false },
  calc: {
    stat: 'strike_atk', total: 273617, boost: 42080,
    z: 149, zenkai: 0, ll: 30,
    mode: 'direct', fragBase: 0, fragNonBase: 0, charId: '', selected: {},
  },
};

const ELEMENTS = ['RED', 'YEL', 'PUR', 'GRN', 'BLU', 'LGT', 'DRK'];
const PRESETS = {
  attack: { label: '攻撃特化', weights: { strike_atk: 1, blast_atk: 1 } },
  defense: { label: '耐久特化', weights: { hp: 1, strike_def: 0.7, blast_def: 0.7 } },
  balance: { label: 'バランス', weights: { hp: 0.6, strike_atk: 0.8, blast_atk: 0.8, strike_def: 0.5, blast_def: 0.5, critical: 0.2, ki_recovery: 0.1 } },
};

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
function battleIds() {
  return ui.party.memberIds.slice(0, 3).filter((id) => id && charDef(id));
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
    member_ids: ui.party.memberIds.filter(Boolean).map(Number),
    battle_ids: battleIds().map(Number),
    equips: ui.party.equips,
    display_stat: ui.displayStat,
    opt: ui.opt,
  }];
}
function restorePartyFromMyData() {
  const p = state.my.parties?.[0];
  if (!p) return;
  const ids = (p.member_ids || []).map(String);
  ui.party.memberIds = [0, 1, 2, 3, 4, 5].map((i) => ids[i] || '');
  ui.party.equips = p.equips || {};
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
    class: `char-tile el-${def.element}${owned ? '' : ' not-owned'}`,
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
  const count = state.my.fragments[String(f.id)] || 0;
  const used = assignedCount(f.id, opts.exclude);
  return el('div', {
    class: `frag-tile fr-${f.rarity || 'default'}${count > 0 ? '' : ' not-owned'}${opts.disabled ? ' disabled' : ''}`,
    onclick: opts.onclick,
    title: f.name,
  },
    lazyImg(f.icon, f.name),
    used > 0 ? el('div', { class: 'equipped-badge' }, '装備中') : null,
    el('div', { class: 'count-badge' }, opts.showRemaining ? `残${Math.max(0, count - used)}` : `×${count}`));
}

// ---------------------------------------------------------------- 編成タブ

function renderParty() {
  const root = $('#party-view');
  const members = partyMembers();
  const bIds = battleIds();
  const ext = members.length ? abilityCorrections(members, bIds, state.game.effectMap) : {};

  // 表示ステータスの合計（バトル3体の❸合計）
  let battleTotal = 0;
  const details = new Map();
  for (const m of members) {
    const cid = String(m.character.id);
    const fragList = memberEquips(cid).filter(Boolean).map(fragDef).filter(Boolean);
    const d = characterDetail({ member: m, ext: ext[cid], fragmentList: fragList, effectMap: state.game.effectMap });
    details.set(cid, d);
    if (bIds.map(String).includes(cid) && d.stats[ui.displayStat]) {
      battleTotal += d.stats[ui.displayStat].final;
    }
  }

  const slot = (i) => {
    const id = ui.party.memberIds[i];
    const def = id ? charDef(id) : null;
    return el('div', { class: 'party-slot' },
      i === 0 && def ? el('div', { class: 'leader-badge' }, 'LEADER') : null,
      def
        ? charTile(def, { onclick: () => openCharPicker(i), showOwned: false })
        : el('div', { class: 'slot-empty', onclick: () => openCharPicker(i) }, '＋'),
      el('div', { class: 'party-label' }, i < 3 ? `バトル ${i + 1}` : `ベンチ ${i - 2}`));
  };

  const memberCard = (m) => {
    const cid = String(m.character.id);
    const d = details.get(cid);
    const st = d?.stats[ui.displayStat];
    const equips = memberEquips(cid);
    return el('div', { class: `member-card el-${m.character.element}` },
      el('div', { class: 'portrait', onclick: () => openCharSheet(cid) }, lazyImg(m.character.image, m.character.name)),
      el('div', { class: 'm-body' },
        el('div', { class: 'm-name' }, m.character.name,
          bIds.map(String).includes(cid) ? el('span', { class: 'badge ok' }, '出撃') : el('span', { class: 'badge ng' }, 'ベンチ')),
        el('div', { class: 'm-sub' }, `${m.character.card_no} ★${m.my.stars} / Zアビ${['I','II','III','IV'][((m.my.z_level && m.my.z_level !== 'auto') ? m.my.z_level : autoAbilityLevel(m.my.stars)) - 1] || '—'}`),
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
          : el('div', { class: 'm-stats' }, el('span', { class: 'small-note' }, 'ステータス未取得'))));
  };

  root.replaceChildren(...nodes(
    el('div', { class: 'party-summary' },
      el('div', {}, 'バトル3体 ',
        el('select', {
          style: 'width:auto;display:inline-block;padding:2px 6px;margin:0;font-size:12px',
          onchange: (e) => { ui.displayStat = e.target.value; persistMy(); renderParty(); },
        }, STATS.map((s) => el('option', { value: s, selected: ui.displayStat === s }, STAT_LABELS[s]))),
        ' 合計'),
      el('div', { class: 'val' }, fmt0(battleTotal))),
    el('div', { class: 'party-grid' }, [0, 1, 2].map(slot)),
    el('div', { class: 'party-grid' }, [3, 4, 5].map(slot)),
    members.length === 0
      ? el('p', { class: 'hint' }, '「＋」からキャラを選んでパーティを組んでください。所持キャラは「キャラ」タブでも登録できます。')
      : null,
    members.map(memberCard),
    renderOptimizerPanel()));
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
    el('label', { class: 'check' },
      el('input', {
        type: 'radio', name: 'opt-targets', checked: m.targets === 'battle',
        onchange: () => { m.targets = 'battle'; },
      }), 'バトル出撃3体に配分'),
    el('label', { class: 'check' },
      el('input', {
        type: 'radio', name: 'opt-targets', checked: m.targets === 'all',
        onchange: () => { m.targets = 'all'; },
      }), 'パーティ6体全員に配分'),
    el('label', { class: 'check' },
      el('input', {
        type: 'checkbox', checked: m.allowDup,
        onchange: (e) => { m.allowDup = e.target.checked; },
      }), '同一フラグメントの重複装備を許可（実機未確認）'),
    el('button', { class: 'btn', onclick: runOptimize }, '最適化を実行'),
    el('p', { class: 'small-note' }, '所持数を入れたフラグメントだけが対象です（「フラグ」タブで入力）。結果は上の装備枠に反映されます。'));
}

function currentWeights() {
  const m = ui.opt;
  if (m.mode === 'single') return { [m.stat]: 1 };
  if (m.mode === 'preset') return { ...PRESETS[m.preset].weights };
  return { ...m.weights };
}

async function runOptimize() {
  clearMsgs();
  const members = partyMembers();
  if (members.length === 0) {
    showMsg('error', '■ パーティが空です\nキャラを1体以上入れてください。');
    return;
  }
  const bIds = battleIds();
  if (ui.opt.targets === 'battle' && bIds.length === 0) {
    showMsg('error', '■ バトル出撃メンバーがいません\n上段の枠に1体以上入れてください。');
    return;
  }
  const ownedIds = Object.keys(state.my.fragments).filter((id) => state.my.fragments[id] > 0);
  if (ownedIds.length === 0) {
    showMsg('error', '■ 所持フラグメントが未登録です\n「フラグ」タブで所持数を入力してください。');
    return;
  }
  if (!checkRarities(ownedIds)) return;
  const weights = currentWeights();
  if (!Object.values(weights).some((w) => w > 0)) {
    showMsg('error', '■ 重みがすべて 0 です');
    return;
  }
  const result = optimizeParty({
    members, battleIds: bIds,
    fragmentsById: state.game.fragments,
    counts: { ...state.my.fragments },
    weights, effectMap: state.game.effectMap,
    targets: ui.opt.targets, allowDuplicates: ui.opt.allowDup,
  });
  for (const [cid, asg] of Object.entries(result.assignments)) {
    const slots = Number(charMy(cid)?.equip_slots) || 3;
    const arr = asg.ids.slice(0, slots);
    while (arr.length < slots) arr.push(null);
    ui.party.equips[cid] = arr;
  }
  await persistMy();
  renderParty();
  reportUnknown(result.unknown);
  for (const w of [...new Set(result.warnings)]) showMsg('warn', `■ ${w}`);
  showMsg(result.exact ? 'ok' : 'warn',
    result.exact ? '最適化が完了しました（厳密解）。装備枠に反映しました。'
      : '最適化を打ち切りで終えました（暫定解）。装備枠に反映しました。');
}

// ---------------------------------------------------------------- キャラ選択シート

function openCharPicker(slotIndex) {
  const filter = { q: '', el: '', ownedOnly: true };
  const body = el('div', {});
  const grid = el('div', { class: 'char-grid' });

  const rerenderGrid = () => {
    const q = filter.q.trim();
    const inParty = new Set(ui.party.memberIds.filter(Boolean).map(String));
    const defs = Object.values(state.game.characters)
      .filter((d) => !filter.ownedOnly || isOwned(d.id))
      .filter((d) => !filter.el || d.element === filter.el)
      .filter((d) => !q || (d.name || '').includes(q) || (d.card_no || '').includes(q))
      .sort((a, b) => b.id - a.id);
    grid.replaceChildren(...defs.slice(0, 300).map((d) => {
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
    if (defs.length > 300) grid.append(el('p', { class: 'hint' }, `${defs.length} 体中 300 体を表示中。検索で絞り込んでください。`));
    if (defs.length === 0) grid.append(el('p', { class: 'hint' }, filter.ownedOnly ? '所持キャラがいません。「所持のみ」を外すと全キャラから選べます（選ぶと自動で登録されます）。' : '該当なし'));
  };

  body.append(...nodes(
    el('div', { class: 'filter-row' },
      el('input', { type: 'search', placeholder: '名前・カード番号で検索', oninput: (e) => { filter.q = e.target.value; rerenderGrid(); } }),
      el('label', { class: 'check', style: 'margin:0;flex:none' },
        el('input', { type: 'checkbox', checked: filter.ownedOnly, onchange: (e) => { filter.ownedOnly = e.target.checked; rerenderGrid(); } }), '所持のみ')),
    el('div', { class: 'chip-row' },
      ELEMENTS.map((e2) => el('button', {
        class: `chip${filter.el === e2 ? ' on' : ''}`,
        onclick: (ev) => {
          filter.el = filter.el === e2 ? '' : e2;
          body.querySelectorAll('.chip-row .chip').forEach((c) => c.classList.remove('on'));
          if (filter.el) ev.target.classList.add('on');
          rerenderGrid();
        },
      }, e2))),
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
  rerenderGrid();
  openSheet(`${slotIndex < 3 ? `バトル ${slotIndex + 1}` : `ベンチ ${slotIndex - 2}`} のキャラを選択`, body);
}

// ---------------------------------------------------------------- フラグメント選択シート

function fragSlotEffectsView(f, stars) {
  return (f.slots || []).map((slot) =>
    el('div', { class: 'slot-eff' },
      el('div', { class: 'sl' }, slot.label, slot.star7 ? `（★7で解放${stars < 7 ? '・現在の星では無効' : ''}）` : ''),
      (slot.lines || []).map((line) => line.raw != null
        ? el('div', { class: 'line raw' }, line.raw)
        : el('div', { class: 'line' }, `${line.text} +${line.value}%${line.value_min != null ? `（最大値。${line.value_min}〜${line.value}%）` : ''}`))));
}

function openFragPicker(cid, slotIdx) {
  const def = charDef(cid);
  const my = charMy(cid) || defaultCharMy(def);
  const filter = { q: '', ownedOnly: true };
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
      .filter((f) => !filter.ownedOnly || (state.my.fragments[String(f.id)] || 0) > 0)
      .filter((f) => !q || (f.name || '').includes(q))
      .sort((a, b) => (state.my.fragments[String(b.id)] || 0) - (state.my.fragments[String(a.id)] || 0) || b.id - a.id);
    grid.replaceChildren(...list.slice(0, 300).map((f) => {
      const sid = String(f.id);
      const count = state.my.fragments[sid] || 0;
      const usedElsewhere = assignedCount(f.id, { cid, idx: slotIdx });
      const isCurrent = String(current[slotIdx] || '') === sid;
      const dupInChar = !ui.opt.allowDup && memberEquips(cid).some((x, i) => i !== slotIdx && String(x || '') === sid);
      const noneLeft = count > 0 && usedElsewhere >= count;
      return fragTile(f, {
        exclude: { cid, idx: slotIdx },
        showRemaining: true,
        disabled: dupInChar || (noneLeft && !isCurrent && count > 0),
        onclick: async () => {
          if (isCurrent) { await assign(null); return; } // タップで外す
          if (count === 0) {
            state.my.fragments[sid] = 1; // 未所持を選んだら所持数1として登録
            showMsg('info', `「${f.name}」の所持数を 1 にしました（「フラグ」タブで変更できます）`);
          }
          await assign(sid);
        },
      });
    }));
    if (list.length === 0) {
      grid.append(el('p', { class: 'hint' }, filter.ownedOnly
        ? 'このキャラが装備できる所持フラグメントがありません。「所持のみ」を外すと全候補から選べます（選ぶと所持数1で登録されます）。'
        : 'このキャラが装備できるフラグメントがありません。'));
    }
  };

  body.append(
    slotRow,
    el('p', { class: 'hint', style: 'text-align:center' }, `${def.name} — スロット${slotIdx + 1}${current[slotIdx] ? '（装備中のものをタップすると外せます）' : ''}`),
    el('div', { class: 'filter-row' },
      el('input', { type: 'search', placeholder: 'フラグメント名で検索', oninput: (e) => { filter.q = e.target.value; rerenderGrid(); } }),
      el('label', { class: 'check', style: 'margin:0;flex:none' },
        el('input', { type: 'checkbox', checked: filter.ownedOnly, onchange: (e) => { filter.ownedOnly = e.target.checked; rerenderGrid(); } }), '所持のみ')),
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
    const q = f.q.trim();
    const defs = Object.values(state.game.characters)
      .filter((d) => !f.ownedOnly || isOwned(d.id))
      .filter((d) => !f.el || d.element === f.el)
      .filter((d) => !q || (d.name || '').includes(q) || (d.card_no || '').includes(q))
      .sort((a, b) => b.id - a.id);
    grid.replaceChildren(...defs.slice(0, 400).map((d) =>
      charTile(d, { onclick: () => openCharSheet(String(d.id)) })));
    if (defs.length > 400) grid.append(el('p', { class: 'hint' }, `${defs.length} 体中 400 体を表示中。検索で絞り込んでください。`));
  };
  root.replaceChildren(
    el('p', { class: 'hint' }, `全 ${Object.keys(state.game.characters).length} 体 / 所持登録 ${Object.keys(state.my.characters).length} 体。タップで詳細・所持登録。`),
    el('div', { class: 'filter-row' },
      el('input', { type: 'search', value: f.q, placeholder: '名前・カード番号で検索', oninput: (e) => { f.q = e.target.value; rerenderGrid(); } }),
      el('label', { class: 'check', style: 'margin:0;flex:none' },
        el('input', { type: 'checkbox', checked: f.ownedOnly, onchange: (e) => { f.ownedOnly = e.target.checked; rerenderGrid(); } }), '所持のみ')),
    el('div', { class: 'chip-row' },
      ELEMENTS.map((e2) => el('button', {
        class: `chip${f.el === e2 ? ' on' : ''}`,
        onclick: () => { f.el = f.el === e2 ? '' : e2; renderChars(); },
      }, e2))),
    grid);
  rerenderGrid();
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
        labeledNum('限界突破（星）', m2, 'stars'),
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
  awakenedgold: '覚醒ゴールド', platinum: 'プラチナ', unique: 'ユニーク',
  event: 'イベント', rainbow: 'レインボー',
};

function renderFrags() {
  const root = $('#frags-view');
  const f = ui.fragFilter;
  const rarities = [...new Set(Object.values(state.game.fragments).map((x) => x.rarity).filter(Boolean))];
  const grid = el('div', { class: 'frag-grid' });
  const rerenderGrid = () => {
    const q = f.q.trim();
    const list = Object.values(state.game.fragments)
      .filter((x) => !f.ownedOnly || (state.my.fragments[String(x.id)] || 0) > 0)
      .filter((x) => !f.rarity || x.rarity === f.rarity)
      .filter((x) => !q || (x.name || '').includes(q))
      .sort((a, b) => b.id - a.id);
    grid.replaceChildren(...list.slice(0, 400).map((x) =>
      fragTile(x, { onclick: () => openFragSheet(String(x.id)) })));
    if (list.length > 400) grid.append(el('p', { class: 'hint' }, `${list.length} 件中 400 件を表示中。検索で絞り込んでください。`));
  };
  root.replaceChildren(
    el('p', { class: 'hint' }, `全 ${Object.keys(state.game.fragments).length} 件 / 所持 ${Object.values(state.my.fragments).filter((n) => n > 0).length} 種。タップで詳細・所持数入力。`),
    el('div', { class: 'filter-row' },
      el('input', { type: 'search', value: f.q, placeholder: 'フラグメント名で検索', oninput: (e) => { f.q = e.target.value; rerenderGrid(); } }),
      el('label', { class: 'check', style: 'margin:0;flex:none' },
        el('input', { type: 'checkbox', checked: f.ownedOnly, onchange: (e) => { f.ownedOnly = e.target.checked; rerenderGrid(); } }), '所持のみ')),
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
  const count = () => state.my.fragments[fid] || 0;

  const countRow = el('div', { class: 'row', style: 'align-items:center' });
  const renderCountRow = () => {
    countRow.replaceChildren(
      el('button', {
        class: 'btn secondary', style: 'flex:none;width:52px',
        onclick: async () => {
          const n = Math.max(0, count() - 1);
          if (n === 0) delete state.my.fragments[fid]; else state.my.fragments[fid] = n;
          await persistMy(); renderCountRow(); renderFrags();
        },
      }, '−'),
      el('div', { style: 'text-align:center;font-size:20px;font-weight:800;color:var(--accent)' }, `所持 ${count()}`),
      el('button', {
        class: 'btn secondary', style: 'flex:none;width:52px',
        onclick: async () => {
          state.my.fragments[fid] = count() + 1;
          await persistMy(); renderCountRow(); renderFrags();
        },
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
        f.condition_text ? el('div', { class: 'item-desc' }, `装備条件: ${f.condition_text}`) : null)),
    countRow,
    el('h3', {}, '効果（数値は最大値）'),
    Array.isArray(f.slots) && f.slots.length
      ? fragSlotEffectsView(f, 7)
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
  const ownedFragIds = Object.keys(state.my.fragments).filter((id) => state.my.fragments[id] > 0 && fragDef(id));

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
    const list = ownedFragIds.map((id) => fragDef(id)).filter((f) => !def || canEquip(def, f));
    fragArea = el('div', { class: 'item-list' },
      list.length === 0
        ? el('p', { class: 'hint' }, '所持フラグメントがありません。「フラグ」タブで所持数を入力してください。')
        : list.map((f) => el('div', { class: 'item' },
            el('input', {
              type: 'checkbox', checked: !!m.selected[f.id],
              onchange: (e) => { m.selected[f.id] = e.target.checked; },
            }),
            el('div', { class: 'grow' },
              el('div', { class: 'item-title' }, f.name)))));
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
