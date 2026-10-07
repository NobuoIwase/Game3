// 画面部品（アイコン・シート）
import { ELEMENTS, WEAPON_TYPES } from './model.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 公式サイトの画像URL（googleusercontent）はサイズ指定ができる
export const sized = (url, px = 64) => (url ? `${url}=s${px}` : '');

export function img(url, cls = 'ico', alt = '') {
  if (!url) return `<span class="${cls} ico-none"></span>`;
  return `<img class="${cls}" src="${esc(sized(url, 96))}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`;
}

// 属性アイコン（独自デザイン: 色付きの丸に一文字）
const ELEM_STYLE = {
  ANY: ['全', '#6b7280'],
  NO_ELEMENT: ['無', '#8a8f98'],
  FIRE: ['火', '#e0452b'],
  WATER: ['水', '#2b7de0'],
  THUNDER: ['雷', '#d8a60a'],
  ICE: ['氷', '#39b6d6'],
  DRAGON: ['龍', '#8b3fb8'],
  POISON: ['毒', '#9c4fc4'],
  PARALYSIS: ['麻', '#c9a50f'],
  SLEEP: ['眠', '#5a7fb8'],
  BLAST: ['爆', '#d0742a'],
};
export function elemIcon(el, size = 'm') {
  const [ch, color] = ELEM_STYLE[el] || ['?', '#888'];
  return `<span class="elem elem-${size}" style="--c:${color}" title="${esc(ELEMENTS[el] || 'すべて')}">${ch}</span>`;
}

// 武器種アイコン: その武器種の鉱石シリーズ武器の公式画像
export function weaponTypeIcon(D, type, cls = 'ico') {
  const w = D.weapons.find((x) => x.type === type && x.id.startsWith('ORE_')) || D.weapons.find((x) => x.type === type);
  return img(w && w.img, cls, WEAPON_TYPES[type]);
}

// 防具アイコン: モンスターのアイコン（無ければ防具画像）
export const armorIcon = (a, cls = 'ico') => img(a && (a.mon || a.img), cls, a && a.name);
export const weaponIcon = (w, cls = 'ico') => img(w && w.img, cls, w && w.name);

// ---- ボトムシート ----
let sheetOnClose = null;
export function openSheet(title, html, bind, onClose) {
  let root = document.getElementById('sheet');
  if (!root) {
    root = document.createElement('div');
    root.id = 'sheet';
    root.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet-panel" role="dialog" aria-modal="true">
      <div class="sheet-head"><b class="sheet-title"></b><button class="sheet-close" aria-label="閉じる">×</button></div>
      <div class="sheet-body"></div></div>`;
    document.body.appendChild(root);
    root.querySelector('.sheet-backdrop').addEventListener('click', closeSheet);
    root.querySelector('.sheet-close').addEventListener('click', closeSheet);
  }
  root.querySelector('.sheet-title').textContent = title;
  const body = root.querySelector('.sheet-body');
  body.innerHTML = html;
  root.classList.add('open');
  document.body.classList.add('noscroll');
  sheetOnClose = onClose || null;
  if (bind) bind(body);
  return body;
}
export function closeSheet() {
  const root = document.getElementById('sheet');
  if (!root) return;
  root.classList.remove('open');
  document.body.classList.remove('noscroll');
  const f = sheetOnClose;
  sheetOnClose = null;
  if (f) f();
}
