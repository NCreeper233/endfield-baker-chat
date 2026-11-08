// backgroundImage —— 用户选的背景图压成一张能塞进 localStorage 的 data URL
//
// 只在本机生效：它不进设置快照（getSettingsSnapshot），所以导出/导入都不带它。
// 换设备、清空站点数据会丢；「恢复默认」就是删掉那个 localStorage 键。

/** 存下来的背景长边上限：再大只会吃配额，屏幕上看不出差别 */
export const CUSTOM_BG_MAX_EDGE = 1920
/** 编码质量（webp / jpeg 通用） */
export const CUSTOM_BG_QUALITY = 0.82
/** 原文件上限：超大图先读进内存再缩放，低端机会直接卡死 */
export const CUSTOM_BG_MAX_FILE_BYTES = 24 * 1024 * 1024

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('这个文件读不出来，换一张试试'))
    reader.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('这张图解码失败，换一张试试'))
    img.src = src
  })
}

/**
 * 把用户选的图片文件转成可持久化的 data URL
 *
 * 长边压到 1920，优先 webp；浏览器不支持 webp 编码时退回 jpeg（背景是铺满裁切的，
 * 不需要透明通道）。
 */
export async function fileToBackgroundDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('只能选图片文件')
  }
  if (file.size > CUSTOM_BG_MAX_FILE_BYTES) {
    const mb = Math.round(CUSTOM_BG_MAX_FILE_BYTES / 1024 / 1024)
    throw new Error(`图片超过 ${mb}MB，请先压缩或换一张`)
  }

  const raw = await readAsDataUrl(file)
  if (!raw.startsWith('data:image/')) throw new Error('这个文件不是图片')

  const img = await loadImage(raw)
  const sw = img.naturalWidth || img.width
  const sh = img.naturalHeight || img.height
  if (!sw || !sh) throw new Error('这张图没有有效的尺寸')

  const scale = Math.min(1, CUSTOM_BG_MAX_EDGE / Math.max(sw, sh))
  const w = Math.max(1, Math.round(sw * scale))
  const h = Math.max(1, Math.round(sh * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  try {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前浏览器不支持处理图片')
    ctx.drawImage(img, 0, 0, w, h)

    let out = ''
    try {
      out = canvas.toDataURL('image/webp', CUSTOM_BG_QUALITY)
    } catch {
      out = ''
    }
    if (!out.startsWith('data:image/webp')) {
      // 不支持 webp 编码：补白底再画一次，避免透明区变黑块
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)
      out = canvas.toDataURL('image/jpeg', CUSTOM_BG_QUALITY)
    }
    if (!out.startsWith('data:image/')) throw new Error('图片编码失败，换一张试试')
    return out
  } finally {
    // 立刻释放画布后备存储，避免连续换图时内存叠高
    canvas.width = 0
    canvas.height = 0
  }
}
