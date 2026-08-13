// =============================================================================
// 截图工具(captureImage)
// -----------------------------------------------------------------------------
// 对 html-to-image 的薄封装:
//   - captureRegion():toSvg → Image → canvas 裁剪子区域
//   - downloadDataUrl():下载 data URL
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

/** 下载 data URL 为文件(<a> 标签触发下载,与 zipExport.downloadProject 风格一致) */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}
