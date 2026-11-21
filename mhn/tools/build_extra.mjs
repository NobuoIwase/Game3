// 公式サイトの一覧に載っていない装備（季節限定・コラボ・イベント装備など）を補完する。
//
//   node mhn/tools/build_extra.mjs           # 取得して mhn/data/extra.json を生成
//   node mhn/tools/build_extra.mjs --cache F  # 保存済みの HTML（F）から生成
//
// 取得元: ナウかる（mhnowcalc.com）の装備構成エディタに埋め込まれている装備データ。
// 公式データ（data/*.json）に1つも同名の装備が無い「シリーズ」だけを取り込む
// （同じ装備が重複しないように）。値は最大グレード（10-5相当）のみ。名前と数値だけを保存する。

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = 'https://mhnowcalc.com/calc/build_editor_simple.php?lang=ja';

const WEAPON_TYPE = {
  SwordAndShield: 'SWORD_SHIELD', DualBlades: 'DUAL_BLADES', GreatSword: 'GREAT_SWORD', LongSword: 'LONG_SWORD',
  Hammer: 'HAMMER', HuntingHorn: 'HUNTING_HORN', Lance: 'LANCE', Gunlance: 'GUNLANCE', SwitchAxe: 'SWITCH_AXE',
  ChargeBlade: 'CHARGE_BLADE', InsectGlaive: 'INSECT_GLAIVE', LightBowgun: 'LIGHT_BOWGUN', HeavyBowgun: 'HEAVY_BOWGUN', Bow: 'BOW',
};
const ELEMENT = {
  None: 'NO_ELEMENT', '': 'NO_ELEMENT', Fire: 'FIRE', Water: 'WATER', Thunder: 'THUNDER', Ice: 'ICE', Dragon: 'DRAGON',
  Poison: 'POISON', Paralysis: 'PARALYSIS', Sleep: 'SLEEP', Blast: 'BLAST',
};
const PART = { Head: 'head', Body: 'body', Arm: 'arm', Waist: 'waist', Feet: 'feet' };

// 公式スキル一覧に無いイベント限定スキル → このアプリでのキー
const EVENT_SKILL_KIND = (key) => `EV_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;

export function extractBootstrap(html) {
  const m = html.match(/window\.BUILD_EDITOR_BOOTSTRAP = (\{.*?\});\s*\n/s);
  if (!m) throw new Error('BUILD_EDITOR_BOOTSTRAP が見つかりません');
  return JSON.parse(m[1]);
}

const norm = (s) => String(s || '').replace(/[\s・＝=改ー－\-‐]/g, '').replace(/ノ/g, 'の');

export function buildExtra(boot, official) {
  const officialNames = new Set();
  for (const x of [...official.weapons, ...official.armor]) {
    officialNames.add(norm(x.name));
    if (x.baseName) officialNames.add(norm(x.baseName));
  }
  const nameToKind = {};
  for (const [kind, s] of Object.entries(official.skills)) nameToKind[s.name] = kind;

  // シリーズごとに、公式データと同名の装備が1つでもあれば「公式に載っているシリーズ」とみなして除外
  const bySeries = {};
  for (const c of boot.equipCatalog) {
    const d = boot.equipDetails[c.equip_key];
    if (!d) continue;
    (bySeries[c.series_key] = bySeries[c.series_key] || []).push({ c, d });
  }
  const weapons = [];
  const armor = [];
  const skills = {};
  const skillMax = Object.fromEntries((boot.driftSkills || []).map((s) => [s.skill_key, s.max_level]));
  const mapSkill = (s) => {
    const kind = nameToKind[s.skill_name_ja];
    if (kind) return kind;
    const k = EVENT_SKILL_KIND(s.skill_key);
    if (!skills[k]) skills[k] = { name: s.skill_name_ja, cat: 'EVENT', max: s.max_level || skillMax[s.skill_key] || 1, eff: [], cond: [], sort: 9000, extra: true };
    return k;
  };
  const series = [];
  for (const [key, items] of Object.entries(bySeries)) {
    if (items.some(({ d }) => officialNames.has(norm(d.equip_name_ja)))) continue;
    series.push(key);
    for (const { c, d } of items) {
      const sk = (d.skills || []).map((s) => [mapSkill(s), s.skill_level]);
      const seriesName = `${c.series_name_ja}シリーズ`;
      if (c.category === 'Weapon') {
        const row = [d.attack, d.element_value, d.affinity];
        weapons.push({
          id: `EX_${c.equip_key}`.toUpperCase(),
          name: d.equip_name_ja,
          baseName: d.equip_name_ja,
          type: WEAPON_TYPE[d.weapon_type] || d.weapon_type,
          element: ELEMENT[d.element_type] ?? 'NO_ELEMENT',
          series: seriesName,
          sort: 9e8 + (c.sort_order || 0),
          style: !!(d.custom_style && d.custom_style.enabled),
          img: null,
          mon: null,
          extra: true,
          grades: { 10: { lv: [row, row, row, row, row], skills: sk } },
        });
      } else if (PART[c.category]) {
        armor.push({
          id: `EX_${c.equip_key}`.toUpperCase(),
          name: d.equip_name_ja,
          part: PART[c.category],
          series: seriesName,
          seriesId: 0,
          img: null,
          mon: null,
          extra: true,
          grades: { 10: { slots: d.slot_count || 0, skills: sk } },
        });
      }
    }
  }
  // スタイル強化: 武器ごとのプロファイル（各Lvの上昇値・Lv10/15/20 の選択肢の値）
  const styleProfiles = {};
  const styleMap = {};
  const byName = {};
  for (const w of [...official.weapons, ...weapons]) byName[norm(w.name)] = w.id;
  for (const c of boot.equipCatalog) {
    const d = boot.equipDetails[c.equip_key];
    const cs = d && d.custom_style;
    if (!cs || !cs.enabled) continue;
    const key = cs.profile_key;
    if (!styleProfiles[key]) {
      styleProfiles[key] = {
        name: cs.profile_name_ja,
        max: cs.max_level,
        milestones: cs.milestone_levels,
        choices: Object.fromEntries((cs.choices || []).map((x) => [x.key, x.value])),
        // [Lv, 攻撃+, 属性+, 会心+]
        rules: (cs.level_rules || []).map((r) => [r.level_no, r.attack_add, r.element_add, r.affinity_add]).filter((r) => r[1] || r[2] || r[3]),
      };
    }
    let id = byName[norm(d.equip_name_ja)];
    if (!id) {
      // 名前の表記ゆれで見つからないときは、武器種・属性と最大グレードの攻撃力・属性値が一致する武器
      const type = WEAPON_TYPE[d.weapon_type];
      const hits = official.weapons.filter((w) => {
        const g = w.grades[10] || w.grades[Math.max(...Object.keys(w.grades).map(Number))];
        const top = g.lv[g.lv.length - 1];
        return w.type === type && w.element === (ELEMENT[d.element_type] ?? 'NO_ELEMENT') && top[0] === d.attack && top[1] === d.element_value && !styleMap[w.id];
      });
      if (hits.length === 1) id = hits[0].id;
    }
    if (id) styleMap[id] = key;
  }
  return { source: SOURCE, fetched_at: new Date().toISOString(), series, weapons, armor, skills, styleProfiles, styleMap };
}

async function main() {
  const i = process.argv.indexOf('--cache');
  const html = i >= 0
    ? await readFile(process.argv[i + 1], 'utf8')
    : await (await fetch(SOURCE, { headers: { 'User-Agent': 'Mozilla/5.0 (personal build tool)' } })).text();
  const j = async (n) => JSON.parse(await readFile(join(ROOT, 'data', `${n}.json`), 'utf8'));
  const official = { weapons: await j('weapons'), armor: await j('armor'), skills: (await j('skills')).skills };
  const extra = buildExtra(extractBootstrap(html), official);
  await writeFile(join(ROOT, 'data', 'extra.json'), JSON.stringify(extra));
  console.log({ series: extra.series, weapons: extra.weapons.length, armor: extra.armor.length, styleProfiles: Object.keys(extra.styleProfiles).length, styleMapped: Object.keys(extra.styleMap).length, skills: Object.values(extra.skills).map((s) => s.name) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
