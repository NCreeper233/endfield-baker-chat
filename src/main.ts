import { isElectron, isNative } from './utils/platform'

/**
 * 只有打包端注册品牌字体：字体在包内、本地 IO 几乎零成本。
 * 网页版不注册 —— 4.3MB 中文字体在测试链路上要 ~29 秒，回退到系统字体的观感差别很小。
 */
function registerBrandFont(): void {
  if (!isElectron() && !isNative()) return
  if (document.getElementById('brand-font')) return
  const style = document.createElement('style')
  style.id = 'brand-font'
  style.textContent =
    "@font-face{font-family:'HarmonyOS Sans SC Medium';" +
    "src:url('/fonts/HarmonyOS_Sans_SC_Medium.woff2') format('woff2');" +
    'font-weight:500;font-style:normal;font-display:swap}'
  document.head.appendChild(style)
}

registerBrandFont()

/**
 * 原生端「安全区」兜底（2026-11-08 第三版：Capacitor 8 透传 + 真机校正）
 *
 * 安卓 15/16 对 targetSdk 35+ 强制边到边：WebView 铺满整块屏幕，状态栏压住顶栏、
 * 三键导航栏压住聊天输入条。正解是读系统给的真实内边距 ——
 * Capacitor 8 的 SystemBars 插件在 WebView 140+ 且 viewport-fit=cover 时，
 * 会把值写进 --safe-area-inset-*（styles/_base.scss 已把它们接到
 * --safe-top / --safe-bottom，CSS 直接 var() 就能用，且随键盘/旋转实时更新）。
 *
 * 因此：只要 --safe-area-inset-* 存在（哪怕值是 0px），布局就完全听原生的，
 * 这里不再自己猜。只有「原生壳不注入」的旧壳才退回下面的估算：
 *  A. 原生壳已经把 WebView 放在状态栏下方：screen.height 比 innerHeight 大一个状态栏 → 不用补
 *  B. 真·边到边：两者几乎相等 → 补兜底值
 * 键盘弹出会让 innerHeight 变小，所以记录历史最大视口高度再比较。
 * 浏览器端（网页版）完全不执行，桌面/网页布局零变化。
 */
const SAFE_TOP_FALLBACK = 40
function ensureNativeSafeTop(): void {
  if (!isNative()) return
  const root = document.documentElement
  /** 读 CSS 变量算出的值（自定义属性会先做 var() 替换，所以这里拿到的是最终 px） */
  const readCss = (name: string) => (getComputedStyle(root).getPropertyValue(name) || '').trim()
  /** Capacitor 8 是否已经注入真实内边距 */
  const hasNativeInsets = () => readCss('--safe-area-inset-top') !== ''
  let maxInnerHeight = window.innerHeight

  const evaluate = () => {
    if (hasNativeInsets()) {
      // 原生给了真实值：撤掉自己上一轮可能写过的兜底，布局完全跟随 --safe-area-inset-*
      root.style.removeProperty('--safe-top')
    } else {
      maxInnerHeight = Math.max(maxInnerHeight, window.innerHeight)
      const missing = (window.screen?.height || 0) - maxInnerHeight
      if (missing >= 24) {
        // 系统已经让出了状态栏：不需要兜底
        root.style.removeProperty('--safe-top')
      } else {
        // 边到边：内容被状态栏压住
        root.style.setProperty('--safe-top', SAFE_TOP_FALLBACK + 'px')
      }
    }
    // 真机排查用：CDP 里读 window.__bakerSafeArea 就知道这一台的判定结果
    ;(window as unknown as Record<string, unknown>).__bakerSafeArea = {
      native: hasNativeInsets(),
      rawTop: readCss('--safe-area-inset-top'),
      rawBottom: readCss('--safe-area-inset-bottom'),
      safeTop: parseFloat(readCss('--safe-top')) || 0,
      safeBottom: parseFloat(readCss('--safe-bottom')) || 0,
      innerHeight: window.innerHeight,
      screenHeight: window.screen?.height || 0,
    }
  }

  evaluate()
  // 原生注入可能晚于首帧（SystemBars 在 DOM ready 之后才 requestApplyInsets），
  // 前 3 秒每 250ms 复查一次，之后交给 resize / orientationchange
  let ticks = 0
  const timer = window.setInterval(() => {
    evaluate()
    if (++ticks >= 12) window.clearInterval(timer)
  }, 250)
  window.addEventListener('resize', evaluate, { passive: true })
  window.visualViewport?.addEventListener('resize', evaluate, { passive: true })
  window.addEventListener(
    'orientationchange',
    () => {
      // 旋转后视口高度会变，重置基准再算
      maxInnerHeight = window.innerHeight
      window.setTimeout(evaluate, 300)
    },
    { passive: true },
  )
}
ensureNativeSafeTop()

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { useChatStore } from './stores/chat'
import { useSettingsStore } from './stores/settings'
import { useChatPersistence } from './composables/useChatPersistence'
import { useBubbleMeasure } from './composables/useBubbleMeasure'
import { BUBBLE_FONT_SIZE, BUBBLE_FONT } from './utils/measure'
import './styles/main.scss'

/**
 * 让启动层退场
 *
 * 启动层是 index.html 里的静态层（在 #app 外面），挂载不会替换它；这里补满进度、
 * 播黄幕擦过 + 淡出，再把它从 DOM 移除。它播完会广播 `baker:boot-done`，
 * App 收到后才允许弹公告 / 首次偏好。
 */
function exitBootLayer(): void {
  const win = window as unknown as { __bakerBoot?: { exit: () => void } }
  win.__bakerBoot?.exit()
}

/**
 * 启动失败兜底页
 *
 * 启动链路(读本地库 / 建应用 / 首次挂载)任何一步抛错, #app 里就只剩
 * 静态骨架或半截 DOM —— 用户看到的是"永远加载中",和卡死无法区分。
 * 这里用原生 DOM 画一页可见的错误说明;样式内联在 index.html 里,
 * 所以即使 Vue 完全没起来、构建 CSS 没加载,也能正常显示。
 */
function renderBootError(error: unknown): void {
  const host = document.getElementById('app')
  if (!host) return

  // 启动层是 #app 的兄弟节点：不先摘掉，它会一直盖在错误页上面
  document.getElementById('boot-layer')?.remove()

  const detail = error instanceof Error ? error.message : String(error)

  const wrap = document.createElement('div')
  wrap.className = 'boot-error'
  wrap.setAttribute('role', 'alert')

  const eyebrow = document.createElement('p')
  eyebrow.className = 'boot-error__eyebrow'
  eyebrow.textContent = '// BOOT FAULT'

  const title = document.createElement('h1')
  title.className = 'boot-error__title'
  title.textContent = '启动失败'

  const hint = document.createElement('p')
  hint.className = 'boot-error__hint'
  hint.textContent = '本地数据不会被删除。请先重新加载；若仍然失败，把下面的信息反馈给开发者。'

  const pre = document.createElement('pre')
  pre.className = 'boot-error__detail'
  pre.textContent = detail || '未知错误'

  const retry = document.createElement('button')
  retry.className = 'boot-error__retry'
  retry.type = 'button'
  retry.textContent = '重新加载'
  retry.addEventListener('click', () => location.reload())

  wrap.append(eyebrow, title, hint, pre, retry)
  host.replaceChildren(wrap)
}

/**
 * 气泡字体后台预热
 *
 * 全量中文字体有 4.3MB。若像以前那样把 fonts.load / fonts.ready 放进挂载
 * 门槛,弱网下首屏会一直停在骨架;而字体本身是 font-display: swap,
 * 先用系统字体显示完全可用。因此改成挂载后再预热,失败也只是回退字体。
 *
 * 字体就绪后字形宽度才最终确定:之前按回退字体量出的气泡尺寸必须作废,
 * 并强制一次重排,避免气泡宽度/换行停在回退字体上。
 */
function prewarmBubbleFont(): void {
  const fonts = typeof document !== 'undefined' ? document.fonts : null
  if (!fonts) return

  void (async () => {
    try {
      await fonts.load(`${BUBBLE_FONT_SIZE}px ${BUBBLE_FONT}`)
      await fonts.ready
    } catch {
      // 字体加载失败:沿用系统回退字体,不影响任何功能
      return
    }

    // 测量缓存是模块级单例,这里取用不需要组件上下文
    useBubbleMeasure().clearCache()
    requestAnimationFrame(() => {
      // 读一次布局属性,强制浏览器在字体替换后完成同步重排
      void document.body.offsetHeight
      // 几何 / 缩放模块监听 resize:借这一拍让它们按最终字体重新量一遍
      window.dispatchEvent(new Event('resize'))
    })
  })()
}

async function bootstrap(): Promise<void> {
  const pinia = createPinia()
  const app = createApp(App)
  app.use(pinia)

  // 全局错误记录:不能依赖 devWarn —— 生产构建会把整个分支 tree-shake 掉,
  // 发布版里的渲染异常就完全没现场可查了。
  app.config.errorHandler = (err, _instance, info) => {
    console.error('[boot] 组件异常:', info, err)
  }

  // 启动恢复:挂载前还原已存数据,避免"初始数据 → 已存数据"首帧跳变。
  // 字体**不**参与这个 await:数据恢复通常远快于 4.3MB 字体,字体放到
  // 挂载后再预热(见 prewarmBubbleFont),弱网首屏不再被字体卡住。
  const chatStore = useChatStore(pinia)
  const settingsStore = useSettingsStore(pinia)
  const { loadProject } = useChatPersistence(chatStore, settingsStore)
  await loadProject()

  app.mount('#app')
  // 挂载完成才撤启动层：黄幕盖在已经画好的应用上，再淡出露出界面
  exitBootLayer()
  prewarmBubbleFont()
}

// 未捕获的 Promise 异常同样要留现场:这类异常会让界面停在半截,
// 生产环境没有 devError,不记录就完全无法定位。
window.addEventListener('unhandledrejection', (event) => {
  console.error('[boot] 未处理的 Promise 异常:', event.reason)
})

bootstrap().catch((error) => {
  console.error('[boot] 启动失败:', error)
  renderBootError(error)
})
