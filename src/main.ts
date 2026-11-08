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
