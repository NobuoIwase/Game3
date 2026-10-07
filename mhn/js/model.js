// スキル効果の解釈（どのスキルがダメージ計算のどの項に入るか）と表示用の定数。
// 効果量そのものは公式データ（data/skills.json の eff = effectAmount）から読む。
// ここに書くのは「eff の何番目の値を、計算式のどの項に入れるか」と「既定の発動率」だけ。

export const WEAPON_TYPES = {
  SWORD_SHIELD: '片手剣', DUAL_BLADES: '双剣', GREAT_SWORD: '大剣', LONG_SWORD: '太刀',
  HAMMER: 'ハンマー', HUNTING_HORN: '狩猟笛', LANCE: 'ランス', GUNLANCE: 'ガンランス',
  SWITCH_AXE: 'スラッシュアックス', CHARGE_BLADE: 'チャージアックス', INSECT_GLAIVE: '操虫棍',
  LIGHT_BOWGUN: 'ライトボウガン', HEAVY_BOWGUN: 'ヘビィボウガン', BOW: '弓',
};

export const ELEMENTS = {
  NO_ELEMENT: '無属性', FIRE: '火', WATER: '水', THUNDER: '雷', ICE: '氷', DRAGON: '龍',
  POISON: '毒', PARALYSIS: '麻痺', SLEEP: '睡眠', BLAST: '爆破',
};
export const DAMAGE_ELEMENTS = ['FIRE', 'WATER', 'THUNDER', 'ICE', 'DRAGON'];
export const AILMENT_ELEMENTS = ['POISON', 'PARALYSIS', 'SLEEP', 'BLAST'];

export const PARTS = ['head', 'body', 'arm', 'waist', 'feet'];
export const PART_NAMES = { weapon: '武器', head: '頭', body: '胴', arm: '腕', waist: '腰', feet: '脚' };

const RANGED = ['LIGHT_BOWGUN', 'HEAVY_BOWGUN', 'BOW'];
const BOWGUNS = ['LIGHT_BOWGUN', 'HEAVY_BOWGUN'];
const GUARD_WEAPONS = ['SWORD_SHIELD', 'LANCE', 'GUNLANCE', 'CHARGE_BLADE'];

// term:
//   atkPct    攻撃力倍率（武器攻撃力に掛かる%、互いに加算）
//   atkFlat   攻撃力加算
//   atkActive 攻撃活性（加算後の攻撃力に掛かる%）
//   dmgPct    与ダメージ倍率（互いに加算）
//   crit      会心率（%）
//   critMul   会心倍率（%、最大値を採用）
//   elemFlat  属性値加算（属性一致時のみ）
//   elemPct   属性倍率（%、加算）
//   critElem  会心撃【属性】（会心時のみ属性%加算）
//   elder     古龍系の属性倍率（%、加算後に乗算）
// idx:   eff の何番目を使うか（既定 0）
// mul:   値に掛ける係数（力任せの会心低下など負の値に使う）
// elem:  属性一致が必要な属性
// needs: [スキル, Lv] このスキルがLv以上のときのみ有効（境地スキル）
// rate:  既定の発動率(%)。100 は常時。types があればその武器種以外は 0
// note:  画面に出す補足
export const SKILL_EFFECTS = {
  ATTACK_BOOST: [{ term: 'atkFlat' }],
  ATTACK_BOOST_SECRET: [{ term: 'atkFlat', needs: ['ATTACK_BOOST', 5] }],
  PEAK_PERFORMANCE: [{ term: 'atkFlat', rate: 80 }],
  HELLFIRE_CLOAK: [{ term: 'atkFlat', rate: 60 }],
  RISING_TIDE: [{ term: 'atkFlat', idx: 0, stacksFromCond: 0, rate: 50, note: '段階×上昇量を最大とし発動率で按分（推定）' }],
  BURST: [{ term: 'atkPct', idx: 2, rate: 85 }],
  BURST_SECRET: [{ term: 'atkPct', needs: ['BURST', 5], rate: 85, rateFrom: 'BURST' }],
  HEROICS: [{ term: 'atkPct', rate: 0 }],
  OFFENSIVE_GUARD: [{ term: 'atkPct', rate: 30, types: GUARD_WEAPONS }],
  FORTIFY: [{ term: 'atkPct', rate: 0 }],
  RESENTMENT: [{ term: 'atkPct', idx: 1, rate: 50 }],
  JUST_CHARGE: [{ term: 'atkPct', rate: 0, note: '溜め派生のアクション中のみ' }],
  BRAVERY: [{ term: 'atkFlat', rate: 50 }],
  MULTI_ATTACK_BOOST: [{ term: 'atkFlat', rate: 0, note: 'グループハント時' }],
  ATTACK_UP_CRITICAL_DOWN: [{ term: 'atkFlat' }, { term: 'crit', idx: 2, mul: -1 }],
  POWERHOUSE: [{ term: 'atkActive' }],
  POWERHOUSE_CRITICAL: [{ term: 'atkFlat', perWeaponCrit: true }],
  PURSUIT_BLAST: [{ term: 'atkFlat', stacksFromEff: 1, rate: 30, types: null, elemAny: ['BLAST'] }],

  DISABLE_PERFECT_EVADE: [{ term: 'dmgPct' }],
  SNEAK_ATTACK: [{ term: 'dmgPct', rate: 40 }],
  AIRBORNE: [{ term: 'dmgPct', rate: 0, rateByType: { INSECT_GLAIVE: 70 } }],
  BREAK_ATTACK_BOOST: [{ term: 'dmgPct', rate: 60 }],
  BLOODBLIGHT_CLOAK: [{ term: 'dmgPct', rate: 70 }],
  RESUSCITATE: [{ term: 'dmgPct', rate: 40 }],
  COALESCENCE: [{ term: 'dmgPct', rate: 40 }],
  PERFECT_EVADE_ATTACK_BOOST: [{ term: 'dmgPct', rate: 10 }],
  BURST_DODGER: [{ term: 'dmgPct', rate: 60 }],
  FIGHTING_SPIRIT: [{ term: 'dmgPct', rate: 40 }],
  SP_UNDERCURRENT: [{ term: 'dmgPct', rate: 80 }],
  POWER_BURST: [{ term: 'dmgPct', rate: 85 }],
  NERGIGANTE_GREED: [{ term: 'dmgPct' }],
  PURSUIT_POISON: [{ term: 'dmgPct', rate: 25, elemAny: ['POISON'] }],
  PURSUIT_PARALYSIS: [{ term: 'dmgPct', rate: 15, elemAny: ['PARALYSIS'] }],
  BUILDUP_BOOST: [{ term: 'dmgPct', rate: 30, elemAny: AILMENT_ELEMENTS }],
  MORPH_BOOST: [{ term: 'dmgPct', idx: 1, rate: 70, types: ['DUAL_BLADES', 'SWITCH_AXE', 'CHARGE_BLADE'] }],
  MORPH_ATTACK_BOOST: [{ term: 'dmgPct', rate: 10, types: ['SWITCH_AXE', 'CHARGE_BLADE'] }, { term: 'crit', idx: 1, rate: 10, types: ['SWITCH_AXE', 'CHARGE_BLADE'], rateFrom: 'MORPH_ATTACK_BOOST' }],
  HEAD_ON_FIGHT: [{ term: 'dmgPct', rate: 50 }],
  MOVE_FORWARD_STRENGTHEN: [{ term: 'dmgPct', rate: 60 }],
  CRITICAL_RANGE_BOOST: [{ term: 'dmgPct', rate: 80, types: RANGED }],
  CHARGE_UP: [{ term: 'dmgPct', rate: 40, types: ['HAMMER', 'HUNTING_HORN'] }],
  ENDING_SHOT: [{ term: 'dmgPct', rate: 20, types: ['GUNLANCE', 'CHARGE_BLADE', ...BOWGUNS] }],
  ENHANCEMENT_NORMAL_AMMO: [{ term: 'dmgPct', rate: 0, types: BOWGUNS, note: '通常弾・属性通常弾を撃つ割合' }],
  ENHANCEMENT_SLICING_AMMO: [{ term: 'dmgPct', rate: 0, types: BOWGUNS, note: '斬裂弾を撃つ割合' }],
  CHARGE_STOCK: [{ term: 'dmgPct', rate: 0, note: '溜め攻撃の割合' }],

  CRITICAL_EYE: [{ term: 'crit' }],
  WEAKNESS_EXPLOIT: [{ term: 'crit', rate: 80, note: '弱点に当てる割合' }],
  LATENT_POWER: [{ term: 'crit', rate: 50 }],
  DEATHGARON: [{ term: 'crit', rate: 50, note: '裂傷状態の割合' }],
  BRUTAL_STRIKE: [{ term: 'crit', mul: -1 }, { term: 'brutal', idx: 3 }],
  CRITICAL_BOOST: [{ term: 'critMul', idx: 1 }],

  FIRE_ATTACK: [{ term: 'elemFlat', elem: 'FIRE' }],
  WATER_ATTACK: [{ term: 'elemFlat', elem: 'WATER' }],
  THUNDER_ATTACK: [{ term: 'elemFlat', elem: 'THUNDER' }],
  ICE_ATTACK: [{ term: 'elemFlat', elem: 'ICE' }],
  DRAGON_ATTACK: [{ term: 'elemFlat', elem: 'DRAGON' }],
  WATER_ATTACK_BOOST_SECRET: [{ term: 'elemFlat', idx: 1, elem: 'WATER', needs: ['WATER_ATTACK', 5] }],
  THUNDER_ATTACK_BOOST_SECRET: [{ term: 'elemFlat', idx: 1, elem: 'THUNDER', needs: ['THUNDER_ATTACK', 5] }],
  ICE_ATTACK_BOOST_SECRET: [{ term: 'elemFlat', idx: 1, elem: 'ICE', needs: ['ICE_ATTACK', 5] }],
  DRAGON_ATTACK_BOOST_SECRET: [{ term: 'elemFlat', idx: 1, elem: 'DRAGON', needs: ['DRAGON_ATTACK', 5] }],
  HIGH_PERFORMANCE_FIRE: [{ term: 'elemFlat', idx: 1, elem: 'FIRE', perHp: true, rate: 100, note: '体力×倍率。発動率=体力満タン付近の割合' }],
  HIGH_PERFORMANCE_WATER: [{ term: 'elemFlat', idx: 1, elem: 'WATER', perHp: true, rate: 100, note: '体力×倍率。発動率=体力満タン付近の割合' }],
  HIGH_PERFORMANCE_THUNDER: [{ term: 'elemFlat', idx: 1, elem: 'THUNDER', perHp: true, rate: 100, note: '体力×倍率。発動率=体力満タン付近の割合' }],
  HIGH_PERFORMANCE_ICE: [{ term: 'elemFlat', idx: 1, elem: 'ICE', perHp: true, rate: 100, note: '体力×倍率。発動率=体力満タン付近の割合' }],
  HIGH_PERFORMANCE_DRAGON: [{ term: 'elemFlat', idx: 1, elem: 'DRAGON', perHp: true, rate: 100, note: '体力×倍率。発動率=体力満タン付近の割合' }],
  CHARGE_MASTER: [{ term: 'elemPct', rate: 0, note: '溜め攻撃の割合' }],
  SP_OVERDRIVE: [{ term: 'elemPct', rate: 30 }],
  CRITICAL_ELEMENT: [{ term: 'critElem' }],
  KUSHALA_BLESS: [{ term: 'elder', elem: 'ICE' }],
  VELKHANA_ARMOR: [{ term: 'elder', elem: 'ICE' }],
  KIRIN_ROBE: [{ term: 'elder', elem: 'THUNDER' }],
  NAMIELLE_WAVE: [{ term: 'elder', elem: 'WATER' }],
  MALZENO_BLOOD: [{ term: 'elder', elem: 'DRAGON' }],
};

// 発動率を設定できる（常時発動ではない）スキルの一覧
export function conditionalSkills() {
  return Object.entries(SKILL_EFFECTS)
    .filter(([, effs]) => effs.some((e) => e.rate !== undefined && !e.rateFrom))
    .map(([k]) => k);
}

// 武器種ごとの既定発動率
export function defaultRate(kind, weaponType) {
  const effs = SKILL_EFFECTS[kind];
  if (!effs) return 100;
  const e = effs.find((x) => x.rate !== undefined && !x.rateFrom) || effs[0];
  if (e.types && weaponType && !e.types.includes(weaponType)) return 0;
  if (e.rateByType && weaponType && e.rateByType[weaponType] !== undefined) return e.rateByType[weaponType];
  return e.rate === undefined ? 100 : e.rate;
}

export function isDamageSkill(kind) {
  return Object.prototype.hasOwnProperty.call(SKILL_EFFECTS, kind);
}
