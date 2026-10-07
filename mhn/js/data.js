// データの読み込みと、グレード指定での装備ステータス解決。

export async function loadData(base = './data') {
  const [weapons, armor, skillData, meta] = await Promise.all(
    ['weapons', 'armor', 'skills', 'meta'].map((n) => fetch(`${base}/${n}.json`).then((r) => r.json())),
  );
  return indexData({ weapons, armor, skills: skillData.skills, driftstones: skillData.driftstones, meta });
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
