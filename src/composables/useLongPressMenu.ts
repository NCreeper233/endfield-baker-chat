// useLongPressMenu —— 长按 / 右键打开行动菜单
//
// 三类卡片（主卡 / 子卡 / 群卡）和消息行共用同一套手势：
//   · 触屏：按住 460ms 打开；手指移动超过 10px（滚动列表）即取消
//   · 桌面：右键打开（contextmenu）
//   · 打开后会吞掉随之而来的那次 click —— 否则松手时菜单位于手指下方，
//     点击会直接落在某一行上，误触删除。这个 click 用捕获阶段拦一次，
//     并加 700ms 兜底移除（部分 WebView 长按后不派发 click）。
import { computed, ref } from 'vue'
import { activeMenuKey, closeMenu as closeOwnedMenu, openMenu as openOwnedMenu } from './useMenuOwner'

/** 长按判定时长(ms) */
const LONG_PRESS_MS = 460
/** 移动容差(px)：超过即视为滚动，取消长按 */
const MOVE_TOLERANCE = 10
/** 吞点击的兜底存活时长(ms) */
const SWALLOW_MS = 700

/**
 * @param key 本菜单的全局唯一标识（如 `card:3`、`sub:12`）。
 *            所有菜单共用一个占用权，打开新的会顶掉上一个。
 */
export function useLongPressMenu(key: string) {
  /** 菜单是否展开（只有自己持有占用权时为真） */
  const open = computed(() => activeMenuKey.value === key)
  /** 菜单锚点(屏幕坐标) */
  const pos = ref({ x: 0, y: 0 })

  let timer: number | null = null
  let startX = 0
  let startY = 0
  /** 本次交互是否由长按/右键触发（用于吞掉 click） */
  let suppressClick = false
  /** 守卫标记的自动复位定时器 */
  let suppressTimer: number | null = null

  function clearTimer(): void {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
  }

  /**
   * 武装「吞掉下一次点击」的标记
   *
   * 必须带自动复位：右键不会产生 click，长按后部分 WebView 也不产生 click，
   * 标记若一直留着，下一次真实点击就会被误吞（表现为点一下没反应）。
   */
  function armSuppress(): void {
    suppressClick = true
    if (suppressTimer !== null) window.clearTimeout(suppressTimer)
    suppressTimer = window.setTimeout(() => {
      suppressClick = false
      suppressTimer = null
    }, SWALLOW_MS)
  }

  /** 立刻解除标记（全局拦截已经处理过这次点击） */
  function disarmSuppress(): void {
    suppressClick = false
    if (suppressTimer !== null) {
      window.clearTimeout(suppressTimer)
      suppressTimer = null
    }
  }

  /**
   * 吞掉紧接着的一次点击
   *
   * 捕获阶段 stopPropagation：菜单行上的监听收不到，主卡/子卡的点击也收不到。
   */
  function swallowNextClick(): void {
    const handler = (ev: MouseEvent) => {
      ev.stopPropagation()
      ev.preventDefault()
      disarmSuppress()
      cleanup()
    }
    const cleanup = () => {
      document.removeEventListener('click', handler, true)
      window.clearTimeout(timeoutId)
    }
    const timeoutId = window.setTimeout(cleanup, SWALLOW_MS)
    document.addEventListener('click', handler, true)
  }

  function show(x: number, y: number): void {
    pos.value = { x, y }
    openOwnedMenu(key)
  }

  function close(): void {
    closeOwnedMenu(key)
  }

  function onPointerDown(e: PointerEvent): void {
    // 鼠标只认左键；右键走 contextmenu
    if (e.pointerType === 'mouse' && e.button !== 0) return
    suppressClick = false
    startX = e.clientX
    startY = e.clientY
    clearTimer()
    const x = e.clientX
    const y = e.clientY
    timer = window.setTimeout(() => {
      timer = null
      armSuppress()
      show(x, y)
      swallowNextClick()
    }, LONG_PRESS_MS)
  }

  function onPointerMove(e: PointerEvent): void {
    if (timer === null) return
    if (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE) {
      clearTimer()
    }
  }

  function onPointerEnd(): void {
    clearTimer()
  }

  function onContextMenu(e: MouseEvent): void {
    e.preventDefault()
    // 右键不产生 click，只武装守卫（会自动复位），不加全局拦截 ——
    // 否则用户在 700ms 内点菜单项会被一起吞掉。
    armSuppress()
    show(e.clientX, e.clientY)
  }

  /** 点击处理器开头调用：返回 true 表示这次点击来自长按/右键，应忽略 */
  function consumeClick(): boolean {
    if (!suppressClick) return false
    disarmSuppress()
    return true
  }

  return {
    open,
    pos,
    close,
    onPointerDown,
    onPointerMove,
    onPointerEnd,
    onContextMenu,
    consumeClick,
  }
}
