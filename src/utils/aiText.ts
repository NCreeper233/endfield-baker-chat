// =============================================================================
// aiText —— AI 回复文本的归一化与分段
// -----------------------------------------------------------------------------
// 单聊与群聊共用同一套"把一段回复切成多条气泡"的规则:
//   1. 归一化转义:部分模型/代理双重 JSON 编码,JSON.parse 后仍残留字面量
//      \\n / \\" / \\r,需按固定顺序还原(先处理双反斜杠)
//   2. 切段(由设置项「智能消息分条」控制,默认开启):
//        开启 → 换行处 / 每个左括号之前 / 每个句末标点之后,三处都切
//               (但**成对的括号描写内部不切**:动作/神态描写永远是一个整体)
//        关闭 → 只按换行切(与本功能加入之前完全一致)
//   3. 去空白、丢空段
//   4. 短段合并:不足 MIN_SEGMENT_CHARS 个字的段不单独成条,并入下一条
//   5. 合并"纯括号段"到相邻段
//
// 第 4 条的原因:模型偶发把括号描写单独另起一行(如 "(动作)\n\n台词")。
// 若照原样分段,会出现只有括号描写的独立气泡,写进 AI 上下文后,下一轮模型
// 会模仿"只有括号的 assistant 回复",导致整段回复退化成只有动作没有台词。
// 这条守卫在第 2 条落地后依然必要:切段本身也会切出纯括号段
// (如 "(动作A)(动作B) 台词"、"台词。(微笑)")。
//
// 本模块是分段的**唯一实现** —— useAiChat(单聊)与 useGroupChat(群聊)
// 都调 splitAiSegments。此前单聊曾内联一份等价拷贝,改规则要改两处、
// 极易走散,已合并。
//
// 另有 splitBracketParts(渲染层):把**一条**消息拆成"气泡段 + 居中段",
// 供设置项「括号描写居中」在渲染层使用。它与 splitAiSegments 是两个层面:
//   - splitAiSegments:一次回复 → 几条消息(落库,进 AI 上下文)
//   - splitBracketParts:一条消息 → 几个渲染部件(只在渲染层,不落库)
// 故后者绝不可用于写入 store / contextHistory —— 括号原文必须原样喂给模型。
// =============================================================================

import { EMOJI_TOKEN_RE } from '../constants/emoji'

/**
 * 归一化 AI 原始回复里的残留转义序列
 *
 * 处理顺序敏感:`\\\\` → `\` 必须先于 `\n` / `\"`,否则会漏掉第一个反斜杠。
 */
export function normalizeAiText(raw: string): string {
  return (raw ?? '')
    .replace(/\r\n/g, '\n')   // Windows 换行统一
    .replace(/\\\\/g, '\\')   // 双反斜杠 → 单反斜杠
    .replace(/\\n/g, '\n')    // 字面量 \n → 实际换行
    .replace(/\\r/g, '')      // 清除残留字面量 \r
    .replace(/\\"/g, '"')     // 字面量 \" → "
}

/** 左括号:在其**之前**断句(半角与全角都认,中文角色扮演里两种写法都常见) */
const OPEN_BRACKET = /[(（]/

/**
 * 句末标点:在其**之后**断句
 *
 * 半角 `!` `?` 一并认 —— 中英混排里很常见,语义同样是句末。
 * 刻意**不含句点 `.`**:小数点、英文缩写、省略号都会被误伤,
 * 收益远小于风险。
 */
const SENTENCE_END = /[。！？!?]/

/**
 * 收尾标点:句末标点后面若紧跟这些,不能立刻断
 *
 * 否则 `“走吧。”他笑了。` 会被切成 `“走吧。` + `”他笑了。`,
 * 把右引号甩到下一段开头。
 */
const TRAILING_CLOSER = /[”’」』）】》〉"')]/

/**
 * 短段阈值(字)
 *
 * 分条后不足(≤)此字数的分段**不单独成条**,并入相邻段 —— 模型常吐
 * `嗯。` / `好。` / `不过——` / `（点头）` 这类极短行,各自成条会显得很碎。
 * 调大 = 更少的、更长的气泡;调小 = 更贴近"一句一条"。
 */
export const MIN_SEGMENT_CHARS = 10

/** 分段中间表示:文本 + 与上一段之间原本是否为换行 */
interface RawSegment {
  text: string
  /**
   * 这一段之前原本就是换行
   *
   * 合并短段时用它决定用换行还是直接相接 —— 原文里的换行必须原样保留,
   * 否则合并会凭空抹掉/添加断行,而这段文本还要写进 AI 上下文。
   */
  br: boolean
}

/** 统计"字数":表情 token(`[sns_emoji_001]`)记 1 个字,其余按码点计 */
function charCount(text: string): number {
  return Array.from(text.replace(EMOJI_TOKEN_RE, '\u3000')).length
}

/** 旧版切段:只按换行 */
function splitByNewline(text: string): RawSegment[] {
  return text.split('\n').map((t, i) => ({ text: t, br: i > 0 }))
}

/**
 * 智能切段:换行 / 每个左括号之前 / 每个句末标点之后
 *
 * 手写扫描而不是正则 split:
 *   1. "句末标点之后"在正则里要么用后行断言 `(?<=…)`(Safari 16.4 以下会直接
 *      解析报错,整个模块挂掉),要么用捕获组再拼接(三条规则混在一起很容易写错)
 *   2. 收尾标点需要**向前看一个字符**才能决定断不断,split 表达不了
 *
 * "段首就是左括号"会先推出一个空段,由调用方统一 filter 掉,不会产生空气泡。
 *
 * ⚠️ **成对的括号描写整体不拆**(2026-10-04 补):区间内部的换行、句末标点、
 *    嵌套左括号都不是断句点。否则 `（她笑了。然后转身离开）` 会被切成
 *    `（她笑了。` + `然后转身离开）` —— 一句动作/神态描写被劈成两条气泡,
 *    玩家看到的是半句旁白接半句旁白。区间判定复用 bracketPartRanges
 *    (括号解析的唯一实现),因此未闭合 / 空括号不在区间内,模型偶发漏写右括号时
 *    分条不会整体失效。
 */
function splitSmart(text: string): RawSegment[] {
  const out: RawSegment[] = []
  let buf = ''
  /** 上一个字符是句末标点,等看清下一个字符再决定断不断 */
  let atSentenceEnd = false
  /** 下一段是否紧跟在换行之后(供合并时还原分隔符) */
  let nextBr = false

  /** 成对括号描写的区间(只取 centered 的那些 = 括号本身) */
  const bracketRanges = bracketPartRanges(text)
  /** 该位置是否落在某对括号描写的**内部**(最外层括号自身不算"内部") */
  const inBracket = (pos: number): boolean =>
    bracketRanges.some((r) => r.centered && pos > r.start && pos < r.end)

  /** 收段:把当前缓冲推出去(调用方负责复位 atSentenceEnd) */
  const flush = () => {
    out.push({ text: buf, br: nextBr })
    buf = ''
    nextBr = false
  }

  // 按**下标**遍历(而非 for...of):判断断句点是否落在括号区间内必须知道位置。
  // 代理对(emoji)按码元逐个拼接,结果与原字符串一致,不改变任何字符。
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (ch === '\n') {
      // 括号内部的换行不切段:换行**原样写回缓冲**
      // (nextBr 只能记录"段首是换行",这里不 flush,不写回就等于把字符吞掉了)
      if (inBracket(i)) {
        buf += '\n'
        atSentenceEnd = false
        continue
      }
      flush()
      nextBr = true
      atSentenceEnd = false
      continue
    }

    if (OPEN_BRACKET.test(ch)) {
      // 括号内部的嵌套左括号不切;只有括号**外**的左括号才在它之前断句
      if (!inBracket(i)) {
        flush()
        buf = ch
        atSentenceEnd = false
        continue
      }
      buf += ch
      atSentenceEnd = false
      continue
    }

    // 句末标点之后:下一个字符不是收尾标点、也不是连着的句末标点、且不在括号内,
    // 才在此断开(连着的 `！？` / `。！` 属于同一句的收尾,不该从中间切开)
    //
    // ⚠️ 断完必须把 atSentenceEnd 复位:它表示"**上一个字符**是句末标点"。
    // 漏掉复位会让这个标记一直挂着,从此刻起每读一个字符都满足断句条件,
    // 文本被切成一字一段 —— 表现是"分条看起来失效了"(单字段全被短段合并
    // 又拼回去,合并边界与设计不符)。
    if (atSentenceEnd && !TRAILING_CLOSER.test(ch) && !SENTENCE_END.test(ch) && !inBracket(i)) {
      flush()
      atSentenceEnd = false
    }

    buf += ch
    if (SENTENCE_END.test(ch)) atSentenceEnd = true
  }

  flush()
  return out
}

/**
 * 整段只有一对括号(允许后面跟句末标点)
 *
 * 末尾那个可选标点是必须的:开启句末分条后,`(动作)。` 会成为一个独立段,
 * 若不算它作"纯括号段",这条守卫就形同虚设 —— 正是它要防的"只有动作没有台词"。
 */
const PURE_BRACKET = /^[(（][^)）]*[)）][。！？!?]*$/

/**
 * 短段合并:不足 MIN_SEGMENT_CHARS 个字的原始分段,不单独成条
 *
 * 不变式:**每条输出要么自己够长,要么至少和另一段待在一起** —— 任何一段都不会
 * 孤零零成条。做法:
 *   - 逐段累积,遇到"够长"的一段就收一条(短段总是被它后面那条带走)
 *   - 结尾剩下的短段没有下一条可并:
 *       成串(≥2 段)→ 它们彼此作伴,自成一条
 *       独苗(1 段)→ 并入**上一条**(否则它还是"单独出现");整条回复只有它一段时
 *                     无上一条可并,只能自己成条
 *   - 合并按原文分隔符还原:原本是换行就补换行,否则直接相接 ——
 *     合并只改"怎么分条",不改一个字符(这段文本还要写进 AI 上下文)
 *
 * 与 PURE_BRACKET 守卫的关系:两者都在"分条"这一层,顺序是先并短段、再并纯括号段
 * (守卫判据与字数无关,故仍独立生效)。
 */
function mergeShortSegments(input: RawSegment[]): RawSegment[] {
  const out: RawSegment[] = []
  /** 正在累积的一条(把前面若干短段吸进来) */
  let buf: RawSegment[] = []

  /** 把 b 接到 a 后面(按 b 原本的分隔符还原换行) */
  const append = (a: RawSegment, b: RawSegment): RawSegment => ({
    text: a.text + (b.br ? '\n' : '') + b.text,
    br: a.br,
  })
  const joinAll = (segs: RawSegment[]): RawSegment =>
    segs.reduce((acc, s) => append(acc, s))

  for (const seg of input) {
    buf.push(seg)
    // 这一段够长:它(连同前面吸进来的短段)自成一条
    if (charCount(seg.text) > MIN_SEGMENT_CHARS) {
      out.push(joinAll(buf))
      buf = []
    }
  }
  if (buf.length > 0) {
    if (buf.length > 1 || out.length === 0) out.push(joinAll(buf))
    else out[out.length - 1] = append(out[out.length - 1], buf[0])
  }
  return out
}

/**
 * 把一段 AI 回复切成用于显示的多条气泡
 *
 * 规则顺序:归一化 → 切段(智能 / 只按换行)→ 去空白 → **短段合并** → 纯括号段合并
 *
 * @param raw        模型返回的原始文本
 * @param smartSplit 是否启用智能分条;默认开启。
 *                   由设置项「智能消息分条」驱动,关闭即退回只按换行切
 *                   (短段合并与开关无关:它只决定"多短的一条不单独出现")
 * @returns          分段数组(已去除空段);无有效内容时返回空数组
 */
export function splitAiSegments(raw: string, smartSplit = true): string[] {
  const normalized = normalizeAiText(raw)

  const rawSegments = (smartSplit ? splitSmart(normalized) : splitByNewline(normalized))
    .map((s) => ({ text: s.text.trim(), br: s.br }))
    .filter((s) => s.text.length > 0)

  const segments: string[] = []
  const pendingBrackets: string[] = []
  for (const { text: seg } of mergeShortSegments(rawSegments)) {
    if (PURE_BRACKET.test(seg)) {
      pendingBrackets.push(seg)
      continue
    }
    // 正常段:把暂存的纯括号段并到它的开头
    const prefix = pendingBrackets.splice(0, pendingBrackets.length).join('')
    segments.push(prefix + seg)
  }
  // 结尾仍有纯括号段(整段回复全是括号):并入上一段末尾,无上一段则保留
  if (pendingBrackets.length > 0) {
    const tail = pendingBrackets.join('')
    if (segments.length > 0) segments[segments.length - 1] += `\n${tail}`
    else segments.push(tail)
  }
  return segments
}

// =============================================================================
// 括号描写居中(渲染层部件拆分)
// -----------------------------------------------------------------------------

/**
 * 一条消息的渲染部件
 *
 * - centered=false:普通气泡段(走气泡渲染)
 * - centered=true :括号内的动作/神态描写(走居中文本渲染,文本已去括号)
 */
export interface MessagePart {
  text: string
  centered: boolean
}

/**
 * 一段文本里"部件区间"的原始下标
 *
 * 相邻区间**首尾相接**:把它们按顺序拼起来恒等于原文(不丢一个字符)。
 * 这是逐拍显示能做"只追加、最后等于原文"的前提。
 */
export interface BracketPartRange {
  /** 起下标(含) */
  start: number
  /** 止下标(不含);最后一个区间恒等于 text.length */
  end: number
  /** true = 括号描写(区间**含最外层括号**);false = 括号外的文字 */
  centered: boolean
}

/** 左括号(半角 / 全角都认,中文角色扮演里两种写法都常见) */
const OPEN_PAREN = new Set(['(', '（'])
/** 右括号(与左括号**不要求配对同型**:模型常写出 `(动作）` 这类混用) */
const CLOSE_PAREN = new Set([')', '）'])

/**
 * 扫出文本里的"括号描写区间"(其余部分即气泡文字区间)
 *
 * 规则:
 *   - 每对配对的括号 `(...)` / `（...）`(允许嵌套,取最外层)单独成为一个居中区间
 *   - 区间**首尾相接**,拼起来 = 原文
 *   - 刻意保守的两种情况一律当普通文字,不切区间(绝不静默吞掉内容):
 *       括号未闭合(`（笑`)、括号内容为空或只有空白(`()`)
 *
 * 本函数是括号解析的唯一实现:渲染拆分(splitBracketParts)与逐拍显示
 * (useReplyReveal)都建立在它之上,两边不可能对"哪里算括号描写"产生分歧。
 *
 * @param text 消息文本(支持 \n 换行)
 * @returns    区间数组;无括号时长度为 1 且 centered=false
 */
export function bracketPartRanges(text: string): BracketPartRange[] {
  const ranges: BracketPartRange[] = []
  /** 已切出去的位置(下一个气泡区间的起点) */
  let cursor = 0
  let i = 0
  while (i < text.length) {
    if (!OPEN_PAREN.has(text[i])) {
      i++
      continue
    }
    // 找与 text[i] 配对的最外层右括号(深度计数,支持嵌套)
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
    // 未闭合 / 空括号:当普通文字,继续往后扫(后面的括号仍可能闭合)
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
 * 把一条消息拆成"气泡段 + 居中段"
 *
 * 规则:
 *   1. 每对配对的括号 `(...)` / `（...）`(允许嵌套,取最外层)单独成为一段居中部件
 *   2. 括号**外**的文字按出现顺序成为气泡段(两端空白去掉,空段丢弃)
 *   3. 相邻的括号描写合并成**同一条**居中文本(用换行分隔),避免两块横线叠在一起
 *      —— 模型常连着写 `(动作A)(动作B) 台词`
 *
 * ⚠️ 返回值只用于渲染。落库 / 进 AI 上下文的文本必须保持原样(含括号):
 * 模型看到的 assistant 历史若全是"没有括号的动作",下一轮就会停止写括号描写。
 *
 * @param text 消息文本(支持 \n 换行)
 * @returns    渲染部件数组;无括号时长度为 1 且 centered=false
 */
export function splitBracketParts(text: string): MessagePart[] {
  const parts: MessagePart[] = []
  for (const r of bracketPartRanges(text)) {
    if (r.centered) {
      // 区间含最外层括号,居中文本要去掉它(内层括号原样保留)
      const inner = text.slice(r.start + 1, r.end - 1).trim()
      const last = parts[parts.length - 1]
      if (last && last.centered) last.text += `\n${inner}`
      else parts.push({ text: inner, centered: true })
    } else {
      const t = text.slice(r.start, r.end).trim()
      if (t) parts.push({ text: t, centered: false })
    }
  }
  // 没有可拆的部件(空文本 / 全空白):保持"单气泡"的既有行为
  return parts.length > 0 ? parts : [{ text, centered: false }]
}

/**
 * 只把**最前面**那一对括号抽成居中段(「居中我方括号内容」用)
 *
 * 与 splitBracketParts 的区别:玩家自己打的消息**只处理开头那段旁白**,
 * 后面再出现的括号原样留在气泡里 —— 不然一句
 *   「（看了眼窗外）今天天气不错（顺口一提）」
 * 会被拆成三段,玩家自己写的正文反而被切碎了。
 *
 * 判定"开头"以 `text.slice(0, first.start).trim()` 为空为准:允许括号前有
 * 空格 / 换行,但只要有实际文字,就不是开头,整条按普通气泡返回。
 *
 * ⚠️ 同 splitBracketParts:返回值只用于渲染,落库 / 进 AI 上下文的文本保持含括号原文。
 *
 * @param text 我方消息文本
 * @returns    部件数组;开头不是括号时长度为 1 且 centered=false
 */
export function splitLeadingBracketParts(text: string): MessagePart[] {
  const ranges = bracketPartRanges(text)
  // 跳过开头"只有空白"的非居中区间:允许括号前有空格 / 换行
  let idx = 0
  while (
    idx < ranges.length &&
    !ranges[idx].centered &&
    !text.slice(ranges[idx].start, ranges[idx].end).trim()
  ) {
    idx++
  }
  const first = ranges[idx]
  if (!first || !first.centered) return [{ text, centered: false }]
  // 括号前若有实际文字,说明它不是"开头那一段"(双保险,正常已被上面的循环排除)
  if (text.slice(0, first.start).trim()) return [{ text, centered: false }]

  const inner = text.slice(first.start + 1, first.end - 1).trim()
  const rest = text.slice(first.end).trim()
  const parts: MessagePart[] = []
  if (inner) parts.push({ text: inner, centered: true })
  if (rest) parts.push({ text: rest, centered: false })
  // 整条就是一对括号(没有正文):保留居中段即可;空括号则退回原样单气泡
  return parts.length > 0 ? parts : [{ text, centered: false }]
}
