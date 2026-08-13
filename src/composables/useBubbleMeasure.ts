// =============================================================================
// useBubbleMeasure:气泡尺寸测量(带缓存)
// -----------------------------------------------------------------------------
// computed 重算时同一段文本会被反复测量,用 Map 缓存 text -> BubbleBox 避免
// 重复触发 ruler DOM 重排;编辑消息文本后调用 clearCache 失效缓存。
// =============================================================================

import { measureBubble, type BubbleBox } from '../utils/measure'

/** 测量缓存(text -> BubbleBox) */
const cache = new Map<string, BubbleBox>()

/**
 * 气泡测量 composable
 *
 * @returns measure(text) 测量函数(带缓存)
 *          clearCache()  清空缓存(后续编辑消息文本时调用)
 */
export function useBubbleMeasure() {
  /**
   * 测量文本对应的气泡尺寸(命中缓存则直接返回)
   *
   * @param text  消息文本
   */
  function measure(text: string): BubbleBox {
    const hit = cache.get(text)
    if (hit) return hit
    const result = measureBubble(text)
    cache.set(text, result)
    return result
  }

  /** 清空缓存 */
  function clearCache() {
    cache.clear()
  }

  return { measure, clearCache }
}
