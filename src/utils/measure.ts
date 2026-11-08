// measure —— 气泡文本尺寸测量
// canvas 先估宽，再用隐藏 ruler DOM 实测行数与最宽行，取较大值；只用 canvas 会因误差
// 导致气泡塌陷。字体/字号/边距收敛为 BubbleMetrics，移动端由几何层传入。

import { emojiToHtml, measureTextWithEmoji } from '../constants/emoji'
import type { MessageSide, RectSize } from '../types/chat'

/** rect 左侧留给尾巴的空间；mine 侧右侧也留同样空间 */
export const BUBBLE_TAIL_OFFSET = 8.2

/** 容器跟随过渡尺寸，rect 右缘 = svgW - 尾巴偏移，任何时刻 rect 都在 svg 内 */
export function bubbleSvgWidth(width: number, side: MessageSide): number {
  return BUBBLE_TAIL_OFFSET + width + (side === 'mine' ? BUBBLE_TAIL_OFFSET : 0)
}

export const BUBBLE_FONT_SIZE = 20.88
/** 字号 × 1.5 */
export const BUBBLE_LINE_HEIGHT = BUBBLE_FONT_SIZE * 1.5
export const BUBBLE_PAD_X = 13
export const BUBBLE_PAD_Y = 9
/** 单字短消息也保持圆角形状 */
export const BUBBLE_MIN_W = 51.76
export const BUBBLE_MIN_H = 42.47
/** 一行行高 + 上下 padding：加载气泡与单行文字气泡据此对齐 */
export const BUBBLE_SINGLE_LINE_H = BUBBLE_LINE_HEIGHT + BUBBLE_PAD_Y * 2
/** 文字气泡从该尺寸过渡到自身尺寸 */
export const LOADING_RECT: RectSize = { w: 100, h: BUBBLE_SINGLE_LINE_H }
/** 桌面默认值；移动端由几何层传入更小值 */
const BUBBLE_MAX_W = 660
const BUBBLE_INNER_MAX_W = BUBBLE_MAX_W - BUBBLE_PAD_X * 2

/** 单位均为 px */
export interface BubbleMetrics {
  fontSize: number
  lineHeight: number
  padX: number
  padY: number
  minW: number
  minH: number
}

export const DESKTOP_BUBBLE_METRICS: BubbleMetrics = {
  fontSize: BUBBLE_FONT_SIZE,
  lineHeight: BUBBLE_LINE_HEIGHT,
  padX: BUBBLE_PAD_X,
  padY: BUBBLE_PAD_Y,
  minW: BUBBLE_MIN_W,
  minH: BUBBLE_MIN_H,
}

/** 量出气泡外框尺寸；innerMax 为内容最大宽度，超出换行 */
export function measureBubble(
  text: string,
  innerMax: number = BUBBLE_INNER_MAX_W,
  metrics: BubbleMetrics = DESKTOP_BUBBLE_METRICS,
): BubbleBox {
  return measureWith(
    {
      innerMax,
      padX: metrics.padX,
      padY: metrics.padY,
      minW: metrics.minW,
      minH: metrics.minH,
      fontSize: metrics.fontSize,
      lineHeight: metrics.lineHeight,
    },
    text,
  )
}
/** canvas 与 ruler 必须共用同一字体栈 */
export const BUBBLE_FONT = `"HarmonyOS Sans SC Medium", "HarmonyOS Sans SC", "Microsoft YaHei", sans-serif`

/** 全局单飞：字体只等一次，且该任务永不 reject */
let bubbleFontPromise: Promise<void> | null = null

/**
 * 只在截图/导出前 await（captureImage 调用）：font-display:swap 下 fonts.ready 可能
 * 早于换行测量，字体未就绪会回退到雅黑，行宽与导出结果不一致。测量路径刻意不等。
 */
export function ensureBubbleFont(): Promise<void> {
  if (!bubbleFontPromise) bubbleFontPromise = waitBubbleFont()
  return bubbleFontPromise
}

/** 3s 上限：字体 4.3MB，加载慢或挂起时不能阻塞截图 */
async function waitBubbleFont(): Promise<void> {
  try {
    await Promise.race([
      (async () => {
        try {
          await document.fonts.load(`${BUBBLE_FONT_SIZE}px ${BUBBLE_FONT}`)
        } catch { /* 保留后备 */ }
        await document.fonts.ready
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ])
  } catch { /* 忽略 */ }
}

export interface BubbleBox {
  /** 含 padding */
  rectW: number
  rectH: number
  /** 不含 padding */
  innerW: number
}

interface MeasureConfig {
  innerMax: number
  padX: number
  padY: number
  minW: number
  minH: number
  fontSize: number
  lineHeight: number
}

/** 单例：每次测量都建 DOM 会触发重排 */
let ruler: HTMLDivElement | null = null

function getRuler(metrics: { fontSize: number; lineHeight: number }): HTMLDivElement {
  if (!ruler) {
    const el = document.createElement('div')
    el.style.cssText =
      `position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;` +
      `white-space:pre-line;word-break:break-word;` +
      `font-family:${BUBBLE_FONT};`
    document.body.appendChild(el)
    ruler = el
  }
  ruler.style.fontSize = `${metrics.fontSize}px`
  ruler.style.lineHeight = `${metrics.lineHeight}px`
  return ruler
}

/** 单例，避免每次测量 new canvas 造成 GC 压力 */
let canvasCtx: CanvasRenderingContext2D | null = null

function getCanvasCtx(fontSize: number): CanvasRenderingContext2D {
  if (!canvasCtx) {
    const canvas = document.createElement('canvas')
    canvasCtx = canvas.getContext('2d')!
  }
  canvasCtx.font = `${fontSize}px ${BUBBLE_FONT}`
  return canvasCtx
}

/**
 * Range.getClientRects() 对内联内容是逐片段返回的：同一行里两个并排的表情会给出
 * 两条各只有半个表情宽的 rect，直接取 max 会把气泡算窄。这里先按行归并再取行宽。
 * 归并用垂直交叠而非 top 相等：表情是 vertical-align:middle，与同行文字 top 不同。
 */
function maxLineWidth(range: Range): number {
  const rects = [...range.getClientRects()]
    .filter((r) => r.width > 0 || r.height > 0)
    .sort((a, b) => a.top - b.top)
  const lines: { top: number; bottom: number; left: number; right: number }[] = []
  for (const r of rects) {
    const line = lines.find((ln) => r.top < ln.bottom - 0.5 && r.bottom > ln.top + 0.5)
    if (line) {
      line.top = Math.min(line.top, r.top)
      line.bottom = Math.max(line.bottom, r.bottom)
      line.left = Math.min(line.left, r.left)
      line.right = Math.max(line.right, r.right)
    } else {
      lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })
    }
  }
  let widest = 0
  for (const ln of lines) widest = Math.max(widest, ln.right - ln.left)
  return widest
}

function measureWith(config: MeasureConfig, text: string): BubbleBox {
  const innerMax = config.innerMax
  const ctx = getCanvasCtx(config.fontSize)

  // 第一轮 canvas 估算：同步高频路径（流式每个 chunk 都跑），刻意不触发字体加载
  let innerW = 0
  let canvasLines = 1
  for (const seg of text.split('\n')) {
    const w = measureTextWithEmoji(ctx, seg)
    innerW = Math.max(innerW, Math.min(w, innerMax))
    canvasLines += Math.max(0, Math.ceil(w / innerMax) - 1)
  }

  // 第二轮 ruler DOM 实测，优先采用
  let lines = canvasLines
  let rulerW = 0
  const rulerEl = getRuler(config)
  rulerEl.style.width = `${innerMax}px`
  // 表情内联 em 尺寸，图片加载前也能按真实宽高参与布局
  rulerEl.innerHTML = emojiToHtml(text)
  const rulerLines = Math.round(rulerEl.scrollHeight / config.lineHeight)
  if (Number.isFinite(rulerLines) && rulerLines > 0) lines = rulerLines
  const range = document.createRange()
  range.selectNodeContents(rulerEl)
  // 不能读 scrollWidth：内容不溢出时它恒等于容器宽，会把短消息撑满
  const contentW = maxLineWidth(range)
  rulerW = Math.min(contentW, innerMax)
  innerW = Math.max(innerW, rulerW)

  return {
    rectW: Math.max(config.minW, innerW + config.padX * 2),
    rectH: Math.max(config.minH, lines * config.lineHeight + config.padY * 2),
    innerW,
  }
}
