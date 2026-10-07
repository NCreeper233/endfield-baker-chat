// =============================================================================
// token 估算(tokenEstimate)
// -----------------------------------------------------------------------------
// 用途:在没有服务商 usage 上报时,本地估算请求的输入 token 数,
//       供"上下文占用"显示与压缩触发判断使用。
//
// 为什么不用分词器:
//   项目无新依赖约束(打包环境含 Android WebView),且自定义 API 面向任意
//   服务商,没有唯一正确的分词表。此处采用字符启发式 + 自校准:
//     - 实测/上报到真实 prompt_tokens 后,维护 实际值/估算值 的 EMA 比值,
//       后续估算乘以该比值,使误差随使用收敛。
//
// 参考量级(DeepSeek 官方口径):1 个中文字符 ≈ 0.6 token;英文约 4 字符/token。
// =============================================================================

/** CJK / 全角字符匹配(中日韩统一表意文字 + 假名 + 全角标点与字母) */
const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g

/** 每 token 对应的中文字符数(约 1/0.6) */
const CJK_CHARS_PER_TOKEN = 1.6

/** 每 token 对应的非中文字符数 */
const OTHER_CHARS_PER_TOKEN = 4

/** 单条消息的 role / 分隔符等协议框架开销(token) */
const PER_MESSAGE_OVERHEAD = 4

/** 整个请求的框架开销(token) */
const REQUEST_OVERHEAD = 3

/**
 * 单张图片的 token 估算(经验常数)
 *
 * 视觉模型的图片开销取决于分辨率与分块策略(约 85 基础 + 170/块),
 * dataURL 字节数无法可靠换算,故取一张常规截图的中间量级。
 * 该常数误差由自校准比值部分吸收。
 */
const IMAGE_TOKEN_ESTIMATE = 800

/** 可估算的消息内容:纯文本,或 OpenAI Vision 的内容数组 */
export type EstimableContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >

/** 可估算的消息(结构化类型,与 llm.ts 的 LlmMessage 兼容) */
export interface EstimableMessage {
  role: string
  content: EstimableContent
}

/** 可估算的历史条目(与 stores/chat 的 contextHistory 元素兼容) */
export interface EstimableEntry {
  text: string
  image?: string
}

/** 估算纯文本的 token 数(未乘校准比值) */
export function estimateText(text: string): number {
  if (!text) return 0
  const cjkCount = (text.match(CJK_RE) || []).length
  const otherCount = text.length - cjkCount
  return Math.ceil(cjkCount / CJK_CHARS_PER_TOKEN + otherCount / OTHER_CHARS_PER_TOKEN)
}

/** 估算消息内容(文本或 Vision 数组)的 token 数(未乘校准比值) */
function estimateContent(content: EstimableContent): number {
  if (typeof content === 'string') return estimateText(content)
  let total = 0
  for (const part of content) {
    if (part.type === 'text') total += estimateText(part.text)
    else total += IMAGE_TOKEN_ESTIMATE
  }
  return total
}

/**
 * 估算完整消息数组的 token 数
 *
 * @param messages 消息数组
 * @param ratio    自校准比值(实际/估算;默认 1 表示未校准)
 */
export function estimateMessages(messages: EstimableMessage[], ratio = 1): number {
  let total = REQUEST_OVERHEAD
  for (const msg of messages) {
    total += PER_MESSAGE_OVERHEAD + estimateContent(msg.content)
  }
  return Math.ceil(total * ratio)
}

/**
 * 估算单条历史条目的 token 数(未乘校准比值)
 *
 * 压缩规划需要逐条累加前缀体积,故单独暴露。
 */
export function estimateEntry(entry: EstimableEntry): number {
  return PER_MESSAGE_OVERHEAD + estimateText(entry.text) + (entry.image ? IMAGE_TOKEN_ESTIMATE : 0)
}

/**
 * 估算历史条目数组的 token 数(不含消息框架开销以外的东西)
 *
 * 用于压缩规划:不需要真正把条目转成消息即可算出体积。
 *
 * @param entries 历史条目
 * @param ratio   自校准比值
 */
export function estimateEntries(entries: EstimableEntry[], ratio = 1): number {
  let total = 0
  for (const entry of entries) total += estimateEntry(entry)
  return Math.ceil(total * ratio)
}

/**
 * 计算下一个自校准比值(指数滑动平均)
 *
 * 仅在拿到服务商真实 usage 时调用;比值被夹在 [0.5, 3] 内,
 * 避免单次异常上报把估算器带偏。
 *
 * @param prev       上一次比值
 * @param estimated  本地估算值
 * @param actual     服务商上报的真实值
 */
export function nextCalibrationRatio(prev: number, estimated: number, actual: number): number {
  if (estimated <= 0 || actual <= 0) return prev
  const sample = actual / estimated
  const next = prev * 0.7 + sample * 0.3
  return Math.min(3, Math.max(0.5, next))
}
