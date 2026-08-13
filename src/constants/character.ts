// =============================================================================
// 干员数据(名字 + 头像 + 性别)
// -----------------------------------------------------------------------------
// 数据来源:森空岛干员列表。
//   https://wiki.skland.com/endfield/catalog?mainTypeId=1&subTypeId=1&header=0
//
// 头像已下载到 src/assets/avatars/ 本地托管,规避 CDN 防盗链问题。
//
// 字段说明:
//   - name   : 角色名(与游戏内一致)
//   - avatar : 本地头像 URL(由 import.meta.glob 加载)
//   - gender : 性别('male' | 'female')
//
// 注意:gender 字段为占位,后续由用户校正。
// =============================================================================

/** 性别字面量类型 */
type CharacterGender = 'male' | 'female'

/** 干员数据结构 */
interface Character {
  /** 角色名 */
  name: string
  /** 头像 URL(本地托管) */
  avatar: string
  /** 性别(占位,待校正) */
  gender: CharacterGender
}

/**
 * 批量加载 src/assets/avatars/ 下所有头像文件
 *
 * import.meta.glob 会返回 { './梨诺.webp': url } 形式的对象,
 * Vite 构建时会处理为正确的资源 URL(哈希命名等)。
 *
 * eager:立即加载而非懒加载,character.ts 初始化时所有头像 URL 即可用
 * as:'url':直接返回 URL 字符串,而非模块对象
 */
const avatarModules = import.meta.glob('../assets/avatars/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

/**
 * 把 glob 返回的 key 转换为文件名(去路径与扩展名)
 *
 * './梨诺.webp' → '梨诺'
 * './管理员_男.webp' → '管理员_男'
 */
function globKeyToName(globKey: string): string {
  // 取最后一段文件名(去 ./ 前缀)
  const filename = globKey.replace(/^.*\//, '')
  // 去掉 .webp 扩展名
  return filename.replace(/\.webp$/, '')
}

/** 文件名 → 头像 URL 查找表 */
const avatarMap: Record<string, string> = {}
for (const [key, url] of Object.entries(avatarModules)) {
  avatarMap[globKeyToName(key)] = url
}

/**
 * 角色名 → 头像文件名的映射
 *
 * 处理角色名与文件名不一致的情况(如含括号空格)。
 */
const NAME_TO_FILE: Record<string, string> = {
  '管理员': '管理员_男',
  '管理员_女': '管理员_女',
}

/**
 * 按角色名查找本地头像 URL
 *
 * @param name 角色名
 * @returns   头像 URL(本地),未找到返回 undefined
 */
function resolveLocalAvatar(name: string): string | undefined {
  const fileName = NAME_TO_FILE[name] ?? name
  return avatarMap[fileName]
}

/** 内置干员数据列表(头像 URL 由 import.meta.glob 注入) */
export const CHARACTERS: Character[] = [
  { name: '梨诺',       avatar: resolveLocalAvatar('梨诺')!,       gender: 'female' },
  { name: '诀',         avatar: resolveLocalAvatar('诀')!,         gender: 'female' },
  { name: '卡缪',       avatar: resolveLocalAvatar('卡缪')!,       gender: 'male' },
  { name: '弭弗',       avatar: resolveLocalAvatar('弭弗')!,       gender: 'female' },
  { name: '庄方宜',     avatar: resolveLocalAvatar('庄方宜')!,     gender: 'female' },
  { name: '洛茜',       avatar: resolveLocalAvatar('洛茜')!,       gender: 'female' },
  { name: '汤汤',       avatar: resolveLocalAvatar('汤汤')!,       gender: 'female' },
  { name: '伊冯',       avatar: resolveLocalAvatar('伊冯')!,       gender: 'female' },
  { name: '洁尔佩塔',   avatar: resolveLocalAvatar('洁尔佩塔')!,   gender: 'female' },
  { name: '莱万汀',     avatar: resolveLocalAvatar('莱万汀')!,     gender: 'female' },
  { name: '骏卫',       avatar: resolveLocalAvatar('骏卫')!,       gender: 'male' },
  { name: '余烬',       avatar: resolveLocalAvatar('余烬')!,       gender: 'female' },
  { name: '别礼',       avatar: resolveLocalAvatar('别礼')!,       gender: 'female' },
  { name: '黎风',       avatar: resolveLocalAvatar('黎风')!,       gender: 'male' },
  { name: '艾尔黛拉',   avatar: resolveLocalAvatar('艾尔黛拉')!,   gender: 'female' },
  { name: '佩丽卡',     avatar: resolveLocalAvatar('佩丽卡')!,     gender: 'female' },
  { name: '陈千语',     avatar: resolveLocalAvatar('陈千语')!,     gender: 'female' },
  { name: '狼卫',       avatar: resolveLocalAvatar('狼卫')!,       gender: 'male' },
  { name: '弧光',       avatar: resolveLocalAvatar('弧光')!,       gender: 'female' },
  { name: '赛希',       avatar: resolveLocalAvatar('赛希')!,       gender: 'female' },
  { name: '阿列什',     avatar: resolveLocalAvatar('阿列什')!,     gender: 'male' },
  { name: '大潘',       avatar: resolveLocalAvatar('大潘')!,       gender: 'male' },
  { name: '艾维文娜',   avatar: resolveLocalAvatar('艾维文娜')!,   gender: 'female' },
  { name: '昼雪',       avatar: resolveLocalAvatar('昼雪')!,       gender: 'female' },
  { name: '秋栗',       avatar: resolveLocalAvatar('秋栗')!,       gender: 'female' },
  { name: '埃特拉',     avatar: resolveLocalAvatar('埃特拉')!,     gender: 'female' },
  { name: '卡契尔',     avatar: resolveLocalAvatar('卡契尔')!,     gender: 'male' },
  { name: '萤石',       avatar: resolveLocalAvatar('萤石')!,       gender: 'female' },
  { name: '安塔尔',     avatar: resolveLocalAvatar('安塔尔')!,     gender: 'male' },
]

// DEV 模式下校验所有头像已正确加载。resolveLocalAvatar 返回 undefined
// 时 `!` 非空断言骗过 TS,但运行时 avatar=undefined 会导致 <img src="undefined">
// 报错。构建期 import.meta.glob 静态分析可发现文件缺失,此校验作为运行时双保险。
if (import.meta.env.DEV) {
  for (const c of CHARACTERS) {
    if (!c.avatar) console.warn(`[character] 头像缺失: ${c.name}`)
  }
}

/**
 * 按角色名查找干员
 *
 * @param name 角色名
 * @returns   干员数据,未找到返回 undefined
 */
export function findCharacter(name: string): Character | undefined {
  return CHARACTERS.find((c) => c.name === name)
}

/**
 * "我方"默认头像 URL(管理员·男,本地托管)
 *
 * 聊天区右侧气泡头像使用此 URL。
 * 后续自定义对话若需不同的我方头像,可在 Conversation 中扩展字段覆盖。
 */
export const MINE_AVATAR_URL: string = resolveLocalAvatar('管理员')!

/**
 * "我方"女管理员头像 URL(管理员_女.webp,本地托管)
 *
 * 由对话级性别切换使用,切换后聊天区右侧气泡头像随之改变。
 */
export const MINE_AVATAR_FEMALE_URL: string = resolveLocalAvatar('管理员_女')!

/**
 * 默认头像 URL(角色未找到 / 空对话等默认场景,使用"未识别 NPC"素材)
 *
 * 新建会话默认展示此头像;聊天区默认一律走此 NPC 头像。
 */
import npcDefaultAvatar from '../assets/materials/icon_sns_npc_single_a.webp'
export const DEFAULT_AVATAR_URL: string = npcDefaultAvatar
