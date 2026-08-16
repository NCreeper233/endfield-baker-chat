// =============================================================================
// useBubbleMeasure:气泡尺寸测量(带缓存)
// -----------------------------------------------------------------------------
// computed 重算时同一段文本会被反复测量,用 Map 缓存避免重复触发 ruler DOM
// 重排。缓存键 = innerMax + text:移动端与桌面端最大内宽不同,同一段文本在
// 不同宽度下的换行结果不同,必须区分;编辑消息文本后调用 clearCache 失效缓存。
// =============================================================================

import {
  DESKTOP_BUBBLE_METRICS,
  measureBubble,
  type BubbleBox,
  type BubbleMetrics,
} from '../utils/measure'

/** 测量缓存(innerMax|metrics|text -> BubbleBox) */
const cache = new Map<string, BubbleBox>()

/** metrics 序列化(缓存键用;对象字段顺序固定) */
function metricsKey(m: BubbleMetrics): string {
  return `${m.fontSize}|${m.lineHeight}|${m.padX}|${m.padY}|${m.minW}|${m.minH}`
}

/**
 * 气泡测量 composable
 *
 * @returns measure(text, innerMax, metrics) 测量函数(带缓存,默认桌面参数)
 *          clearCache()  清空缓存(后续编辑消息文本时调用)
 */
export function useBubbleMeasure() {
  /**
   * 测量文本对应的气泡尺寸(命中缓存则直接返回)
   *
   * @param text      消息文本
   * @param innerMax  内容最大宽度(px,超出换行;桌面默认,移动端由几何层传入)
   * @param metrics   气泡测量参数(字号/行高/边距/最小尺寸;桌面默认,移动端由几何层传入)
   */
  function measure(
    text: string,
    innerMax?: number,
    metrics: BubbleMetrics = DESKTOP_BUBBLE_METRICS,
  ): BubbleBox {
    const key = `${innerMax ?? 634}|${metricsKey(metrics)}|${text}`
    const hit = cache.get(key)
    if (hit) return hit
    const result = measureBubble(text, innerMax, metrics)
    cache.set(key, result)
    return result
  }

  /** 清空缓存 */
  function clearCache() {
    cache.clear()
  }

  return { measure, clearCache }
}
