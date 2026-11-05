// =============================================================================
// lengthPolicy —— "这条回复该说多长"的唯一真源
// -----------------------------------------------------------------------------
// 为什么需要单独一层:
//   长度指令此前有两处来源且互相打架 —— 通用规则第 6 条写"话要尽量多、至少两
//   三句",角色卡写"能用一个字绝不延伸";角色卡在前、通用规则在后,而卡里的
//   few-shot 例句比抽象规则更有力,于是同一个模型对佩丽卡的回复中位数是 234 字、
//   对埃特拉只有 26 字(相差 9 倍)。这不是前端渲染问题,但没有一份"唯一答案"
//   时,任何一处想改长度都只能再叠一条相反的规则,冲突只会更多。
//
//   因此:角色 → 档位(本文件) → 数值区间(本文件) → 提示词占位符
//   `{LENGTH_TARGET}`(constants/prompts.ts 的第 6 条)。规则文本里不再出现
//   "尽量多/至少两三句"这类与角色卡对立的绝对值,只留一个由本表填进去的区间。
//
// 数值区间的依据(生产日志 3062 条真实单聊请求):
//   全量 mean 153 / median 91 / p10 29 / p90 364 字;
//   佩丽卡 median 234(话多的代表),埃特拉 median 26(话少的代表)。
//   → terse  取 15~60 字(p10 ～ 埃特拉量级)
//     normal 取 60~220 字(中位数两侧,佩丽卡量级的下沿)
//     verbose 取 200~420 字(佩丽卡量级以上,p90 附近)
//   区间只是"目标",不是硬截断:模型偶尔超出不需要处理,提示词层不负责裁字。
//
// 本模块是纯函数 + 常量,不依赖 Vue / store / 平台,便于单测与三端共用。
// =============================================================================

/** 回复长度档位 */
export type ReplyLength = 'terse' | 'normal' | 'verbose'

/** 一个档位的长度目标 */
export interface LengthTarget {
  /** 档位(便于排查"这个角色为什么这么短") */
  level: ReplyLength
  /** 台词总量下界(字) */
  min: number
  /** 台词总量上界(字) */
  max: number
  /** 直接填进提示词的自然语言描述 */
  text: string
}

/**
 * 各档位的数值区间
 *
 * 注意量的是**台词**(括号里的动作/神态描写不算)—— 沉浸式模式下去掉描写后,
 * 玩家看到的字数就是这里的区间,两种模式的手感才一致。
 */
export const LENGTH_TARGET: Record<ReplyLength, LengthTarget> = {
  terse: {
    level: 'terse',
    min: 15,
    max: 60,
    text: '15~60 字(一两句话,能一句说清就不用第二句)',
  },
  normal: {
    level: 'normal',
    min: 60,
    max: 220,
    text: '60~220 字(两到四句话)',
  },
  verbose: {
    level: 'verbose',
    min: 200,
    max: 420,
    text: '200~420 字(四到八句话)',
  },
}

/**
 * 角色 → 长度档位
 *
 * 只列**与默认档位不同**的角色 + 需要显式钉住的角色,其余走
 * DEFAULT_REPLY_LENGTH(normal)。新增角色时若角色卡里写了"极度简洁/惜字如金",
 * 就应当在这里登记,而不是在角色卡里再写一遍长度要求。
 */
export const LENGTH_BY_CHARACTER: Record<string, ReplyLength> = {
  // 角色卡明确要求"能用一个字绝不延伸 / 极度简洁":实测中位 26 字
  埃特拉: 'terse',
  狼卫: 'terse',
  卡契尔: 'terse',
  // 话多但不需要"极长":中位 234 字,落在 normal 上沿,不额外加压到 verbose
  佩丽卡: 'normal',
  // 「管理员」不是可对话角色,但群里可能出现同名卡;钉住以免落到别的档位
  管理员: 'normal',
}

/** 未登记角色的默认档位 */
export const DEFAULT_REPLY_LENGTH: ReplyLength = 'normal'

/** 提示词里等待填充的长度占位符 */
export const LENGTH_TARGET_PLACEHOLDER = '{LENGTH_TARGET}'

/**
 * 解析角色对应的长度档位
 *
 * 允许"角色名带后缀"的写法(如「佩丽卡(测试)」):精确命中优先,否则按
 * 最长子串命中 —— 表里的键都写全名,不易误伤;仍不命中则回默认档。
 */
export function resolveReplyLength(characterName?: string): ReplyLength {
  const name = (characterName ?? '').trim()
  if (!name) return DEFAULT_REPLY_LENGTH
  const exact = LENGTH_BY_CHARACTER[name]
  if (exact) return exact

  let best: ReplyLength | null = null
  let bestLen = 0
  for (const [key, level] of Object.entries(LENGTH_BY_CHARACTER)) {
    if (key.length > bestLen && name.includes(key)) {
      best = level
      bestLen = key.length
    }
  }
  return best ?? DEFAULT_REPLY_LENGTH
}

/** 取角色对应的长度目标(区间 + 提示词描述) */
export function resolveLengthTarget(characterName?: string): LengthTarget {
  return LENGTH_TARGET[resolveReplyLength(characterName)]
}

/**
 * 把文本里的 `{LENGTH_TARGET}` 占位符填成本角色的区间描述
 *
 * 幂等:文本里没有占位符时原样返回 —— 于是所有"拼装通用回复规则"的地方
 * 都可以无条件过一遍,不必先判断自己手上这份是不是 EMPHASIS_RULE。
 */
export function fillLengthTarget(text: string, characterName?: string): string {
  const raw = text ?? ''
  if (raw.indexOf(LENGTH_TARGET_PLACEHOLDER) === -1) return raw
  const { text: target } = resolveLengthTarget(characterName)
  return raw.split(LENGTH_TARGET_PLACEHOLDER).join(target)
}
