import { devOnly, devWarn } from '../utils/logger'
// =============================================================================
// 干员数据(名字 + 头像 + 性别 + 属性)
// -----------------------------------------------------------------------------
// 数据来源:森空岛干员列表。
//   https://wiki.skland.com/endfield/catalog?mainTypeId=1&subTypeId=1&header=0
//
// 头像已下载到 src/assets/avatars/ 本地托管,规避 CDN 防盗链问题。
//
// 字段说明:
//   - name      : 角色名(与游戏内一致)
//   - avatar    : 本地头像 URL(由 import.meta.glob 加载)
//   - attribute : 作战属性(物理/灼热/电磁/寒冷/自然/超域),见下方类型注释
//   - gender    : 性别('male' | 'female')
//
// 注意:gender 字段为占位,后续由用户校正。
// =============================================================================

/**
 * 性别字面量类型
 *
 * - 'male' / 'female':普通干员,子卡的"和他/她聊聊"按它取词
 * - 'ta'             :不区分性别(目前只有「管理员」——档案里性别一栏是"■■")。
 *                      SubCard 的 和他/她 都匹配不上,自然落到"和TA聊聊"
 */
type CharacterGender = 'male' | 'female' | 'ta'

/**
 * 角色作战属性(小写英文键)
 *
 * 数据源:G:\Cloudflared\docs\characters\角色属性.md
 * (fz.wiki 干员条目的 element 字段 + EN 客户端 i18n 对照)
 *
 *   physical = 物理 / heat = 灼热 / electric = 电磁
 *   cryo     = 寒冷 / nature = 自然 / aetherside = 超域(Aetherside)
 *
 * 「彩色括号描写」按这个属性给居中描配上色,配色见 ATTRIBUTE_COLORS,
 * 中文名见 ATTRIBUTE_LABELS。
 */
export type CharacterAttribute = 'physical' | 'heat' | 'electric' | 'cryo' | 'nature' | 'aetherside'

/** 干员数据结构 */
interface Character {
  /** 角色名 */
  name: string
  /** 头像 URL(本地托管) */
  avatar: string
  /**
   * 第二张头像(可选)
   *
   * 有它的角色,主卡头像可以点击切换(目前只有「管理员」:男 / 女两张形象)。
   * 缺省时主卡头像与其它角色一样,点击冒泡给整卡(展开 / 选中),不做任何切换。
   */
  avatarAlt?: string
  /** 作战属性(「彩色括号描写」按它取色,见 ATTRIBUTE_COLORS) */
  attribute: CharacterAttribute
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
  // 新添加的角色一律排在**最上方**(越新越靠前)—— 见下面的「管理员」。
  { name: '噗切娜',     avatar: resolveLocalAvatar('噗切娜')!,     attribute: 'physical', gender: 'female' },
  // 「管理员」:我方身份那一位的同名角色卡,按普通角色处理,只有两点特殊 ——
  //   1. 两张形象(男 / 女),主卡头像与聊天区对方头像都可点击切换(avatarAlt);
  //   2. 不区分性别(gender: 'ta'),子卡提示语是"和TA聊聊"。
  // 头像直接复用"我方"那两张(管理员_男 / 管理员_女,见 resolveLocalAvatar 的 NAME_TO_FILE)。
  // 属性按档案取 physical(物理)——“居中我方括号内容”在单人对话里就用这个颜色。
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
  { name: '祀',         avatar: resolveLocalAvatar('祀')!,         attribute: 'heat',     gender: 'female' },
]

// DEV 模式下校验所有头像已正确加载。resolveLocalAvatar 返回 undefined
// 时 `!` 非空断言骗过 TS,但运行时 avatar=undefined 会导致 <img src="undefined">
// 报错。构建期 import.meta.glob 静态分析可发现文件缺失,此校验作为运行时双保险。
devOnly(() => {
  for (const c of CHARACTERS) {
    if (!c.avatar) devWarn(`[character] 头像缺失: ${c.name}`)
  }
})

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
 * 属性配色表(「彩色括号描写」用)
 *
 * 数值取自 G:\Cloudflared\docs\characters\角色属性.md 的「不同属性颜色」一节,
 * 与游戏内的属性色一致;改色只改这一处。
 */
export const ATTRIBUTE_COLORS: Record<CharacterAttribute, string> = {
  physical: '#888888',   // 物理
  heat: '#ff6545',       // 灼热
  electric: '#ffc434',   // 电磁
  cryo: '#00c5cf',       // 寒冷
  nature: '#91df40',     // 自然
  aetherside: '#5e49ac', // 超域
}

/** 属性中文名(英文键 → 中文;界面/日志里要用中文时取这里) */
export const ATTRIBUTE_LABELS: Record<CharacterAttribute, string> = {
  physical: '物理',
  heat: '灼热',
  electric: '电磁',
  cryo: '寒冷',
  nature: '自然',
  aetherside: '超域',
}

/**
 * 彩色描写的透明度(0~1,**调浓淡就改这一个数**)
 *
 * 居中描写的统一色本身就是半透明的(CENTER_ACTION_COLOR = 50% 白),属性色若按
 * 原色实心显示会明显刺眼,因此这里统一压到同一档:色相保留,整体半透明。
 * 想更淡就调小(如 0.35),想更亮就调大(如 0.7)。
 */
export const ATTRIBUTE_TEXT_ALPHA = 0.5

/** #rrggbb → rgba(r, g, b, a);解析失败时原样返回 */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/**
 * 按角色名取属性颜色(已按 ATTRIBUTE_TEXT_ALPHA 降到半透明)
 *
 * @param name 角色名(可以是"管理员"或任意干员名)
 * @returns    可直接内联使用的 rgba 颜色;角色不存在时返回 undefined —— 调用方
 *             据此回退到统一的居中文本颜色(见 constants/colors 的 CENTER_ACTION_COLOR)
 */
export function attributeColorOf(name: string): string | undefined {
  const attr = findCharacter(name)?.attribute
  return attr ? withAlpha(ATTRIBUTE_COLORS[attr], ATTRIBUTE_TEXT_ALPHA) : undefined
}

/**
 * 需要用"原比例"缩放头像的角色名
 *
 * 这二位的立绘构图与其他干员不同(人物更靠上、四周留白更多),若沿用统一的
 * scale(1.3) 收紧裁剪,会把脑袋本身切掉,因此单独放小到 scale(1.1)。
 */
const ORIGINAL_SCALE_AVATARS = new Set(['阿达希尔', '聂菲斯'])

/**
 * 该角色的头像是否使用"原比例"缩放(scale 1.1)而非默认的收紧裁剪(scale 1.3)
 *
 * 单人主卡头像与群聊九宫格里的每个成员头像共用本判定 —— 两处必须一致,
 * 否则同一个角色在主卡和群聊格里会呈现不同的裁剪范围。
 *
 * @param name 角色名
 */
export function isOriginalScaleAvatar(name: string): boolean {
  return ORIGINAL_SCALE_AVATARS.has(name)
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
 * 默认头像 URL(角色未找到 / 空对话等默认场景,使用头像底图素材占位)
 *
 * 新建会话默认展示此头像;聊天区默认一律走此头像。
 */
import defaultAvatar from '../assets/materials/icon_virtualmouse_bg.webp'
export const DEFAULT_AVATAR_URL: string = defaultAvatar
