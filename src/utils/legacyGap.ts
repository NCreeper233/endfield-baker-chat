// legacyGap —— Chromium 83 的 flex gap 兜底（运行时 polyfill）
//
// 背景：vivo / iQOO 的系统 WebView 冻结在 Chromium 83，只支持 grid 的 gap，
// flex 容器的 `gap` 被静默忽略（该能力需要 Chrome 84+）。表现为设置页各区块
// 贴在一起、工具栏按钮挤成一团、聊天输入框右侧按钮没有间隔。
//
// 为什么不用构建期把 gap 改写成 margin：
//   1) `.pn-row` 这类容器的第一个子元素是 `position:absolute` 的装饰层，
//      `> * + *` 会把真正的第一个内容块也加上 margin，整体位移；
//   2) 桌面规则与移动端 `@media` 覆盖是两条规则，静态展开会残留错误值。
// 运行时读计算值就没有这些问题：绝对定位子元素被跳过，媒体查询也已生效。
//
// 不能靠 UA 判断，也不能用 `CSS.supports('gap','1px')` —— 后者在 83 上会因为
// grid gap 存在而误报 true。唯一可靠的办法是造两个子项实测间距。

/** 标记类：既是探测结果，也可由外部预先写好用于本地复现 */
const LEGACY_CLASS = 'legacy-no-flex-gap'
/** 探测用的间距，以及判定为「不支持」的阈值 */
const PROBE_GAP = 10
const MIN_SUPPORTED_GAP = 5
/** 变更防抖（ms） */
const MUTATION_DEBOUNCE = 60

let installed = false
let timer: number | null = null

/** 实测引擎是否支持 flex gap */
function detectFlexGap(): boolean {
  try {
    const probe = document.createElement('div')
    probe.style.cssText =
      `position:fixed;left:-9999px;top:0;display:flex;gap:${PROBE_GAP}px;` +
      'visibility:hidden;pointer-events:none'
    probe.innerHTML =
      '<i style="width:10px;height:10px;flex:none;display:block"></i>' +
      '<i style="width:10px;height:10px;flex:none;display:block"></i>'
    document.documentElement.appendChild(probe)
    const [first, second] = Array.from(probe.children) as HTMLElement[]
    const measured = second.getBoundingClientRect().left - first.getBoundingClientRect().right
    probe.remove()
    return measured >= MIN_SUPPORTED_GAP
  } catch {
    // 探测失败按「支持」处理：宁可间距正常，也不要误伤新机型
    return true
  }
}

/** 需要跳过 margin 的子元素：脱离文档流的、以及不渲染的 */
function isInFlow(el: HTMLElement): boolean {
  const style = getComputedStyle(el)
  if (style.display === 'none') return false
  return style.position !== 'absolute' && style.position !== 'fixed'
}

/**
 * 伪元素是不是一个真实的 flex 子项
 *
 * `.pn-sec__head::before` 是标题前那根黄色竖条，它参与 flex 布局。
 * 如果漏掉它，第一个真实子元素会被当成「首项」而不补间距，整行就少一档 gap。
 */
function isPseudoInFlow(el: HTMLElement, which: '::before' | '::after'): boolean {
  const style = getComputedStyle(el, which)
  if (!style) return false
  if (style.content === 'none' || style.content === 'normal') return false
  if (style.display === 'none') return false
  return style.position !== 'absolute' && style.position !== 'fixed'
}

/**
 * 给 root 子树里所有「flex 容器 + gap」补 margin
 *
 * 只处理真正参与布局的子元素，因此绝对定位的装饰层不会吃到一个多余的 margin。
 * 方向必须区分：行向只补水平间距，列向只补纵向间距 —— 两个方向都补会让
 * 列容器里的元素被水平推开（实测偏移 8px）。
 */
function applyGapFix(root: ParentNode): void {
  const nodes = root.querySelectorAll<HTMLElement>('*')
  for (const el of nodes) {
    const style = getComputedStyle(el)
    if (style.display !== 'flex' && style.display !== 'inline-flex') continue
    const rowGap = parseFloat(style.rowGap) || 0
    const colGap = parseFloat(style.columnGap) || 0
    if (rowGap <= 0 && colGap <= 0) continue

    const isRow = style.flexDirection.startsWith('row')
    const wraps = style.flexWrap === 'wrap' || style.flexWrap === 'wrap-reverse'
    const beforeIsItem = isPseudoInFlow(el, '::before')
    const kids = Array.from(el.children).filter(
      (k): k is HTMLElement => k instanceof HTMLElement && isInFlow(k),
    )

    // 换行容器给每项补了 margin-bottom，最后一行同样吃到一份，卡片会比原设计高 一档。
    // 从容器底部内边距里等量扣掉，高度就回到 gap 的效果。
    // 用 dataset 记住原始值：polyfill 会随 DOM 变化反复执行，直接读 style 会越扣越少。
    if (wraps && rowGap > 0) {
      const ORIGINAL = 'legacyPadBottom'
      if (!el.dataset[ORIGINAL]) el.dataset[ORIGINAL] = style.paddingBottom
      const original = parseFloat(el.dataset[ORIGINAL]) || 0
      el.style.paddingBottom = original >= rowGap ? `${original - rowGap}px` : ''
    }

    kids.forEach((kid, index) => {
      // ::before 也算一项，这时第一个真实子元素前面同样要有间距
      const isFirst = index === 0 && !beforeIsItem

      if (wraps) {
        // 换行容器：必须给「每一项」加右/下 margin，不能用「除首项外」的左侧 margin。
        // 否则第二行第一个元素也会被推开一档，整行右移 —— 数据页按钮错位就是这么来的。
        kid.style.marginLeft = ''
        kid.style.marginTop = ''
        kid.style.marginRight = colGap > 0 ? `${colGap}px` : ''
        kid.style.marginBottom = rowGap > 0 ? `${rowGap}px` : ''
        return
      }

      kid.style.marginRight = ''
      kid.style.marginBottom = ''
      if (isRow) {
        // 行向：column-gap 是水平间距
        kid.style.marginLeft = isFirst || colGap <= 0 ? '' : `${colGap}px`
        kid.style.marginTop = ''
      } else {
        // 列向：row-gap 是纵向间距，补水平 margin 只会把内容推歪
        kid.style.marginTop = isFirst || rowGap <= 0 ? '' : `${rowGap}px`
        kid.style.marginLeft = ''
      }
    })
  }
}

/** 防抖执行（弹窗挂载、列表刷新都会触发 MutationObserver） */
function schedule(): void {
  if (timer !== null) return
  timer = window.setTimeout(() => {
    timer = null
    applyGapFix(document)
  }, MUTATION_DEBOUNCE)
}

/**
 * 安装 flex gap 兜底
 *
 * 支持 flex gap 的引擎直接返回，什么都不做（零开销、零样式变化）。
 * 不支持的引擎：打标记类 + 补一次 margin，并监听 DOM 变更与旋转。
 */
export function installLegacyGapFix(): void {
  if (installed) return
  installed = true

  // 预置了标记类（本地复现旧内核时用）也按不支持处理
  const forced = document.documentElement.classList.contains(LEGACY_CLASS)
  if (!forced && detectFlexGap()) return

  document.documentElement.classList.add(LEGACY_CLASS)
  applyGapFix(document)

  const observer = new MutationObserver(() => schedule())
  observer.observe(document.documentElement, { childList: true, subtree: true })
  window.addEventListener('resize', schedule, { passive: true })
  window.addEventListener('orientationchange', schedule, { passive: true })
}
