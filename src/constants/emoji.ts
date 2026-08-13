// =============================================================================
// 表情(token 表 + 文本转换工具)
// -----------------------------------------------------------------------------
// 消息文本中表情以 token 形式存储(纯字符串,便于持久化/测量/回显),
// 例如 "[sns_emoji_001]" 对应 src/assets/emojis/sns_emoji_001.png。
// 展示时用 emojiToHtml 渲染为 <img>,输入框/气泡序列化用 htmlToEmojiText 还原。
// =============================================================================

/** 表情素材(import.meta.glob 按文件名序号排序,001 → 037;
 *  独立目录 src/assets/emojis/,?no-inline 使其作为独立资产文件按需加载,
 *  避免 37 张小图被 base64 内联进主 JS 包) */
const emojiModules = import.meta.glob<string>('../assets/emojis/*.webp', {
  eager: true,
  import: 'default',
  query: '?no-inline',
})

export interface Emoji {
  /** 文本 token,如 '[sns_emoji_001]' */
  token: string
  /** 表情图片 URL */
  src: string
}

/** 表情 token 前缀(形如 sns_emoji_001) */
const TOKEN_PREFIX = 'sns_emoji_'

/** 按文件名数字序号升序排列的表情列表 */
export const EMOJIS: Emoji[] = Object.keys(emojiModules)
  .sort((a, b) => {
    const na = Number(a.match(/sns_emoji_(\d+)\.webp$/)?.[1] ?? 0)
    const nb = Number(b.match(/sns_emoji_(\d+)\.webp$/)?.[1] ?? 0)
    return na - nb
  })
  .map((path) => {
    const num = path.match(/sns_emoji_(\d+)\.webp$/)?.[1] ?? '000'
    return { token: `[${TOKEN_PREFIX}${num}]`, src: emojiModules[path] }
  })

/** 匹配单个表情 token(如 [sns_emoji_001]) */
const EMOJI_TOKEN_RE = /\[sns_emoji_(\d+)\]/g

/** 非方形表情的原始尺寸(宽×高,px);未列出的默认为 60×60。
 *  用于按真实宽高比渲染,避免横幅/竖条等异形表情被压扁。 */
const EMOJI_NATURAL: Record<number, readonly [number, number]> = {
  9: [62, 60],
  18: [62, 60],
  30: [47, 43],
  31: [44, 46],
  32: [60, 26],
  33: [44, 52],
  34: [57, 56],
  35: [36, 50],
  36: [52, 38],
  37: [46, 48],
}

/** 表情宽高比(宽/高),方形表情为 1;未知序号返回 1 */
function emojiAspect(num: string): number {
  const [w, h] = EMOJI_NATURAL[Number(num)] ?? [60, 60]
  return w / h
}

/** token → 表情图片 URL(找不到返回 null) */
const emojiByToken = new Map(EMOJIS.map((e) => [e.token, e.src]))

/**
 * 用 canvas 测量含表情 token 的文本宽度
 *
 * 表情无法用字符测量,按"真实宽高比缩放后的渲染宽"(宽 = 字号 × 宽高比)
 * 展开为若干空格,使 canvas 宽度 ≈ 真实排版宽度。
 *
 * @param ctx  已设置字体样式的 canvas 上下文(字号需与 CSS 一致)
 * @param text 含表情 token 的纯文本
 * @returns    文本像素宽度
 */
export function measureTextWithEmoji(ctx: CanvasRenderingContext2D, text: string): number {
  const spaceW = ctx.measureText(' ').width || 1
  const fontSize = Number.parseFloat(ctx.font) || 20.88
  const expanded = text.replace(EMOJI_TOKEN_RE, (_m, num: string) =>
    ' '.repeat(Math.max(1, Math.round((fontSize * emojiAspect(num)) / spaceW))),
  )
  return ctx.measureText(expanded).width
}

/** 表情渲染用的 img 标签(带 data-emoji 便于序列化还原) */
export function emojiImgHtml(token: string, src: string): string {
  const num = token.match(/^\[sns_emoji_(\d+)\]$/)?.[1] ?? ''
  // 内联 em 尺寸:高度 1em(随字号),宽度按原图宽高比 = 宽高比 em。
  // 内联保证图片加载前即可确定布局(宽度不为 0,测量不偏窄),且任何字号下都是真实比例。
  const style = ` style="width:${emojiAspect(num)}em;height:1em"`
  return `<img class="sns-emoji" data-emoji="${num}" src="${src}" alt=""${style} />`
}

/**
 * 将消息文本转换为含 <img> 的 HTML(渲染用)
 *
 * 先转义 HTML 特殊字符(文本不可信),再替换表情 token 为图片标签。
 * 表情自带内联 em 尺寸(高度 1em、宽度按原图宽高比),任意字号下布局确定且比例正确。
 *
 * @param text 含表情 token 的纯文本
 * @returns    可直接 v-html 的 HTML 片段
 */
export function emojiToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return escaped.replace(EMOJI_TOKEN_RE, (m) => emojiImgHtml(m, emojiByToken.get(m) ?? ''))
}

/** 需当作换行处理的块级标签(contenteditable 换行可能产生 div/p 等) */
const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'BLOCKQUOTE'])

/**
 * 将含表情 <img> 的 HTML 还原为纯文本 token(序列化用)
 *
 * 只保留文本节点与表情图,丢弃其余标签(粘贴的脏 HTML 也在此被清理)。
 * 换行表示:
 * - <br> → 换行
 * - 块级元素(div/p 等,Chrome 的 execCommand insertText '\n' 会插入 div)
 *   → 在其内容前补一个换行(连续块级不产生多余空行)
 *
 * @param html contenteditable 内容(innerHTML)
 * @returns    含表情 token 的纯文本
 */
export function htmlToEmojiText(html: string): string {
  const root = document.createElement('div')
  root.innerHTML = html
  let text = ''
  const pushNl = () => {
    if (text !== '' && !text.endsWith('\n')) text += '\n'
  }
  const walker = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
      return
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (el.tagName === 'IMG' && el.dataset.emoji) {
        text += `[${TOKEN_PREFIX}${el.dataset.emoji}]`
        return
      }
      if (el.tagName === 'BR') {
        pushNl()
        return
      }
      if (BLOCK_TAGS.has(el.tagName)) {
        // 块级元素:内容前补一个换行,内容内再正常遍历(连续块级去重)
        pushNl()
        for (const child of el.childNodes) walker(child)
        return
      }
      for (const child of el.childNodes) walker(child)
    }
  }
  for (const child of root.childNodes) walker(child)
  return text
}
