// useCanvasZoom —— 画布等比缩放（模块级单例）
// 用 `zoom` 而非 transform: scale()，否则会影响文字选择与命中测试；resize 用 rAF 节流。
// 单例是为了让所有调用方共享同一个 scale ref 与同一份 resize 监听。

import { onMounted, onUnmounted, ref } from 'vue'
import { DESIGN_W, DESIGN_H } from '../constants/design'

const scale = ref(1)
let raf = 0
/** 活跃引用数，决定 resize 监听何时注销 */
let activeCount = 0

function update() {
  // 无头环境 / 隐藏标签页的 innerWidth 可能是 0，会让 zoom:0 导致画布消失
  const next = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H)
  scale.value = Math.max(0.01, next)
}

function onResize() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(update)
}

/** @returns scale 响应式缩放系数，1 = 原始尺寸 */
export function useCanvasZoom() {
  onMounted(() => {
    activeCount++
    // 首个挂载：注册监听并立刻取一次视口尺寸
    if (activeCount === 1) {
      update()
      window.addEventListener('resize', onResize)
    }
  })

  onUnmounted(() => {
    activeCount = Math.max(0, activeCount - 1)
    if (activeCount === 0) {
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(raf)
      raf = 0
    }
  })

  return { scale }
}
