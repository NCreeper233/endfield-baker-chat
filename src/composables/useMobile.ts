// =============================================================================
// useMobile:移动端视口判定
// -----------------------------------------------------------------------------
// 响应式监听视口尺寸,提供:
//   - isMobile:宽度 ≤ MOBILE_BREAKPOINT 即视为移动端(启用列表↔聊天切换视图)
//   - width / height:当前视口尺寸(供移动端 zoom 容器计算缩放系数)
// 模块级单例:多个组件共享同一组 ref 与 resize 监听(与 useCanvasZoom 同思路)。
// =============================================================================

import { onMounted, onUnmounted, ref } from 'vue'

/** 移动端断点(px):≤ 此宽度进入移动端视图 */
export const MOBILE_BREAKPOINT = 768

const width = ref(typeof window !== 'undefined' ? window.innerWidth : 1920)
const height = ref(typeof window !== 'undefined' ? window.innerHeight : 1080)

/** 是否移动端视口 */
const isMobile = ref(width.value <= MOBILE_BREAKPOINT)

// 模块级导出:供 chatGeometry 等模块级 computed 直接读取(useMobile() 需在 setup 内调用)
export { width as viewportWidth, height as viewportHeight, isMobile as isMobileView }

let raf = 0
let activeCount = 0

/**
 * 视口高度有效下限(px)
 *
 * 移动端浏览器(尤其 Android)在软键盘弹出/收起的过渡瞬间,innerHeight 会
 * 短暂变为 0 或极小值;若此时读取,几何层会按异常高度布局(面板跑到屏幕外、
 * 滚动区塌缩),且恢复事件可能丢失导致布局卡死在异常值。
 * 过滤掉该区间的高度,保留上一次有效值,等键盘动画结束后的恢复值再更新。
 */
const MIN_VALID_HEIGHT = 100

function update() {
  width.value = window.innerWidth
  const h = window.innerHeight
  // 键盘过渡瞬间的异常高度:不更新,保留上一次有效值
  if (h >= MIN_VALID_HEIGHT) {
    height.value = h
  }
  isMobile.value = window.innerWidth <= MOBILE_BREAKPOINT
}

function onResize() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(update)
}

/**
 * 移动端视口 composable(单例)
 *
 * @returns { isMobile, width, height } 全部响应式
 */
export function useMobile() {
  onMounted(() => {
    activeCount++
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

  return { isMobile, width, height }
}
