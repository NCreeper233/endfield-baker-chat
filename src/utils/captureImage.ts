// =============================================================================
// 截图工具(captureImage)
// -----------------------------------------------------------------------------
// 对 html-to-image 的薄封装:
//   - captureRegion():toSvg → Image → canvas 裁剪子区域
//   - downloadDataUrl():保存 data URL(原生端走系统保存通道)
//
// 设计理由:
//   - 本项目 .chat-area 为 0×0 origin-container,子元素按 1920×1080 设计坐标
//     绝对定位;无法直接捕获根元素,需先捕获外层 stage 再裁剪子区域。
//   - 手动 toSvg → loadImage → drawImage → canvas 平移裁剪(html-to-image 的
//     toPng 在 drawImage 后直接 toDataURL,无法插入 canvas 平移裁剪步骤),
//     从而只导出目标子区域,绘制大小精确受控。
//   - 不需要 inlineForeignObjectStyles:ChatBubble 的布局关键样式(display/font/
//     white-space/word-break/width 等)已写入 textStyle inline style,html-to-image
//     对 SVG 根元素深克隆(cloneNode(true))会天然复制 inline style,无需事后内联。
// =============================================================================

import { toSvg } from 'html-to-image'
import { ensureBubbleFont } from './measure'
import { isNative } from './platform'
import { downloadBlob } from './zipExport'

/** 捕获子区域(设计坐标,与画布 zoom 无关) */
export interface CaptureRegion {
  x: number
  y: number
  w: number
  h: number
}

/** 双 rAF:等两次浏览器绘制,确保布局/字体/图片就绪后定格 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

/** 加载 data URL 为 Image(等解码完成) */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => img.decode().then(() => resolve(img))
    img.onerror = () => reject(new Error('导出图片解码失败'))
    // crossOrigin 对 data URL 无实际意义(data URL 不受同源策略限制),
    // 仅对未来可能改为 blob URL / 外部 SVG 的场景预留。
    img.crossOrigin = 'anonymous'
    img.src = src
  })
}

/**
 * 截取 el 内 (x,y) 起、w×h 的子区域为 PNG data URL
 *
 * 流程:
 *   1. 等字体就绪 + 双 rAF
 *   2. toSvg:克隆 DOM + 内联 @font-face(data URL)+ 序列化为 SVG data URL
 *   3. loadImage:SVG → Image(onload 等待 SVG 内资源含字体加载完成)
 *   4. drawImage 全量绘制(pixelRatio = scale)
 *   5. canvas 平移裁剪 region
 *
 * @param el     离屏渲染根节点(如导出 stage)
 * @param region 设计坐标裁剪区
 * @param scale  倍率(pixelRatio):1 = 设计坐标 1:1
 */
export async function captureRegion(
  el: HTMLElement,
  region: CaptureRegion,
  scale = 1,
): Promise<string> {
  // 字体未就绪会导致导出文字偏移/掉字体;先等字体 + 双 rAF 稳定
  await ensureBubbleFont()
  await nextPaint()

  // toSvg:克隆 DOM + 内联 @font-face(data URL)+ 包 foreignObject 序列化为 SVG
  // style 覆盖回 absolute+0,0:节点原为 fixed 离屏定位,克隆会把 left:-10000px
  // 一并带入 SVG,整图被推离视口而空白;right/bottom 也需重置 auto。
  //
  // toSvg 可能因 DOM 克隆失败 / 字体内联失败等抛错,包装为带上下文的
  // 错误信息,让用户看到具体原因而非笼统的"生成失败"。
  let svgDataUrl: string
  try {
    svgDataUrl = await toSvg(el, {
      cacheBust: true,
      // 跳过 @font-face 字体内嵌(4.3MB woff2 → base64 序列化极慢/卡顿)
      skipFonts: true,
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

  // SVG data URL → Image
  const img = await loadImage(svgDataUrl)

  // 目标 canvas 尺寸:仅裁剪区域大小(× 倍率)
  const dstW = Math.round(region.w * scale)
  const dstH = Math.round(region.h * scale)

  // 用 drawImage 的 9 参数形式直接从源图裁剪子区域绘制到目标 canvas,
  // 不经过全量绘制的中间 canvas(全量可能 1919×1080 × scale² ≈ 30MB,
  // 直接裁剪可省去该层内存开销)。
  const canvas = document.createElement('canvas')
  canvas.width = dstW
  canvas.height = dstH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  // drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh):
  // 从源图的 (region.x*scale, region.y*scale) 起取 (dstW, dstH) 大小,
  // 绘制到目标 canvas 的 (0, 0) 位置(1:1,无缩放——源区域已按 scale 放大)。
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

/** dataURL → Blob（只用于原生保存；按真实字节解码，顺带校验非空） */
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
  // 空内容守卫看**解码后的真实字节**，不看字符串长度（B10）：
  // 字符串非空不代表图有效，落一个 0 字节文件比直接报错更糟。
  if (binary.length === 0) throw new Error('截图内容为空（0 字节），已中止保存')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/**
 * 保存 data URL 为文件
 *
 * 原生端（安卓/iOS）**不能**走 <a download>：Android WebView 里 download 属性
 * 没有系统下载器接管，点了什么都不会发生（审计 B9）。原生端改为与 ZIP/JSON
 * 完全相同的保存通道（downloadBlob → saveExportFileSmart）：
 *   · APK：SAF 保存框 / 大文件分块写入；
 *   · 浏览器（含 EXE 桌面端）：保持原来的 <a download>。
 *
 * 注意：这个函数现在是异步的（原生保存需要等用户选位置）。
 */
export async function downloadDataUrl(dataUrl: string, filename: string): Promise<void> {
  if (isNative()) {
    await downloadBlob(dataUrlToBlob(dataUrl), filename)
    return
  }

  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}
