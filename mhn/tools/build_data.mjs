// モンハンNow 公式サイト（monsterhunternow.com/ja）の武器・防具・スキル一覧ページから
// 計算に必要な数値データだけを抜き出して mhn/data/*.json を生成する。
//
//   node mhn/tools/build_data.mjs            # 公式サイトから取得して生成
//   node mhn/tools/build_data.mjs --cache D  # D/{weapons,armor,skills}.html を使う（オフライン再生成）
//
// 公式ページには <root-island component="..." props="{JSON}"> の形でゲームデータが埋め込まれている。
// 画像URLや説明文は保存しない（名前と数値のみ）。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'data');
const BASE = 'https://monsterhunternow.com/ja';
const PAGES = { weapons: 'weapons', armor: 'armor', skills: 'skills' };

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function extractIslandProps(html) {
  const re = /<root-island component="(\w+)" props="([^"]*)"/g;
  const out = {};
  let m;
  while ((m = re.exec(html))) out[m[1]] = JSON.parse(decodeEntities(m[2]));
  return out;
}

async function loadPage(name, cacheDir) {
  if (cacheDir) return readFile(join(cacheDir, `${name}.html`), 'utf8');
  const res = await fetch(`${BASE}/${PAGES[name]}`, { headers: { 'User-Agent': 'Mozilla/5.0 (personal build tool)' } });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.text();
}

const skillPair = (s) => [s.kind, s.level];

// 公式ページは全グレードの名前を翻訳していない（未翻訳は "WEAPON_NAME_123" のようなキーのまま）。
const translated = (t, key) => (t[key] && t[key] !== key ? t[key] : null);
const stripGradeDigit = (n) => n.replace(/[０-９0-9]+$/, '');

export function buildWeapons(props) {
  const t = props.guideTranslations;
  const list = [];
  for (const w of Object.values(props.weapons)) {
    if (w.enabled === false) continue;
    const grades = {};
    let firstName = null;
    let lastName = null;
    for (const g of w.grades) {
      const n = translated(t, g.name);
      if (n) { if (!firstName) firstName = stripGradeDigit(n); lastName = n; }
      grades[g.grade] = {
        // [攻撃力, 属性値, 会心率] × サブレベル1..5
        lv: g.levels.map((l) => [l.attack, l.elementAttack, l.critical]),
        skills: g.skills.map((s) => (s.requiredCustomEnhancementLevel
          ? [s.kind, s.level, s.requiredCustomEnhancementLevel] : skillPair(s))),
      };
    }
    list.push({
      id: w.id,
      name: lastName ? stripGradeDigit(lastName) : (firstName || w.id),
      baseName: firstName || lastName || w.id,
      type: w.category,
      element: w.element,
      series: t[`SERIES_NAME_${w.seriesId}`] || w.series,
      sort: Number(w.sortOrder) || 0,
      style: !!(w.customizationSpec && w.customizationSpec.customizable),
      grades,
    });
  }
  list.sort((a, b) => a.sort - b.sort);
  return list;
}

const PART = { HEAD: 'head', CHEST: 'body', ARMS: 'arm', TORSO: 'waist', WAIST: 'waist', LEGS: 'feet' };

export function buildArmor(props) {
  const t = props.guideTranslations;
  const list = [];
  for (const a of Object.values(props.armor)) {
    const grades = {};
    let name = null;
    for (const g of a.grades) {
      const n = translated(t, g.name);
      if (n && !name) name = stripGradeDigit(n);
      grades[g.grade] = {
        slots: g.driftsmeltSlots,
        skills: g.skills.map(skillPair),
      };
    }
    list.push({
      id: a.id,
      name: name || a.id,
      part: PART[a.category] || a.category,
      series: t[`SERIES_NAME_${a.seriesId}`] || a.series,
      seriesId: a.seriesId,
      grades,
    });
  }
  return list;
}

export function buildSkills(props) {
  const t = props.guideTranslations;
  const skills = {};
  for (const s of Object.values(props.skills)) {
    skills[s.kind] = {
      name: t[s.name] || s.kind,
      cat: s.category,
      max: s.maxLevel,
      // レベルごとの effectAmount / conditionAmount（公式の生値）
      eff: s.levels.map((l) => l.effectAmount),
      cond: s.levels.map((l) => l.conditionAmount),
      sort: s.sortOrder,
    };
  }
  const driftstones = [];
  for (const d of Object.values(props.driftstones || {})) {
    if (d.enabled === false) continue;
    driftstones.push({
      id: d.name,
      name: t[`DRIFTSTONE_NAME_${d.name}`] || d.name,
      skills: [...new Set(d.skills.map((s) => s.skillKind))],
    });
  }
  return { skills, driftstones };
}

async function main() {
  const i = process.argv.indexOf('--cache');
  const cacheDir = i >= 0 ? process.argv[i + 1] : null;
  const pages = {};
  for (const name of Object.keys(PAGES)) {
    pages[name] = extractIslandProps(await loadPage(name, cacheDir));
    if (!cacheDir) await new Promise((r) => setTimeout(r, 1500));
  }
  const weapons = buildWeapons(pages.weapons.SortableWeaponList);
  const armor = buildArmor(pages.armor.SortableArmorList);
  const { skills, driftstones } = buildSkills(pages.skills.SortableSkillList);
  // 武器・防具ページにだけ出てくるスキル名も補完する
  for (const p of [pages.weapons.SortableWeaponList, pages.armor.SortableArmorList]) {
    for (const s of Object.values(p.skills || {})) {
      if (!skills[s.kind]) {
        skills[s.kind] = {
          name: p.guideTranslations[s.name] || s.kind, cat: s.category, max: s.maxLevel,
          eff: (s.levels || []).map((l) => l.effectAmount), cond: (s.levels || []).map((l) => l.conditionAmount), sort: s.sortOrder,
        };
      }
    }
  }
  await mkdir(OUT, { recursive: true });
  const meta = { source: BASE, fetched_at: new Date().toISOString(), weapons: weapons.length, armor: armor.length, skills: Object.keys(skills).length };
  await writeFile(join(OUT, 'weapons.json'), JSON.stringify(weapons));
  await writeFile(join(OUT, 'armor.json'), JSON.stringify(armor));
  await writeFile(join(OUT, 'skills.json'), JSON.stringify({ skills, driftstones }));
  await writeFile(join(OUT, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log(meta);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
