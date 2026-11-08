// character —— 干员数据（名字 / 头像 / 性别 / 作战属性）
// 头像走本地托管以规避 CDN 防盗链。

import { devOnly, devWarn } from '../utils/logger'

/** 'ta' = 不区分性别（档案里性别是"■■"，如管理员） */
type CharacterGender = 'male' | 'female' | 'ta'

/** 「彩色括号描写」按它取色，配色见 ATTRIBUTE_COLORS */
export type CharacterAttribute = 'physical' | 'heat' | 'electric' | 'cryo' | 'nature' | 'aetherside'

interface Character {
  name: string
  avatar: string
  /** 有第二张形象的角色，主卡头像可点击切换（目前只有管理员） */
  avatarAlt?: string
  attribute: CharacterAttribute
  /** 占位，待校正 */
  gender: CharacterGender
}

/** eager 只内联 URL 字符串，图片仍由 <img> 触发请求 */
const avatarModules = import.meta.glob('../assets/avatars/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

function globKeyToName(globKey: string): string {
  const filename = globKey.replace(/^.*\//, '')
  return filename.replace(/\.webp$/, '')
}

/** 文件名 → 头像 URL */
const avatarMap: Record<string, string> = {}
for (const [key, url] of Object.entries(avatarModules)) {
  avatarMap[globKeyToName(key)] = url
}

/** 角色名与文件名不一致的例外（含括号空格的那几个） */
const NAME_TO_FILE: Record<string, string> = {
  '管理员': '管理员_男',
  '管理员_女': '管理员_女',
}

function resolveLocalAvatar(name: string): string | undefined {
  const fileName = NAME_TO_FILE[name] ?? name
  return avatarMap[fileName]
}

export const CHARACTERS: Character[] = [
  // 新角色一律排最上方（越新越靠前）；老用户已有的卡不受此处顺序影响
  { name: '明河',       avatar: resolveLocalAvatar('明河')!,       attribute: 'electric', gender: 'male' },
  { name: '祀',         avatar: resolveLocalAvatar('祀')!,         attribute: 'cryo',     gender: 'female' },
  { name: '噗切娜',     avatar: resolveLocalAvatar('噗切娜')!,     attribute: 'physical', gender: 'female' },
  // 管理员按普通角色处理，只有两点特殊：两张形象可点击切换；gender 为 'ta'
  { name: '管理员',     avatar: resolveLocalAvatar('管理员')!,     avatarAlt: resolveLocalAvatar('管理员_女')!, attribute: 'physical', gender: 'ta' },
  { name: '提弗洛斯',   avatar: resolveLocalAvatar('提弗洛斯')!,   attribute: 'nature',   gender: 'female' },
  { name: '梨诺',       avatar: resolveLocalAvatar('梨诺')!,       attribute: 'electric', gender: 'female' },
  { name: '诀',         avatar: resolveLocalAvatar('诀')!,         attribute: 'nature',   gender: 'female' },
  { name: '卡缪',       avatar: resolveLocalAvatar('卡缪')!,       attribute: 'heat',     gender: 'male' },
  { name: '弭弗',       avatar: resolveLocalAvatar('弭弗')!,       attribute: 'physical', gender: 'female' },
  { name: '庄方宜',     avatar: resolveLocalAvatar('庄方宜')!,     attribute: 'electric', gender: 'female' },
  { name: '洛茜',       avatar: resolveLocalAvatar('洛茜')!,       attribute: 'physical', gender: 'female' },
  { name: '汤汤',       avatar: resolveLocalAvatar('汤汤')!,       attribute: 'cryo',     gender: 'female' },
  { name: '伊冯',       avatar: resolveLocalAvatar('伊冯')!,       attribute: 'cryo',     gender: 'female' },
  { name: '洁尔佩塔',   avatar: resolveLocalAvatar('洁尔佩塔')!,   attribute: 'nature',   gender: 'female' },
  { name: '莱万汀',     avatar: resolveLocalAvatar('莱万汀')!,     attribute: 'heat',     gender: 'female' },
  { name: '骏卫',       avatar: resolveLocalAvatar('骏卫')!,       attribute: 'physical', gender: 'male' },
  { name: '余烬',       avatar: resolveLocalAvatar('余烬')!,       attribute: 'heat',     gender: 'female' },
  { name: '别礼',       avatar: resolveLocalAvatar('别礼')!,       attribute: 'cryo',     gender: 'female' },
  { name: '黎风',       avatar: resolveLocalAvatar('黎风')!,       attribute: 'physical', gender: 'male' },
  { name: '艾尔黛拉',   avatar: resolveLocalAvatar('艾尔黛拉')!,   attribute: 'nature',   gender: 'female' },
  { name: '佩丽卡',     avatar: resolveLocalAvatar('佩丽卡')!,     attribute: 'electric', gender: 'female' },
  { name: '陈千语',     avatar: resolveLocalAvatar('陈千语')!,     attribute: 'physical', gender: 'female' },
  { name: '狼卫',       avatar: resolveLocalAvatar('狼卫')!,       attribute: 'heat',     gender: 'male' },
  { name: '弧光',       avatar: resolveLocalAvatar('弧光')!,       attribute: 'electric', gender: 'female' },
  { name: '赛希',       avatar: resolveLocalAvatar('赛希')!,       attribute: 'cryo',     gender: 'female' },
  { name: '阿列什',     avatar: resolveLocalAvatar('阿列什')!,     attribute: 'cryo',     gender: 'male' },
  { name: '大潘',       avatar: resolveLocalAvatar('大潘')!,       attribute: 'physical', gender: 'male' },
  { name: '艾维文娜',   avatar: resolveLocalAvatar('艾维文娜')!,   attribute: 'electric', gender: 'female' },
  { name: '昼雪',       avatar: resolveLocalAvatar('昼雪')!,       attribute: 'cryo',     gender: 'female' },
  { name: '秋栗',       avatar: resolveLocalAvatar('秋栗')!,       attribute: 'heat',     gender: 'female' },
  { name: '埃特拉',     avatar: resolveLocalAvatar('埃特拉')!,     attribute: 'cryo',     gender: 'female' },
  { name: '卡契尔',     avatar: resolveLocalAvatar('卡契尔')!,     attribute: 'physical', gender: 'male' },
  { name: '萤石',       avatar: resolveLocalAvatar('萤石')!,       attribute: 'nature',   gender: 'female' },
  { name: '安塔尔',     avatar: resolveLocalAvatar('安塔尔')!,     attribute: 'electric', gender: 'male' },
  { name: '聂菲斯',     avatar: resolveLocalAvatar('聂菲斯')!,     attribute: 'aetherside', gender: 'female' },
  { name: '阿达希尔',   avatar: resolveLocalAvatar('阿达希尔')!,   attribute: 'aetherside', gender: 'male' },
]

// DEV 校验：`!` 非空断言骗过 TS，但 avatar=undefined 会让 <img src="undefined"> 报错
devOnly(() => {
  for (const c of CHARACTERS) {
    if (!c.avatar) devWarn(`[character] 头像缺失: ${c.name}`)
  }
})

export function findCharacter(name: string): Character | undefined {
  return CHARACTERS.find((c) => c.name === name)
}

/** 取自游戏内属性色，改色只改这一处 */
export const ATTRIBUTE_COLORS: Record<CharacterAttribute, string> = {
  physical: '#888888',
  heat: '#ff6545',
  electric: '#ffc434',
  cryo: '#00c5cf',
  nature: '#91df40',
  aetherside: '#5e49ac',
}

export const ATTRIBUTE_LABELS: Record<CharacterAttribute, string> = {
  physical: '物理',
  heat: '灼热',
  electric: '电磁',
  cryo: '寒冷',
  nature: '自然',
  aetherside: '超域',
}

/**
 * 彩色描写的透明度（0~1）：居中描写本身已是 50% 白，属性色实心显示会刺眼，
 * 故统一压到同一档，保留色相。调浓淡只改这一个数。
 */
export const ATTRIBUTE_TEXT_ALPHA = 0.5

/** #rrggbb → rgba(r, g, b, a)；解析失败时原样返回 */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** 属性色（已降到半透明）；角色不存在返回 undefined，调用方回退到 CENTER_ACTION_COLOR */
export function attributeColorOf(name: string): string | undefined {
  const attr = findCharacter(name)?.attribute
  return attr ? withAlpha(ATTRIBUTE_COLORS[attr], ATTRIBUTE_TEXT_ALPHA) : undefined
}

/** 构图与众不同，默认的收紧裁剪会把头切掉，只能按原比例缩放 */
const ORIGINAL_SCALE_AVATARS = new Set(['阿达希尔', '聂菲斯'])

/** 主卡头像与群聊九宫格必须共用本判定，否则同一角色在两处裁剪范围不同 */
export function isOriginalScaleAvatar(name: string): boolean {
  return ORIGINAL_SCALE_AVATARS.has(name)
}

/** 我方默认头像（管理员·男），聊天区右侧气泡用 */
export const MINE_AVATAR_URL: string = resolveLocalAvatar('管理员')!

/** 我方女管理员头像，随对话级性别切换 */
export const MINE_AVATAR_FEMALE_URL: string = resolveLocalAvatar('管理员_女')!

/** 角色未找到 / 空对话时的占位头像 */
import defaultAvatar from '../assets/materials/icon_virtualmouse_bg.webp'
export const DEFAULT_AVATAR_URL: string = defaultAvatar
