import { loadData, resolveWeapon, resolveArmor, gradesOf } from './data.js';
import { WEAPON_TYPES, ELEMENTS, PARTS, PART_NAMES, SKILL_EFFECTS, AILMENT_ELEMENTS, conditionalSkills, defaultRate } from './model.js';
import { evaluateBuild, isRelevant } from './search.js';
import { esc, elemIcon, weaponTypeIcon, armorIcon, weaponIcon, openSheet, closeSheet } from './ui.js';

const STORE_KEY = 'mhn-calc-v1';
const DRIFT_MODES = { free: '自由（フル錬成）', owned: '所持リストから', fixed: '固定', none: '錬成なし' };
const QUICK = [
  { key: 'lockon', label: 'ロックオンLv1', skill: 'LOCK_ON', lv: 1 },
  { key: 'focus', label: '集中Lv5', skill: 'FOCUS', lv: 5 },
  { key: 'recoil', label: '反動軽減Lv3', skill: 'RECOIL_DOWN', lv: 3, bowgun: true },
  { key: 'reload', label: '装填速度Lv3', skill: 'RELOAD_SPEED', lv: 3, bowgun: true },
];
const STYLE_MS = [10, 15, 20];

let D = null;
let S = null;
let worker = null;
let lastResults = [];
let lastMeta = '';
let lastStatus = '';

const $ = (sel, root = document) => root.querySelector(sel);
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('ja-JP') : '-');
const skillName = (k) => (D.skills[k] ? D.skills[k].name : k);
const opt = (v, label, sel) => `<option value="${esc(v)}"${String(v) === String(sel) ? ' selected' : ''}>${esc(label)}</option>`;
const clone = (x) => JSON.parse(JSON.stringify(x));

function defaultState() {
  return {
    build: {
      weapon: { id: null, locked: true },
      parts: Object.fromEntries(PARTS.map((p) => [p, { id: null, grade: null, drift: null, locked: false }])),
    },
    gear: { armor: {}, weapons: {} },
    settings: { rates: {}, elemWeakMul: 1, extraAtk: 0, hpBonus: 0, defaultGrade: 10, defaultDrift: 'free', freeKinds: null },
    search: {
      type: 'LONG_SWORD', element: 'ANY', weaponId: '', topN: 30, required: [], noDrift: false, ownedOnly: false,
      useBuildLocks: false, style: { level: 0, ms: { 10: '', 15: '', 20: '' } },
    },
    ui: { tab: 'search', gearPart: 'head', gearFilter: '', gearOwnedOnly: false, gearKind: 'armor', gearWeaponType: 'LONG_SWORD' },
  };
}
function load() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { saved = null; }
  const b = defaultState();
  if (!saved) return b;
  const st = {
    build: { ...b.build, ...saved.build, parts: { ...b.build.parts, ...(saved.build && saved.build.parts) } },
    gear: { ...b.gear, ...saved.gear },
    settings: { ...b.settings, ...saved.settings },
    search: { ...b.search, ...saved.search },
    ui: { ...b.ui, ...saved.ui },
  };
  // 旧形式（drift: 'gear' 等の文字列）の移行
  for (const p of PARTS) {
    const P = st.build.parts[p];
    if (typeof P.drift === 'string') P.drift = P.drift === 'gear' ? null : { mode: P.drift, fixed: P.fixed || [], tokens: [] };
  }
  if (!st.search.style || !st.search.style.ms) st.search.style = b.search.style;
  if (!RENDER_KEYS.includes(st.ui.tab)) st.ui.tab = 'search';
  return st;
}
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch { /* 保存不可の環境 */ } }
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---- 装備の解決 -----------------------------------------------------------------

const weaponGear = (id) => S.gear.weapons[id] || {};
const armorGear = (id) => S.gear.armor[id] || {};

// スタイル強化 {level, ms:{10,15,20}, atk, elem} → 合計値
function styleTotals(style, w) {
  if (!style || !w || !w.style) return null;
  const level = Number(style.level) || 0;
  let atk = Number(style.atk) || 0;
  let elem = Number(style.elem) || 0;
  let crit = 0;
  for (const m of STYLE_MS) {
    if (level < m) continue;
    const c = style.ms && style.ms[m];
    if (c === 'atk') atk += 100;
    else if (c === 'crit') crit += 10;
    else if (c === 'elem') elem += AILMENT_ELEMENTS.includes(w.element) ? 50 : 100;
  }
  return { level, atk, elem, crit };
}
function weaponStyle(w) {
  const g = weaponGear(w.id);
  if (g.style) return g.style;
  return S.search.style;
}
function resolvedWeapon(id) {
  const w = D.weaponById[id];
  if (!w) return null;
  const g = weaponGear(id);
  return resolveWeapon(w, g.grade || S.settings.defaultGrade, g.sub || 5, styleTotals(weaponStyle(w), w));
}
function gearDrift(id) {
  const g = armorGear(id);
  const mode = !g.mode || g.mode === 'default' ? S.settings.defaultDrift : g.mode;
  return { mode, tokens: g.tokens || [], fixed: g.fixed || [] };
}
function armorOption(id, grade, drift) {
  const a = D.armorById[id];
  if (!a) return null;
  const r = resolveArmor(a, grade || armorGear(id).grade || S.settings.defaultGrade);
  return { ...r, drift: clone(drift || gearDrift(id)) };
}
function calcSettings(type, over = {}) {
  return {
    rates: { ...(S.settings.rates[type] || {}) },
    elemWeakMul: Number.isFinite(Number(S.settings.elemWeakMul)) ? Number(S.settings.elemWeakMul) : 1,
    extraAtk: Number(S.settings.extraAtk) || 0,
    hpBonus: Number(S.settings.hpBonus) || 0,
    ...over,
  };
}
const freeKinds = () => (S.settings.freeKinds ? new Set(S.settings.freeKinds) : D.driftable);
function ctxFor(weapon, settings, required = {}) {
  return {
    skillDefs: D.skills, settings, required, freeKinds: freeKinds(),
    relevantKinds: Object.keys(SKILL_EFFECTS).filter((k) => isRelevant(k, weapon, settings)),
  };
}
const weaponsOf = (type, el) => D.weapons.filter((w) => w.type === type && (!el || el === 'ANY' || w.element === el));
const sortedLevels = (levels) => Object.entries(levels).sort((a, b) => (D.skills[a[0]] ? D.skills[a[0]].sort : 0) - (D.skills[b[0]] ? D.skills[b[0]].sort : 0));

// ---- 共通部品 -------------------------------------------------------------------

function typePicker(id, selected) {
  return `<div class="picker" id="${id}">${Object.entries(WEAPON_TYPES).map(([k, v]) => `<button type="button" class="pick${k === selected ? ' on' : ''}" data-v="${k}" title="${esc(v)}">${weaponTypeIcon(D, k, 'pick-ico')}<span>${esc(v)}</span></button>`).join('')}</div>`;
}
function elemPicker(id, selected, withAny = true) {
  const keys = [...(withAny ? ['ANY'] : []), ...Object.keys(ELEMENTS)];
  return `<div class="picker picker-elem" id="${id}">${keys.map((k) => `<button type="button" class="pick${k === selected ? ' on' : ''}" data-v="${k}">${elemIcon(k)}<span>${esc(k === 'ANY' ? 'すべて' : ELEMENTS[k])}</span></button>`).join('')}</div>`;
}
function bindPicker(root, id, cb) {
  root.querySelectorAll(`#${id} .pick`).forEach((b) => b.addEventListener('click', () => cb(b.dataset.v)));
}
const skillCard = (k, lv, cls = '') => `<span class="sk ${cls}"><span class="sk-n">${esc(skillName(k))}</span><span class="sk-l">${lv}</span></span>`;

function skillOptions(selected, driftFirst = true) {
  const kinds = Object.keys(D.skills).sort((a, b) => {
    if (driftFirst) {
      const d = (D.driftable.has(a) ? 0 : 1) - (D.driftable.has(b) ? 0 : 1);
      if (d) return d;
    }
    return (D.skills[a].sort || 0) - (D.skills[b].sort || 0);
  });
  let html = '';
  let group = null;
  for (const k of kinds) {
    const g = driftFirst ? (D.driftable.has(k) ? '錬成で付くスキル' : 'その他') : 'スキル';
    if (g !== group) { if (group !== null) html += '</optgroup>'; html += `<optgroup label="${g}">`; group = g; }
    html += opt(k, D.skills[k].name, selected);
  }
  return `${html}</optgroup>`;
}

function styleBox(id, style, w) {
  const showElem = !w || w.element !== 'NO_ELEMENT';
  return `<div class="style-box" id="${id}">
    <div class="style-top"><b>スタイル強化</b><span class="style-lv">Lv <strong>${style.level || 0}</strong></span></div>
    <input type="range" min="0" max="20" step="1" value="${style.level || 0}" class="style-range">
    <div class="style-ms">${STYLE_MS.map((m) => `<div class="ms${(style.level || 0) >= m ? '' : ' off'}"><div class="ms-t">Lv${m}</div>
      ${[['atk', '物理'], ...(showElem ? [['elem', '属性']] : []), ['crit', '会心']].map(([c, l]) => `<button type="button" class="ms-b${style.ms && style.ms[m] === c ? ' on' : ''}" data-m="${m}" data-c="${c}">${l}</button>`).join('')}</div>`).join('')}</div>
    <div class="row small"><label>Lv上昇分 攻撃+<input type="number" class="narrow st-atk" value="${style.atk || 0}"></label>
      <label>属性+<input type="number" class="narrow st-elem" value="${style.elem || 0}"></label></div>
    <p class="note">Lv10/15/20 の選択は 物理+100・会心+10%・属性+100（状態異常武器は+50）で計算。各Lvの細かい上昇分はゲーム画面の値を「Lv上昇分」に入れてください。</p>
  </div>`;
}
function bindStyleBox(root, id, style, onChange) {
  const box = root.querySelector(`#${id}`);
  if (!box) return;
  box.querySelector('.style-range').addEventListener('input', (e) => { style.level = +e.target.value; box.querySelector('.style-lv strong').textContent = style.level; });
  box.querySelector('.style-range').addEventListener('change', () => onChange());
  box.querySelectorAll('.ms-b').forEach((b) => b.addEventListener('click', () => {
    style.ms = style.ms || {};
    style.ms[b.dataset.m] = style.ms[b.dataset.m] === b.dataset.c ? '' : b.dataset.c;
    onChange();
  }));
  box.querySelector('.st-atk').addEventListener('change', (e) => { style.atk = +e.target.value || 0; onChange(); });
  box.querySelector('.st-elem').addEventListener('change', (e) => { style.elem = +e.target.value || 0; onChange(); });
}

// ---- 錬成編集シート（結果・構築・所持の共通） -------------------------------------------

// piece: armorOption（drift を含む）, assigned: その防具に割り当てられた錬成 [[kind, lv]]
// actions: [{label, primary, onClick(drift)}]
function openDriftSheet(piece, assigned, actions) {
  const a = D.armorById[piece.id];
  const st = { mode: piece.drift ? piece.drift.mode : 'free', tokens: clone((piece.drift && piece.drift.tokens) || []), fixed: clone((piece.drift && piece.drift.fixed) || []) };
  if (st.mode === 'fixed' && !st.fixed.length && assigned.length) st.fixed = clone(assigned);
  const render = (body) => {
    const list = st.mode === 'owned' ? st.tokens : st.fixed;
    const used = st.mode === 'fixed' ? st.fixed.reduce((n, x) => n + x[1], 0) : 0;
    body.innerHTML = `<div class="piece-head">${armorIcon(a, 'ico-l')}<div><b>${esc(a.name)}</b><div class="small muted">${PART_NAMES[a.part]}・G${piece.grade}・錬成枠 <b>${piece.slots}</b></div>
        <div>${piece.skills.map(([k, l]) => skillCard(k, l)).join('')}</div></div></div>
      ${assigned.length ? `<div class="small">現在の割り当て: ${assigned.map(([k, l]) => skillCard(k, l, 'drift')).join('')}</div>` : ''}
      ${piece.slots ? '' : '<div class="warnbox">このグレードでは錬成枠がありません。</div>'}
      <div class="seg">${Object.entries(DRIFT_MODES).map(([k, v]) => `<button type="button" class="${st.mode === k ? 'on' : ''}" data-mode="${k}">${v}</button>`).join('')}</div>
      <p class="note">${{
    free: '錬成で付くスキルから、期待値が最大になるよう自動で選びます。',
    owned: 'この防具が持っている錬成スキルと個数を登録すると、その中から枠数まで自動で選びます（例: 弱点特効×2）。',
    fixed: '実際にセットしている錬成スキルをそのまま使います。',
    none: '錬成スキルを使いません。',
  }[st.mode]}</p>
      ${st.mode === 'owned' || st.mode === 'fixed' ? `<div class="dlist">${list.map(([k, n], i) => `<div class="drow">
          <select data-k="${i}">${skillOptions(k)}</select>
          <div class="stepper"><button type="button" data-dec="${i}">−</button><b>${st.mode === 'owned' ? '×' : 'Lv'}${n}</b><button type="button" data-inc="${i}">＋</button></div>
          <button type="button" class="small" data-del="${i}">削除</button></div>`).join('')}
        <div class="row"><button type="button" class="small" id="d-add">＋ スキルを追加</button>
        ${st.mode === 'fixed' && assigned.length ? '<button type="button" class="small" id="d-copy">現在の割り当てをコピー</button>' : ''}</div>
        ${st.mode === 'fixed' && used > piece.slots ? `<div class="warnbox">錬成枠が${used - piece.slots}枠不足しています。超過分は計算に入りません。</div>` : ''}</div>` : ''}
      <div class="row sheet-actions">${actions.map((x, i) => `<button type="button" class="${x.primary ? 'primary' : ''}" data-act="${i}">${esc(x.label)}</button>`).join('')}</div>`;
    body.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      st.mode = b.dataset.mode;
      if (st.mode === 'fixed' && !st.fixed.length && assigned.length) st.fixed = clone(assigned);
      render(body);
    }));
    const L = () => (st.mode === 'owned' ? st.tokens : st.fixed);
    body.querySelectorAll('[data-k]').forEach((s) => s.addEventListener('change', () => { L()[+s.dataset.k][0] = s.value; }));
    body.querySelectorAll('[data-inc]').forEach((b) => b.addEventListener('click', () => { const r = L()[+b.dataset.inc]; r[1] = Math.min(5, r[1] + 1); render(body); }));
    body.querySelectorAll('[data-dec]').forEach((b) => b.addEventListener('click', () => { const r = L()[+b.dataset.dec]; r[1] = Math.max(1, r[1] - 1); render(body); }));
    body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { L().splice(+b.dataset.del, 1); render(body); }));
    if ($('#d-add', body)) $('#d-add', body).addEventListener('click', () => { L().push(['WEAKNESS_EXPLOIT', 1]); render(body); });
    if ($('#d-copy', body)) $('#d-copy', body).addEventListener('click', () => { st.fixed = clone(assigned); render(body); });
    body.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const drift = { mode: st.mode, tokens: clone(st.tokens), fixed: clone(st.fixed) };
      actions[+b.dataset.act].onClick(drift);
    }));
  };
  openSheet(`錬成を編集（${PART_NAMES[a.part]}）`, '', render);
}

function saveGearDrift(id, drift, grade) {
  S.gear.armor[id] = { ...armorGear(id), mode: drift.mode, tokens: drift.tokens, fixed: drift.fixed };
  if (grade && !armorGear(id).grade) S.gear.armor[id].grade = grade;
  save();
}

// ---- 発動率シート -----------------------------------------------------------------

const RATE_GROUPS = [
  ['会心', ['crit', 'critMul']],
  ['攻撃力', ['atkPct', 'atkFlat', 'atkActive']],
  ['与ダメージ', ['dmgPct']],
  ['属性', ['elemFlat', 'elemPct', 'critElem', 'elder']],
];
function openRateSheet(type, onDone) {
  const render = (body) => {
    const rates = S.settings.rates[type] || {};
    const conds = conditionalSkills();
    const groupOf = (k) => {
      const t = SKILL_EFFECTS[k][0].term;
      return RATE_GROUPS.findIndex(([, terms]) => terms.includes(t));
    };
    body.innerHTML = `<div class="row"><label>武器種<select id="r-type">${Object.entries(WEAPON_TYPES).map(([k, v]) => opt(k, v, type)).join('')}</select></label>
      <button type="button" class="small" id="r-reset">入力リセット</button></div>
      <p class="note">常時発動しないスキルは「効果量 × 発動率」で期待値に入れます。空欄は既定値（灰色の数字）。</p>
      ${RATE_GROUPS.map(([g], gi) => `<details open><summary>${g}</summary><div class="rate-grid">${conds.filter((k) => groupOf(k) === gi).map((k) => {
    const has = rates[k] !== undefined;
    const note = (SKILL_EFFECTS[k].find((e) => e.note) || {}).note;
    return `<label class="${has ? 'changed' : ''}"><span>${esc(skillName(k))}${note ? `<small class="muted"> ${esc(note)}</small>` : ''}</span>
          <input type="number" min="0" max="100" class="narrow" data-rate="${k}" placeholder="${defaultRate(k, type)}" value="${has ? rates[k] : ''}"></label>`;
  }).join('')}</div></details>`).join('')}`;
    $('#r-type', body).addEventListener('change', (e) => { type = e.target.value; render(body); });
    $('#r-reset', body).addEventListener('click', () => { delete S.settings.rates[type]; save(); render(body); });
    body.querySelectorAll('[data-rate]').forEach((el) => el.addEventListener('change', () => {
      const r = { ...(S.settings.rates[type] || {}) };
      if (el.value === '') delete r[el.dataset.rate]; else r[el.dataset.rate] = Math.max(0, Math.min(100, +el.value));
      S.settings.rates[type] = r;
      save();
      el.closest('label').classList.toggle('changed', el.value !== '');
    }));
  };
  openSheet('発動率', '', render, onDone);
}

// ---- 装備構成検索 -------------------------------------------------------------------

function renderSearch() {
  const root = $('#tab-search');
  const Q = S.search;
  const wsel = Q.weaponId ? D.weaponById[Q.weaponId] : null;
  const showStyle = wsel ? wsel.style : weaponsOf(Q.type, Q.element).some((w) => w.style);
  const isBowgun = Q.type === 'LIGHT_BOWGUN' || Q.type === 'HEAVY_BOWGUN';
  const locked = Q.useBuildLocks ? PARTS.filter((p) => S.build.parts[p].locked && S.build.parts[p].id) : [];
  root.innerHTML = `<section class="panel">
    <div class="field"><div class="field-label">武器種</div>${typePicker('s-type', Q.type)}</div>
    <div class="field"><div class="field-label">属性</div>${elemPicker('s-elem', Q.element)}</div>
    <div class="field two">
      <div><div class="field-label">武器（任意）</div>
        <button type="button" class="wselect" id="s-weapon">${wsel ? `${weaponIcon(wsel)}<span>${esc(wsel.name)}</span>` : '<span class="muted">指定なし（すべての武器）</span>'}<i>▾</i></button></div>
      <div><div class="field-label">表示件数</div><select id="s-top">${[10, 30, 50, 100].map((n) => opt(n, `${n}件`, Q.topN)).join('')}</select></div>
    </div>
    ${showStyle ? styleBox('s-style', Q.style, wsel) : ''}
    <div class="box">
      <h3>必須スキル条件</h3>
      <div class="skill-search"><input type="search" id="s-skq" placeholder="追加するスキルを検索" autocomplete="off"><div id="s-skres" class="skres"></div></div>
      <div class="req-list">${Q.required.length ? Q.required.map(([k, lv], i) => `<span class="req">${esc(skillName(k))}
        <button type="button" data-rdec="${i}">−</button><b>Lv${lv}</b><button type="button" data-rinc="${i}">＋</button><button type="button" class="x" data-rdel="${i}" aria-label="削除">×</button></span>`).join('') : '<span class="muted small">必須スキル条件なし</span>'}</div>
      <h3>クイック条件</h3>
      <div class="quick">
        ${QUICK.filter((q) => !q.bowgun || isBowgun).map((q) => `<button type="button" class="qbtn${Q.required.some(([k, l]) => k === q.skill && l >= q.lv) ? ' on' : ''}" data-q="${q.key}">${q.label}</button>`).join('')}
        <button type="button" class="qbtn${Q.noDrift ? ' on' : ''}" id="q-nodrift">錬成無し</button>
        <button type="button" class="qbtn${Q.ownedOnly ? ' on' : ''}" id="q-owned">所持装備のみ</button>
        <button type="button" class="qbtn${Q.useBuildLocks ? ' on' : ''}" id="q-locks">構築の固定を使う</button>
      </div>
      ${locked.length ? `<p class="note">固定中: ${locked.map((p) => `${PART_NAMES[p]} ${esc(D.armorById[S.build.parts[p].id].name)}`).join(' / ')}</p>` : ''}
      <p class="note">${Q.noDrift ? '錬成無し: 新しい錬成（フル錬成）は使いません。所持・錬成タブで登録済みの錬成（固定・所持リスト）は含めて計算します。' : '錬成あり: 防具ごとの設定（所持・錬成タブ）に従います。未設定の防具は「' + esc(DRIFT_MODES[S.settings.defaultDrift]) + '」。'}</p>
    </div>
    <div class="actions"><button type="button" class="primary big-btn" id="s-run">検索</button><button type="button" id="s-clear">クリア</button>
      <button type="button" id="s-rates">発動率</button></div>
    <div id="s-status" class="status">${esc(lastStatus)}</div><div class="progress"><i id="s-bar"></i></div>
  </section>
  <section class="panel">
    <div class="res-head"><h3>検索結果</h3>
      <label class="small">期待値表示 <select id="s-view">${opt(1, '通常', S.settings.elemWeakMul)}${opt(1.5, '属性1.5倍', S.settings.elemWeakMul)}${opt(0, '属性なし', S.settings.elemWeakMul)}</select></label></div>
    <div class="small muted">${esc(lastMeta)}</div>
    <div id="s-results">${resultsHtml()}</div>
  </section>`;

  const rer = () => { save(); renderSearch(); };
  bindPicker(root, 's-type', (v) => { Q.type = v; Q.weaponId = ''; rer(); });
  bindPicker(root, 's-elem', (v) => { Q.element = v; Q.weaponId = ''; rer(); });
  $('#s-weapon').addEventListener('click', () => openWeaponPicker(Q.type, Q.element, true, (id) => { Q.weaponId = id; rer(); }));
  $('#s-top').addEventListener('change', (e) => { Q.topN = +e.target.value; save(); });
  bindStyleBox(root, 's-style', Q.style, rer);
  // スキル検索
  const q = $('#s-skq');
  const res = $('#s-skres');
  const showRes = () => {
    const t = q.value.trim();
    if (!t) { res.innerHTML = ''; return; }
    const hits = Object.keys(D.skills).filter((k) => D.skills[k].name.includes(t) && !Q.required.some((r) => r[0] === k)).slice(0, 12);
    res.innerHTML = hits.map((k) => `<button type="button" data-add="${k}">${esc(skillName(k))}</button>`).join('') || '<div class="muted small">該当スキルなし</div>';
    res.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => { Q.required.push([b.dataset.add, 1]); rer(); }));
  };
  q.addEventListener('input', showRes);
  root.querySelectorAll('[data-rinc]').forEach((b) => b.addEventListener('click', () => { const r = Q.required[+b.dataset.rinc]; r[1] = Math.min(D.skills[r[0]] ? D.skills[r[0]].max : 5, r[1] + 1); rer(); }));
  root.querySelectorAll('[data-rdec]').forEach((b) => b.addEventListener('click', () => { const r = Q.required[+b.dataset.rdec]; r[1] = Math.max(1, r[1] - 1); rer(); }));
  root.querySelectorAll('[data-rdel]').forEach((b) => b.addEventListener('click', () => { Q.required.splice(+b.dataset.rdel, 1); rer(); }));
  root.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
    const qq = QUICK.find((x) => x.key === b.dataset.q);
    const i = Q.required.findIndex(([k]) => k === qq.skill);
    if (i >= 0 && Q.required[i][1] >= qq.lv) Q.required.splice(i, 1);
    else if (i >= 0) Q.required[i][1] = qq.lv;
    else Q.required.push([qq.skill, qq.lv]);
    rer();
  }));
  $('#q-nodrift').addEventListener('click', () => { Q.noDrift = !Q.noDrift; rer(); });
  $('#q-owned').addEventListener('click', () => { Q.ownedOnly = !Q.ownedOnly; rer(); });
  $('#q-locks').addEventListener('click', () => { Q.useBuildLocks = !Q.useBuildLocks; rer(); });
  $('#s-run').addEventListener('click', runSearch);
  $('#s-clear').addEventListener('click', () => { Q.required = []; Q.noDrift = false; Q.ownedOnly = false; Q.weaponId = ''; lastResults = []; lastMeta = ''; rer(); });
  $('#s-rates').addEventListener('click', () => openRateSheet(Q.type, () => { if (lastResults.length) { recalcAll(); } }));
  $('#s-view').addEventListener('change', (e) => { S.settings.elemWeakMul = Number(e.target.value); save(); recalcAll(); });
  bindResults();
}

function buildSearchInput() {
  const Q = S.search;
  const B = S.build;
  let weapons;
  if (Q.useBuildLocks && B.weapon.locked && B.weapon.id) weapons = [resolvedWeapon(B.weapon.id)];
  else if (Q.weaponId) weapons = [resolvedWeapon(Q.weaponId)];
  else weapons = weaponsOf(Q.type, Q.element).filter((w) => !Q.ownedOnly || weaponGear(w.id).owned).map((w) => resolvedWeapon(w.id));
  // 錬成無し: 自由（フル錬成）は使わないが、防具に既に付いている錬成（固定・所持リスト）は含める
  const existingOnly = (d) => (d && (d.mode === 'fixed' || d.mode === 'owned') ? d : { mode: 'none' });
  const driftFor = (id) => (Q.noDrift ? existingOnly(gearDrift(id)) : gearDrift(id));
  const partOptions = {};
  for (const part of PARTS) {
    const P = B.parts[part];
    if (Q.useBuildLocks && P.locked && P.id) {
      partOptions[part] = [armorOption(P.id, P.grade, Q.noDrift ? existingOnly(P.drift || gearDrift(P.id)) : (P.drift || gearDrift(P.id)))];
      continue;
    }
    partOptions[part] = D.armor
      .filter((a) => a.part === part && (!Q.ownedOnly || armorGear(a.id).owned))
      .map((a) => armorOption(a.id, armorGear(a.id).owned ? armorGear(a.id).grade : S.settings.defaultGrade, driftFor(a.id)));
  }
  const type = weapons[0] ? weapons[0].type : Q.type;
  return {
    weapons, partOptions,
    settings: calcSettings(type),
    required: Object.fromEntries(Q.required),
    freeKinds: [...freeKinds()],
    topN: Q.topN,
    timeLimitMs: 25000,
  };
}

function runSearch() {
  const input = buildSearchInput();
  const status = $('#s-status');
  const bar = $('#s-bar');
  if (!input.weapons.length) { status.textContent = '対象の武器がありません（「所持装備のみ」の場合は所持登録を確認してください）'; return; }
  lastStatus = '';
  if (worker) worker.terminate();
  worker = new Worker(new URL('./search_worker.js', import.meta.url), { type: 'module' });
  const btn = $('#s-run');
  btn.disabled = true;
  status.textContent = `検索中…（武器 ${input.weapons.length} 本）`;
  bar.style.width = '5%';
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'progress') {
      status.textContent = `検索中… 武器 ${m.weapon}/${m.weapons}・${m.evaluated.toLocaleString()} 通り`;
      bar.style.width = `${Math.min(95, (m.weapon / m.weapons) * 100)}%`;
    } else if (m.type === 'done') {
      btn.disabled = false;
      bar.style.width = '100%';
      lastResults = m.results.map((r) => ({ ...r, required: input.required }));
      lastMeta = `${m.evaluated.toLocaleString()} 通りを評価（${(m.elapsed / 1000).toFixed(1)}秒）${m.timedOut ? '・時間切れのため途中まで' : ''}${m.approximated ? '・候補を絞って探索（近似）' : ''}`;
      lastStatus = '検索完了';
      worker.terminate(); worker = null;
      renderSearch();
    } else if (m.type === 'error') {
      btn.disabled = false;
      status.textContent = `エラー: ${m.message}`;
    }
  };
  worker.postMessage(input);
}

// 結果1件を再計算（錬成編集・表示倍率変更・発動率変更のあと）
function recalcResult(r) {
  const weapon = r.weapon;
  const settings = calcSettings(weapon.type);
  const ev = evaluateBuild(weapon, r.pieces, ctxFor(weapon, settings, r.required || {}));
  r.damage = ev.value;
  r.drifts = ev.drifts;
  r.levels = ev.levels;
  r.unmet = ev.unmet;
  r.slotsTotal = ev.slotsTotal;
  r.critRate = ev.result.critRate;
  r.stat = { phys: ev.result.phys, elem: ev.result.elemNorm };
}
function recalcAll() {
  lastResults.forEach(recalcResult);
  lastResults.sort((a, b) => (Object.keys(a.unmet || {}).length - Object.keys(b.unmet || {}).length) || (b.damage - a.damage));
  renderSearch();
}

function resultsHtml() {
  if (!lastResults.length) return `<div class="empty">${lastMeta ? '候補の装備がありません。「所持装備のみ」の場合は所持・錬成タブで登録してください。' : '武器種を選んで検索してください。'}</div>`;
  return lastResults.map((r, i) => {
    const byPiece = {};
    for (const d of r.drifts) (byPiece[d.pieceId] = byPiece[d.pieceId] || []).push([d.kind, d.lv]);
    const used = r.drifts.reduce((n, d) => n + d.lv, 0);
    const reqKeys = Object.keys(r.required || {});
    const skills = sortedLevels(r.levels).filter(([k]) => SKILL_EFFECTS[k] || reqKeys.includes(k));
    const unmet = Object.entries(r.unmet || {});
    const w = D.weaponById[r.weapon.id];
    return `<article class="res${r.edited ? ' edited' : ''}">
      <div class="res-build">
        <div class="res-weapon">${weaponIcon(w, 'ico-m')}<div><span class="rank">#${i + 1}</span> <b>${esc(r.weapon.name)}</b> ${elemIcon(r.weapon.element, 's')}
          <div class="small muted">${r.weapon.grade}-${r.weapon.sub}・攻撃${r.weapon.atk}${r.weapon.elem ? `・属性${r.weapon.elem}` : ''}・会心${r.weapon.crit}%</div></div></div>
        <div class="res-armor">${PARTS.filter((p) => r.pieces[p]).map((p) => {
    const x = r.pieces[p];
    const a = D.armorById[x.id];
    const dr = byPiece[x.id] || [];
    const alt = x.alternatives && x.alternatives.length ? `<span class="alt">他${x.alternatives.length}</span>` : '';
    return `<button type="button" class="piece" data-res="${i}" data-part="${p}" title="タップで錬成を編集">${armorIcon(a, 'ico-s')}
            <span class="pn">${esc(x.name)}<small> G${x.grade}</small>${alt}</span>
            <span class="pd">${dr.length ? dr.map(([k, l]) => skillCard(k, l, 'drift mini')).join('') : `<span class="pd-none">${x.slots ? (x.drift.mode === 'none' ? '錬成なし' : '空き') : '枠なし'}</span>`}</span></button>`;
  }).join('')}</div>
      </div>
      <div class="res-side">
        <div class="res-val"><span class="small muted">期待値</span><b>${fmt(r.damage)}</b><span class="small muted">会心${r.critRate.toFixed(0)}%・錬成${used}/${r.slotsTotal}</span>
          ${r.edited ? '<span class="tag">錬成編集済み</span>' : ''}</div>
        <div class="res-skills">${skills.map(([k, l]) => skillCard(k, l)).join('')}</div>
        ${unmet.length ? `<div class="warnbox">不足: ${unmet.map(([k, n]) => `${esc(skillName(k))} あと${n}`).join('、')}</div>` : ''}
        <div class="row"><button type="button" class="small" data-apply="${i}">構築で開く</button></div>
      </div>
    </article>`;
  }).join('');
}

function bindResults() {
  document.querySelectorAll('#s-results [data-apply]').forEach((el) => el.addEventListener('click', () => applyToBuild(lastResults[+el.dataset.apply])));
  document.querySelectorAll('#s-results .piece').forEach((el) => el.addEventListener('click', () => {
    const r = lastResults[+el.dataset.res];
    const part = el.dataset.part;
    const piece = r.pieces[part];
    const assigned = r.drifts.filter((d) => d.pieceId === piece.id).map((d) => [d.kind, d.lv]);
    openDriftSheet(piece, assigned, [
      { label: 'この構成で再計算', primary: true, onClick: (drift) => { piece.drift = drift; r.edited = true; recalcResult(r); closeSheet(); renderSearch(); toast(`再計算しました: ${fmt(r.damage)}`); } },
      { label: '再計算して防具の設定にも保存', onClick: (drift) => { piece.drift = drift; r.edited = true; saveGearDrift(piece.id, drift, piece.grade); recalcResult(r); closeSheet(); renderSearch(); toast('防具の錬成設定に保存しました'); } },
    ]);
  }));
}

function applyToBuild(r) {
  const B = S.build;
  B.weapon.id = r.weapon.id;
  for (const part of PARTS) {
    const x = r.pieces[part];
    if (!x) continue;
    const P = B.parts[part];
    P.id = x.id;
    P.grade = x.grade;
    const ds = r.drifts.filter((d) => d.pieceId === x.id).map((d) => [d.kind, d.lv]);
    P.drift = { mode: ds.length ? 'fixed' : 'none', fixed: ds, tokens: [] };
  }
  save();
  switchTab('build');
  toast('構築に反映しました（錬成は割り当てどおり固定）');
}

// ---- 武器・防具の選択シート -------------------------------------------------------------

function openWeaponPicker(type, element, allowNone, onPick) {
  let t = type;
  let e = element || 'ANY';
  let q = '';
  const render = (body) => {
    const list = weaponsOf(t, e).filter((w) => !q || w.name.includes(q) || w.series.includes(q));
    body.innerHTML = `${typePicker('wp-type', t)}${elemPicker('wp-elem', e)}
      <input type="search" id="wp-q" placeholder="名前で絞り込み" value="${esc(q)}">
      <div class="plist">${allowNone ? '<button type="button" class="pitem" data-id=""><span class="ico-m ico-none"></span><span>指定なし（すべての武器）</span></button>' : ''}
      ${list.map((w) => {
    const r = resolvedWeapon(w.id);
    return `<button type="button" class="pitem" data-id="${w.id}">${weaponIcon(w, 'ico-m')}<span><b>${esc(w.name)}</b>${weaponGear(w.id).owned ? ' <span class="star">★</span>' : ''}
          <small class="muted">${elemIcon(w.element, 's')} 攻撃${r.atk}${r.elem ? `・属性${r.elem}` : ''}・会心${r.crit}%</small>
          <span>${r.skills.map(([k, l]) => skillCard(k, l, 'mini')).join('')}</span></span></button>`;
  }).join('') || '<div class="muted">該当なし</div>'}</div>`;
    bindPicker(body, 'wp-type', (v) => { t = v; render(body); });
    bindPicker(body, 'wp-elem', (v) => { e = v; render(body); });
    const qi = $('#wp-q', body);
    qi.addEventListener('change', () => { q = qi.value.trim(); render(body); });
    body.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => { closeSheet(); onPick(b.dataset.id || null); }));
  };
  openSheet('武器を選択', '', render);
}

function openArmorPicker(part, onPick) {
  let q = '';
  let ownedOnly = false;
  const render = (body) => {
    const list = D.armor.filter((a) => a.part === part && (!q || a.name.includes(q) || a.series.includes(q)) && (!ownedOnly || armorGear(a.id).owned));
    body.innerHTML = `<div class="row"><input type="search" id="ap-q" placeholder="名前で絞り込み" value="${esc(q)}">
      <label class="inline"><input type="checkbox" id="ap-own" ${ownedOnly ? 'checked' : ''}> 所持のみ</label></div>
      <div class="plist"><button type="button" class="pitem" data-id=""><span class="ico-m ico-none"></span><span>（なし）</span></button>
      ${list.map((a) => {
    const r = resolveArmor(a, armorGear(a.id).grade || S.settings.defaultGrade);
    return `<button type="button" class="pitem" data-id="${a.id}">${armorIcon(a, 'ico-m')}<span><b>${esc(a.name)}</b>${armorGear(a.id).owned ? ' <span class="star">★</span>' : ''}
          <small class="muted">G${r.grade}・錬成枠${r.slots}</small><span>${r.skills.map(([k, l]) => skillCard(k, l, 'mini')).join('')}</span></span></button>`;
  }).join('')}</div>`;
    const qi = $('#ap-q', body);
    qi.addEventListener('change', () => { q = qi.value.trim(); render(body); });
    $('#ap-own', body).addEventListener('change', (e) => { ownedOnly = e.target.checked; render(body); });
    body.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => { closeSheet(); onPick(b.dataset.id || null); }));
  };
  openSheet(`${PART_NAMES[part]}を選択`, '', render);
}

// ---- 装備構成（構築） ----------------------------------------------------------------

function buildPieces() {
  const pieces = {};
  for (const part of PARTS) {
    const P = S.build.parts[part];
    if (P.id) pieces[part] = armorOption(P.id, P.grade, P.drift || gearDrift(P.id));
  }
  return pieces;
}

function renderBuild() {
  const root = $('#tab-build');
  const B = S.build;
  const w = B.weapon.id ? D.weaponById[B.weapon.id] : null;
  const rw = w ? resolvedWeapon(w.id) : null;
  const pieces = buildPieces();
  let ev = null;
  if (rw) {
    const settings = calcSettings(rw.type);
    ev = evaluateBuild(rw, pieces, ctxFor(rw, settings));
  }
  const byPiece = {};
  if (ev) for (const d of ev.drifts) (byPiece[d.pieceId] = byPiece[d.pieceId] || []).push([d.kind, d.lv]);

  const wg = w ? weaponGear(w.id) : {};
  let html = `<section class="panel"><div class="slots">
    <div class="slot slot-weapon">
      <button type="button" class="slot-main" id="b-weapon">${w ? weaponIcon(w, 'ico-l') : weaponTypeIcon(D, S.search.type, 'ico-l dim')}
        <span><span class="slot-part">武器</span><b>${w ? esc(w.name) : 'タップして選択'}</b>
        ${rw ? `<small class="muted">${elemIcon(rw.element, 's')} 攻撃${rw.atk}${rw.elem ? `・属性${rw.elem}` : ''}・会心${rw.crit}%</small>` : ''}</span></button>
      ${w ? `<div class="slot-ctrl"><label>G<select id="b-wgrade">${gradesOf(w).map((g) => opt(g, g, rw.grade)).join('')}</select></label>
        <label>段階<select id="b-wsub">${[1, 2, 3, 4, 5].map((s) => opt(s, s, wg.sub || 5)).join('')}</select></label>
        <label class="inline"><input type="checkbox" id="b-wown" ${wg.owned ? 'checked' : ''}>所持</label>
        <label class="inline"><input type="checkbox" id="b-wlock" ${B.weapon.locked ? 'checked' : ''}>固定</label></div>
        <div class="slot-skills">${rw.skills.map(([k, l]) => skillCard(k, l)).join('')}${rw.lockedSkills.map(([k, l, req]) => `<span class="sk off"><span class="sk-n">${esc(skillName(k))}</span><span class="sk-l">${l}</span><small>Lv${req}</small></span>`).join('')}</div>` : ''}
    </div>
    ${w && w.style ? styleBox('b-style', wg.style || clone(S.search.style), w) : ''}`;
  for (const part of PARTS) {
    const P = B.parts[part];
    const a = P.id ? D.armorById[P.id] : null;
    const o = pieces[part];
    const dr = a ? byPiece[a.id] || [] : [];
    html += `<div class="slot">
      <button type="button" class="slot-main" data-pick="${part}">${a ? armorIcon(a, 'ico-l') : '<span class="ico-l ico-none"></span>'}
        <span><span class="slot-part">${PART_NAMES[part]}</span><b>${a ? esc(a.name) : 'タップして選択'}</b>${a && armorGear(a.id).owned ? ' <span class="star">★</span>' : ''}</span></button>
      ${a ? `<div class="slot-ctrl"><label>G<select data-grade="${part}">${gradesOf(a).map((g) => opt(g, g, o.grade)).join('')}</select></label>
        <label class="inline"><input type="checkbox" data-lock="${part}" ${P.locked ? 'checked' : ''}>固定</label></div>
        <div class="slot-skills">${o.skills.map(([k, l]) => skillCard(k, l)).join('')}</div>
        <button type="button" class="drift-area" data-drift="${part}"><span class="dl">錬成 ${dr.reduce((n, x) => n + x[1], 0)}/${o.slots}<small>${esc(DRIFT_MODES[o.drift.mode])}${P.drift ? '' : '（防具の設定）'}</small></span>
          <span>${dr.map(([k, l]) => skillCard(k, l, 'drift')).join('') || '<span class="muted small">なし</span>'}</span><i>✎</i></button>` : ''}
    </div>`;
  }
  html += '</div></section>';
  html += `<section class="panel" id="b-result">${ev ? buildSummaryHtml(ev) : '<div class="empty">武器を選ぶと期待値を計算します。防具は空欄でも計算できます。</div>'}</section>
    <div class="actions"><button type="button" class="primary" id="b-search">固定していない部位を検索で埋める</button>
      <button type="button" id="b-rates">発動率</button><button type="button" id="b-clear">構築をクリア</button></div>`;
  root.innerHTML = html;

  const rer = () => { save(); renderBuild(); };
  $('#b-weapon').addEventListener('click', () => openWeaponPicker(w ? w.type : S.search.type, 'ANY', false, (id) => { B.weapon.id = id; rer(); }));
  if (w) {
    const setG = (k, v) => { S.gear.weapons[w.id] = { ...weaponGear(w.id), [k]: v }; rer(); };
    $('#b-wgrade').addEventListener('change', (e) => setG('grade', +e.target.value));
    $('#b-wsub').addEventListener('change', (e) => setG('sub', +e.target.value));
    $('#b-wown').addEventListener('change', (e) => setG('owned', e.target.checked));
    $('#b-wlock').addEventListener('change', (e) => { B.weapon.locked = e.target.checked; save(); });
    if (w.style) {
      const st = wg.style || clone(S.search.style);
      bindStyleBox(root, 'b-style', st, () => { S.gear.weapons[w.id] = { ...weaponGear(w.id), style: st }; rer(); });
    }
  }
  root.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => openArmorPicker(b.dataset.pick, (id) => {
    const P = B.parts[b.dataset.pick];
    P.id = id; P.grade = null; P.drift = null; rer();
  })));
  root.querySelectorAll('[data-grade]').forEach((s) => s.addEventListener('change', () => { B.parts[s.dataset.grade].grade = +s.value; rer(); }));
  root.querySelectorAll('[data-lock]').forEach((c) => c.addEventListener('change', () => { B.parts[c.dataset.lock].locked = c.checked; save(); }));
  root.querySelectorAll('[data-drift]').forEach((b) => b.addEventListener('click', () => {
    const part = b.dataset.drift;
    const P = B.parts[part];
    const o = pieces[part];
    const assigned = ev ? ev.drifts.filter((d) => d.pieceId === o.id).map((d) => [d.kind, d.lv]) : [];
    openDriftSheet(o, assigned, [
      { label: 'この構築に適用', primary: true, onClick: (drift) => { P.drift = drift; closeSheet(); rer(); } },
      { label: '防具の設定として保存', onClick: (drift) => { saveGearDrift(o.id, drift, o.grade); P.drift = null; closeSheet(); rer(); toast('防具の錬成設定に保存しました'); } },
    ]);
  }));
  $('#b-search').addEventListener('click', () => {
    S.search.useBuildLocks = true;
    if (w) S.search.type = w.type;
    switchTab('search');
    runSearch();
  });
  $('#b-rates').addEventListener('click', () => openRateSheet(w ? w.type : S.search.type, () => renderBuild()));
  $('#b-clear').addEventListener('click', () => { S.build = defaultState().build; rer(); });
}

const TERM_LABEL = {
  atkPct: '攻撃力%', atkFlat: '攻撃力+', atkActive: '攻撃活性%', dmgPct: '与ダメージ%', crit: '会心率%',
  elemFlat: '属性+', elemPct: '属性%', critElem: '会心時属性%', elder: '古龍属性%',
};
function buildSummaryHtml(r) {
  const res = r.result;
  const used = r.drifts.reduce((s, d) => s + d.lv, 0);
  const driftRaw = {};
  for (const d of r.drifts) driftRaw[d.kind] = (driftRaw[d.kind] || 0) + d.lv;
  return `<div class="sum-top"><div><div class="small muted">期待値（モーション値100・肉質100あたり）</div><div class="big">${fmt(res.expected)}</div></div>
      <div class="small muted">錬成 ${used}/${r.slotsTotal} 枠</div></div>
    <div class="stats">
      <div><span>物理</span><b>${fmt(res.phys)}</b></div>
      <div><span>属性（通常/会心）</span><b>${fmt(res.elemNorm)} / ${fmt(res.elemCrit)}</b></div>
      <div><span>会心率</span><b>${res.critRate.toFixed(1)}%</b></div>
      <div><span>会心倍率</span><b>${(res.critMul / 100).toFixed(2)}倍</b></div>
      <div><span>与ダメージ補正</span><b>+${res.dmgPct.toFixed(1)}%</b></div>
      <div><span>通常 / 会心ヒット</span><b>${fmt(res.normal)} / ${fmt(res.critHit)}</b></div>
    </div>
    <h3>発動スキル</h3><div>${sortedLevels(r.levels).map(([k, lv]) => skillCard(k, lv, SKILL_EFFECTS[k] ? '' : 'weak') + (driftRaw[k] ? `<span class="sk drift mini"><span class="sk-n">錬成</span><span class="sk-l">+${driftRaw[k]}</span></span>` : '')).join('') || '<span class="muted">なし</span>'}</div>
    <details><summary class="small">計算の内訳</summary><table class="list"><tr><th>スキル</th><th>項</th><th>寄与（発動率込み）</th></tr>${res.contrib.map((c) => `<tr><td>${esc(skillName(c.kind))}</td><td>${TERM_LABEL[c.term] || c.term}</td><td class="num">${c.value.toFixed(1)}</td></tr>`).join('')}</table></details>`;
}

// ---- 所持・錬成 -----------------------------------------------------------------------

function renderGear() {
  const root = $('#tab-gear');
  const U = S.ui;
  root.innerHTML = `<section class="panel">
    <p class="note">所持装備のグレードと、防具ごとの錬成を登録します。錬成欄をタップすると編集できます。
      「所持リストから」は、その防具が実際に持っている錬成スキル（例: 弱点特効×2）の中だけから選んで計算します。</p>
    <div class="seg">${[['armor', '防具'], ['weapon', '武器']].map(([k, v]) => `<button type="button" data-kind="${k}" class="${U.gearKind === k ? 'on' : ''}">${v}</button>`).join('')}</div>
    ${U.gearKind === 'armor'
    ? `<div class="seg">${[...PARTS, 'all'].map((p) => `<button type="button" data-gpart="${p}" class="${U.gearPart === p ? 'on' : ''}">${p === 'all' ? 'すべて' : PART_NAMES[p]}</button>`).join('')}</div>`
    : typePicker('g-wtype', U.gearWeaponType)}
    <div class="row"><input type="search" id="g-filter" value="${esc(U.gearFilter)}" placeholder="名前・シリーズで絞り込み">
      <label class="inline"><input type="checkbox" id="g-owned" ${U.gearOwnedOnly ? 'checked' : ''}> 所持のみ</label></div>
  </section><section class="panel" id="g-list"></section>`;
  root.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => { U.gearKind = b.dataset.kind; save(); renderGear(); }));
  root.querySelectorAll('[data-gpart]').forEach((b) => b.addEventListener('click', () => { U.gearPart = b.dataset.gpart; save(); renderGear(); }));
  bindPicker(root, 'g-wtype', (v) => { U.gearWeaponType = v; save(); renderGear(); });
  $('#g-filter').addEventListener('input', (e) => { U.gearFilter = e.target.value; save(); renderGearList(); });
  $('#g-owned').addEventListener('change', (e) => { U.gearOwnedOnly = e.target.checked; save(); renderGearList(); });
  renderGearList();
}

function renderGearList() {
  const U = S.ui;
  const box = $('#g-list');
  const q = U.gearFilter.trim();
  if (U.gearKind === 'weapon') {
    const list = D.weapons.filter((w) => w.type === U.gearWeaponType && (!q || w.name.includes(q) || w.series.includes(q)) && (!U.gearOwnedOnly || weaponGear(w.id).owned));
    box.innerHTML = list.map((w) => {
      const g = weaponGear(w.id);
      return `<div class="gitem">${weaponIcon(w, 'ico-m')}<div class="gmain"><b>${esc(w.name)}</b> ${elemIcon(w.element, 's')}${w.style ? '<small class="muted"> スタイル強化</small>' : ''}
        <div class="row small"><label class="inline"><input type="checkbox" data-wown="${w.id}" ${g.owned ? 'checked' : ''}>所持</label>
        <label>G<select data-wgrade="${w.id}">${gradesOf(w).map((x) => opt(x, x, g.grade || S.settings.defaultGrade)).join('')}</select></label>
        <label>段階<select data-wsub="${w.id}">${[1, 2, 3, 4, 5].map((x) => opt(x, x, g.sub || 5)).join('')}</select></label></div></div></div>`;
    }).join('') || '<div class="empty">該当なし</div>';
    const setW = (id, k, v) => { S.gear.weapons[id] = { ...weaponGear(id), [k]: v }; save(); };
    box.querySelectorAll('[data-wown]').forEach((el) => el.addEventListener('change', () => setW(el.dataset.wown, 'owned', el.checked)));
    box.querySelectorAll('[data-wgrade]').forEach((el) => el.addEventListener('change', () => setW(el.dataset.wgrade, 'grade', +el.value)));
    box.querySelectorAll('[data-wsub]').forEach((el) => el.addEventListener('change', () => setW(el.dataset.wsub, 'sub', +el.value)));
    return;
  }
  const list = D.armor.filter((a) => (U.gearPart === 'all' || a.part === U.gearPart) && (!q || a.name.includes(q) || a.series.includes(q)) && (!U.gearOwnedOnly || armorGear(a.id).owned));
  box.innerHTML = list.map((a) => {
    const g = armorGear(a.id);
    const r = resolveArmor(a, g.grade || S.settings.defaultGrade);
    const mode = g.mode || 'default';
    const list2 = mode === 'owned' ? (g.tokens || []).map(([k, n]) => skillCard(k, `×${n}`, 'drift')) : mode === 'fixed' ? (g.fixed || []).map(([k, n]) => skillCard(k, n, 'drift')) : [];
    return `<div class="gitem">${armorIcon(a, 'ico-m')}<div class="gmain"><b>${esc(a.name)}</b> <small class="muted">${PART_NAMES[a.part]}</small>
      <div class="row small"><label class="inline"><input type="checkbox" data-aown="${a.id}" ${g.owned ? 'checked' : ''}>所持</label>
        <label>G<select data-agrade="${a.id}">${gradesOf(a).map((x) => opt(x, x, r.grade)).join('')}</select></label></div>
      <div>${r.skills.map(([k, l]) => skillCard(k, l, 'mini')).join('')}</div>
      <button type="button" class="drift-area" data-aedit="${a.id}"><span class="dl">錬成枠 ${r.slots}<small>${mode === 'default' ? `既定（${esc(DRIFT_MODES[S.settings.defaultDrift])}）` : esc(DRIFT_MODES[mode])}</small></span>
        <span>${list2.join('') || '<span class="muted small">タップして設定</span>'}</span><i>✎</i></button></div></div>`;
  }).join('') || '<div class="empty">該当なし</div>';
  const setA = (id, k, v) => { S.gear.armor[id] = { ...armorGear(id), [k]: v }; save(); };
  box.querySelectorAll('[data-aown]').forEach((el) => el.addEventListener('change', () => setA(el.dataset.aown, 'owned', el.checked)));
  box.querySelectorAll('[data-agrade]').forEach((el) => el.addEventListener('change', () => { setA(el.dataset.agrade, 'grade', +el.value); renderGearList(); }));
  box.querySelectorAll('[data-aedit]').forEach((el) => el.addEventListener('click', () => {
    const id = el.dataset.aedit;
    const piece = armorOption(id, armorGear(id).grade, gearDrift(id));
    openDriftSheet(piece, [], [
      { label: '保存', primary: true, onClick: (drift) => { saveGearDrift(id, drift); closeSheet(); renderGearList(); toast('保存しました'); } },
      { label: '既定に戻す', onClick: () => { setA(id, 'mode', 'default'); closeSheet(); renderGearList(); } },
    ]);
  }));
}

// ---- 設定 ---------------------------------------------------------------------------

function renderSettings() {
  const root = $('#tab-settings');
  const T = S.settings;
  const fk = freeKinds();
  root.innerHTML = `<section class="panel">
    <h3>計算条件</h3>
    <div class="row">
      <label>属性の扱い<select id="t-weak">${opt(1, '弱点を突く（属性値をそのまま加算）', T.elemWeakMul)}${opt(1.5, '弱点を突く（属性値1.5倍）', T.elemWeakMul)}${opt(0, '弱点でない相手（属性値は加算しない）', T.elemWeakMul)}</select></label>
      <label>追加攻撃力（錬成パラメータ等）<input type="number" id="t-extra" value="${T.extraAtk}"></label>
      <label>体力の追加分<input type="number" id="t-hp" value="${T.hpBonus}" class="narrow"></label>
      <label>未所持装備のグレード<select id="t-grade">${[5, 6, 7, 8, 9, 10].map((g) => opt(g, g, T.defaultGrade)).join('')}</select></label>
      <label>防具の錬成の既定<select id="t-drift">${opt('free', '自由（フル錬成）', T.defaultDrift)}${opt('none', '錬成なし', T.defaultDrift)}</select></label>
    </div>
    <div class="row"><button type="button" id="t-rates">発動率を設定</button></div>
  </section>
  <section class="panel">
    <h3>自由錬成で付けられるスキル</h3>
    <p class="note">「自由（フル錬成）」の防具に付ける候補。既定は公式の漂流石・漂流純石から付くスキルすべて。</p>
    <div class="rate-grid">${[...D.driftable].filter((k) => SKILL_EFFECTS[k]).sort((a, b) => D.skills[a].sort - D.skills[b].sort).map((k) => `<label class="inline"><input type="checkbox" data-fk="${k}" ${fk.has(k) ? 'checked' : ''}> ${esc(skillName(k))}</label>`).join('')}</div>
    <div class="row"><button type="button" class="small" id="t-fk-reset">すべてに戻す</button></div>
  </section>
  <section class="panel">
    <h3>バックアップ</h3>
    <div class="row"><button type="button" id="t-export">書き出し（コピー）</button><button type="button" id="t-import">読み込み</button></div>
    <textarea id="t-json" rows="4" placeholder="書き出したJSONを貼り付けて「読み込み」"></textarea>
  </section>
  <section class="panel small">
    <h3>データと計算の前提</h3>
    <p>装備・スキルの数値と画像: <a href="${esc(D.meta.source)}" target="_blank" rel="noopener">モンハンNow公式サイト</a>（取得 ${esc(D.meta.fetched_at)}）。画像は公式サイトのURLを表示時に参照しています。</p>
    <ul>
      <li>期待値はモーション値100・肉質100あたり。武器種固有の補正は入れていないため、比較は同じ武器種どうしで。</li>
      <li>攻撃力%系は武器攻撃力に、与ダメージ%系は最終値に掛け、同じ系統どうしは加算。会心倍率は基本1.25倍、マイナス会心は0.75倍。</li>
      <li>属性値は弱点属性の相手にのみ加算される前提（コミュニティの検証による）。</li>
      <li>錬成は1枠＝スキル1Lv。錬成枠数は防具のグレードで決まる（公式データ）。</li>
      <li>スタイル強化の Lv10/15/20 は 物理+100・会心+10%・属性+100（状態異常武器+50）。</li>
      <li>尻上がり・追い打ち【爆破】・凶会心の効果量の解釈は推定。合わない場合は発動率で調整を。</li>
    </ul>
  </section>`;
  const set = (k, v) => { T[k] = v; save(); };
  $('#t-weak').addEventListener('change', (e) => set('elemWeakMul', Number(e.target.value)));
  $('#t-extra').addEventListener('change', (e) => set('extraAtk', +e.target.value || 0));
  $('#t-hp').addEventListener('change', (e) => set('hpBonus', +e.target.value || 0));
  $('#t-grade').addEventListener('change', (e) => set('defaultGrade', +e.target.value));
  $('#t-drift').addEventListener('change', (e) => set('defaultDrift', e.target.value));
  $('#t-rates').addEventListener('click', () => openRateSheet(S.search.type));
  root.querySelectorAll('[data-fk]').forEach((el) => el.addEventListener('change', () => {
    const cur = new Set(freeKinds());
    if (el.checked) cur.add(el.dataset.fk); else cur.delete(el.dataset.fk);
    T.freeKinds = [...cur]; save();
  }));
  $('#t-fk-reset').addEventListener('click', () => { T.freeKinds = null; save(); renderSettings(); });
  $('#t-export').addEventListener('click', async () => {
    const json = JSON.stringify(S);
    $('#t-json').value = json;
    try { await navigator.clipboard.writeText(json); toast('コピーしました'); } catch { toast('下の欄からコピーしてください'); }
  });
  $('#t-import').addEventListener('click', () => {
    try {
      const v = JSON.parse($('#t-json').value);
      if (!v || typeof v !== 'object' || !v.gear) throw new Error('形式が違います');
      localStorage.setItem(STORE_KEY, JSON.stringify(v));
      S = load();
      toast('読み込みました');
      renderSettings();
    } catch (e) { toast(`読み込めませんでした: ${e.message}`); }
  });
}

// ---- タブ ---------------------------------------------------------------------------

const RENDER = { search: renderSearch, build: renderBuild, gear: renderGear, settings: renderSettings };
const RENDER_KEYS = Object.keys(RENDER);
function switchTab(tab) {
  S.ui.tab = tab;
  save();
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== `tab-${tab}`; });
  RENDER[tab]();
  window.scrollTo(0, 0);
}

async function main() {
  S = load();
  try {
    D = await loadData('./data');
  } catch (e) {
    document.querySelector('main').innerHTML = `<p class="warnbox">データを読み込めませんでした: ${esc(e.message)}</p>`;
    return;
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  switchTab(S.ui.tab);
}

main();
