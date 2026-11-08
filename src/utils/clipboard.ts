// clipboard —— 复制文本到剪贴板
// Clipboard API 只在安全上下文可用，故保留 textarea + execCommand 兜底；失败静默。

/**
 * 调用方多是「点击群号」这类动作：复制成功与否都不打断跳转。
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
    // 两条路径都失败：静默放弃，用户仍可手动选择
  }
}
