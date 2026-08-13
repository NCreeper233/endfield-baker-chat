import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { useChatStore } from './stores/chat'
import { useChatPersistence } from './composables/useChatPersistence'
import { BUBBLE_FONT_SIZE, BUBBLE_FONT } from './utils/measure'
import './styles/main.scss'

async function bootstrap() {
  // 字体加载与数据恢复并行(IndexedDB 读取通常 <100ms,内部有 8s 超时保护)
  const fontsReady = (async () => {
    try {
      await document.fonts.load(`${BUBBLE_FONT_SIZE}px ${BUBBLE_FONT}`)
      await document.fonts.ready
    } catch {
      // 字体加载失败时使用回退字体，测量可能有偏差但不阻塞渲染
    }
  })()

  const pinia = createPinia()
  const app = createApp(App)
  app.use(pinia)

  // 启动恢复:在挂载前还原已存数据,避免"初始数据 → 已存数据"首帧跳变
  const chatStore = useChatStore(pinia)
  const { loadProject } = useChatPersistence(chatStore)

  await Promise.all([fontsReady, loadProject()])
  app.mount('#app')
}

bootstrap()
