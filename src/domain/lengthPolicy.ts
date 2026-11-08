// lengthPolicy —— 一条回复该说多长（唯一真源）
// 角色 → 档位 → 字区间 → 提示词里的 {LENGTH_TARGET} 占位符。
// 试过在角色卡和通用规则里各写一遍长度要求，结果两边互相打架：同一模型对佩丽卡
// 中位 234 字、对埃特拉 26 字。所以只保留这一张表，规则文本里不再写绝对值。

/** 回复长度档位 */
export type ReplyLength = 'terse' | 'normal' | 'verbose'

export interface LengthTarget {
  /** 档位，便于排查「这个角色为什么这么短」 */
  level: ReplyLength
  /** 台词总量下界（字） */
  min: number
  /** 台词总量上界（字） */
  max: number
  /** 直接填进提示词的自然语言描述 */
  text: string
}

/**
 * 各档位的区间
 *
 * 量的是**台词**，括号里的动作描写不算：沉浸式下去掉描写后，玩家看到的字数
 * 正好落在区间内，两种模式手感才一致。区间是目标不是硬截断，超出不用处理。
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
 * 角色 → 档位，只登记与默认不同的
 *
 * 新角色若在角色卡里写了「极度简洁」，就在这里登记，别再往角色卡里写长度要求。
 */
export const LENGTH_BY_CHARACTER: Record<string, ReplyLength> = {
  // 角色卡要求「能用一个字绝不延伸」
  埃特拉: 'terse',
  狼卫: 'terse',
  卡契尔: 'terse',
  // 话多但不必到 verbose
  佩丽卡: 'normal',
  // 管理员不是可对话角色，但群里可能出现同名卡，钉住以免落到别的档位
  管理员: 'normal',
}

export const DEFAULT_REPLY_LENGTH: ReplyLength = 'normal'

export const LENGTH_TARGET_PLACEHOLDER = '{LENGTH_TARGET}'

/** 解析档位：精确命中优先，其次按最长子串命中（支持「佩丽卡(测试)」这类写法） */
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

export function resolveLengthTarget(characterName?: string): LengthTarget {
  return LENGTH_TARGET[resolveReplyLength(characterName)]
}

/** 幂等：文本里没有占位符就原样返回，所以拼装规则的地方可以无条件过一遍 */
export function fillLengthTarget(text: string, characterName?: string): string {
  const raw = text ?? ''
  if (raw.indexOf(LENGTH_TARGET_PLACEHOLDER) === -1) return raw
  const { text: target } = resolveLengthTarget(characterName)
  return raw.split(LENGTH_TARGET_PLACEHOLDER).join(target)
}
