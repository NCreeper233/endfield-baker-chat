// =============================================================================
// useDebugMode:URL hash 调试模式
// -----------------------------------------------------------------------------
// 触发条件:URL 包含 `#debug`。延迟 500ms 后采集所有 .chat-bubble 的尺寸信息,
// 渲染到左下角黑色 <pre> 浮层(等宽字体,便于开发期排查气泡塌陷)。
// 抽离为 composable:组件挂载时调用即可,非调试模式为空操作。
// =============================================================================

import { onMounted, onUnmounted } from 'vue'

/**
 * 调试模式 composable
 *
 * 用法:在需要调试信息的根组件 setup 中调用一次即可。
 * 非调试模式下为空操作,无副作用。
 */
export function useDebugMode() {
  /** 调试延迟定时器句柄(保存句柄,卸载时清理) */
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 已挂载到 body 的调试浮层引用(卸载时移除) */
  let preEl: HTMLPreElement | null = null

  onMounted(() => {
    if (!location.hash.includes('debug')) return

    timer = setTimeout(() => {
      const out: string[] = []
      document.querySelectorAll('.chat-bubble').forEach((el, i) => {
        const div = el.querySelector('.chat-bubble__text') as HTMLElement | null
        if (!div) return
        out.push(`#${i}: svgH=${el.getAttribute('height')} divCH=${div.clientHeight} divSH=${div.scrollHeight}`)
      })
      const pre = document.createElement('pre')
      pre.id = 'debug-box'
      pre.style.cssText =
        'position:fixed;bottom:0;left:0;z-index:99999;background:#000;color:#0f0;font:11px monospace;white-space:pre;padding:4px'
      pre.textContent = out.join('\n')
      document.body.appendChild(pre)
      preEl = pre
      timer = null
    }, 500)
  })

  // 卸载时清理未触发的定时器,并移除已挂载的调试浮层,
  // 避免 HMR / 路由切换残留多个 <pre id="debug-box">。
  onUnmounted(() => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (preEl && preEl.parentNode) {
      preEl.parentNode.removeChild(preEl)
      preEl = null
    }
  })
}
