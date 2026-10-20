// データの読み込みと、グレード指定での装備ステータス解決。

// イベント限定スキルの効果量（公式のスキル一覧に載っていないもの）。
// ホットサマー【2025】: 火属性+10/+20/+50（イベント期間中は10倍）。Lv3は資料により+30の記載もある。
export const EVENT_SKILL_VALUES = {
  EV_SWELTERING_SUMMER2025: [[10], [20], [50]],
};

export async function loadData(base = './data') {
  const [weapons, armor, skillData, meta, extra] = await Promise.all(
    ['weapons', 'armor', 'skills', 'meta', 'extra'].map((n) => fetch(`${base}/${n}.json?v=__V__`).then((r) => (r.ok ? r.json() : null)).catch(() => null)),
  );
  return indexData(mergeExtra({ weapons, armor, skills: skillData.skills, driftstones: skillData.driftstones, meta }, extra));
}

// 公式一覧に無い装備（季節限定・コラボ等）の補完データを合流させる
export function mergeExtra(d, extra) {
  if (!extra) return d;
  const skills = { ...d.skills };
  for (const [k, v] of Object.entries(extra.skills || {})) {
    if (!skills[k]) skills[k] = { ...v, eff: EVENT_SKILL_VALUES[k] || v.eff || [] };
  }
  // スタイル強化データの紐付け（データがある武器はスタイル強化可能として扱う）
  const styleMap = extra.styleMap || {};
  const withStyle = (w) => (styleMap[w.id] ? { ...w, style: true, styleProfile: styleMap[w.id] } : w);
  return {
    ...d,
    skills,
    styleProfiles: extra.styleProfiles || {},
    weapons: [...d.weapons, ...(extra.weapons || [])].map(withStyle),
    armor: [...d.armor, ...(extra.armor || [])],
    extraMeta: { source: extra.source, fetched_at: extra.fetched_at, series: extra.series },
  };
}

// 手入力の装備（所持・錬成タブで追加したもの）を合流させる
export function withCustom(d, custom = []) {
  const weapons = d.weapons.filter((w) => !w.custom);
  const armor = d.armor.filter((a) => !a.custom);
  for (const c of custom) {
    const skills = (c.skills || []).filter(([k]) => d.skills[k]);
    if (c.kind === 'weapon') {
      const row = [Number(c.atk) || 0, Number(c.elem) || 0, Number(c.crit) || 0];
      weapons.push({
        id: c.id, name: c.name || '手入力の武器', baseName: c.name, type: c.type, element: c.element || 'NO_ELEMENT',
        series: '手入力', sort: 1e9, style: false, img: null, mon: null, custom: true,
        grades: { 10: { lv: [row, row, row, row, row], skills } },
      });
    } else {
      armor.push({
        id: c.id, name: c.name || '手入力の防具', part: c.part, series: '手入力', seriesId: 0, img: null, mon: null, custom: true,
        grades: { 10: { slots: Number(c.slots) || 0, skills } },
      });
    }
  }
  return indexData({ ...d, weapons, armor });
}

// スタイル強化 {level, ms:{10,15,20: 'atk'|'elem'|'crit'}, atk, elem} → 合計の上昇値
// プロファイル（武器ごとのデータ）があれば Lv ごとの上昇値と選択肢の値をそこから取る。
export function styleTotals(style, w, profiles = {}) {
  if (!style || !w || !w.style) return null;
  const level = Number(style.level) || 0;
  const prof = w.styleProfile ? profiles[w.styleProfile] : null;
  let atk = Number(style.atk) || 0;
  let elem = Number(style.elem) || 0;
  let crit = 0;
  if (prof) for (const [lv, a, e, c] of prof.rules) if (lv <= level) { atk += a; elem += e; crit += c; }
  const ailment = ['POISON', 'PARALYSIS', 'SLEEP', 'BLAST'].includes(w.element);
  const val = (k, fb) => (prof && prof.choices[k] !== undefined ? prof.choices[k] : fb);
  for (const m of [10, 15, 20]) {
    if (level < m) continue;
    const c = style.ms && style.ms[m];
    if (c === 'atk') atk += val('Attack', 100);
    else if (c === 'crit') crit += val('Critical', 10);
    else if (c === 'elem') elem += val('Element', ailment ? 50 : 100);
  }
  return { level, atk, elem, crit };
}

export function indexData(d) {
  d.weaponById = Object.fromEntries(d.weapons.map((w) => [w.id, w]));
  d.armorById = Object.fromEntries(d.armor.map((a) => [a.id, a]));
  // 漂流石（純石含む）から付く可能性のあるスキル
  d.driftable = new Set(d.driftstones.flatMap((s) => s.skills));
  return d;
}

export const gradesOf = (item) => Object.keys(item.grades).map(Number).sort((a, b) => a - b);
export const maxGrade = (item) => Math.max(...gradesOf(item));

// 指定グレード以下で一番近いグレードのデータ（そのグレードが無ければ最小グレード）
export function gradeData(item, grade) {
  const gs = gradesOf(item);
  let g = gs[0];
  for (const x of gs) if (x <= grade) g = x;
  return { grade: g, data: item.grades[g] };
}

// style: { level, atk, elem, crit } … スタイル強化（ゲーム画面の合計値を入力）
export function resolveWeapon(w, grade = 10, sub = 5, style = null) {
  const { grade: g, data } = gradeData(w, grade);
  const lv = data.lv[Math.max(1, Math.min(sub, data.lv.length)) - 1];
  const styleLv = style ? Number(style.level) || 0 : 0;
  const skills = data.skills
    .filter((s) => s.length < 3 || styleLv >= s[2])
    .map((s) => [s[0], s[1]]);
  return {
    id: w.id,
    name: w.name,
    type: w.type,
    element: w.element,
    grade: g,
    sub,
    atk: lv[0] + (style ? Number(style.atk) || 0 : 0),
    elem: lv[1] + (style ? Number(style.elem) || 0 : 0),
    crit: lv[2] + (style ? Number(style.crit) || 0 : 0),
    skills,
    lockedSkills: data.skills.filter((s) => s.length >= 3 && styleLv < s[2]),
  };
}

export function resolveArmor(a, grade = 10) {
  const { grade: g, data } = gradeData(a, grade);
  return { id: a.id, name: a.name, part: a.part, series: a.series, grade: g, slots: data.slots, skills: data.skills };
}
