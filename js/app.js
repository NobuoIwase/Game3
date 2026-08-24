// UI 層（DESIGN.md §7, §8）。
// 計算は js/calc.js、最適化は js/optimizer.js、永続化は js/store.js に分離してある。
// エラーメッセージはすべて日本語で、原因と対処が分かる文言にする（§6）。

import { STATS, STAT_LABELS, computeStat, marginalValues } from './calc.js';
import { sumFragmentEffects, resolveFragmentEffects, parseEffectText } from './effects.js';
import { optimizeParty, abilityCorrections, canEquip, characterDetail } from './optimizer.js';
import * as store from './store.js';
import { parseCharacterListHTML, parseTagSelectHTML } from './parser.js';

// ---------------------------------------------------------------- 状態

const state = {
  game: null,      // loadGameData() の結果（characters / fragments / effectMap / tags / config）
  my: null,        // my_data（IndexedDB）
  overrides: null, // game_data オーバーライド（IndexedDB）
};

// フォームの入力途中値（再描画で消えないようにモデルに持つ）
const ui = {
  tab: 'calc',
  calc: {
    stat: 'strike_atk', total: 273617, boost: 42080,
    z: 149, zenkai: 0, ll: 30,
    mode: 'direct', fragBase: 0, fragNonBase: 0,
    charId: '', selected: {},
  },
  opt: {
    memberIds: ['', '', '', '', '', ''],
    targets: 'battle', mode: 'single', stat: 'strike_atk',
    preset: 'attack', weights: Object.fromEntries(STATS.map((s) => [s, 0])),
    allowDup: false,
  },
  chars: { editingId: null, form: null },
  frags: { editingId: null, form: null },
};

// ---------------------------------------------------------------- DOM ヘルパ

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected' || k === 'readOnly') node[k] = v;
    else if (k === 'value') node.value = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
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
  box.scrollIntoView({ block: 'nearest' });
  return box;
}
function clearMsgs() { $('#banner').replaceChildren(); }

function tagName(id) {
  return state.game.tags[String(id)] || `タグ${id}`;
}
function tagChips(ids) {
  return (ids || []).map((t) => el('span', { class: 'tagchip' }, tagName(t)));
}

function labeledNum(labelText, model, key, opts = {}) {
  return el('label', {}, labelText,
    el('input', {
      type: 'number', inputmode: 'decimal', step: 'any', value: model[key],
      oninput: (e) => { model[key] = e.target.value === '' ? 0 : Number(e.target.value); opts.oninput?.(); },
    }));
}
function labeledText(labelText, model, key, opts = {}) {
  return el('label', {}, labelText,
    el('input', {
      type: 'text', value: model[key] ?? '', placeholder: opts.placeholder || '',
      oninput: (e) => { model[key] = e.target.value; },
    }));
}

const parseIdList = (s) => String(s || '').split(/[,、\s]+/).filter(Boolean).map(Number).filter(Number.isFinite);

// ---------------------------------------------------------------- 共通データアクセス

async function persistMy() {
  try { await store.saveMyData(state.my); }
  catch (e) { showMsg('error', `■ 保存に失敗しました\n${e.message}`); }
}
async function persistOverridesAndReload() {
  try {
    await store.saveOverrides(state.overrides);
    state.game = await store.loadGameData();
  } catch (e) { showMsg('error', `■ 保存に失敗しました\n${e.message}`); }
}

/** 登録済み（my_data にある）キャラの ID 一覧 */
function registeredCharIds() {
  return Object.keys(state.my.characters)
    .filter((id) => state.game.characters[id])
    .sort((a, b) => Number(a) - Number(b));
}
function charDef(id) { return state.game.characters[String(id)]; }
function charMy(id) { return state.my.characters[String(id)]; }
function fragDef(id) { return state.game.fragments[String(id)]; }

const zeroStats = () => Object.fromEntries(STATS.map((s) => [s, 0]));

function defaultCharMy() {
  return { stars: 0, equip_slots: 3, boost: zeroStats(), z_ability: [], ll_ability: [], zenkai_ability: [] };
}

/** 効果1行の表示（未対応は⚠付き — §1-4） */
function effectLines(frag) {
  const { effects, unknown } = resolveFragmentEffects(frag, state.game.effectMap);
  const lines = effects.map((e) =>
    el('div', { class: 'effline' },
      `${e.base ? '基礎' : ''}${STAT_LABELS[e.stat]} +${e.value}%（${e.base ? '❷に加算' : '最後に乗算'}）`));
  for (const u of unknown) {
    lines.push(el('div', { class: 'effline' },
      el('span', { class: 'unknown' }, `⚠ ${u.reason} — 計算に含まれません`)));
  }
  return lines;
}

/** 未対応効果の一覧を §6 の文言で表示する */
function reportUnknown(unknownList) {
  if (!unknownList.length) return;
  const uniq = new Map();
  for (const u of unknownList) uniq.set(`${u.fragmentId}:${u.reason}`, u);
  const lines = [...uniq.values()]
    .map((u) => `・${u.reason}（フラグメント: ${u.fragmentName}）`).join('\n');
  showMsg('warn',
    `■ 未対応の効果が ${uniq.size} 件ありました\n${lines}\n` +
    'これらは計算に含まれていません。実際の数値とズレる可能性があります。\n' +
    '「データ」タブの効果変換表（effect_map）への追加が必要です。');
}

/** レアリティの妥当性チェック（§6: 未知のレアリティは計算を中止する） */
function checkRarities(fragIds) {
  const known = state.game.config.known_rarities || [];
  if (known.length === 0) return true; // リスト未整備の間はチェックしない（config.json 参照）
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

// ---------------------------------------------------------------- タブ

function switchTab(name) {
  ui.tab = name;
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
  document.querySelectorAll('#tabbar button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- 計算タブ（v0）

const VERIFY_CASES = [
  { label: '検算(1)', fragBase: 110, fragNonBase: 0 },
  { label: '検算(2)', fragBase: 60, fragNonBase: 30 },
  { label: '検算(3)', fragBase: 15, fragNonBase: 40 },
];

function renderCalc() {
  const m = ui.calc;
  const root = $('#calc-form');
  const ownedFragIds = Object.keys(state.my.fragments).filter((id) => state.my.fragments[id] > 0 && fragDef(id));

  const statSelect = el('label', {}, '対象ステータス',
    el('select', {
      onchange: (e) => { m.stat = e.target.value; fillFromChar(); renderCalc(); },
    }, STATS.map((s) => el('option', { value: s, selected: m.stat === s }, STAT_LABELS[s]))));

  const fillFromChar = () => {
    if (!m.charId) return;
    const def = charDef(m.charId); const my = charMy(m.charId);
    if (!def) return;
    m.total = Number(def.base_stats?.[m.stat]) || 0;
    m.boost = Number(my?.boost?.[m.stat]) || 0;
  };

  const charSelect = el('label', {}, 'キャラから合計ステ/ブースト値を読み込む（任意）',
    el('select', {
      onchange: (e) => { m.charId = e.target.value; fillFromChar(); renderCalc(); },
    },
      el('option', { value: '' }, '（手入力）'),
      registeredCharIds().map((id) =>
        el('option', { value: id, selected: m.charId === id }, charDef(id).name))));

  // フラグメント補正の入力方法
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
    const list = ownedFragIds
      .map((id) => fragDef(id))
      .filter((f) => !def || canEquip(def, f));
    fragArea = el('div', { class: 'item-list' },
      list.length === 0
        ? el('p', { class: 'hint' }, '所持フラグメントがありません。「フラグ」タブで所持数を入力してください。')
        : list.map((f) => el('div', { class: 'item' },
            el('input', {
              type: 'checkbox', checked: !!m.selected[f.id],
              onchange: (e) => { m.selected[f.id] = e.target.checked; },
            }),
            el('div', { class: 'grow' },
              el('div', { class: 'item-title' }, f.name),
              el('div', { class: 'item-desc' }, effectLines(f))))),
      def ? el('p', { class: 'small-note' }, `装備条件（タグ）を満たすものだけを表示中: ${def.name}`) : null);
  }

  root.replaceChildren(el('div', { class: 'card' },
    charSelect,
    statSelect,
    el('div', { class: 'grid2' },
      labeledNum('合計ステ（画面左の数値）', m, 'total'),
      labeledNum('ブースト値（括弧内の数値）', m, 'boost'),
      labeledNum('Zアビ合計 (%)（パーティ6体）', m, 'z'),
      labeledNum('ZENKAIアビ合計 (%)（6体）', m, 'zenkai'),
      labeledNum('LLアビ合計 (%)（バトル3体）', m, 'll')),
    el('h3', {}, 'フラグメント補正'),
    modeRadio,
    fragArea,
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: runCalc }, '計算する'),
      ...VERIFY_CASES.map((c) => el('button', {
        class: 'btn secondary',
        onclick: () => {
          Object.assign(m, {
            total: 273617, boost: 42080, z: 149, zenkai: 0, ll: 30,
            stat: 'strike_atk', mode: 'direct', fragBase: c.fragBase, fragNonBase: c.fragNonBase,
            charId: '',
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
    const sums = sumFragmentEffects(selected.map(fragDef), state.game.effectMap);
    fragBase = sums.basePct[m.stat];
    fragNonBase = sums.nonBasePct[m.stat];
    reportUnknown(sums.unknown);
    const my = m.charId ? charMy(m.charId) : null;
    if (my && selected.length > (my.equip_slots || 3)) {
      showMsg('warn', `■ 選択枚数が装備枠（${my.equip_slots || 3}枠）を超えています`);
    }
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
      `参考: いまの状態での限界価値 … 基礎あり+1% → +${fmt(mv.basePlus1)} / 基礎なし+1% → +${fmt(mv.nonBasePlus1)}` +
      '（比較は必ず ❸ で行われます）')));
}

// ---------------------------------------------------------------- 最適化タブ（v1/v2）

const PRESETS = {
  attack: { label: '攻撃特化', weights: { strike_atk: 1, blast_atk: 1 } },
  defense: { label: '耐久特化', weights: { hp: 1, strike_def: 0.7, blast_def: 0.7 } },
  balance: { label: 'バランス', weights: { hp: 0.6, strike_atk: 0.8, blast_atk: 0.8, strike_def: 0.5, blast_def: 0.5, critical: 0.2, ki_recovery: 0.1 } },
};

function renderOpt() {
  const m = ui.opt;
  const root = $('#optimize-form');
  const ids = registeredCharIds();

  const memberSelect = (i) => el('label', {},
    i < 3 ? `バトル出撃 ${i + 1}` : `ベンチ ${i - 2}`,
    el('select', {
      onchange: (e) => { m.memberIds[i] = e.target.value; },
    },
      el('option', { value: '' }, '（空き）'),
      ids.map((id) => el('option', { value: id, selected: m.memberIds[i] === id }, charDef(id).name))));

  const modeArea = el('div', {},
    el('div', { class: 'check' },
      ...[['single', '単一ステータス'], ['preset', 'プリセット'], ['custom', 'カスタム重み']].map(([v, label]) =>
        el('label', { class: 'check', style: 'margin-top:0' },
          el('input', {
            type: 'radio', name: 'opt-mode', checked: m.mode === v,
            onchange: () => { m.mode = v; renderOpt(); },
          }), label))),
    m.mode === 'single'
      ? el('label', {}, '最大化するステータス',
          el('select', { onchange: (e) => { m.stat = e.target.value; } },
            STATS.map((s) => el('option', { value: s, selected: m.stat === s }, STAT_LABELS[s]))))
      : null,
    m.mode === 'preset'
      ? el('label', {}, 'プリセット',
          el('select', { onchange: (e) => { m.preset = e.target.value; } },
            Object.entries(PRESETS).map(([k, p]) =>
              el('option', { value: k, selected: m.preset === k }, p.label))))
      : null,
    m.mode === 'custom'
      ? el('div', { class: 'grid2' },
          STATS.map((s) => labeledNum(`${STAT_LABELS[s]} の重み`, m.weights, s)))
      : null);

  root.replaceChildren(el('div', { class: 'card' },
    el('h3', {}, 'パーティ編成（上3体がバトル出撃）'),
    ids.length === 0
      ? el('p', { class: 'hint' }, '登録済みキャラがいません。「キャラ」タブで登録するか、「データ」タブでサンプルを読み込んでください。')
      : el('div', { class: 'grid2' }, [0, 1, 2, 3, 4, 5].map(memberSelect)),
    el('h3', {}, '最適化の設定'),
    el('label', { class: 'check' },
      el('input', {
        type: 'radio', name: 'opt-targets', checked: m.targets === 'battle',
        onchange: () => { m.targets = 'battle'; },
      }), 'バトル出撃3体に配分する'),
    el('label', { class: 'check' },
      el('input', {
        type: 'radio', name: 'opt-targets', checked: m.targets === 'all',
        onchange: () => { m.targets = 'all'; },
      }), 'パーティ6体全員に配分する'),
    modeArea,
    el('label', { class: 'check' },
      el('input', {
        type: 'checkbox', checked: m.allowDup,
        onchange: (e) => { m.allowDup = e.target.checked; },
      }), '同一フラグメントの同キャラ重複装備を許可（実機未確認）'),
    el('button', { class: 'btn', onclick: runOptimize }, '最適化を実行')));
}

function currentWeights() {
  const m = ui.opt;
  if (m.mode === 'single') return { [m.stat]: 1 };
  if (m.mode === 'preset') return { ...PRESETS[m.preset].weights };
  return { ...m.weights };
}

async function runOptimize() {
  clearMsgs();
  const m = ui.opt;
  const memberIds = [...new Set(m.memberIds.filter((id) => id && charDef(id)))];
  if (memberIds.length === 0) {
    showMsg('error', '■ パーティが選択されていません\nメンバーを1体以上選んでください。');
    return;
  }
  const battleIds = m.memberIds.slice(0, 3).filter((id) => id && charDef(id));
  if (m.targets === 'battle' && battleIds.length === 0) {
    showMsg('error', '■ バトル出撃メンバーがいません\n上3つの枠に1体以上入れてください。');
    return;
  }
  const ownedIds = Object.keys(state.my.fragments).filter((id) => state.my.fragments[id] > 0);
  if (!checkRarities(ownedIds)) return;

  const members = memberIds.map((id) => ({ character: charDef(id), my: charMy(id) || defaultCharMy() }));
  const weights = currentWeights();
  if (!Object.values(weights).some((w) => w > 0)) {
    showMsg('error', '■ 重みがすべて 0 です\n最大化するステータスの重みを設定してください。');
    return;
  }

  const result = optimizeParty({
    members, battleIds,
    fragmentsById: state.game.fragments,
    counts: { ...state.my.fragments },
    weights, effectMap: state.game.effectMap,
    targets: m.targets, allowDuplicates: m.allowDup,
  });

  renderOptResult(members, battleIds, weights, result);
  reportUnknown(result.unknown);
  for (const w of [...new Set(result.warnings)]) showMsg('warn', `■ ${w}`);
  if (!result.exact) {
    showMsg('warn', '■ 厳密解を保証できませんでした\n表示している割当は探索できた範囲での最良解です。');
  }

  // 編成を保存
  state.my.parties = [{ name: '現在の編成', member_ids: m.memberIds.map(Number).filter(Boolean), battle_ids: battleIds.map(Number) }];
  await persistMy();
}

function renderOptResult(members, battleIds, weights, result) {
  const weightedStats = STATS.filter((s) => (weights[s] || 0) > 0);
  const cards = [];
  const usage = new Map(); // fragId → 使用数

  for (const member of members) {
    const cid = String(member.character.id);
    const asg = result.assignments[cid];
    if (!asg) continue; // 最適化対象外（ベンチ）
    const fragList = asg.ids.map((id) => fragDef(id)).filter(Boolean);
    for (const id of asg.ids) usage.set(id, (usage.get(id) || 0) + 1);
    const withFrags = characterDetail({ member, ext: result.ext[cid], fragmentList: fragList, effectMap: state.game.effectMap });
    const noFrags = characterDetail({ member, ext: result.ext[cid], fragmentList: [], effectMap: state.game.effectMap });

    const statRows = weightedStats
      .filter((s) => withFrags.stats[s])
      .map((s) => {
        const a = withFrags.stats[s]; const b = noFrags.stats[s];
        return el('tr', {},
          el('td', {}, STAT_LABELS[s]),
          el('td', { class: 'num' }, fmt0(b.final)),
          el('td', { class: 'num big' }, fmt0(a.final)),
          el('td', { class: 'num pos' }, `❻ +${fmt(a.fragTotal, 1)}%`));
      });

    cards.push(el('div', { class: 'card' },
      el('div', { class: 'item-title' },
        member.character.name,
        battleIds.map(String).includes(cid)
          ? el('span', { class: 'badge ok' }, 'バトル出撃')
          : el('span', { class: 'badge ng' }, 'ベンチ')),
      el('div', { class: 'item-desc' },
        fragList.length === 0 ? '装備なし（スコアが上がるフラグメントがありません）'
          : fragList.map((f) => el('div', {}, `・${f.name}`))),
      statRows.length > 0
        ? el('table', {},
            el('tr', {}, el('th', {}, 'ステータス'), el('th', {}, '装備なし❸'), el('th', {}, '装備後❸'), el('th', {}, 'フラグ補正')),
            statRows)
        : el('p', { class: 'hint' }, '合計ステが未入力のため数値を表示できません（「キャラ」タブで入力してください）')));
  }

  const usageLines = [...usage.entries()].map(([id, n]) => {
    const f = fragDef(id);
    return el('div', { class: 'effline' }, `・${f ? f.name : id} … ${n} / 所持 ${state.my.fragments[id] || 0}`);
  });

  $('#optimize-result').replaceChildren(
    el('div', { class: 'card sub-card' },
      el('h3', {}, `結果${result.exact ? '（厳密解）' : '（暫定解）'}`),
      el('p', { class: 'small-note' },
        `評価: ${weightedStats.map((s) => `${STAT_LABELS[s]}×${weights[s]}`).join(' / ')}`)),
    ...cards,
    el('div', { class: 'card' },
      el('h3', {}, 'フラグメント使用状況'),
      usageLines.length ? usageLines : el('p', { class: 'hint' }, '使用なし')));
}

// ---------------------------------------------------------------- キャラタブ

const ABILITY_KINDS = [
  ['z_ability', 'Zアビリティ（パーティ6体に乗る）'],
  ['zenkai_ability', 'ZENKAIアビリティ（パーティ6体に乗る）'],
  ['ll_ability', 'LLアビリティ（バトル3体に乗る）'],
];

function renderChars() {
  const root = $('#chars-view');
  if (ui.chars.editingId != null) {
    root.replaceChildren(renderCharForm());
    return;
  }
  const ids = registeredCharIds();
  const unregistered = Object.keys(state.game.characters)
    .filter((id) => !state.my.characters[id])
    .sort((a, b) => Number(a) - Number(b));
  let addSelect = null;

  root.replaceChildren(
    el('div', { class: 'card' },
      el('h3', {}, '登録済みキャラ'),
      ids.length === 0 ? el('p', { class: 'hint' }, 'まだ登録がありません。下の図鑑から追加してください。') : null,
      el('div', { class: 'item-list' }, ids.map((id) => {
        const def = charDef(id); const my = charMy(id);
        return el('div', { class: 'item' },
          el('div', { class: 'grow' },
            el('div', { class: 'item-title' }, def.name),
            el('div', { class: 'item-desc' },
              `${def.card_no || ''} ★${my.stars} / 装備枠${my.equip_slots} `, tagChips(def.tags))),
          el('button', {
            class: 'btn secondary small',
            onclick: () => startCharEdit(id),
          }, '編集'),
          el('button', {
            class: 'btn danger small',
            onclick: async () => {
              if (!confirm(`${def.name} の登録（星・ブースト値・アビリティ入力）を削除しますか？`)) return;
              delete state.my.characters[id];
              await persistMy(); renderChars();
            },
          }, '削除'));
      }))),
    el('div', { class: 'card' },
      el('h3', {}, '図鑑から登録'),
      addSelect = el('select', {},
        el('option', { value: '' }, 'キャラを選択…'),
        unregistered.map((id) => el('option', { value: id }, `${charDef(id).name}（${charDef(id).card_no || id}）`))),
      el('button', {
        class: 'btn',
        onclick: async () => {
          const id = addSelect.value;
          if (!id) return;
          state.my.characters[id] = defaultCharMy();
          await persistMy(); startCharEdit(id);
        },
      }, '登録して編集'),
      el('p', { class: 'small-note' }, '図鑑に無いキャラは「データ」タブのHTML貼り付け取り込みで追加するか、下の手入力で作成できます。'),
      el('details', {},
        el('summary', {}, '新しいキャラ定義を手入力で作る'),
        renderNewCharForm())));
}

function renderNewCharForm() {
  const form = { id: '', name: '', card_no: '', tags: '' };
  return el('div', {},
    labeledText('内部ID（参照サイトの character/番号。無ければ空きの番号）', form, 'id', { placeholder: '例: 738' }),
    labeledText('名前', form, 'name'),
    labeledText('カード番号', form, 'card_no', { placeholder: '例: DBL98-01L' }),
    labeledText('タグID（空白またはカンマ区切り）', form, 'tags', { placeholder: '例: 7 1 40 50010' }),
    el('button', {
      class: 'btn', onclick: async () => {
        const id = Number(form.id);
        if (!Number.isFinite(id) || id <= 0) { showMsg('error', '■ 内部IDは正の数値で入力してください'); return; }
        if (charDef(id)) { showMsg('error', `■ ID ${id} は既に存在します`); return; }
        state.overrides.characters[String(id)] = {
          id, card_no: form.card_no, name: form.name || `キャラ${id}`,
          element: '', rarity: '', tags: parseIdList(form.tags), base_stats: zeroStats(),
        };
        await persistOverridesAndReload();
        state.my.characters[String(id)] = defaultCharMy();
        await persistMy();
        startCharEdit(String(id));
      },
    }, '作成して登録'));
}

function startCharEdit(id) {
  const def = charDef(id); const my = charMy(id) || defaultCharMy();
  ui.chars.editingId = String(id);
  ui.chars.form = {
    name: def.name,
    tags: (def.tags || []).join(' '),
    base_stats: { ...zeroStats(), ...def.base_stats },
    stars: my.stars, equip_slots: my.equip_slots,
    boost: { ...zeroStats(), ...my.boost },
    abilities: Object.fromEntries(ABILITY_KINDS.map(([k]) =>
      [k, (my[k] || []).map((a) => ({ stat: a.stat, base: a.base !== false, value: a.value, condition_tags: (a.condition_tags || []).join(' ') }))])),
  };
  renderChars();
  switchTab('chars');
}

function renderCharForm() {
  const id = ui.chars.editingId;
  const f = ui.chars.form;

  const abilityEditor = (kind, label) => {
    const rows = f.abilities[kind];
    const rerender = () => renderChars();
    return el('div', { class: 'card sub-card' },
      el('h3', {}, label),
      rows.length === 0 ? el('p', { class: 'small-note' }, 'なし（限界突破の星の数で数値が変わるため、実機のアビリティ画面を見て入力してください）') : null,
      rows.map((row, i) => el('div', {},
        el('div', { class: 'row' },
          el('label', {}, 'ステータス',
            el('select', { onchange: (e) => { row.stat = e.target.value; } },
              STATS.map((s) => el('option', { value: s, selected: row.stat === s }, STAT_LABELS[s])))),
          el('label', {}, '種別',
            el('select', { onchange: (e) => { row.base = e.target.value === 'true'; } },
              el('option', { value: 'true', selected: row.base }, '基礎あり'),
              el('option', { value: 'false', selected: !row.base }, '基礎なし'))),
          labeledNum('数値 (%)', row, 'value')),
        el('div', { class: 'row' },
          labeledText('対象タグID（空なら全員に乗る）', row, 'condition_tags', { placeholder: '例: 7' }),
          el('button', {
            class: 'btn danger small',
            onclick: () => { rows.splice(i, 1); rerender(); },
          }, '行を削除')),
        el('hr'))),
      el('button', {
        class: 'btn secondary small',
        onclick: () => { rows.push({ stat: 'strike_atk', base: true, value: 0, condition_tags: '' }); rerender(); },
      }, '＋ 行を追加'));
  };

  return el('div', {},
    el('div', { class: 'card' },
      el('h3', {}, `編集: ${f.name}`),
      labeledText('名前（表示用）', f, 'name'),
      labeledText('タグID（空白区切り）', f, 'tags'),
      el('h3', {}, '合計ステ（Lv上限・ステータス画面左の数値）'),
      el('div', { class: 'grid2' }, STATS.map((s) => labeledNum(STAT_LABELS[s], f.base_stats, s))),
      el('h3', {}, 'ブースト値（ステータス画面の括弧内の数値）'),
      el('div', { class: 'grid2' }, STATS.map((s) => labeledNum(STAT_LABELS[s], f.boost, s))),
      el('h3', {}, '育成状態'),
      el('div', { class: 'row' },
        labeledNum('限界突破（星）', f, 'stars'),
        labeledNum('装備枠', f, 'equip_slots'))),
    ABILITY_KINDS.map(([k, label]) => abilityEditor(k, label)),
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: () => saveCharEdit(id) }, '保存'),
      el('button', {
        class: 'btn secondary',
        onclick: () => { ui.chars.editingId = null; ui.chars.form = null; renderChars(); },
      }, 'キャンセル')));
}

async function saveCharEdit(id) {
  const f = ui.chars.form;
  const def = charDef(id);
  // 図鑑側の変更はオーバーライドへ（§1-1: 手入力の経路を必ず用意する）
  state.overrides.characters[id] = {
    ...def,
    name: f.name,
    tags: parseIdList(f.tags),
    base_stats: Object.fromEntries(STATS.map((s) => [s, Number(f.base_stats[s]) || 0])),
  };
  await persistOverridesAndReload();
  // 個人データは my_data へ（§1-5: ゲームデータと自分のデータを分離する）
  state.my.characters[id] = {
    stars: Number(f.stars) || 0,
    equip_slots: Math.max(0, Number(f.equip_slots) || 3),
    boost: Object.fromEntries(STATS.map((s) => [s, Number(f.boost[s]) || 0])),
    ...Object.fromEntries(ABILITY_KINDS.map(([k]) => [k, f.abilities[k]
      .filter((a) => Number(a.value))
      .map((a) => ({ stat: a.stat, base: a.base, value: Number(a.value), condition_tags: parseIdList(a.condition_tags) }))])),
  };
  await persistMy();
  ui.chars.editingId = null; ui.chars.form = null;
  renderChars();
  showMsg('ok', '保存しました');
}

// ---------------------------------------------------------------- フラグメントタブ

function renderFrags() {
  const root = $('#frags-view');
  if (ui.frags.form) {
    root.replaceChildren(renderFragForm());
    return;
  }
  const ids = Object.keys(state.game.fragments).sort((a, b) => Number(a) - Number(b));
  root.replaceChildren(
    el('div', { class: 'card' },
      el('h3', {}, 'フラグメント一覧と所持数'),
      el('p', { class: 'hint' }, '所持数を入れたものだけが最適化の対象になります。数値は最大値で入力します（個体差は扱いません）。'),
      el('div', { class: 'item-list' }, ids.map((id) => {
        const f = state.game.fragments[id];
        return el('div', { class: 'item' },
          el('div', { class: 'grow' },
            el('div', { class: 'item-title' }, f.name),
            el('div', { class: 'item-desc' },
              effectLines(f),
              (f.equip_conditions?.require_tags_any?.length || f.equip_conditions?.require_tags_all?.length)
                ? el('div', {}, '装備条件: ',
                    tagChips(f.equip_conditions.require_tags_any),
                    (f.equip_conditions.require_tags_all || []).length
                      ? ['（すべて必須: ', tagChips(f.equip_conditions.require_tags_all), '）'] : null)
                : el('div', {}, '装備条件: なし'))),
          el('label', { style: 'margin:0' }, '所持',
            el('input', {
              class: 'count', type: 'number', inputmode: 'numeric', min: 0,
              value: state.my.fragments[id] || 0,
              onchange: async (e) => {
                const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
                if (n === 0) delete state.my.fragments[id];
                else state.my.fragments[id] = n;
                await persistMy();
              },
            })),
          el('button', { class: 'btn secondary small', onclick: () => startFragEdit(id) }, '編集'));
      }))),
    el('div', { class: 'card' },
      el('button', { class: 'btn', onclick: () => startFragEdit(null) }, '＋ フラグメントを追加')));
}

function startFragEdit(id) {
  if (id == null) {
    const nextId = Math.max(0, ...Object.keys(state.game.fragments).map(Number)) + 1;
    ui.frags.form = {
      isNew: true, id: nextId, name: '', rarity: '',
      any: '', all: '', effects: [{ text: '', value: 0 }],
    };
  } else {
    const f = state.game.fragments[id];
    ui.frags.form = {
      isNew: false, id: Number(id), name: f.name, rarity: f.rarity || '',
      any: (f.equip_conditions?.require_tags_any || []).join(' '),
      all: (f.equip_conditions?.require_tags_all || []).join(' '),
      effects: (f.effects || []).map((e) => {
        if (e.text) return { text: e.text, value: e.value };
        // 構造化エントリは対応する文言に逆変換して編集する
        const entry = Object.entries(state.game.effectMap.entries || {})
          .find(([, v]) => v.stat === e.stat && (v.base === true) === (e.base === true));
        const text = entry ? entry[0] : `${e.base ? '基礎' : ''}${STAT_LABELS[e.stat]}アップ`;
        return { text, value: e.value };
      }),
    };
  }
  renderFrags();
}

function renderFragForm() {
  const f = ui.frags.form;
  const rerender = () => renderFrags();

  const effectRow = (row, i) => {
    const parsed = parseEffectText(row.text, state.game.effectMap);
    return el('div', {},
      el('div', { class: 'row' },
        el('label', {}, '効果文言',
          el('input', {
            type: 'text', value: row.text, list: 'effect-datalist',
            placeholder: '例: 基礎打撃攻撃力アップ',
            oninput: (e) => { row.text = e.target.value; },
            onchange: () => rerender(),
          })),
        labeledNum('数値 (%)', row, 'value'),
        el('button', { class: 'btn danger small', onclick: () => { f.effects.splice(i, 1); rerender(); } }, '削除')),
      el('p', { class: 'small-note' },
        row.text === '' ? ''
          : parsed
            ? `→ ${parsed.base ? '基礎あり（❷に加算）' : '基礎なし（最後に乗算）'} / ${STAT_LABELS[parsed.stat]}`
            : '⚠ 未対応の文言です。このまま保存すると計算から除外され、警告が表示されます。'));
  };

  return el('div', { class: 'card' },
    el('h3', {}, f.isNew ? 'フラグメントを追加' : `編集: ${f.name}`),
    el('datalist', { id: 'effect-datalist' },
      Object.keys(state.game.effectMap.entries || {}).map((t) => el('option', { value: t }))),
    labeledNum('内部ID', f, 'id'),
    f.isNew ? null : el('p', { class: 'small-note' }, 'IDは参照キーです。変更すると別フラグメントとして保存されます。'),
    labeledText('名前', f, 'name'),
    labeledText('レアリティ（不明なら空欄）', f, 'rarity'),
    el('div', { class: 'row' },
      labeledText('装備条件: いずれかのタグ', f, 'any', { placeholder: '例: 50010' }),
      labeledText('装備条件: すべてのタグ', f, 'all')),
    el('h3', {}, '効果（最大値で入力）'),
    f.effects.map(effectRow),
    el('button', { class: 'btn secondary small', onclick: () => { f.effects.push({ text: '', value: 0 }); rerender(); } }, '＋ 効果を追加'),
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: saveFragEdit }, '保存'),
      el('button', { class: 'btn secondary', onclick: () => { ui.frags.form = null; rerender(); } }, 'キャンセル'),
      f.isNew ? null : el('button', {
        class: 'btn danger',
        onclick: async () => {
          if (!confirm(`${f.name} を削除しますか？（所持数の記録も削除されます）`)) return;
          state.overrides.fragments[String(f.id)] = null;
          delete state.my.fragments[String(f.id)];
          await persistOverridesAndReload(); await persistMy();
          ui.frags.form = null; renderFrags();
        },
      }, '削除')));
}

async function saveFragEdit() {
  const f = ui.frags.form;
  const id = Number(f.id);
  if (!Number.isFinite(id) || id <= 0) { showMsg('error', '■ 内部IDは正の数値で入力してください'); return; }
  const effects = f.effects
    .filter((r) => r.text.trim() !== '' || Number(r.value))
    .map((r) => ({ text: r.text.trim(), value: Number(r.value) || 0 }));
  state.overrides.fragments[String(id)] = {
    id, name: f.name || `フラグメント${id}`, rarity: f.rarity,
    equip_conditions: { require_tags_any: parseIdList(f.any), require_tags_all: parseIdList(f.all) },
    effects,
  };
  await persistOverridesAndReload();
  ui.frags.form = null;
  renderFrags();
  showMsg('ok', '保存しました');
}

// ---------------------------------------------------------------- データタブ

function renderData() {
  const root = $('#data-view');
  let fileInput = null;
  let htmlArea = null;

  root.replaceChildren(
    el('div', { class: 'card' },
      el('h3', {}, 'バックアップ（重要）'),
      el('p', { class: 'hint' }, '所持フラグメント・キャラ入力（my_data）はこの端末のブラウザにのみ保存されており、消すと復旧できません。定期的にエクスポートしてください。'),
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
      el('h3', {}, 'サンプルデータ'),
      el('p', { class: 'hint' }, '検算用キャラとサンプルフラグメントを読み込みます（現在の my_data は上書きされます）。'),
      el('button', {
        class: 'btn secondary',
        onclick: async () => {
          if (Object.keys(state.my.characters).length > 0 &&
              !confirm('現在の登録内容をサンプルデータで上書きします。よろしいですか？')) return;
          try {
            const res = await fetch('./my_data/sample_inventory.json', { cache: 'no-cache' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const sample = await res.json();
            const clean = Object.fromEntries(Object.entries(sample).filter(([k]) => !k.startsWith('_')));
            state.my = { ...store.emptyMyData(), ...clean };
            await persistMy();
            await reloadAll();
            showMsg('ok', 'サンプルデータを読み込みました。「最適化」タブを試してください。');
          } catch (err) {
            showMsg('error', `■ サンプルの読み込みに失敗しました\n${err.message}`);
          }
        },
      }, 'サンプルを読み込む')),
    el('div', { class: 'card' },
      el('h3', {}, 'HTML貼り付け取り込み'),
      el('p', { class: 'hint' },
        '参照サイトのキャラ一覧ページのHTMLを貼り付けると、キャラ定義（ID・名前・タグ）とタグ名対応表を取り込みます。' +
        '端末単独で完結する取り込み手段です（DESIGN.md §5-2）。合計ステは取り込まれないため「キャラ」タブで入力してください。'),
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
              '■ 取り込みに失敗しました\n貼り付けた内容からキャラ・タグを見つけられませんでした。\n' +
              '参照先のページ構造が変わった可能性があります。アプリの更新が必要です。\n' +
              '（前回取り込んだデータで引き続き利用できます）');
            return;
          }
          for (const c of characters) {
            const existing = charDef(c.id);
            state.overrides.characters[String(c.id)] = {
              id: c.id,
              card_no: existing?.card_no || '',
              name: c.name, element: c.element, rarity: c.rarity, tags: c.tags,
              base_stats: existing?.base_stats || zeroStats(),
            };
          }
          for (const [id, name] of Object.entries(tags)) state.overrides.tags[id] = name;
          await persistOverridesAndReload();
          renderAll();
          showMsg('ok',
            `取り込みました: キャラ ${characters.length} 体 / タグ名 ${Object.keys(tags).length} 件` +
            (skipped ? `\n⚠ IDを特定できず読み飛ばした行が ${skipped} 件あります` : ''));
          htmlArea.value = '';
        },
      }, '取り込む')),
    el('div', { class: 'card' },
      el('h3', {}, '効果変換表（effect_map）'),
      el('p', { class: 'hint' }, '効果文言と内部表現の対応です。未対応の効果が出た場合は game_data/effect_map.json に1行追加します。'),
      el('details', {},
        el('summary', {}, `登録済み ${Object.keys(state.game.effectMap.entries || {}).length} 件を表示`),
        el('table', {},
          Object.entries(state.game.effectMap.entries || {}).map(([text, v]) =>
            el('tr', {},
              el('td', {}, text),
              el('td', {}, STAT_LABELS[v.stat] || v.stat),
              el('td', {}, v.base ? '❷に加算' : '乗算')))))),
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
            if (!confirm('所持フラグメント・キャラ入力・取り込みデータをすべて削除します。エクスポートしていない場合は復旧できません。本当に削除しますか？')) return;
            await store.clearAll();
            await reloadAll();
            showMsg('ok', 'すべてのローカルデータを削除しました');
          },
        }, '全データ削除')),
      el('p', { class: 'small-note' },
        'このアプリは個人利用を前提にしています。データはすべてこの端末に保存され、外部には送信されません。')));
}

// ---------------------------------------------------------------- 起動

function renderAll() {
  renderCalc();
  renderOpt();
  renderChars();
  renderFrags();
  renderData();
}

async function reloadAll() {
  state.game = await store.loadGameData();
  state.my = await store.loadMyData();
  state.overrides = await store.loadOverrides();
  restorePartyFromMyData();
  renderAll();
}

function restorePartyFromMyData() {
  const party = state.my.parties?.[0];
  if (!party) return;
  const ids = (party.member_ids || []).map(String);
  ui.opt.memberIds = [0, 1, 2, 3, 4, 5].map((i) => ids[i] || '');
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
  switchTab(registeredCharIds().length === 0 ? 'data' : 'calc');
  if (registeredCharIds().length === 0) {
    showMsg('info', 'はじめに「サンプルを読み込む」を押すと動作を確認できます。実データは「キャラ」「フラグ」タブから入力してください。');
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // オフライン化に失敗してもアプリ自体は動作する
    });
  }
}

boot();
