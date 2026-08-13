// =============================================================================
// useCanvasZoom:画布等比缩放
// -----------------------------------------------------------------------------
// 监听视口尺寸变化,计算 zoom 系数使 1920×1080 设计稿等比铺满视口。
//
// 设计理由:
// - 使用 `zoom` 而非 `transform: scale()`,避免影响文字选择与命中测试
// - 用 rAF 节流 resize 事件,避免高频重排
//
// 模块级单例:scale / update / onResize 只注册一次,所有调用方共享同一 ref,
// 避免多组件各自实例化出多套独立 scale 与多个 resize 监听器。
// =============================================================================

import { onMounted, onUnmounted, ref } from 'vue'
import { DESIGN_W, DESIGN_H } from '../constants/design'

/**
 * 模块级单例 scale + 监听计数
 *
 * 多个组件调用 useCanvasZoom() 时共享同一 scale ref;首个组件挂载时注册
 * resize 监听,最后一个组件卸载时注销。中间的挂载/卸载只增减引用计数。
 */
const scale = ref(1)
let raf = 0
/** 当前活跃的 useCanvasZoom 引用计数(决定 resize 监听何时注销) */
let activeCount = 0

function update() {
  // 无头环境 / 隐藏标签页可能 innerWidth/Height = 0,
  // 导致 scale = 0 → zoom:0 画布消失。用 0.01 兜底保持画布可见。
  const next = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H)
  scale.value = Math.max(0.01, next)
}

function onResize() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(update)
}

/**
 * 画布缩放 composable(单例)
 *
 * 多次调用共享同一 scale ref 与同一 resize 监听,
 * 避免多实例 scale 短暂不同步窗口与重复监听开销。
 *
 * @returns scale 响应式缩放系数(1 = 原始尺寸)
 */
export function useCanvasZoom() {
  onMounted(() => {
    activeCount++
    // 首个挂载:注册 resize 监听并立即 update 一次(取最新视口尺寸)
    if (activeCount === 1) {
      update()
      window.addEventListener('resize', onResize)
    }
  })

  onUnmounted(() => {
    activeCount = Math.max(0, activeCount - 1)
    // 最后一个卸载:注销 resize 监听并取消未触发的 rAF
    if (activeCount === 0) {
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(raf)
      raf = 0
    }
  })

  return { scale }
}
