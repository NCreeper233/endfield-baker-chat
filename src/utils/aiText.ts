// aiText —— 把一段 AI 回复切成多条气泡，以及括号描写的区间解析
// 分条与括号解析的唯一实现：单聊、群聊、渲染层都走这里，不得另写一份。

import { EMOJI_TOKEN_RE } from '../constants/emoji'

/** 还原双重编码残留的转义。顺序敏感：`\\` 必须先还原，否则后续替换会吃掉它的反斜杠 */
export function normalizeAiText(raw: string): string {
  return (raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\"/g, '"')
}

/** 左括号：在它**之前**断句 */
const OPEN_BRACKET = /[(（]/

/** 句末标点：在它**之后**断句。刻意不含 `.` —— 小数、缩写、省略号都会被误伤 */
const SENTENCE_END = /[。！？!?]/

/** 句末标点后紧跟这些时先不断，否则 `“走吧。”他笑了。` 会把右引号甩到下一段 */
const TRAILING_CLOSER = /[”’」』）】》〉"')]/

/** ≤ 此字数的分段不单独成条（`嗯。`、`（点头）` 各自成条会显得很碎） */
export const MIN_SEGMENT_CHARS = 10

interface RawSegment {
  text: string
  /** 这一段之前原本是换行。合并短段时据此还原分隔符，不能凭空增删断行 */
  br: boolean
  /** 首字符在原文里的下标，只有流式分段用（算已消费字符数） */
  start: number
  /** 尾后一位的下标，含义同 String#slice 的 end */
  end: number
}

/** 表情 token 记 1 个字，其余按码点计 */
function charCount(text: string): number {
  return Array.from(text.replace(EMOJI_TOKEN_RE, '\u3000')).length
}

function splitByNewline(text: string): RawSegment[] {
  let at = 0
  return text.split('\n').map((t, i) => {
    const start = at
    // +1 是被 split 吃掉的换行符
    at += t.length + 1
    return { text: t, br: i > 0, start, end: start + t.length }
  })
}

/**
 * 手写扫描而非正则 split：后行断言在 Safari 16.4 以下解析报错、整个模块会挂，
 * 且收尾标点要向前看一个字符才决定断不断。成对括号的内部不是断句点，
 * 否则 `（她笑了。然后转身离开）` 会被劈成两条半句旁白。
 */
function splitSmart(text: string): RawSegment[] {
  const out: RawSegment[] = []
  let buf = ''
  /** 上一个字符是句末标点，等看清下一个字符再决定断不断 */
  let atSentenceEnd = false
  let nextBr = false
  let bufStart = 0

  const bracketRanges = bracketPartRanges(text)
  /** 该位置是否在某对括号描写的内部（最外层括号自身不算） */
  const inBracket = (pos: number): boolean =>
    bracketRanges.some((r) => r.centered && pos > r.start && pos < r.end)

  const flush = (end: number) => {
    out.push({ text: buf, br: nextBr, start: bufStart, end })
    buf = ''
    nextBr = false
  }

  // 按**下标**遍历而非 for...of：判断断句点是否落在括号区间内必须知道位置
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (ch === '\n') {
      // 括号内的换行原样写回缓冲：这里不 flush，不写回就等于把字符吞掉
      if (inBracket(i)) {
        buf += '\n'
        atSentenceEnd = false
        continue
      }
      flush(i)
      nextBr = true
      atSentenceEnd = false
      bufStart = i + 1
      continue
    }

    if (OPEN_BRACKET.test(ch)) {
      if (!inBracket(i)) {
        flush(i)
        buf = ch
        atSentenceEnd = false
        bufStart = i
        continue
      }
      buf += ch
      atSentenceEnd = false
      continue
    }

    // 断完必须复位 atSentenceEnd（它表示「上一个字符」是句末标点）。漏掉复位会让
    // 标记一直挂着，从此每读一个字符都满足断句条件，整段被切成一字一段。
    if (atSentenceEnd && !TRAILING_CLOSER.test(ch) && !SENTENCE_END.test(ch) && !inBracket(i)) {
      flush(i)
      atSentenceEnd = false
      bufStart = i
    }

    buf += ch
    if (SENTENCE_END.test(ch)) atSentenceEnd = true
  }

  flush(text.length)
  return out
}

/**
 * 整段只有一对括号（允许后面跟句末标点）
 *
 * 末尾标点必须算进来：开启句末分条后 `(动作)。` 会单独成段，不认它就漏掉
 * 「只有动作没有台词」这一种。
 */
const PURE_BRACKET = /^[(（][^)）]*[)）][。！？!?]*$/

/**
 * 不变式：每条输出要么自己够长，要么至少和另一段待在一起。合并按原文分隔符还原，
 * 只改怎么分条、不改一个字符 —— 这段文本还要写进 AI 上下文。
 */
function mergeShortSegments(input: RawSegment[]): RawSegment[] {
  const out: RawSegment[] = []
  let buf: RawSegment[] = []

  const append = (a: RawSegment, b: RawSegment): RawSegment => ({
    text: a.text + (b.br ? '\n' : '') + b.text,
    br: a.br,
    // 区间取首段之头与末段之尾
    start: a.start,
    end: b.end,
  })
  const joinAll = (segs: RawSegment[]): RawSegment =>
    segs.reduce((acc, s) => append(acc, s))

  for (const seg of input) {
    buf.push(seg)
    // 够长就收一条（前面吸进来的短段跟着它走）
    if (charCount(seg.text) > MIN_SEGMENT_CHARS) {
      out.push(joinAll(buf))
      buf = []
    }
  }
  if (buf.length > 0) {
    // 结尾剩下的短段没有下一条可并：成串就自成一条，独苗并进上一条
    if (buf.length > 1 || out.length === 0) out.push(joinAll(buf))
    else out[out.length - 1] = append(out[out.length - 1], buf[0])
  }
  return out
}

/** 把一段回复切成多条气泡：归一化 → 切段 → 去空白 → 短段合并 → 纯括号段合并 */
export function splitAiSegments(raw: string, smartSplit = true): string[] {
  const normalized = normalizeAiText(raw)

  const rawSegments = (smartSplit ? splitSmart(normalized) : splitByNewline(normalized))
    .map((s) => ({ ...s, text: s.text.trim() }))
    .filter((s) => s.text.length > 0)

  const segments: string[] = []
  const pendingBrackets: string[] = []
  for (const { text: seg } of mergeShortSegments(rawSegments)) {
    if (PURE_BRACKET.test(seg)) {
      pendingBrackets.push(seg)
      continue
    }
    // 正常段：暂存的纯括号段并到它的开头
    const prefix = pendingBrackets.splice(0, pendingBrackets.length).join('')
    segments.push(prefix + seg)
  }
  // 结尾仍有纯括号段（整段回复全是括号）：并入上一段，无上一段则保留
  if (pendingBrackets.length > 0) {
    const tail = pendingBrackets.join('')
    if (segments.length > 0) segments[segments.length - 1] += `\n${tail}`
    else segments.push(tail)
  }
  return segments
}

/** 一条消息的渲染部件：centered 为 true 时走居中文本，文本已去括号 */
export interface MessagePart {
  text: string
  centered: boolean
}

/**
 * 一条消息里各部件在原文中的区间
 *
 * 相邻区间首尾相接，拼起来恒等于原文 —— 逐拍显示「只追加、最后等于原文」的
 * 前提就是它。
 */
export interface BracketPartRange {
  /** 起下标（含） */
  start: number
  /** 止下标（不含），最后一个区间恒等于 text.length */
  end: number
  /** true = 括号描写（含最外层括号） */
  centered: boolean
}

const OPEN_PAREN = new Set(['(', '（'])
/** 左右**不要求同型**：模型常写出 `(动作）` 这种混用 */
const CLOSE_PAREN = new Set([')', '）'])

/**
 * 括号解析的唯一实现：渲染拆分与逐拍显示都建在它上面，两边不会对「哪里算括号描写」
 * 产生分歧。未闭合括号与空括号一律当普通文字，绝不静默吞掉内容。
 */
export function bracketPartRanges(text: string): BracketPartRange[] {
  const ranges: BracketPartRange[] = []
  /** 已切出去的位置，即下一个气泡区间的起点 */
  let cursor = 0
  let i = 0
  while (i < text.length) {
    if (!OPEN_PAREN.has(text[i])) {
      i++
      continue
    }
    // 找配对的最外层右括号（深度计数，支持嵌套）
    let depth = 0
    let end = -1
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (OPEN_PAREN.has(c)) depth++
      else if (CLOSE_PAREN.has(c) && --depth === 0) {
        end = j
        break
      }
    }
    // 未闭合或空括号：当普通文字继续往后扫，后面的括号仍可能闭合
    if (end === -1 || !text.slice(i + 1, end).trim()) {
      i = end === -1 ? i + 1 : end + 1
      continue
    }
    if (i > cursor) ranges.push({ start: cursor, end: i, centered: false })
    ranges.push({ start: i, end: end + 1, centered: true })
    cursor = end + 1
    i = end + 1
  }
  if (cursor < text.length) ranges.push({ start: cursor, end: text.length, centered: false })
  return ranges
}

/**
 * 取 1 而不是 3：角色卡要求「能用一个字绝不延伸」，`嗯。`、`好。` 是正常台词，
 * 阈值取 3 会把它们判成无台词并丢弃整条回复。
 */
export const MIN_DIALOGUE_CHARS = 1

/**
 * 去掉括号描写、空白与表情 token 后剩下的码点数。
 * 未闭合括号之后的文字也算描写；表情 token 记 0 字，故 `(微笑)[sns_emoji_001]`
 * 依然是「没有台词」—— 这种回复写进上下文后模型会跟着学。
 */
export function countDialogueChars(text: string): number {
  const raw = (text ?? '').replace(EMOJI_TOKEN_RE, '')
  let depth = 0
  let count = 0
  // for...of 按码点遍历，emoji 不会被算成两个字
  for (const ch of raw) {
    if (OPEN_PAREN.has(ch)) {
      depth++
      continue
    }
    if (CLOSE_PAREN.has(ch)) {
      if (depth > 0) depth--
      continue
    }
    if (depth > 0) continue
    if (/\s/.test(ch)) continue
    count++
  }
  return count
}

/**
 * 流式只能切它之前的内容：括号里的字可能还没到，切出来的半句描写会被当成一条消息
 * 播出去并写进历史，之后 playedCount 就对不上了。
 */
function stablePrefixLength(text: string): number {
  let depth = 0
  let lastOpen = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (OPEN_PAREN.has(ch)) {
      if (depth === 0) lastOpen = i
      depth++
    } else if (CLOSE_PAREN.has(ch) && depth > 0) {
      depth--
      if (depth === 0) lastOpen = -1
    }
  }
  return depth > 0 && lastOpen >= 0 ? lastOpen : text.length
}

export interface StreamingSplit {
  /** 已定稿的分段，后续增量不会再改写它们 */
  segments: string[]
  /** 已消费的字符数，相对传入的**原始**缓冲 */
  consumed: number
}

/**
 * 与 splitAiSegments 的差别有三处：未闭合括号内不切；末尾两段不播（还会被后续增量
 * 或纯括号段改写）；返回 consumed 让调用方切缓冲，而不是用 indexOf 猜位置。
 */
export function splitAiSegmentsStreaming(raw: string, smartSplit = true): StreamingSplit {
  const empty: StreamingSplit = { segments: [], consumed: 0 }
  if (!raw) return empty

  const normalized = normalizeAiText(raw)
  // 归一化会改变长度，此时 consumed 无法映射回原始缓冲 —— 一拍都不播，
  // 等 done 帧一次播完。这类残留极少见，退化的只是节奏。
  if (normalized.length !== raw.length) return empty

  const prefix = normalized.slice(0, stablePrefixLength(normalized))
  if (!prefix) return empty

  const rawSegments = (smartSplit ? splitSmart(prefix) : splitByNewline(prefix))
    .map((s) => ({ ...s, text: s.text.trim() }))
    .filter((s) => s.text.length > 0)
  const groups = mergeShortSegments(rawSegments)

  // 最后一组永远不消费；它是纯括号段时，倒数第二组也得留着 ——
  // 那条括号段没有后继台词时会被并回前一组，提前播就丢字。
  let stable = groups.length - 1
  if (stable > 0 && PURE_BRACKET.test(groups[groups.length - 1].text)) stable--
  while (stable > 0 && PURE_BRACKET.test(groups[stable - 1].text)) stable--
  if (stable === 0) return empty

  const segments: string[] = []
  const pending: string[] = []
  for (let i = 0; i < stable; i++) {
    const seg = groups[i].text
    if (PURE_BRACKET.test(seg)) {
      pending.push(seg)
      continue
    }
    segments.push(pending.splice(0, pending.length).join('') + seg)
  }
  if (pending.length > 0) {
    // 兜底，理论上到不了：真到了就并进上一段，绝不单独播一条只有括号的气泡
    if (segments.length === 0) return empty
    segments[segments.length - 1] += `\n${pending.join('')}`
  }

  // 首帧就只剩未闭合括号时 stable 可能是 0，此时 groups[-1] 是 undefined
  const lastGroup = groups[stable - 1]
  if (!lastGroup) return empty
  return { segments, consumed: lastGroup.end }
}

/**
 * 相邻的括号描写合并成同一条居中文本，否则两块横线会叠在一起。
 *
 * 括号出现在**哪个位置都算**（开头 / 中间 / 末尾），对方侧与我方侧共用这一份：
 * 两边对「哪里算括号描写」绝不能有两套判断，否则开关叠起来就会互相打架。
 * ⚠️ 结果只用于渲染：落库与进上下文的文本必须保留括号原文，否则模型下一轮就不写了。
 */
export function splitBracketParts(text: string): MessagePart[] {
  const parts: MessagePart[] = []
  for (const r of bracketPartRanges(text)) {
    if (r.centered) {
      // 区间含最外层括号，居中文本去掉它（内层括号保留）
      const inner = text.slice(r.start + 1, r.end - 1).trim()
      const last = parts[parts.length - 1]
      if (last && last.centered) last.text += `\n${inner}`
      else parts.push({ text: inner, centered: true })
    } else {
      const t = text.slice(r.start, r.end).trim()
      if (t) parts.push({ text: t, centered: false })
    }
  }
  // 空文本 / 全空白：保持单气泡
  return parts.length > 0 ? parts : [{ text, centered: false }]
}
