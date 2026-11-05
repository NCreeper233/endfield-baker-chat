// =============================================================================
// useBubbleMeasure:气泡尺寸测量(带缓存)
// -----------------------------------------------------------------------------
// computed 重算时同一段文本会被反复测量,用 Map 缓存避免重复触发 ruler DOM
// 重排。缓存键 = innerMax + text:移动端与桌面端最大内宽不同,同一段文本在
// 不同宽度下的换行结果不同,必须区分。
//
// 缓存必须有上限:键里含**全文**,而流式回复每个 token 都会产生一个新键
// (同一段回复的每个前缀各占一条),一次长回复就能堆出上千条、且整份会话
// 期间不释放。这里按 LRU 淘汰,容量见 CACHE_MAX。
//
// clearCache() 用于缓存整体失效(切换会话 / 清空消息 / 字号几何变化)。
// 调用点不在本文件:需要的地方从 useBubbleMeasure() 取 clearCache 调用即可
// (缓存是模块级的,任意一处调用对所有调用方生效)。
// =============================================================================

import {
  DESKTOP_BUBBLE_METRICS,
  measureBubble,
  type BubbleBox,
  type BubbleMetrics,
} from '../utils/measure'

/**
 * 测量缓存容量上限(条)
 *
 * 512 ≈ 一屏多一点的气泡数量:足够覆盖"重渲染 / 滚动回来"的命中场景,
 * 又不会让长回复把内存吃住。超限按 LRU 淘汰最久未用的条目。
 */
const CACHE_MAX = 512

/** 测量缓存(innerMax|metrics|text -> BubbleBox;Map 迭代顺序 = 插入顺序) */
const cache = new Map<string, BubbleBox>()

/** 写入缓存并维持容量上限(最久未使用的先淘汰) */
function remember(key: string, value: BubbleBox): void {
  cache.set(key, value)
  if (cache.size <= CACHE_MAX) return
  const oldest = cache.keys().next().value
  // 理论上 size > CACHE_MAX 时必有键;这里的防御只为满足类型收窄
  if (oldest !== undefined) cache.delete(oldest)
}

/** metrics 序列化(缓存键用;对象字段顺序固定) */
function metricsKey(m: BubbleMetrics): string {
  return `${m.fontSize}|${m.lineHeight}|${m.padX}|${m.padY}|${m.minW}|${m.minH}`
}

/**
 * 气泡测量 composable
 *
 * @returns measure(text, innerMax, metrics) 测量函数(带 LRU 缓存,默认桌面参数)
 *          clearCache()  清空缓存(切会话 / 清空消息时调用)
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
    if (hit) {
      // 命中即刷新为"最近使用":先删再插,移到 Map 队尾。
      // 不做这步就退化成 FIFO,热点文本(反复重渲染的长消息)会被新键挤掉。
      cache.delete(key)
      cache.set(key, hit)
      return hit
    }
    const result = measureBubble(text, innerMax, metrics)
    remember(key, result)
    return result
  }

  /** 清空缓存(切换会话 / 清空消息后调用,避免继续命中旧内容的测量结果) */
  function clearCache() {
    cache.clear()
  }

  return { measure, clearCache }
}
