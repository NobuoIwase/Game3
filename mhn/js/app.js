import { loadData, resolveWeapon, resolveArmor, gradesOf, maxGrade } from './data.js';
import { WEAPON_TYPES, ELEMENTS, PARTS, PART_NAMES, SKILL_EFFECTS, conditionalSkills, defaultRate } from './model.js';
import { evaluateBuild, isRelevant } from './search.js';

const STORE_KEY = 'mhn-calc-v1';
const DRIFT_MODES = { default: '既定に従う', free: '自由（フル錬成）', owned: '所持リストから', fixed: '固定', none: '錬成なし' };

let D = null; // ゲームデータ
let S = null; // 保存する状態
let worker = null;

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('ja-JP') : '-');
const skillName = (k) => (D.skills[k] ? D.skills[k].name : k);
const opt = (v, label, sel) => `<option value="${esc(v)}"${String(v) === String(sel) ? ' selected' : ''}>${esc(label)}</option>`;

function defaultState() {
  return {
    build: {
      weapon: { id: null, locked: true },
      parts: Object.fromEntries(PARTS.map((p) => [p, { id: null, grade: null, drift: 'gear', fixed: [], locked: false }])),
    },
    gear: { armor: {}, weapons: {} },
    settings: { rates: {}, elemWeakMul: 1, extraAtk: 0, hpBonus: 0, defaultGrade: 10, defaultDrift: 'free', freeKinds: null },
    search: { type: 'LONG_SWORD', element: 'ANY', required: [], driftPolicy: 'gear', ownedOnly: false, topN: 30, useBuildLocks: true },
    ui: { tab: 'build', gearPart: 'head', gearFilter: '', gearOwnedOnly: false, gearKind: 'armor', gearWeaponType: 'LONG_SWORD', rateType: 'LONG_SWORD' },
  };
}

function load() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { saved = null; }
  const base = defaultState();
  if (!saved) return base;
  return {
    build: { ...base.build, ...saved.build, parts: { ...base.build.parts, ...(saved.build && saved.build.parts) } },
    gear: { ...base.gear, ...saved.gear },
    settings: { ...base.settings, ...saved.settings },
    search: { ...base.search, ...saved.search },
    ui: { ...base.ui, ...saved.ui },
  };
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch { /* 保存できない環境では無視 */ }
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---- 装備の解決 -----------------------------------------------------------------

function weaponGear(id) { return S.gear.weapons[id] || {}; }
function armorGear(id) { return S.gear.armor[id] || {}; }

function resolvedWeapon(id) {
  const w = D.weaponById[id];
  if (!w) return null;
  const g = weaponGear(id);
  return resolveWeapon(w, g.grade || S.settings.defaultGrade, g.sub || 5, g.style || null);
}

// 防具1つの「計算用オプション」。policy: 'gear' | 'full' | 'none'
function armorOption(id, grade, policy = 'gear', override = null) {
  const a = D.armorById[id];
  if (!a) return null;
  const g = armorGear(id);
  const r = resolveArmor(a, grade || g.grade || S.settings.defaultGrade);
  let drift;
  if (override && override.mode) drift = override;
  else if (policy === 'full') drift = { mode: 'free' };
  else if (policy === 'none') drift = { mode: 'none' };
  else {
    const mode = !g.mode || g.mode === 'default' ? S.settings.defaultDrift : g.mode;
    drift = { mode, tokens: g.tokens || [], fixed: g.fixed || [] };
  }
  return { ...r, drift };
}

function calcSettings(type) {
  return {
    rates: { ...(S.settings.rates[type] || {}) },
    elemWeakMul: Number.isFinite(Number(S.settings.elemWeakMul)) ? Number(S.settings.elemWeakMul) : 1,
    extraAtk: Number(S.settings.extraAtk) || 0,
    hpBonus: Number(S.settings.hpBonus) || 0,
  };
}
function freeKinds() {
  return S.settings.freeKinds ? new Set(S.settings.freeKinds) : D.driftable;
}

// ---- 共通UI部品 -------------------------------------------------------------------

function skillOptions(selected, { driftFirst = true, damageOnly = false } = {}) {
  const kinds = Object.keys(D.skills).filter((k) => !damageOnly || SKILL_EFFECTS[k]);
  kinds.sort((a, b) => {
    if (driftFirst) {
      const da = D.driftable.has(a) ? 0 : 1;
      const db = D.driftable.has(b) ? 0 : 1;
      if (da !== db) return da - db;
    }
    return (D.skills[a].sort || 0) - (D.skills[b].sort || 0);
  });
  let html = '';
  let group = null;
  for (const k of kinds) {
    const g = driftFirst ? (D.driftable.has(k) ? '錬成で付くスキル' : 'その他のスキル') : '';
    if (g !== group) { if (group !== null) html += '</optgroup>'; html += `<optgroup label="${esc(g || 'スキル')}">`; group = g; }
    html += opt(k, D.skills[k].name, selected);
  }
  return html + '</optgroup>';
}

function skillChips(pairs, cls = '') {
  return pairs.map(([k, lv]) => `<span class="chip ${cls}">${esc(skillName(k))} ${lv}</span>`).join('');
}

// 錬成リスト（[[kind, n], ...]）の編集UI
function driftListEditor(list, dataAttr, unit) {
  const rows = list.map(([k, n], i) => `
    <div class="row">
      <select data-${dataAttr}-kind="${i}">${skillOptions(k)}</select>
      <input type="number" min="1" max="5" class="narrow" value="${n}" data-${dataAttr}-n="${i}"> ${unit}
      <button class="small" data-${dataAttr}-del="${i}">削除</button>
    </div>`).join('');
  return `${rows}<button class="small" data-${dataAttr}-add="1">＋ スキルを追加</button>`;
}
function bindDriftListEditor(root, dataAttr, list, onChange) {
  root.querySelectorAll(`[data-${dataAttr}-kind]`).forEach((el) => el.addEventListener('change', () => { list[+el.dataset[camel(dataAttr) + 'Kind']][0] = el.value; onChange(); }));
  root.querySelectorAll(`[data-${dataAttr}-n]`).forEach((el) => el.addEventListener('change', () => { list[+el.dataset[camel(dataAttr) + 'N']][1] = Math.max(1, Math.min(5, +el.value || 1)); onChange(); }));
  root.querySelectorAll(`[data-${dataAttr}-del]`).forEach((el) => el.addEventListener('click', () => { list.splice(+el.dataset[camel(dataAttr) + 'Del'], 1); onChange(); }));
  root.querySelectorAll(`[data-${dataAttr}-add]`).forEach((el) => el.addEventListener('click', () => { list.push(['WEAKNESS_EXPLOIT', 1]); onChange(); }));
}
function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

// ---- 構築タブ ---------------------------------------------------------------------

function weaponsOfType(type, element) {
  return D.weapons.filter((w) => w.type === type && (!element || element === 'ANY' || w.element === element));
}

function renderBuild() {
  const root = $('#tab-build');
  const B = S.build;
  const w = B.weapon.id ? D.weaponById[B.weapon.id] : null;
  const type = w ? w.type : S.search.type;
  const elemFilter = B.weapon.elemFilter || 'ANY';
  const wlist = weaponsOfType(type, elemFilter);
  const wg = w ? weaponGear(w.id) : {};
  const rw = w ? resolvedWeapon(w.id) : null;

  let html = `<div class="card">
    <div class="slot">
      <div class="head"><b>武器</b>
        <label class="inline small"><input type="checkbox" id="b-wlock" ${B.weapon.locked ? 'checked' : ''}> 検索で固定</label></div>
      <div class="row">
        <label>武器種<select id="b-wtype">${Object.entries(WEAPON_TYPES).map(([k, v]) => opt(k, v, type)).join('')}</select></label>
        <label>属性<select id="b-welem">${opt('ANY', 'すべて', elemFilter)}${Object.entries(ELEMENTS).map(([k, v]) => opt(k, v, elemFilter)).join('')}</select></label>
      </div>
      <div class="row" style="margin-top:6px">
        <select id="b-weapon" class="equip">${opt('', '（武器を選択）', B.weapon.id || '')}${wlist.map((x) => opt(x.id, `${x.name}（${ELEMENTS[x.element]}）`, B.weapon.id)).join('')}</select>
      </div>`;
  if (w) {
    html += `<div class="row" style="margin-top:6px">
        <label>グレード<select id="b-wgrade">${gradesOf(w).map((g) => opt(g, g, rw.grade)).join('')}</select></label>
        <label>段階<select id="b-wsub">${[1, 2, 3, 4, 5].map((s) => opt(s, s, wg.sub || 5)).join('')}</select></label>
        <label class="inline"><input type="checkbox" id="b-wowned" ${wg.owned ? 'checked' : ''}> 所持</label>
      </div>`;
    if (w.style) {
      const st = wg.style || {};
      html += `<div class="row" style="margin-top:6px">
        <label>スタイル強化Lv<input type="number" min="0" max="20" id="b-st-level" value="${st.level || 0}" class="narrow"></label>
        <label>攻撃+<input type="number" id="b-st-atk" value="${st.atk || 0}"></label>
        <label>属性+<input type="number" id="b-st-elem" value="${st.elem || 0}"></label>
        <label>会心+%<input type="number" id="b-st-crit" value="${st.crit || 0}" class="narrow"></label>
      </div><p class="note">スタイル強化の上昇値はゲーム画面の合計値を入力してください（強化Lvはスキル解放の判定に使います）。</p>`;
    }
    html += `<div class="skills">攻撃 <b>${rw.atk}</b>　属性 <b>${rw.elem}</b>　会心 <b>${rw.crit}%</b><br>${skillChips(rw.skills)}${rw.lockedSkills.map(([k, lv, req]) => `<span class="chip off">${esc(skillName(k))} ${lv}（スタイルLv${req}で解放）</span>`).join('')}</div>`;
  }
  html += '</div></div><div class="grid2">';

  for (const part of PARTS) {
    const P = B.parts[part];
    const list = D.armor.filter((a) => a.part === part);
    const a = P.id ? D.armorById[P.id] : null;
    const grade = P.grade || (a ? armorGear(a.id).grade || S.settings.defaultGrade : S.settings.defaultGrade);
    const o = a ? armorOption(a.id, grade, 'gear', P.drift === 'gear' ? null : (P.drift === 'fixed' ? { mode: 'fixed', fixed: P.fixed } : { mode: P.drift })) : null;
    html += `<div class="slot" data-part="${part}">
      <div class="head"><b>${PART_NAMES[part]}</b>
        <label class="inline small"><input type="checkbox" data-plock="${part}" ${P.locked ? 'checked' : ''}> 検索で固定</label></div>
      <select class="equip" data-parmor="${part}">${opt('', '（なし）', P.id || '')}${list.map((x) => opt(x.id, `${x.name}${armorGear(x.id).owned ? ' ★' : ''}`, P.id)).join('')}</select>`;
    if (a) {
      html += `<div class="row" style="margin-top:6px">
        <label>グレード<select data-pgrade="${part}">${gradesOf(a).map((g) => opt(g, g, o.grade)).join('')}</select></label>
        <label>錬成<select data-pdrift="${part}">${opt('gear', '所持・錬成タブの設定', P.drift)}${opt('free', '自由（フル錬成）', P.drift)}${opt('fixed', 'この構築で指定', P.drift)}${opt('none', '錬成なし', P.drift)}</select></label>
      </div>
      <div class="skills">${skillChips(o.skills)} <span class="muted small">錬成枠 ${o.slots}</span></div>`;
      if (P.drift === 'fixed') {
        html += `<div class="drift-edit" data-fixed-part="${part}">${driftListEditor(P.fixed, `bf-${part}`, 'Lv')}<p class="note">錬成枠 ${o.slots} を超えた分は計算に入りません。</p></div>`;
      } else if (P.drift === 'gear') {
        html += `<div class="note">錬成: ${esc(DRIFT_MODES[armorGear(a.id).mode || 'default'])}${(armorGear(a.id).mode || 'default') === 'default' ? `（${esc(DRIFT_MODES[S.settings.defaultDrift])}）` : ''}</div>`;
      }
    }
    html += '</div>';
  }
  html += '</div>';
  html += '<div class="card" id="b-result"></div>';
  html += `<div class="row"><button class="primary" id="b-search">固定していない部位を検索で埋める</button>
    <button id="b-clear">構築をクリア</button></div>`;
  root.innerHTML = html;

  // イベント
  $('#b-wtype').addEventListener('change', (e) => { S.search.type = e.target.value; B.weapon.id = null; save(); renderBuild(); });
  $('#b-welem').addEventListener('change', (e) => { B.weapon.elemFilter = e.target.value; save(); renderBuild(); });
  $('#b-weapon').addEventListener('change', (e) => { B.weapon.id = e.target.value || null; save(); renderBuild(); });
  $('#b-wlock').addEventListener('change', (e) => { B.weapon.locked = e.target.checked; save(); });
  if (w) {
    const setG = (k, v) => { S.gear.weapons[w.id] = { ...weaponGear(w.id), [k]: v }; save(); renderBuild(); };
    $('#b-wgrade').addEventListener('change', (e) => setG('grade', +e.target.value));
    $('#b-wsub').addEventListener('change', (e) => setG('sub', +e.target.value));
    $('#b-wowned').addEventListener('change', (e) => setG('owned', e.target.checked));
    if (w.style) {
      for (const k of ['level', 'atk', 'elem', 'crit']) {
        $(`#b-st-${k}`).addEventListener('change', (e) => setG('style', { ...(weaponGear(w.id).style || {}), [k]: Number(e.target.value) || 0 }));
      }
    }
  }
  root.querySelectorAll('[data-plock]').forEach((el) => el.addEventListener('change', () => { B.parts[el.dataset.plock].locked = el.checked; save(); }));
  root.querySelectorAll('[data-parmor]').forEach((el) => el.addEventListener('change', () => {
    const P = B.parts[el.dataset.parmor];
    P.id = el.value || null; P.grade = null; save(); renderBuild();
  }));
  root.querySelectorAll('[data-pgrade]').forEach((el) => el.addEventListener('change', () => { B.parts[el.dataset.pgrade].grade = +el.value; save(); renderBuild(); }));
  root.querySelectorAll('[data-pdrift]').forEach((el) => el.addEventListener('change', () => { B.parts[el.dataset.pdrift].drift = el.value; save(); renderBuild(); }));
  root.querySelectorAll('[data-fixed-part]').forEach((box) => {
    const part = box.dataset.fixedPart;
    bindDriftListEditor(box, `bf-${part}`, B.parts[part].fixed, () => { save(); renderBuild(); });
  });
  $('#b-search').addEventListener('click', () => { S.search.useBuildLocks = true; switchTab('search'); runSearch(); });
  $('#b-clear').addEventListener('click', () => { S.build = defaultState().build; save(); renderBuild(); });

  renderBuildResult();
}

function currentBuildPieces() {
  const pieces = {};
  for (const part of PARTS) {
    const P = S.build.parts[part];
    if (!P.id) continue;
    const ov = P.drift === 'gear' ? null : (P.drift === 'fixed' ? { mode: 'fixed', fixed: P.fixed } : { mode: P.drift });
    pieces[part] = armorOption(P.id, P.grade, 'gear', ov);
  }
  return pieces;
}

function renderBuildResult() {
  const box = $('#b-result');
  if (!S.build.weapon.id) { box.innerHTML = '<p class="muted">武器を選ぶと期待値を計算します。防具は空欄のままでも計算できます。</p>'; return; }
  const weapon = resolvedWeapon(S.build.weapon.id);
  const pieces = currentBuildPieces();
  const settings = calcSettings(weapon.type);
  const ctx = {
    skillDefs: D.skills, settings, required: {}, freeKinds: freeKinds(),
    relevantKinds: Object.keys(SKILL_EFFECTS).filter((k) => isRelevant(k, weapon, settings)),
  };
  const r = evaluateBuild(weapon, pieces, ctx);
  box.innerHTML = buildSummaryHtml(weapon, pieces, r);
}

function buildSummaryHtml(weapon, pieces, r) {
  const res = r.result;
  const usedSlots = r.drifts.reduce((s, d) => s + d.lv, 0);
  const driftByPiece = {};
  for (const d of r.drifts) (driftByPiece[d.pieceId] = driftByPiece[d.pieceId] || []).push([d.kind, d.lv]);
  const levels = Object.entries(r.levels).sort((a, b) => (D.skills[a[0]] ? D.skills[a[0]].sort : 0) - (D.skills[b[0]] ? D.skills[b[0]].sort : 0));
  const driftRaw = {};
  for (const d of r.drifts) driftRaw[d.kind] = (driftRaw[d.kind] || 0) + d.lv;
  let html = `<div class="row" style="justify-content:space-between"><div><div class="muted small">期待値（モーション値100・肉質100あたり）</div><div class="big">${fmt(res.expected)}</div></div>
    <div class="small muted">錬成 ${usedSlots}/${r.slotsTotal} 枠</div></div>
    <div class="stats">
      <div><span>物理</span><b>${fmt(res.phys)}</b></div>
      <div><span>属性（通常/会心）</span><b>${fmt(res.elemNorm)} / ${fmt(res.elemCrit)}</b></div>
      <div><span>会心率</span><b>${res.critRate.toFixed(1)}%</b></div>
      <div><span>会心倍率</span><b>${(res.critMul / 100).toFixed(2)}倍</b></div>
      <div><span>与ダメージ補正</span><b>+${res.dmgPct.toFixed(1)}%</b></div>
      <div><span>通常 / 会心ヒット</span><b>${fmt(res.normal)} / ${fmt(res.critHit)}</b></div>
    </div>
    <h3>発動スキル</h3><div>`;
  html += levels.map(([k, lv]) => {
    const dr = driftRaw[k] ? `<span class="chip drift">錬成+${driftRaw[k]}</span>` : '';
    const dmg = SKILL_EFFECTS[k] ? '' : ' style="opacity:.7"';
    return `<span class="chip"${dmg}>${esc(skillName(k))} Lv${lv}</span>${dr}`;
  }).join('') || '<span class="muted">なし</span>';
  html += '</div>';
  if (r.drifts.length) {
    html += '<h3>錬成の割り当て</h3><div class="small">';
    for (const part of PARTS) {
      const p = pieces[part];
      if (!p || !driftByPiece[p.id]) continue;
      html += `<div>${PART_NAMES[part]} ${esc(p.name)}: ${skillChips(driftByPiece[p.id], 'drift')}</div>`;
    }
    html += '</div>';
  }
  if (Object.keys(r.unmet || {}).length) {
    html += `<div class="warnbox">必須スキルが不足: ${Object.entries(r.unmet).map(([k, n]) => `${esc(skillName(k))} あと${n}`).join('、')}</div>`;
  }
  html += `<details><summary class="small">計算の内訳</summary><table class="list"><tr><th>スキル</th><th>項</th><th>寄与（発動率込み）</th></tr>${res.contrib.map((c) => `<tr><td>${esc(skillName(c.kind))}</td><td>${TERM_LABEL[c.term] || c.term}</td><td class="num">${c.value.toFixed(1)}</td></tr>`).join('')}</table></details>`;
  return html;
}

const TERM_LABEL = {
  atkPct: '攻撃力%', atkFlat: '攻撃力+', atkActive: '攻撃活性%', dmgPct: '与ダメージ%', crit: '会心率%',
  elemFlat: '属性+', elemPct: '属性%', critElem: '会心時属性%', elder: '古龍属性%',
};

// ---- 検索タブ ---------------------------------------------------------------------

function renderSearch() {
  const root = $('#tab-search');
  const Q = S.search;
  const lockInfo = [];
  if (Q.useBuildLocks) {
    if (S.build.weapon.locked && S.build.weapon.id) lockInfo.push(`武器: ${D.weaponById[S.build.weapon.id].name}`);
    for (const p of PARTS) if (S.build.parts[p].locked && S.build.parts[p].id) lockInfo.push(`${PART_NAMES[p]}: ${D.armorById[S.build.parts[p].id].name}`);
  }
  root.innerHTML = `<div class="card">
    <div class="row">
      <label>武器種<select id="s-type">${Object.entries(WEAPON_TYPES).map(([k, v]) => opt(k, v, Q.type)).join('')}</select></label>
      <label>属性<select id="s-elem">${opt('ANY', 'すべて', Q.element)}${Object.entries(ELEMENTS).map(([k, v]) => opt(k, v, Q.element)).join('')}</select></label>
      <label>錬成<select id="s-drift">${opt('gear', '防具ごとの設定に従う', Q.driftPolicy)}${opt('full', '全防具フル錬成', Q.driftPolicy)}${opt('none', '錬成なし', Q.driftPolicy)}</select></label>
      <label>表示件数<input type="number" id="s-top" min="5" max="100" value="${Q.topN}" class="narrow"></label>
    </div>
    <div class="row" style="margin-top:6px">
      <label class="inline"><input type="checkbox" id="s-owned" ${Q.ownedOnly ? 'checked' : ''}> 所持装備だけで探す</label>
      <label class="inline"><input type="checkbox" id="s-locks" ${Q.useBuildLocks ? 'checked' : ''}> 構築タブで「固定」した装備を使う</label>
    </div>
    ${Q.useBuildLocks && lockInfo.length ? `<p class="note">固定中: ${lockInfo.map(esc).join(' / ')}</p>` : ''}
    <h3>必須スキル</h3>
    <div id="s-req">${Q.required.map(([k, lv], i) => `<div class="row"><select data-req-kind="${i}">${skillOptions(k, { driftFirst: false })}</select>
      Lv<input type="number" min="1" max="5" value="${lv}" class="narrow" data-req-lv="${i}"><button class="small" data-req-del="${i}">削除</button></div>`).join('')}
      <button class="small" id="s-req-add">＋ 必須スキルを追加</button>
    </div>
    <p class="note">必須スキルを満たせない場合も結果は空にせず、不足分を表示して下位に並べます。</p>
    <div class="row" style="margin-top:8px"><button class="primary" id="s-run">検索</button><span id="s-status" class="small muted"></span></div>
    <div class="progress"><i id="s-bar"></i></div>
  </div>
  <div id="s-results">${lastResultsHtml || '<p class="muted">条件を指定して検索してください。</p>'}</div>`;

  const set = (k, v) => { Q[k] = v; save(); };
  $('#s-type').addEventListener('change', (e) => set('type', e.target.value));
  $('#s-elem').addEventListener('change', (e) => set('element', e.target.value));
  $('#s-drift').addEventListener('change', (e) => set('driftPolicy', e.target.value));
  $('#s-top').addEventListener('change', (e) => set('topN', Math.max(5, Math.min(100, +e.target.value || 30))));
  $('#s-owned').addEventListener('change', (e) => set('ownedOnly', e.target.checked));
  $('#s-locks').addEventListener('change', (e) => { set('useBuildLocks', e.target.checked); renderSearch(); });
  root.querySelectorAll('[data-req-kind]').forEach((el) => el.addEventListener('change', () => { Q.required[+el.dataset.reqKind][0] = el.value; save(); }));
  root.querySelectorAll('[data-req-lv]').forEach((el) => el.addEventListener('change', () => { Q.required[+el.dataset.reqLv][1] = Math.max(1, Math.min(5, +el.value || 1)); save(); }));
  root.querySelectorAll('[data-req-del]').forEach((el) => el.addEventListener('click', () => { Q.required.splice(+el.dataset.reqDel, 1); save(); renderSearch(); }));
  $('#s-req-add').addEventListener('click', () => { Q.required.push(['LOCK_ON', 1]); save(); renderSearch(); });
  $('#s-run').addEventListener('click', runSearch);
  bindResultButtons();
}

let lastResults = [];
let lastResultsHtml = '';

function buildSearchInput() {
  const Q = S.search;
  const B = S.build;
  let weapons;
  if (Q.useBuildLocks && B.weapon.locked && B.weapon.id) {
    weapons = [resolvedWeapon(B.weapon.id)];
  } else {
    weapons = weaponsOfType(Q.type, Q.element)
      .filter((w) => !Q.ownedOnly || weaponGear(w.id).owned)
      .map((w) => resolvedWeapon(w.id));
  }
  const partOptions = {};
  for (const part of PARTS) {
    const P = B.parts[part];
    if (Q.useBuildLocks && P.locked && P.id) {
      const ov = P.drift === 'gear' ? null : (P.drift === 'fixed' ? { mode: 'fixed', fixed: P.fixed } : { mode: P.drift });
      partOptions[part] = [armorOption(P.id, P.grade, Q.driftPolicy, ov)];
      continue;
    }
    partOptions[part] = D.armor
      .filter((a) => a.part === part && (!Q.ownedOnly || armorGear(a.id).owned))
      .map((a) => armorOption(a.id, armorGear(a.id).owned ? armorGear(a.id).grade : S.settings.defaultGrade, Q.driftPolicy));
  }
  const type = weapons[0] ? weapons[0].type : Q.type;
  return {
    weapons,
    partOptions,
    settings: calcSettings(type),
    required: Object.fromEntries(Q.required.map(([k, lv]) => [k, lv])),
    freeKinds: [...freeKinds()],
    topN: Q.topN,
    timeLimitMs: 25000,
  };
}

function runSearch() {
  const input = buildSearchInput();
  const status = $('#s-status');
  const bar = $('#s-bar');
  if (!input.weapons.length) { status.textContent = '対象の武器がありません（所持のみ検索の場合は所持登録を確認してください）'; return; }
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
      lastResults = m.results;
      status.textContent = `${m.evaluated.toLocaleString()} 通りを評価（${(m.elapsed / 1000).toFixed(1)}秒）${m.timedOut ? '・時間切れのため途中までの結果' : ''}${m.approximated ? '・候補を絞って探索（近似）' : ''}`;
      lastResultsHtml = resultsHtml(m.results);
      $('#s-results').innerHTML = lastResultsHtml;
      bindResultButtons();
      worker.terminate(); worker = null;
    } else if (m.type === 'error') {
      btn.disabled = false;
      status.textContent = `エラー: ${m.message}`;
    }
  };
  worker.postMessage(input);
}

function resultsHtml(results) {
  if (!results.length) return '<p class="warnbox">候補の装備がありません。所持のみ検索の場合は「所持・錬成」タブで所持登録してください。</p>';
  return results.map((r, i) => {
    const driftByPiece = {};
    for (const d of r.drifts) (driftByPiece[d.pieceId] = driftByPiece[d.pieceId] || []).push([d.kind, d.lv]);
    const unmet = Object.entries(r.unmet || {});
    const top = Object.entries(r.levels).filter(([k]) => SKILL_EFFECTS[k] || S.search.required.some((x) => x[0] === k))
      .sort((a, b) => (D.skills[a[0]] ? D.skills[a[0]].sort : 0) - (D.skills[b[0]] ? D.skills[b[0]].sort : 0));
    return `<div class="result">
      <div class="top"><div><span class="rank">#${i + 1}</span><span class="val">${fmt(r.damage)}</span> <span class="small muted">会心 ${r.critRate.toFixed(0)}%</span></div>
        <button class="small" data-apply="${i}">構築に反映</button></div>
      <div class="pieces">
        <div>武器: <b>${esc(r.weapon.name)}</b> <span class="muted small">${r.weapon.grade}-${r.weapon.sub}</span></div>
        ${PARTS.filter((p) => r.pieces[p]).map((p) => {
    const x = r.pieces[p];
    const alt = x.alternatives && x.alternatives.length ? ` <span class="muted small">（同等: ${x.alternatives.slice(0, 3).map(esc).join('、')}${x.alternatives.length > 3 ? ' 他' : ''}）</span>` : '';
    return `<div>${PART_NAMES[p]}: ${esc(x.name)} <span class="muted small">G${x.grade}</span>${alt} ${driftByPiece[x.id] ? skillChips(driftByPiece[x.id], 'drift') : ''}</div>`;
  }).join('')}
      </div>
      <div>${top.map(([k, lv]) => `<span class="chip">${esc(skillName(k))} ${lv}</span>`).join('')}</div>
      ${unmet.length ? `<div class="warnbox">必須スキル不足: ${unmet.map(([k, n]) => `${esc(skillName(k))} あと${n}`).join('、')}</div>` : ''}
    </div>`;
  }).join('');
}

function bindResultButtons() {
  document.querySelectorAll('[data-apply]').forEach((el) => el.addEventListener('click', () => {
    const r = lastResults[+el.dataset.apply];
    if (!r) return;
    const B = S.build;
    B.weapon.id = r.weapon.id;
    for (const part of PARTS) {
      const x = r.pieces[part];
      const P = B.parts[part];
      if (!x) continue;
      P.id = x.id;
      P.grade = x.grade;
      // 割り当てられた錬成をそのまま固定して再現する
      const ds = r.drifts.filter((d) => d.pieceId === x.id);
      if (x.drift && x.drift.mode === 'fixed') { P.drift = 'fixed'; P.fixed = (x.drift.fixed || []).map((f) => f.slice()); } else if (ds.length) { P.drift = 'fixed'; P.fixed = ds.map((d) => [d.kind, d.lv]); } else { P.drift = 'none'; P.fixed = []; }
    }
    save();
    switchTab('build');
    toast('構築に反映しました（錬成は「この構築で指定」に固定）');
  }));
}

// ---- 所持・錬成タブ -----------------------------------------------------------------

function renderGear() {
  const root = $('#tab-gear');
  const U = S.ui;
  let html = `<div class="card">
    <p class="note">所持している装備のグレードと、各防具に付いている錬成スキルを登録できます。
      「所持リストから」にすると、その防具はリストにある錬成スキルだけを使って計算・検索します（例:「この頭には弱点特効を2つ付けられる」）。</p>
    <div class="row">
      <label>種類<select id="g-kind">${opt('armor', '防具', U.gearKind)}${opt('weapon', '武器', U.gearKind)}</select></label>
      ${U.gearKind === 'armor'
    ? `<label>部位<select id="g-part">${PARTS.map((p) => opt(p, PART_NAMES[p], U.gearPart)).join('')}${opt('all', 'すべて', U.gearPart)}</select></label>`
    : `<label>武器種<select id="g-wtype">${Object.entries(WEAPON_TYPES).map(([k, v]) => opt(k, v, U.gearWeaponType)).join('')}</select></label>`}
      <label>名前で絞り込み<input type="search" id="g-filter" value="${esc(U.gearFilter)}" placeholder="例: レウス"></label>
      <label class="inline"><input type="checkbox" id="g-owned" ${U.gearOwnedOnly ? 'checked' : ''}> 所持のみ</label>
    </div></div><div class="card" id="g-list"></div>`;
  root.innerHTML = html;
  $('#g-kind').addEventListener('change', (e) => { U.gearKind = e.target.value; save(); renderGear(); });
  if ($('#g-part')) $('#g-part').addEventListener('change', (e) => { U.gearPart = e.target.value; save(); renderGearList(); });
  if ($('#g-wtype')) $('#g-wtype').addEventListener('change', (e) => { U.gearWeaponType = e.target.value; save(); renderGearList(); });
  $('#g-filter').addEventListener('input', (e) => { U.gearFilter = e.target.value; save(); renderGearList(); });
  $('#g-owned').addEventListener('change', (e) => { U.gearOwnedOnly = e.target.checked; save(); renderGearList(); });
  renderGearList();
}

const openDrift = new Set();

function renderGearList() {
  const U = S.ui;
  const box = $('#g-list');
  const q = U.gearFilter.trim();
  if (U.gearKind === 'weapon') {
    const list = D.weapons.filter((w) => w.type === U.gearWeaponType && (!q || w.name.includes(q) || w.series.includes(q)) && (!U.gearOwnedOnly || weaponGear(w.id).owned));
    box.innerHTML = list.map((w) => {
      const g = weaponGear(w.id);
      return `<div class="gear-item"><div class="line">
        <label class="inline"><input type="checkbox" data-wown="${w.id}" ${g.owned ? 'checked' : ''}></label>
        <span class="name">${esc(w.name)} <span class="muted small">${esc(ELEMENTS[w.element])}${w.style ? '・スタイル強化' : ''}</span></span>
        <label class="small">G<select data-wgrade="${w.id}">${gradesOf(w).map((x) => opt(x, x, g.grade || S.settings.defaultGrade)).join('')}</select></label>
        <label class="small">段階<select data-wsub="${w.id}">${[1, 2, 3, 4, 5].map((x) => opt(x, x, g.sub || 5)).join('')}</select></label>
      </div></div>`;
    }).join('') || '<p class="muted">該当なし</p>';
    box.querySelectorAll('[data-wown]').forEach((el) => el.addEventListener('change', () => { S.gear.weapons[el.dataset.wown] = { ...weaponGear(el.dataset.wown), owned: el.checked }; save(); }));
    box.querySelectorAll('[data-wgrade]').forEach((el) => el.addEventListener('change', () => { S.gear.weapons[el.dataset.wgrade] = { ...weaponGear(el.dataset.wgrade), grade: +el.value }; save(); }));
    box.querySelectorAll('[data-wsub]').forEach((el) => el.addEventListener('change', () => { S.gear.weapons[el.dataset.wsub] = { ...weaponGear(el.dataset.wsub), sub: +el.value }; save(); }));
    return;
  }
  const list = D.armor.filter((a) => (U.gearPart === 'all' || a.part === U.gearPart) && (!q || a.name.includes(q) || a.series.includes(q)) && (!U.gearOwnedOnly || armorGear(a.id).owned));
  box.innerHTML = list.map((a) => {
    const g = armorGear(a.id);
    const grade = g.grade || S.settings.defaultGrade;
    const r = resolveArmor(a, grade);
    const mode = g.mode || 'default';
    let html = `<div class="gear-item"><div class="line">
      <label class="inline"><input type="checkbox" data-aown="${a.id}" ${g.owned ? 'checked' : ''}></label>
      <span class="name">${esc(a.name)} <span class="muted small">${PART_NAMES[a.part]}</span></span>
      <label class="small">G<select data-agrade="${a.id}">${gradesOf(a).map((x) => opt(x, x, r.grade)).join('')}</select></label>
      <label class="small">錬成<select data-amode="${a.id}">${Object.entries(DRIFT_MODES).map(([k, v]) => opt(k, v, mode)).join('')}</select></label>
    </div>
    <div class="small">${skillChips(r.skills)} <span class="muted">錬成枠 ${r.slots}</span>
      ${mode === 'owned' && (g.tokens || []).length ? skillChips(g.tokens.map(([k, n]) => [k, `×${n}`]), 'drift') : ''}
      ${mode === 'fixed' && (g.fixed || []).length ? skillChips(g.fixed.map(([k, n]) => [k, `Lv${n}`]), 'drift') : ''}
      ${mode === 'owned' || mode === 'fixed' ? `<button class="link small" data-aopen="${a.id}">${openDrift.has(a.id) ? '閉じる' : '錬成スキルを編集'}</button>` : ''}
    </div>`;
    if (openDrift.has(a.id) && (mode === 'owned' || mode === 'fixed')) {
      const key = mode === 'owned' ? 'tokens' : 'fixed';
      html += `<div class="drift-edit" data-aedit="${a.id}">
        <div class="note">${mode === 'owned' ? 'この防具が持っている錬成スキルと個数（同じスキルを2つ持っていれば×2）。検索時は錬成枠の数まで最適に選びます。' : '実際にセットしている錬成スキル（錬成枠の数まで）。'}</div>
        ${driftListEditor(g[key] || [], `ge-${a.id.toLowerCase().replace(/_/g, '-')}`, mode === 'owned' ? '個' : 'Lv')}</div>`;
    }
    return html + '</div>';
  }).join('') || '<p class="muted">該当なし</p>';

  const setA = (id, k, v) => { S.gear.armor[id] = { ...armorGear(id), [k]: v }; save(); };
  box.querySelectorAll('[data-aown]').forEach((el) => el.addEventListener('change', () => setA(el.dataset.aown, 'owned', el.checked)));
  box.querySelectorAll('[data-agrade]').forEach((el) => el.addEventListener('change', () => { setA(el.dataset.agrade, 'grade', +el.value); renderGearList(); }));
  box.querySelectorAll('[data-amode]').forEach((el) => el.addEventListener('change', () => {
    setA(el.dataset.amode, 'mode', el.value);
    if (el.value === 'owned' || el.value === 'fixed') openDrift.add(el.dataset.amode);
    renderGearList();
  }));
  box.querySelectorAll('[data-aopen]').forEach((el) => el.addEventListener('click', () => {
    const id = el.dataset.aopen;
    if (openDrift.has(id)) openDrift.delete(id); else openDrift.add(id);
    renderGearList();
  }));
  box.querySelectorAll('[data-aedit]').forEach((ed) => {
    const id = ed.dataset.aedit;
    const g = armorGear(id);
    const key = g.mode === 'owned' ? 'tokens' : 'fixed';
    const list2 = (g[key] || []).map((x) => x.slice());
    bindDriftListEditor(ed, `ge-${id.toLowerCase().replace(/_/g, '-')}`, list2, () => { setA(id, key, list2); renderGearList(); });
  });
}

// ---- 設定タブ -----------------------------------------------------------------------

function renderSettings() {
  const root = $('#tab-settings');
  const T = S.settings;
  const type = S.ui.rateType;
  const rates = T.rates[type] || {};
  const conds = conditionalSkills().sort((a, b) => (D.skills[a] ? D.skills[a].sort : 0) - (D.skills[b] ? D.skills[b].sort : 0));
  const fk = freeKinds();
  root.innerHTML = `<div class="card">
    <h2>計算条件</h2>
    <div class="row">
      <label>属性の扱い<select id="t-weak">${opt(1, '弱点を突く（属性値をそのまま加算）', T.elemWeakMul)}${opt(1.5, '弱点を突く（属性値1.5倍）', T.elemWeakMul)}${opt(0, '弱点でない相手（属性値は加算しない）', T.elemWeakMul)}</select></label>
      <label>追加攻撃力（錬成パラメータ等）<input type="number" id="t-extra" value="${T.extraAtk}"></label>
      <label>体力の追加分<input type="number" id="t-hp" value="${T.hpBonus}" class="narrow"></label>
    </div>
    <div class="row" style="margin-top:6px">
      <label>未所持装備のグレード<select id="t-grade">${[5, 6, 7, 8, 9, 10].map((g) => opt(g, g, T.defaultGrade)).join('')}</select></label>
      <label>防具の錬成の既定<select id="t-drift">${opt('free', '自由（フル錬成）', T.defaultDrift)}${opt('none', '錬成なし', T.defaultDrift)}</select></label>
    </div>
    <p class="note">「防具の錬成の既定」は、所持・錬成タブで錬成を「既定に従う」にしている防具に使われます。</p>
  </div>
  <div class="card">
    <h2>条件付きスキルの発動率</h2>
    <p class="note">常時発動しないスキルは「効果量 × 発動率」で期待値に入れます。武器種ごとに設定できます（空欄は既定値）。</p>
    <div class="row"><label>武器種<select id="t-rtype">${Object.entries(WEAPON_TYPES).map(([k, v]) => opt(k, v, type)).join('')}</select></label>
      <button class="small" id="t-rreset">この武器種を既定に戻す</button></div>
    <div class="rate-grid" style="margin-top:8px">${conds.map((k) => {
    const def = defaultRate(k, type);
    const has = rates[k] !== undefined && rates[k] !== '';
    const note = (SKILL_EFFECTS[k].find((e) => e.note) || {}).note;
    return `<label class="${has ? 'changed' : ''}" title="${esc(note || '')}"><span>${esc(skillName(k))}${note ? ' *' : ''}</span>
      <input type="number" min="0" max="100" class="narrow" data-rate="${k}" placeholder="${def}" value="${has ? rates[k] : ''}"></label>`;
  }).join('')}</div>
    <p class="note">* 付きは補足あり（項目に触れると表示）。</p>
  </div>
  <div class="card">
    <h2>自由錬成で付けられるスキル</h2>
    <p class="note">「自由（フル錬成）」の防具に付ける候補です。既定は公式の漂流石・漂流純石から付くスキルすべて。</p>
    <div class="rate-grid">${[...D.driftable].filter((k) => SKILL_EFFECTS[k]).sort((a, b) => D.skills[a].sort - D.skills[b].sort).map((k) => `<label class="inline"><input type="checkbox" data-fk="${k}" ${fk.has(k) ? 'checked' : ''}> ${esc(skillName(k))}</label>`).join('')}</div>
    <div class="row" style="margin-top:6px"><button class="small" id="t-fk-reset">すべてに戻す</button></div>
  </div>
  <div class="card">
    <h2>バックアップ</h2>
    <div class="row"><button id="t-export">書き出し（コピー）</button><button id="t-import">読み込み</button></div>
    <textarea id="t-json" rows="4" style="width:100%;margin-top:6px" placeholder="ここに書き出したJSONを貼り付けて「読み込み」"></textarea>
  </div>
  <div class="card small">
    <h2>データと計算の前提</h2>
    <p>装備・スキルの数値: <a href="${esc(D.meta.source)}" target="_blank" rel="noopener">モンハンNow公式サイト</a> の武器・防具・スキル一覧（取得日時 ${esc(D.meta.fetched_at)}）。武器 ${D.meta.weapons} / 防具 ${D.meta.armor} / スキル ${D.meta.skills}。</p>
    <ul>
      <li>期待値はモーション値100・肉質100あたり。武器種固有の補正は入れていないので、比較は同じ武器種どうしで行ってください。</li>
      <li>攻撃力%系（連撃・火事場力など）は武器攻撃力に、与ダメージ%系（闇討ち・不退転など）は最終値に掛け、それぞれ同じ系統どうしは加算しています。</li>
      <li>属性値は弱点属性の相手にのみ攻撃力へ加算される、というコミュニティの検証に基づき、既定では「弱点を突く」前提で属性値を加算します（倍率は上の「属性の扱い」で変更）。属性肉質は無い前提です。</li>
      <li>ハイチャージは「体力 × 倍率」を属性値に加算（体力満タン時。体力増強の分を含む）。</li>
      <li>会心倍率は基本1.25倍（超会心で上書き）、マイナス会心は0.75倍。</li>
      <li>錬成は 1枠 = スキル1Lv。防具ごとの錬成枠数はグレードで変わります（公式データ）。</li>
      <li>尻上がり・追い打ち【爆破】・凶会心の効果量の解釈は公式データの数値からの推定です。実機と合わない場合は発動率で調整してください。</li>
    </ul>
  </div>`;

  const set = (k, v) => { T[k] = v; save(); };
  $('#t-weak').addEventListener('change', (e) => set('elemWeakMul', Number(e.target.value)));
  $('#t-extra').addEventListener('change', (e) => set('extraAtk', +e.target.value || 0));
  $('#t-hp').addEventListener('change', (e) => set('hpBonus', +e.target.value || 0));
  $('#t-grade').addEventListener('change', (e) => set('defaultGrade', +e.target.value));
  $('#t-drift').addEventListener('change', (e) => set('defaultDrift', e.target.value));
  $('#t-rtype').addEventListener('change', (e) => { S.ui.rateType = e.target.value; save(); renderSettings(); });
  $('#t-rreset').addEventListener('click', () => { delete T.rates[type]; save(); renderSettings(); });
  root.querySelectorAll('[data-rate]').forEach((el) => el.addEventListener('change', () => {
    T.rates[type] = { ...(T.rates[type] || {}) };
    if (el.value === '') delete T.rates[type][el.dataset.rate];
    else T.rates[type][el.dataset.rate] = Math.max(0, Math.min(100, +el.value));
    save(); renderSettings();
  }));
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

const RENDER = { build: renderBuild, search: renderSearch, gear: renderGear, settings: renderSettings };
function switchTab(tab) {
  S.ui.tab = tab;
  save();
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== `tab-${tab}`; });
  RENDER[tab]();
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
  switchTab(S.ui.tab || 'build');
}

main();

export { maxGrade };
