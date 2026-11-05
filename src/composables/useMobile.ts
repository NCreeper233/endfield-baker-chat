// =============================================================================
// useMobile:移动端视口判定
// -----------------------------------------------------------------------------
// 响应式监听视口尺寸,提供:
//   - isMobile:宽度 ≤ MOBILE_BREAKPOINT 即视为移动端(启用列表↔聊天切换视图)
//   - width / height:当前视口尺寸(供移动端 zoom 容器计算缩放系数)
// 模块级单例:多个组件共享同一组 ref 与 resize 监听(与 useCanvasZoom 同思路)。
// =============================================================================

import { computed, onMounted, onUnmounted, ref } from 'vue'

/** 移动端断点(px):≤ 此宽度进入移动端视图 */
export const MOBILE_BREAKPOINT = 768

const width = ref(typeof window !== 'undefined' ? window.innerWidth : 1920)
const height = ref(typeof window !== 'undefined' ? window.innerHeight : 1080)

/** 是否移动端视口 */
const isMobile = ref(width.value <= MOBILE_BREAKPOINT)

// ---- 可视视口(visual viewport)----------------------------------------------
// iOS Safari 弹出软键盘时**不会**改变 window.innerHeight(布局视口保持全高),
// 只有 visualViewport 会收缩;同时浏览器会把可视视口整体向下平移,好让获得
// 焦点的输入框露出来。
//
// 若继续按 innerHeight 排版,输入面板会停在键盘背后;而浏览器那一次平移又会把
// 整块 position:fixed 界面顶到屏幕外 —— 用户看到的就是"输入框跑到最上面,
// 中间空出一大片背景"。
//
// 解法:键盘弹出时改用可视视口来排版与定位,让容器严丝合缝地贴在可视视口上,
// 浏览器怎么平移都不影响最终位置。
const visualHeight = ref(height.value)
const visualOffsetTop = ref(0)
/** 软键盘顶起的高度(px);0 表示键盘未弹出 */
const keyboardInset = ref(0)

/**
 * 当前焦点是否在可编辑元素上(文本框 / 多行文本 / contenteditable)
 *
 * 键盘判定不能只看高度差:双指缩放、地址栏收起、横竖屏切换都会让
 * visualViewport.height 变矮。只有"确实在输入"时,这个高度差才可信。
 */
export function hasEditableFocus(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return true
  return el.isContentEditable === true
}

/** 读取可视视口尺寸与偏移,判定软键盘是否弹出 */
function updateVisual() {
  const v = typeof window !== 'undefined' ? window.visualViewport : null
  if (!v || v.height < MIN_VALID_SIZE) {
    visualHeight.value = height.value
    visualOffsetTop.value = 0
    keyboardInset.value = 0
    return
  }
  const layoutH = height.value
  const visH = v.height
  visualHeight.value = visH
  // 只有"确实在编辑 + 可视视口明显变矮"才算键盘弹出:
  // 双指缩放同样会让 visualViewport.height 变小,不能单凭它判断。
  const inset = layoutH - visH
  keyboardInset.value = hasEditableFocus() && inset > 80 ? inset : 0
  // 只有键盘弹出时才补偿浏览器的可视视口平移;平时保持 0,不干扰双指缩放浏览
  visualOffsetTop.value = keyboardInset.value > 0 ? v.offsetTop : 0
}

/**
 * 聊天区真正可用的视口高度
 *
 * 键盘弹出时用可视视口高度(面板因此落在键盘正上方),否则用布局视口高度。
 */
const chatViewportHeight = computed(() =>
  keyboardInset.value > 0 ? visualHeight.value : height.value,
)

// 模块级导出:供 chatGeometry 等模块级 computed 直接读取(useMobile() 需在 setup 内调用)
export {
  width as viewportWidth,
  height as viewportHeight,
  isMobile as isMobileView,
  visualHeight as visualViewportHeight,
  visualOffsetTop as keyboardOffsetTop,
  chatViewportHeight,
  keyboardInset,
}

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
  // 布局视口一变,可视视口与键盘判定也要跟着重算
  updateVisual()
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
    } else {
      // 尺寸没变也可能只是键盘动了(尤其 iOS:innerHeight 不变、只有
      // visualViewport 收缩),所以每轮都补读一次可视视口
      updateVisual()
    }
  }, 500)
}

function stopPolling() {
  if (checkTimer !== null) {
    clearInterval(checkTimer)
    checkTimer = null
  }
}

/** 聚焦/失焦刷新延迟(ms):等待软键盘弹出/收起动画结束(约 250-300ms)后再读视口尺寸 */
const FOCUSOUT_DELAY = 350
/** 聚焦/失焦刷新定时器句柄 */
let focusInTimer: number | null = null
let focusOutTimer: number | null = null

/**
 * 聚焦/失焦兜底:等键盘动画结束再重读一次视口尺寸
 *
 * 只读不写。以前这里会 `window.scrollTo(0,0)` + `visualViewport.scrollTo(0,0)`,
 * 把浏览器"为了让输入框露出来"做的那次滚动强行抵消 —— 结果输入框重新被
 * 键盘挡住;iOS 还会因为判断输入框不可见而立刻收起键盘(点了就回弹)。
 * 位置交给浏览器,布局交给 .m-chat 的 top/height 跟随可视视口。
 */
function resetViewport() {
  update()
  updateVisual()
}

/**
 * 可视视口滚动:只同步几何,不把视口拉回 (0,0)
 *
 * 软键盘弹出时浏览器会平移可视视口以露出输入框。以前这里每 100ms 强行
 * scrollTo(0,0),等于和系统反复对抗 —— 表现为"整体顶到最上面、停不住"。
 */
function onVvScroll() {
  updateVisual()
}

// 聚焦兜底:等键盘弹出动画结束后重读视口尺寸(不再改 body 定位)
function onFocusIn() {
  if (focusInTimer !== null) clearTimeout(focusInTimer)
  focusInTimer = window.setTimeout(() => {
    focusInTimer = null
    resetViewport()
  }, FOCUSOUT_DELAY)
}

// 失焦兜底:等键盘收起动画结束后重读视口尺寸
function onFocusOut() {
  if (focusOutTimer !== null) clearTimeout(focusOutTimer)
  focusOutTimer = window.setTimeout(() => {
    focusOutTimer = null
    resetViewport()
  }, FOCUSOUT_DELAY)
}

function onResize() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(update)
}

/**
 * 移动端视口 composable(单例)
 *
 * @returns 全部响应式:isMobile / width / height(布局视口)
 *          + keyboardOffsetTop / keyboardInset / chatViewportHeight(软键盘相关)
 */
export function useMobile() {
  onMounted(() => {
    activeCount++
    if (activeCount === 1) {
      update()
      window.addEventListener('resize', onResize)
      // 软键盘弹出/收起只体现在可视视口上(iOS 尤其如此),必须单独监听
      const vv = window.visualViewport
      vv?.addEventListener('resize', updateVisual)
      vv?.addEventListener('scroll', onVvScroll)
      // 兜底:轮询同步 + 失焦刷新(resize 事件丢失场景)
      startPolling()
      document.addEventListener('focusin', onFocusIn)
      document.addEventListener('focusout', onFocusOut)
    }
  })

  onUnmounted(() => {
    activeCount = Math.max(0, activeCount - 1)
    if (activeCount === 0) {
      window.removeEventListener('resize', onResize)
      const vv = window.visualViewport
      vv?.removeEventListener('resize', updateVisual)
      vv?.removeEventListener('scroll', onVvScroll)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      stopPolling()
      if (focusInTimer !== null) clearTimeout(focusInTimer)
      if (focusOutTimer !== null) clearTimeout(focusOutTimer)
      cancelAnimationFrame(raf)
      raf = 0
    }
  })

  return {
    isMobile,
    width,
    height,
    /** 软键盘顶起时可视视口相对布局视口的纵向偏移(px);无键盘恒为 0 */
    keyboardOffsetTop: visualOffsetTop,
    /** 软键盘顶起的高度(px);0 表示未弹出 */
    keyboardInset,
    /** 聊天区可用视口高度(键盘弹出时即可视视口高度) */
    chatViewportHeight,
  }
}
