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
/** 高度轮询定时器(兜底 resize 事件丢失) */
let checkTimer: number | null = null

/**
 * 视口尺寸有效下限(px)
 *
 * 移动端浏览器(尤其 Android 的 Edge/夸克)在软键盘弹出/收起的过渡瞬间,
 * innerWidth/innerHeight 可能短暂变为 0 或极小值;若此时读取,几何层会按
 * 异常尺寸布局(缩放系数为 0、锚点为负 → 元素全部被排到视口外)。
 * 过滤掉该区间的尺寸,保留上一次有效值,等键盘动画结束后的恢复值再更新。
 */
const MIN_VALID_SIZE = 100

function update() {
  const w = window.innerWidth
  const h = window.innerHeight
  // 键盘过渡瞬间的异常尺寸:不更新,保留上一次有效值
  if (w >= MIN_VALID_SIZE && h >= MIN_VALID_SIZE) {
    width.value = w
    height.value = h
  }
  // isMobile 只在宽度有效时更新:键盘弹出/收起动画期间部分浏览器会瞬时
  // 报告 innerWidth = 0/极小值,若此时刷新判定会翻转移动/桌面分支,
  // 导致聊天视图整棵卸载(textarea 销毁 → 键盘闪退、内容消失)。
  // 异常区间内保持上一次判定,等稳定值再更新。
  if (w >= MIN_VALID_SIZE) {
    isMobile.value = w <= MOBILE_BREAKPOINT
  }
}

/**
 * 定时轮询兜底:部分浏览器/WebView 在软键盘收起后不触发 resize
 * (或只触发一次异常值),布局会卡在键盘弹出时的高度。
 * 每 500ms 比对 innerHeight 与当前值,发现有效差异即同步,
 * 保证任何浏览器最终都收敛到正确布局。
 */
function startPolling() {
  if (checkTimer !== null) return
  checkTimer = window.setInterval(() => {
    const w = window.innerWidth
    const h = window.innerHeight
    if (
      w >= MIN_VALID_SIZE &&
      h >= MIN_VALID_SIZE &&
      (Math.abs(w - width.value) > 1 || Math.abs(h - height.value) > 1)
    ) {
      update()
    }
  }, 500)
}

function stopPolling() {
  if (checkTimer !== null) {
    clearInterval(checkTimer)
    checkTimer = null
  }
}

/** 失焦刷新延迟(ms):等待软键盘收起动画结束(约 250-300ms)后再读视口尺寸 */
const FOCUSOUT_DELAY = 350
/** 失焦刷新定时器句柄 */
let focusTimer: number | null = null

/**
 * 失焦兜底:输入框失焦(软键盘收起)后,等待键盘动画结束再强制刷新一次视口尺寸,
 * 兜住"键盘收起不触发 resize"的浏览器;同时复位可能被键盘滚动过的文档,
 * 避免 iOS 上 fixed 元素残留错位。定时轮询(startPolling)继续兜底极端场景。
 */
function onFocusOut() {
  if (focusTimer !== null) clearTimeout(focusTimer)
  focusTimer = window.setTimeout(() => {
    focusTimer = null
    update()
    window.scrollTo(0, 0)
  }, FOCUSOUT_DELAY)
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
      // 兜底:轮询同步 + 失焦刷新(resize 事件丢失场景)
      startPolling()
      document.addEventListener('focusout', onFocusOut)
    }
  })

  onUnmounted(() => {
    activeCount = Math.max(0, activeCount - 1)
    if (activeCount === 0) {
      window.removeEventListener('resize', onResize)
      document.removeEventListener('focusout', onFocusOut)
      stopPolling()
      if (focusTimer !== null) clearTimeout(focusTimer)
      cancelAnimationFrame(raf)
      raf = 0
    }
  })

  return { isMobile, width, height }
}
