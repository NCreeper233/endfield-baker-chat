// =============================================================================
// 浮层拖拽(useDraggable)
// -----------------------------------------------------------------------------
// 把固定定位的浮层变成可拖动:在把手元素上按下 → 移动 → 松开。
//
// 设计要点:
//   - Pointer Events 一套覆盖鼠标 / 触屏 / 触控笔,不必写 touch + mouse 双份
//   - setPointerCapture:指针移出把手、甚至移出窗口,事件也不会丢
//   - **首次拖动才固化坐标**。在此之前不输出任何行内定位,完全沿用组件 CSS
//     的默认定位(如 right: 60px)—— 否则挂载时就得测量,首帧会跳一下
//   - 坐标始终夹在视口内:面板不会被拖到看不见的地方;窗口缩小后自动拉回
//   - 记录"抓取点相对面板左上角的偏移",面板跟手而不是瞬移到指针下
//   - 位置持久化到 localStorage(传入 storageKey 即启用)
// =============================================================================

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/** 浮层距视口边缘的最小间距(px):保证边缘始终留一点,便于再次抓取 */
const VIEWPORT_MARGIN = 8

/** 面板左上角坐标 */
export interface PanelPosition {
  left: number
  top: number
}

/**
 * 把一个坐标夹进视口(纯函数,便于单独验证)
 *
 * 面板比视口还大时(极端窄屏),Math.max 兜住下界,结果是钉在左上角留一条
 * 边距 —— 而不是算出反区间导致坐标乱跳。至少保证一边可见,用户还能抓回来。
 *
 * @param p      目标坐标
 * @param panelW 面板宽(offsetWidth,含内边距与边框)
 * @param panelH 面板高(offsetHeight)
 * @param viewW  视口宽
 * @param viewH  视口高
 */
export function clampPanelPosition(
  p: PanelPosition,
  panelW: number,
  panelH: number,
  viewW: number,
  viewH: number,
): PanelPosition {
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewW - panelW - VIEWPORT_MARGIN)
  const maxTop = Math.max(VIEWPORT_MARGIN, viewH - panelH - VIEWPORT_MARGIN)
  return {
    left: Math.min(Math.max(VIEWPORT_MARGIN, p.left), maxLeft),
    top: Math.min(Math.max(VIEWPORT_MARGIN, p.top), maxTop),
  }
}

/** 读取持久化位置;缺失 / 损坏 / 非法一律返回 null,由调用方回退默认定位 */
function readStoredPosition(key: string): PanelPosition | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const p = parsed as Record<string, unknown>
    if (typeof p.left !== 'number' || typeof p.top !== 'number') return null
    if (!Number.isFinite(p.left) || !Number.isFinite(p.top)) return null
    return { left: p.left, top: p.top }
  } catch {
    return null
  }
}

/**
 * 让浮层可拖动
 *
 * @param storageKey 位置持久化的 localStorage key;不传则只在本次挂载内有效
 */
export function useDraggable(storageKey?: string) {
  /** 浮层根元素(用于测量尺寸) */
  const panelEl = ref<HTMLElement | null>(null)
  /** 拖拽把手,通常是浮层的标题栏 */
  const handleEl = ref<HTMLElement | null>(null)
  /** 当前位置;null = 从未拖过,沿用 CSS 默认定位 */
  const pos = ref<PanelPosition | null>(storageKey ? readStoredPosition(storageKey) : null)
  /** 是否正在拖动(用于切换光标 / 拖拽期间禁选文字) */
  const dragging = ref(false)

  /** 按下点相对面板左上角的偏移(拖动时保持这个偏移,面板才跟手) */
  let grabOffsetX = 0
  let grabOffsetY = 0

  /** 把坐标夹进视口,保证整个面板可见 */
  function clampToViewport(p: PanelPosition): PanelPosition {
    const el = panelEl.value
    if (!el) return p
    return clampPanelPosition(p, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight)
  }

  /**
   * 立即按当前视口夹一次
   *
   * 面板每次显示时都应调用:窗口尺寸可能已经变化,上次记录的坐标可能
   * 落在屏幕外,那样面板就"打不开"了(其实在屏幕外)。
   */
  function clampNow(): void {
    if (pos.value) pos.value = clampToViewport(pos.value)
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return // 只响应主键
    const el = panelEl.value
    const handle = handleEl.value
    if (!el || !handle) return

    // 把手里的交互元素(关闭按钮等)不参与拖拽
    const target = event.target
    if (target instanceof Element && target.closest('button, a, input, textarea, select')) return

    // 首次拖动:把当前的 CSS 默认定位固化成 left/top,
    // 否则从 right 定位起步时面板会横向跳一下
    if (!pos.value) {
      const rect = el.getBoundingClientRect()
      pos.value = { left: rect.left, top: rect.top }
    }

    dragging.value = true
    grabOffsetX = event.clientX - pos.value.left
    grabOffsetY = event.clientY - pos.value.top

    handle.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging.value) return
    pos.value = clampToViewport({
      left: event.clientX - grabOffsetX,
      top: event.clientY - grabOffsetY,
    })
  }

  function onPointerUp(event: PointerEvent): void {
    if (!dragging.value) return
    dragging.value = false
    try {
      handleEl.value?.releasePointerCapture(event.pointerId)
    } catch {
      // 指针已被系统回收时 release 会抛错,忽略
    }
    if (storageKey && pos.value) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(pos.value))
      } catch {
        // 存储不可用:位置不持久化,不影响拖动本身
      }
    }
  }

  /** 视口尺寸变化后把面板拉回可见区域 */
  function onWindowResize(): void {
    clampNow()
  }

  onMounted(() => {
    window.addEventListener('resize', onWindowResize)
    // 首次挂载也要夹一次:持久化的坐标可能是大窗口时留下的
    clampNow()
  })

  onBeforeUnmount(() => {
    window.removeEventListener('resize', onWindowResize)
  })

  /**
   * 绑定到浮层根元素的行内样式
   *
   * pos 为 null 时返回 undefined(不加任何行内样式),完全沿用组件 CSS;
   * 一旦拖过就输出 left/top,并**显式把 right 置为 auto** ——
   * left 与 right 同时存在会把元素横向拉伸。
   */
  const panelStyle = computed(() => {
    const p = pos.value
    if (!p) return undefined
    return { left: `${p.left}px`, top: `${p.top}px`, right: 'auto' }
  })

  return {
    panelEl,
    handleEl,
    pos,
    dragging,
    panelStyle,
    clampNow,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  }
}
