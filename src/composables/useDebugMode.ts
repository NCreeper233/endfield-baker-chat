// useDebugMode —— URL 带 #debug 时在左下角打印气泡尺寸（开发期排查塌陷用）
// 非调试模式是空操作。卸载时清定时器与浮层，避免 HMR 残留多个 <pre id="debug-box">。

import { onMounted, onUnmounted } from 'vue'

export function useDebugMode() {
  let timer: ReturnType<typeof setTimeout> | null = null
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
