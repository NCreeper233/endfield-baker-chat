// tokenEstimate —— 没有服务商 usage 时本地估算 token 数
// 不用分词器：安卓 WebView 与任意服务商都没有唯一正确的分词表，改用字符启发式 +
// 自校准（实际/估算 的 EMA 比值）。量级参考：中文约 0.6 token/字，英文约 4 字符/token。

/** CJK / 全角字符（汉字 + 假名 + 全角标点与字母） */
const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g

const CJK_CHARS_PER_TOKEN = 1.6

const OTHER_CHARS_PER_TOKEN = 4

/** 单条消息的 role / 分隔符等协议开销 */
const PER_MESSAGE_OVERHEAD = 4

/** 整个请求的框架开销 */
const REQUEST_OVERHEAD = 3

/** 单张图片的经验常数：分辨率与分块策略无法从 dataURL 反推，取常规截图的中间量级 */
const IMAGE_TOKEN_ESTIMATE = 800

export type EstimableContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >

export interface EstimableMessage {
  role: string
  content: EstimableContent
}

export interface EstimableEntry {
  text: string
  image?: string
}

/** 未乘校准比值 */
export function estimateText(text: string): number {
  if (!text) return 0
  const cjkCount = (text.match(CJK_RE) || []).length
  const otherCount = text.length - cjkCount
  return Math.ceil(cjkCount / CJK_CHARS_PER_TOKEN + otherCount / OTHER_CHARS_PER_TOKEN)
}

function estimateContent(content: EstimableContent): number {
  if (typeof content === 'string') return estimateText(content)
  let total = 0
  for (const part of content) {
    if (part.type === 'text') total += estimateText(part.text)
    else total += IMAGE_TOKEN_ESTIMATE
  }
  return total
}

/** @param ratio 自校准比值（实际/估算），1 = 未校准 */
export function estimateMessages(messages: EstimableMessage[], ratio = 1): number {
  let total = REQUEST_OVERHEAD
  for (const msg of messages) {
    total += PER_MESSAGE_OVERHEAD + estimateContent(msg.content)
  }
  return Math.ceil(total * ratio)
}

/** 单条历史条目的体积，压缩规划需要逐条累加前缀 */
export function estimateEntry(entry: EstimableEntry): number {
  return PER_MESSAGE_OVERHEAD + estimateText(entry.text) + (entry.image ? IMAGE_TOKEN_ESTIMATE : 0)
}

/** 历史条目数组的体积，不必先转成消息 */
export function estimateEntries(entries: EstimableEntry[], ratio = 1): number {
  let total = 0
  for (const entry of entries) total += estimateEntry(entry)
  return Math.ceil(total * ratio)
}

/** 指数滑动平均；夹在 [0.5, 3]，避免单次异常上报把估算器带偏 */
export function nextCalibrationRatio(prev: number, estimated: number, actual: number): number {
  if (estimated <= 0 || actual <= 0) return prev
  const sample = actual / estimated
  const next = prev * 0.7 + sample * 0.3
  return Math.min(3, Math.max(0.5, next))
}
