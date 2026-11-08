// useBubbleMeasure —— 气泡尺寸测量（带 LRU 缓存）
// 缓存键含 innerMax + metrics + 全文：同一段文本在不同宽度下换行结果不同。
// 必须有容量上限：流式回复每个前缀都会产生新键，一次长回复就能堆出上千条。
// clearCache 是模块级的，切会话 / 清空消息 / 字号变化时任意调用方调一次即可。

import {
  DESKTOP_BUBBLE_METRICS,
  measureBubble,
  type BubbleBox,
  type BubbleMetrics,
} from '../utils/measure'

/** 512 ≈ 一屏多一点的气泡数：够覆盖重渲染与滚回来，又不会被长回复吃住内存 */
const CACHE_MAX = 512

/** Map 的迭代顺序即插入顺序，天然可做 LRU */
const cache = new Map<string, BubbleBox>()

function remember(key: string, value: BubbleBox): void {
  cache.set(key, value)
  if (cache.size <= CACHE_MAX) return
  const oldest = cache.keys().next().value
  if (oldest !== undefined) cache.delete(oldest)
}

/** 字段顺序固定，可直接拼进缓存的键 */
function metricsKey(m: BubbleMetrics): string {
  return `${m.fontSize}|${m.lineHeight}|${m.padX}|${m.padY}|${m.minW}|${m.minH}`
}

export function useBubbleMeasure() {
  /**
   * @param innerMax 内容最大宽度（移动端由几何层传入）
   * @param metrics 字号/行高/边距（移动端由几何层传入）
   */
  function measure(
    text: string,
    innerMax?: number,
    metrics: BubbleMetrics = DESKTOP_BUBBLE_METRICS,
  ): BubbleBox {
    const key = `${innerMax ?? 634}|${metricsKey(metrics)}|${text}`
    const hit = cache.get(key)
    if (hit) {
      // 先删再插 = 移到队尾。不做这步就退化成 FIFO，热点文本会被新键挤掉。
      cache.delete(key)
      cache.set(key, hit)
      return hit
    }
    const result = measureBubble(text, innerMax, metrics)
    remember(key, result)
    return result
  }

  function clearCache() {
    cache.clear()
  }

  return { measure, clearCache }
}
