// =============================================================================
// 复制文本到剪贴板
// -----------------------------------------------------------------------------
// 优先用 Clipboard API —— 它只在**安全上下文**(https / localhost)可用,
// 而本应用既可能跑在 http 页面、也可能在 Electron / 安卓 WebView 里,
// 所以保留 textarea + execCommand 的兜底。复制失败不影响其它行为,故整体静默。
// =============================================================================

/**
 * 把文本写进剪贴板
 *
 * 调用方通常把它挂在「点击群号」这类动作上:复制成功与否都不打断跳转。
 *
 * @param text 要复制的文本
 */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // 落到下面的兜底方案
  }
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.style.position = 'fixed'
    el.style.top = '-1000px'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    document.execCommand('copy')
    document.body.removeChild(el)
  } catch {
    // 两条路径都失败:静默放弃(用户仍可手动长按选择群号)
  }
}
