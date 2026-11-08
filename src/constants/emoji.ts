// emoji —— 表情 token 表与文本互转
// 消息里存 token 文本（便于持久化与测量），渲染时转 <img>，序列化时还原成 token。

/** ?no-inline 让 37 张小图作为独立资产按需加载，不被 base64 内联进主包 */
const emojiModules = import.meta.glob<string>('../assets/emojis/*.webp', {
  eager: true,
  import: 'default',
  query: '?no-inline',
})

export interface Emoji {
  /** 形如 '[sns_emoji_001]' */
  token: string
  src: string
}

const TOKEN_PREFIX = 'sns_emoji_'

/** 按文件名序号升序（001 → 037） */
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

/**
 * 单个表情 token。导出给 aiText 按「字数」判定短段：一个 token 在用户眼里是一个字，
 * 按原始长度算会变成 15 个字，纯表情行就漏掉短段合并。
 * 只用于 replace —— 带 g 标志，在外部 test/exec 会残留 lastIndex。
 */
export const EMOJI_TOKEN_RE = /\[sns_emoji_(\d+)\]/g

/** 非方形表情的原始尺寸（宽×高），未列出的按 60×60；用于按真实比例渲染，避免异形表情被压扁 */
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

function emojiAspect(num: string): number {
  const [w, h] = EMOJI_NATURAL[Number(num)] ?? [60, 60]
  return w / h
}

const emojiByToken = new Map(EMOJIS.map((e) => [e.token, e.src]))

/** 按后端 mood 字段（形如 "sns_emoji_001"，不带方括号）查询；无匹配返回 undefined */
export function emojiByMood(mood: string): Emoji | undefined {
  const token = `[${mood}]`
  const src = emojiByToken.get(token)
  return src ? { token, src } : undefined
}

/**
 * canvas 测宽：表情按「字号 × 宽高比」展开成等宽空格，使测得宽度接近真实排版。
 * ctx 需已设好与 CSS 一致的字号。
 */
export function measureTextWithEmoji(ctx: CanvasRenderingContext2D, text: string): number {
  const spaceW = ctx.measureText(' ').width || 1
  const fontSize = Number.parseFloat(ctx.font) || 20.88
  const expanded = text.replace(EMOJI_TOKEN_RE, (_m, num: string) =>
    ' '.repeat(Math.max(1, Math.round((fontSize * emojiAspect(num)) / spaceW))),
  )
  return ctx.measureText(expanded).width
}

/** data-emoji 供序列化时还原序号 */
export function emojiImgHtml(token: string, src: string): string {
  const num = token.match(/^\[sns_emoji_(\d+)\]$/)?.[1] ?? ''
  // 内联 em 尺寸：高 1em，宽按原图比例。图片加载前布局就确定，任何字号下比例都正确。
  const style = ` style="width:${emojiAspect(num)}em;height:1em"`
  return `<img class="sns-emoji" data-emoji="${num}" src="${src}" alt=""${style} />`
}

/** 文本 → 可 v-html 的 HTML：先转义（文本不可信），再把 token 换成图片标签 */
export function emojiToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return escaped.replace(EMOJI_TOKEN_RE, (m) => {
    // 模型可能输出 [sns_emoji_1] 等非标准格式，先补齐 3 位
    const num = m.match(/\d+/)?.[0] ?? ''
    const normalized = `[${TOKEN_PREFIX}${num.padStart(3, '0')}]`
    const src = emojiByToken.get(normalized)
    // 查不到映射就原样输出 token：返回空 src 会得到 <img src="">，
    // 既不显示图也不显示文字（alt 为空），导出图里就是破图。
    if (!src) return m
    return emojiImgHtml(normalized, src)
  })
}

/** contenteditable 换行可能产生块级标签 */
const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'BLOCKQUOTE'])

/**
 * HTML → token 纯文本：只保留文本节点与表情图，其余标签丢弃（粘贴的脏 HTML 在此清掉）。
 * <br> 记一个换行；块级元素在内容前补换行（Chrome 的 insertText '\n' 会插 div）。
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
