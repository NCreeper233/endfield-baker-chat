// captureImage —— html-to-image 的薄封装：toSvg → Image → canvas 裁剪子区域
// .chat-area 是 0×0 的 origin-container，无法直接捕获根元素，必须先捕获 stage 再裁剪；
// toPng 在 drawImage 后立刻 toDataURL，插不进裁剪这步，所以手动走 toSvg。

import { toSvg } from 'html-to-image'
import { ensureBubbleFont } from './measure'
import { isNative } from './platform'
import { downloadBlob } from './zipExport'

/** 设计坐标，与画布 zoom 无关 */
export interface CaptureRegion {
  x: number
  y: number
  w: number
  h: number
}

/** 双 rAF：等两次绘制，确保布局、字体、图片就绪 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => img.decode().then(() => resolve(img))
    img.onerror = () => reject(new Error('导出图片解码失败'))
    // data URL 不受同源策略限制；留给未来可能改为 blob URL 的场景
    img.crossOrigin = 'anonymous'
    img.src = src
  })
}

/** 截取 el 内 (x,y) 起 w×h 的区域为 PNG data URL；scale 即 pixelRatio */
export async function captureRegion(
  el: HTMLElement,
  region: CaptureRegion,
  scale = 1,
): Promise<string> {
  // 字体未就绪会导致文字偏移 / 掉字体
  await ensureBubbleFont()
  await nextPaint()

  let svgDataUrl: string
  try {
    svgDataUrl = await toSvg(el, {
      cacheBust: true,
      // 跳过 @font-face 内嵌：4.3MB woff2 转 base64 会卡死
      skipFonts: true,
      // 节点原为 fixed 离屏定位，克隆会把 left:-10000px 带进 SVG 导致整图空白
      style: {
        position: 'absolute',
        left: '0',
        top: '0',
        right: 'auto',
        bottom: 'auto',
        margin: '0',
      },
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`截图生成失败(SVG 序列化):${reason}`)
  }

  const img = await loadImage(svgDataUrl)

  const dstW = Math.round(region.w * scale)
  const dstH = Math.round(region.h * scale)

  // 用 9 参数 drawImage 直接裁目标区域，省掉全量中间 canvas（1919×1080×scale² ≈ 30MB）
  const canvas = document.createElement('canvas')
  canvas.width = dstW
  canvas.height = dstH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  ctx.drawImage(
    img,
    region.x * scale,
    region.y * scale,
    dstW,
    dstH,
    0,
    0,
    dstW,
    dstH,
  )
  return canvas.toDataURL()
}

/** 按真实字节解码，顺带校验非空 */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:') || comma < 0) throw new Error('截图数据无效，无法保存')
  const meta = dataUrl.slice(5, comma)
  const body = dataUrl.slice(comma + 1)
  const mime = meta.split(';')[0] || 'image/png'
  if (!meta.includes(';base64')) {
    return new Blob([decodeURIComponent(body)], { type: mime })
  }
  const binary = atob(body)
  // 看解码后的真实字节：字符串非空不代表图有效，落一个 0 字节文件比报错更糟
  if (binary.length === 0) throw new Error('截图内容为空（0 字节），已中止保存')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/**
 * 原生端不能用 <a download>：Android WebView 没有下载器接管，点了没反应，
 * 故与 ZIP / JSON 共用 downloadBlob 通道（APK 写进公共下载目录）；浏览器保持原方式。
 * 原生保存是异步的，返回落点信息（浏览器端 path 为空串）。
 */
export async function downloadDataUrl(
  dataUrl: string,
  filename: string,
): Promise<{ path: string; uri: string; revealed: boolean }> {
  if (isNative()) {
    const saved = await downloadBlob(dataUrlToBlob(dataUrl), filename)
    return { path: saved.path, uri: saved.uri, revealed: saved.revealed }
  }

  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  return { path: '', uri: '', revealed: false }
}
