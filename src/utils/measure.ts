// =============================================================================
// 气泡文本尺寸测量
// -----------------------------------------------------------------------------
// 测量策略:
// 1. canvas.measureText 估算每段宽度,得到 innerW 与粗略行数
//    (表情 token 按真实渲染宽展开为若干空格,参与宽度估算)
// 2. 隐藏 ruler DOM 实测精确行数与宽度(ruler 用真实 <img> 表情排版,
//    表情内联固定像素尺寸,加载前即可参与布局)
// 3. 取较大值作为最终结果,避免 canvas 测量误差导致气泡塌陷
//
// 气泡测量参数化:字体/字号/行高/边距/最小尺寸收敛为 BubbleMetrics,
// 桌面端用 DESKTOP_BUBBLE_METRICS(原固定常量),移动端由几何层传入更小值。
// =============================================================================

import { emojiToHtml, measureTextWithEmoji } from '../constants/emoji'
import type { MessageSide, RectSize } from '../types/chat'

/** 气泡尾巴偏移(px):rect 左侧留出空间画尾巴,mine 侧右侧也留同样空间 */
export const BUBBLE_TAIL_OFFSET = 8.2

/**
 * 气泡 SVG 总宽 = 尾巴偏移 + rect 宽(+ mine 侧再补一个尾巴偏移)
 *
 * 容器跟随过渡尺寸:rect 右缘 = svgW - 尾巴偏移,任何时刻 rect 都在 svg 内。
 */
export function bubbleSvgWidth(width: number, side: MessageSide): number {
  return BUBBLE_TAIL_OFFSET + width + (side === 'mine' ? BUBBLE_TAIL_OFFSET : 0)
}

/** 气泡字体字号(px),与会话气泡文字一致 */
export const BUBBLE_FONT_SIZE = 20.88
/** 行高 = 字号 × 1.5,与会话气泡文字一致 */
export const BUBBLE_LINE_HEIGHT = BUBBLE_FONT_SIZE * 1.5
/** 气泡左右内边距(px) */
export const BUBBLE_PAD_X = 13
/** 气泡上下内边距(px) */
export const BUBBLE_PAD_Y = 9
/** 气泡最小宽度(px),单字短消息也保持圆角形状 */
export const BUBBLE_MIN_W = 51.76
/** 气泡最小高度(px) */
export const BUBBLE_MIN_H = 42.47
/** 单行气泡实际高度(px)= 一行行高 + 上下 padding,用于加载气泡与单行文字气泡对齐 */
export const BUBBLE_SINGLE_LINE_H = BUBBLE_LINE_HEIGHT + BUBBLE_PAD_Y * 2
/** 加载气泡 rect 尺寸(文字气泡从该尺寸过渡到自身尺寸) */
export const LOADING_RECT: RectSize = { w: 100, h: BUBBLE_SINGLE_LINE_H }
/** 气泡最大宽度(px),超出则换行(桌面默认;移动端由几何层传入更小值) */
const BUBBLE_MAX_W = 660
/** 气泡内文最大宽度(px)= 外部最大框架宽 − 左右内边距 */
const BUBBLE_INNER_MAX_W = BUBBLE_MAX_W - BUBBLE_PAD_X * 2

/** 气泡测量参数(桌面默认 = 原固定常量;移动端由几何层传入更小值) */
export interface BubbleMetrics {
  /** 字体字号(px) */
  fontSize: number
  /** 行高(px) */
  lineHeight: number
  /** 左右内边距(px) */
  padX: number
  /** 上下内边距(px) */
  padY: number
  /** 最小外框宽(px) */
  minW: number
  /** 最小外框高(px) */
  minH: number
}

/** 桌面端默认测量参数(与历史固定值完全一致) */
export const DESKTOP_BUBBLE_METRICS: BubbleMetrics = {
  fontSize: BUBBLE_FONT_SIZE,
  lineHeight: BUBBLE_LINE_HEIGHT,
  padX: BUBBLE_PAD_X,
  padY: BUBBLE_PAD_Y,
  minW: BUBBLE_MIN_W,
  minH: BUBBLE_MIN_H,
}

/**
 * 测量文本对应的气泡渲染尺寸
 *
 * 表情以 <img> 渲染(1em 高),ruler 用真实 HTML 排版,实测宽度包含表情
 * 的真实渲染宽度;canvas 估算将表情 token 展开为等宽空格作后备。
 *
 * @param text   消息文本(支持 \n 换行,可含表情 token)
 * @param innerMax 内容最大宽度(px,超出换行;桌面默认 634,移动端由几何层传入)
 * @param metrics 测量参数(字号/行高/边距/最小尺寸;默认桌面)
 * @returns      外框宽高 + 内文宽度
 */
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
/** 气泡字体栈(用于 canvas 与 ruler 同步) */
export const BUBBLE_FONT = `"HarmonyOS Sans SC Medium", "HarmonyOS Sans SC", "Microsoft YaHei", sans-serif`

/**
 * 显式等待气泡字体真正装入(font-display: swap 时 fonts.ready 可能早于换行测量)
 *
 * 气泡宽度用 BUBBLE_FONT_STACK 在 ruler/canvas 里测量:若字体未就绪会回退
 * Microsoft YaHei,字形宽度不同导致换行数/边距与导出(HarmonyOS)不一致。
 * 截图与测量前都应先 await 本函数。
 */
export async function ensureBubbleFont(): Promise<void> {
  // 加超时：字体(4.3MB woff2)加载慢/挂起时不再阻塞截图，3s 后放行
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

/** 气泡测量结果 */
export interface BubbleBox {
  /** 外框 rect 宽度(含 padding) */
  rectW: number
  /** 外框 rect 高度(含 padding) */
  rectH: number
  /** 内文区域宽度(不含 padding) */
  innerW: number
}

/** 单次测量的差异参数(气泡) */
interface MeasureConfig {
  /** 内容最大宽度(px),超出换行 */
  innerMax: number
  /** 水平内边距(rectW 附加) */
  padX: number
  /** 垂直内边距(rectH 附加) */
  padY: number
  /** 最小外框宽度(px) */
  minW: number
  /** 最小外框高度(px) */
  minH: number
  /** 字体字号(px,ruler/canvas 测量用) */
  fontSize: number
  /** 行高(px,ruler 行数推算用) */
  lineHeight: number
}

/**
 * 隐藏 ruler DOM 单例
 *
 * 设计理由:每次测量都创建 DOM 会触发重排,缓存单例避免性能损耗。
 * 单例绑定到 body,样式与气泡一致以保证测量精度;每次测量前按
 * metrics 更新字号/行高(桌面与移动端字号不同)。
 */
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

/**
 * canvas 2D 上下文单例(用于文本宽度估算)
 *
 * 只在首次创建,避免每次测量都 new 一个 canvas 造成 GC 压力;
 * 每次测量前按 metrics 更新字号。
 */
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
 * 测量文本对应的气泡渲染尺寸
 *
 * 表情以 <img> 渲染(1em 高),ruler 用真实 HTML 排版,实测宽度包含表情
 * 的真实渲染宽度;canvas 估算将表情 token 展开为等宽空格作后备。
 *
 * @param config 测量定义(最大内宽 / 边距 / 最小尺寸 / 字号 / 行高)
 * @param text   消息文本(支持 \n 换行,可含表情 token)
 * @returns      外框宽高 + 内文宽度
 */
/**
 * 量出一段 range 内容里"最宽一行"的宽度
 *
 * `Range.getClientRects()` 对含内联元素的内容是**逐片段**返回 rect 的:
 * 文字一段、每个 inline-block(表情 <img>)各一段。同一行因此可能有多条 rect,
 * 直接取 max 只会得到最长的那一片段(连续两个表情 = 一个表情的宽),
 * 于是气泡被算窄、后面的表情被迫换行。
 *
 * 这里先把 rect 按行归并,再取每行的"最右 − 最左"作为行宽。
 * 归并判据用**垂直交叠**而非 top 相等:表情图是 vertical-align:middle,
 * 它和同一行的文字行盒 top 并不相同,按 top 分组会把一行拆成两行。
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

  // 第一轮:canvas 估算
  ensureBubbleFont().catch(() => {})
  let innerW = 0
  let canvasLines = 1
  for (const seg of text.split('\n')) {
    const w = measureTextWithEmoji(ctx, seg)
    innerW = Math.max(innerW, Math.min(w, innerMax))
    canvasLines += Math.max(0, Math.ceil(w / innerMax) - 1)
  }

  // 第二轮:ruler DOM 实测,优先采用
  let lines = canvasLines
  let rulerW = 0
  const rulerEl = getRuler(config)
  rulerEl.style.width = `${innerMax}px`
  // 表情内联 em 尺寸:高度 1em、宽度按原图宽高比,图片加载前也能按真实宽高参与布局
  rulerEl.innerHTML = emojiToHtml(text)
  const rulerLines = Math.round(rulerEl.scrollHeight / config.lineHeight)
  if (Number.isFinite(rulerLines) && rulerLines > 0) lines = rulerLines
  const range = document.createRange()
  range.selectNodeContents(rulerEl)
  // 内容宽:取最宽一行的真实渲染宽度。
  // 不能读 scrollWidth——内容不溢出时 scrollWidth 恒等于容器宽(innerMax),
  // 会把短消息撑到最大宽度;getClientRects 返回每行的真实 rect。
  // 也不能直接对 rects 取 max:Range 对内联内容是**逐片段**给的 rect,一行里
  // 两个并排的 <img>(连续表情 token,如 [sns_emoji_033][sns_emoji_033])会返回
  // 两条各只有半个表情宽的 rect,取 max 等于按"一个表情"算宽 —— 气泡窄一点,
  // 第二个表情就被挤到下一行。必须先按行归并、再取该行的最右 − 最左。
  const contentW = maxLineWidth(range)
  rulerW = Math.min(contentW, innerMax)
  innerW = Math.max(innerW, rulerW)

  return {
    rectW: Math.max(config.minW, innerW + config.padX * 2),
    rectH: Math.max(config.minH, lines * config.lineHeight + config.padY * 2),
    innerW,
  }
}