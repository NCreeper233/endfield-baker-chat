<script setup lang="ts">
// =============================================================================
// 设置弹窗(SettingsDialog)
// -----------------------------------------------------------------------------
// AI API 配置 + 提示词编辑,全部持久化到 localStorage(settings store)
// 打开/关闭状态由父组件 App 持有
// =============================================================================
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import { testApiConnection } from '../../utils/llm'
import { MIN_SEGMENT_CHARS } from '../../utils/aiText'
import { testBackendConnection } from '../../utils/backend'
import { useModelPicker } from '../../composables/useModelPicker'
import { guessContextWindow } from '../../utils/modelContext'
import {
  FALLBACK_CONTEXT_WINDOW,
  DEFAULT_COMPACT_TRIGGER_PERCENT,
  MIN_COMPACT_TRIGGER_PERCENT,
  MAX_COMPACT_TRIGGER_PERCENT,
  clampTriggerPercent,
  computeInputBudget,
} from '../../utils/contextBudget'
import { lookupModelContext } from '../../utils/modelsDev'
import type { LibraryHit } from '../../utils/modelsDev'
import { useChatStore } from '../../stores/chat'
import { CHARACTER_PROMPTS } from '../../constants/prompts'
import {
  API_BASES,
  API_ROUTE_LABELS,
  type ApiRoute,
} from '../../constants/apiRoutes'
import { SETTINGS_NAV } from '../../constants/settingsNav'
import type { SettingsTabKey } from '../../constants/settingsNav'
import { isMobileView } from '../../composables/useMobile'
// ⛔ 临时彩蛋(可删):中秋兑换码的状态与文案 —— 删法见 src/easteregg/moon/README.md
import { MOON_HINT, moonRedeemed, redeemMoon } from '../../easteregg/moon/redeem'
import DataManagerDialog from './DataManagerDialog.vue'

const props = defineProps<{
  /** 是否展开 */
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const settingsStore = useSettingsStore()
const chatStore = useChatStore()

/** 当前标签页(键与 SETTINGS_NAV 一致;提示词与背景已并入 prompts 页的"自定义 API"分支) */
const activeTab = ref<SettingsTabKey>('connection')

/** 当前标签页名称:主区标题用它(侧边栏收起时也要能一眼看出在哪一页) */
const activeLabel = computed(
  () => SETTINGS_NAV.find(t => t.key === activeTab.value)?.label ?? '设置',
)

/**
 * 切换标签页
 *
 * 桌面:常驻一列,换页即可。
 * 窄屏(抽屉形态):选完顺手把浮层收起 —— 不收的话它会一直压着刚选中的那半屏内容。
 */
function onSelectTab(key: SettingsTabKey) {
  activeTab.value = key
  if (isMobileView.value) navOpen.value = false
}

// ⛔ 临时彩蛋(可删):关于页的兑换码输入 —— 状态与文案都在 easteregg/moon/redeem
/** 输入框里的兑换码草稿 */
const eggCode = ref('')
/** 上一次兑换是否失败(只在输入框下方提示,不改任何状态) */
const eggWrong = ref(false)

/** 点「兑换」/ 回车:对了才置位(= 月亮从这一刻起才会被渲染、才会开始下载) */
function onRedeemEgg(): void {
  if (redeemMoon(eggCode.value)) {
    eggWrong.value = false
    eggCode.value = ''
  } else {
    eggWrong.value = true
  }
}

/**
 * 页签栏(窄屏抽屉)是否展开
 *
 * 两端的形态不一样,所以两端的默认值也不一样:
 *   · 桌面:常驻一列「图标 + 文字」,没有收起态 —— 这个值在桌面端不参与样式
 *   · 窄屏:平时是一条只露图标的窄栏($nav-rail-w-sm),点箭头展开成一栏完整菜单,
 *          压在内容之上并弹出遮罩(见媒体查询与 &__nav-scrim)
 *
 * 初始值按设备给,跨断点时回到该端的默认值(手机旋屏、桌面窗口拖到 768 以下
 * 都不会留下"窄屏上还硬撑着展开的抽屉")。
 */
const navOpen = ref(!isMobileView.value)

watch(isMobileView, (mobile) => {
  navOpen.value = !mobile
})

// ---- 页签栏选中指示条(两端都是最左侧的竖黄条) ------------------------------
// 窄屏抽屉与桌面竖列同为竖排,黄条方向一致 —— 不再需要横竖两套样式。
/** 页签行容器(ref) */
const navListEl = ref<HTMLElement | null>(null)
/** 各页签项 DOM(按键名缓存,供指示条测量) */
const navItemEls = new Map<string, HTMLElement>()
/** 就绪信号:递增即强制指示条重算(打开面板、跨断点重排时各一次) */
const navReady = ref(0)

/**
 * 指示条是否已完成首次定位
 *
 * 首帧定位必须**不带过渡** —— 否则打开设置面板时,黄条会从列表起点一路滑到
 * 激活项上。定位落位后再打开过渡,后续切页才是平滑滑动(见 &__nav-indicator)。
 */
const indicatorReady = ref(false)

/**
 * 窄屏横向页签行的滚动状态
 *
 * 页签行两侧那层渐隐(见媒体查询里的 &__nav::before / ::after)只在
 * "那一侧确实还有页签藏着"时才显示:
 *   滚到最左端 → 左渐隐消失;滚到最右端 → 右渐隐消失;
 *   页签全放得下(scrollWidth == clientWidth)→ 两侧都不显示。
 * 否则会让人误以为还有内容没露出来。
 */
const navScrollable = ref(false)
const navAtStart = ref(true)
const navAtEnd = ref(true)

/** 重新量一次页签行的滚动状态(scroll 事件、开面板、跨断点、窗口尺寸变化时调用) */
function updateNavScrollState(): void {
  const el = navListEl.value
  if (!el) return
  const max = el.scrollWidth - el.clientWidth
  // 误差 1px:缩放 / 小数宽度下 scrollWidth 常比 clientWidth 大零点几
  navScrollable.value = max > 1
  navAtStart.value = el.scrollLeft <= 1
  navAtEnd.value = el.scrollLeft >= max - 1
}

// 旋屏(手机横竖屏)时页签宽度不变但可视宽变了,需要重新量一次。
// 面板本身是 v-if,挂不上元素级的 ResizeObserver,所以监听窗口。
onMounted(() => window.addEventListener('resize', updateNavScrollState))
onBeforeUnmount(() => window.removeEventListener('resize', updateNavScrollState))

/** 记录页签项 DOM(Vue ref 回调:卸载时传 null) */
function setNavItemEl(key: string, el: unknown) {
  if (el) navItemEls.set(key, el as HTMLElement)
}

/**
 * 把当前页签滚进视野
 *
 * 窄屏的页签行是横向可滑动的:上次停在靠后的页签(如「关于」)时重开设置,
 * 激活项可能停在屏幕外 —— 看上去就像"一项都没选中"。桌面是竖列、六项一次看全,
 * 这个调用在那边是空操作(nearest 判定已经在视野内就不动)。
 */
function revealActiveTab(): void {
  navItemEls.get(activeTab.value)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

/**
 * 指示条几何:一次算出四项,由样式按断点各取所需。
 *
 * 桌面页签栏是竖列 → 取 height + translateY;
 * 窄屏页签栏是横排 → 取 width + translateX(见媒体查询里的 &__nav-indicator)。
 *
 * 为什么用 offset* 而不是 getBoundingClientRect:窄屏列表要横向滚动,
 * 后者量出来的是"相对视口"的位置(含 scrollLeft),列表一滚黄条就跑偏;
 * offset* 是相对列表内边距边缘的距离,与滚动位置无关。
 * navReady 必须无条件读取(在提前返回之前),否则首帧时还没建立依赖,
 * 页签项进 DOM 后无法触发重算。
 */
const navIndicatorStyle = computed((): Record<string, string> => {
  void navReady.value
  const el = navItemEls.get(activeTab.value)
  if (!el) return {}
  return {
    '--ind-w': `${el.offsetWidth}px`,
    '--ind-h': `${el.offsetHeight}px`,
    '--ind-x': `${el.offsetLeft}px`,
    '--ind-y': `${el.offsetTop}px`,
  }
})

/**
 * 每次打开面板:重新定位指示条,并遵循"先落位、后开过渡"
 *
 * 为什么挂在 open 上而不是 onMounted —— 面板内容是 v-if="open" 的:
 * 组件 mount 时面板还没开、页签项根本不存在(navItemEls 为空),
 * 那一刻做定位只会得到空样式;必须等 open 翻真、页签项进 DOM 才谈得上定位。
 * (早期实现就是挂在 onMounted 上,于是打开面板时黄条会从起点滑到激活项。)
 *
 * 三步缺一不可:
 *   1. await nextTick()  —— 等面板与页签项真正进 DOM,模板 ref 就绪
 *   2. navReady++        —— 触发指示条重算,完成首帧定位(此时过渡仍是关的)
 *   3. 空一帧后再开过渡   —— 让浏览器先把上一步的位置应用上去
 */
watch(
  () => props.open,
  async (open) => {
    if (!open) {
      // 关闭即复位,下次打开重新走一遍完整流程
      indicatorReady.value = false
      return
    }
    await nextTick()
    navReady.value++
    revealActiveTab()
    updateNavScrollState()
    await new Promise<void>(r => requestAnimationFrame(() => r()))
    indicatorReady.value = true
  },
  { immediate: true },
)

/**
 * 跨断点重排(mobile ↔ 桌面):黄条方向由纵向变横向,测量值必须重算。
 * 交接瞬间把过渡关掉,免得横竖两套数值之间做一次奇怪的滑动。
 */
watch(isMobileView, async () => {
  indicatorReady.value = false
  await nextTick()
  navReady.value++
  revealActiveTab()
  updateNavScrollState()
  await new Promise<void>(r => requestAnimationFrame(() => r()))
  indicatorReady.value = true
})

/** 内容滚动容器(切页时回到顶部用) */
const bodyEl = ref<HTMLElement | null>(null)

/**
 * 切页回到顶部
 *
 * 各页高度差很大(关于页很短、API 页很长),沿用上一页的滚动位置会落在半空中 ——
 * 换页时又看不见"滚动条"(面板本来就隐藏了滚动条),很容易以为内容丢了。
 */
watch(activeTab, () => {
  if (bodyEl.value) bodyEl.value.scrollTop = 0
})

/**
 * QQ 群入口(关于页:标题下方、相关链接上方)
 *
 * 点击链接会新开加群页,同时把群号复制到剪贴板 ——
 * 跳转后若用户没登录 QQ 或想手动搜索,群号已经躺在剪贴板里了。
 */
const QQ_GROUPS = [
  {
    label: 'BAKER AI 公告群',
    code: '1056020027',
    url: 'https://qun.qq.com/universal-share/share?ac=1&authKey=DPFveNVF1Z52nYKN7Y5hkQpiyePOyZO1tM%2B5HC3RMwbdBIfllYsZnHlF2JiSOuob&busi_data=eyJncm91cENvZGUiOiIxMDU2MDIwMDI3IiwidG9rZW4iOiJiVWRLVFpsUjZvNWN3NUdoajZJS290aWg5M1lleEJuemc2dnBWUUlsNmhSZFZYN3JySE9xRy9XUUh0dXY1cmpEIiwidWluIjoiMTc2MjQ1NTE3In0%3D&data=kxqHAM5MIP1o9MYhyyAWOUWFZtR-xuKw_s0zbIlz-qz0Jh1KUYK6kpQVwWE5AiG4S4yrUU_hloIJ8m9b4eihTw&svctype=4&tempid=h5_group_info',
  },
  {
    label: 'BAKER AI 交流群',
    code: '926147159',
    url: 'https://qun.qq.com/universal-share/share?ac=1&authKey=VuPGuN9ZJgrnDk1yAYhNa1ttQMgjzWtLq3Dy4zFLeySkCrgZw9XGMAdEkyqwqLuG&busi_data=eyJncm91cENvZGUiOiI5MjYxNDcxNTkiLCJ0b2tlbiI6IjdOY1c3K1B2NnRmR2QrYTJKSklqUVZnNHRxNnBlUytLVlErYm1WdWU1bW5JQjlnQyszam1LLzFuVGlzVjMxNjIiLCJ1aW4iOiIxNzYyNDU1MTcifQ%3D%3D&data=ImB81MsUWZyM0CGFfQegtwvYV4fSFCwpojz2Bjv4-r5Ha_O8_Q8nsfO8vqvWYdVFl_WwpAFVHkfVv4PtQrmSXg&svctype=4&tempid=h5_group_info',
  },
] as const

/**
 * 复制文本到剪贴板
 *
 * 优先用 Clipboard API —— 它只在**安全上下文**(https / localhost)可用,
 * 而本应用既可能跑在 http 页面、也可能在 Electron / 安卓 WebView 里,
 * 所以保留 textarea + execCommand 的兜底。
 * 复制失败不影响链接跳转,故整体静默。
 */
async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // 落到下面的兜底方案
  }
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.style.position = 'fixed'
    el.style.top = '0'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    document.execCommand('copy')
    document.body.removeChild(el)
  } catch {
    // 忽略:跳转仍会正常进行
  }
}

// ---- API 配置本地缓存(打开时同步,保存时写入 store) -------------------------
const apiDraft = ref({
  apiMode: 'custom' as 'custom' | 'backend' | 'legacy',
  baseUrl: '',
  apiKey: '',
  model: '',
  backendUrl: '',
  temperature: 1.0,
  maxTokens: 2048,
  contextWindow: 0,
  autoCompact: true,
  compactTriggerPercent: DEFAULT_COMPACT_TRIGGER_PERCENT,
  requestUsage: true,
})

/** 是否为自定义 API 模式(需要显示 baseUrl/apiKey/model 输入框) */
const isCustomMode = computed(() => apiDraft.value.apiMode === 'custom')

/**
 * 各实验性开关"在当前配置下不生效"的判据
 * (2026-10-04 按各链路实际能力重新划分)
 *
 * 背景:这些开关以前只有「默认 API 模式」与「群聊(走后端群聊服务)」会读,
 * 所以共用一条判据置灰。自定义 API 模式补上群聊链路、并补齐直连的
 * 思考模式 / 沉浸式之后,四项的能力边界各不相同,必须分开判断 ——
 * 否则会把"其实已经生效"的开关误灰(用户根本拨不动)。
 *
 *   - 沉浸式         :三种模式 + 单聊/群聊都已落实(后端过滤或前端本地过滤)→ 永不置灰
 *   - 思考模式       :默认 API 全场景、自定义 API(单聊 think 透传 / 群聊生成)、
 *                     群聊后端链路都生效;仅「旧版直连 + 单聊」不支持
 *   - 使用新版提示词 :只有后端会按 characters_v2/ 加载 → 仅默认 API 模式生效
 *   - 智能总结开关   :只被 applySmartSummary 读取(默认 API / 旧版单聊),
 *                     自定义模式单聊由 token 预算压缩接管 → 沿用旧判据
 */
const thinkBlocked = computed(
  () => apiDraft.value.apiMode === 'legacy' && chatStore.chatMode === 'single',
)
const newPromptBlocked = computed(() => apiDraft.value.apiMode !== 'backend')
const summaryBlocked = computed(
  () => apiDraft.value.apiMode !== 'backend' && chatStore.chatMode === 'single',
)

/** 思考模式禁用时的说明 */
const THINK_BLOCKED_NOTE = '旧版直连不支持思考开关（仅默认 API / 自定义 API / 群聊生效）'
/** 新版提示词禁用时的说明 */
const NEW_PROMPT_BLOCKED_NOTE = '仅「默认 API」模式生效（后端按 characters_v2/ 加载）'
/** 智能总结开关禁用时的说明 */
const SUMMARY_BLOCKED_NOTE = '仅默认 API 模式 / 群聊生效，当前模式下不生效'

/** 受限开关的悬浮提示(禁用时说明原因,可用时不给多余提示) */
const thinkTitle = computed(() => (thinkBlocked.value ? THINK_BLOCKED_NOTE : undefined))
const newPromptTitle = computed(() => (newPromptBlocked.value ? NEW_PROMPT_BLOCKED_NOTE : undefined))
const summaryTitle = computed(() => (summaryBlocked.value ? SUMMARY_BLOCKED_NOTE : undefined))

/**
 * 生成受限开关的提示行
 *
 * @param blocked 该开关在当前配置下是否不生效(不生效时统一换成说明文案)
 */
function blockedHint(
  blocked: boolean,
  note: string,
  on: boolean,
  onText: string,
  offText: string,
) {
  if (blocked) return { text: note, level: 'sd__hint--warn' }
  return { text: on ? onText : offText, level: on ? 'sd__hint--ok' : 'sd__hint--warn' }
}

const thinkHint = computed(() =>
  blockedHint(
    thinkBlocked.value,
    THINK_BLOCKED_NOTE,
    settingsStore.thinkEnabled,
    '已开启：角色会先深度思考再回答',
    '已关闭：角色直接回答',
  ),
)
/**
 * 「强制每条搜索」提示（联网搜索的子选项）
 *
 * 语义已收紧：它**只在联网搜索开启时**出现且生效；只走 RAG 时后端不会联网，
 * 因此这里不再用 blockedHint（那套是"当前配置下不生效"的通用文案）。
 */
const forceSearchHint = computed(() => {
  if (settingsStore.forceSearch) {
    return { level: 'sd__hint--warn' as const, text: '已开启：每条消息都强制联网搜索（跳过智能判断，上游消耗更高）' }
  }
  return { level: 'sd__hint--ok' as const, text: '已关闭（推荐）：由后端智能判断这条消息是否需要联网搜索' }
})
/**
 * 知识源提示（RAG 语料库 / 联网搜索）
 *
 * 注意语义方向：这里**开启**代表切换到联网搜索，所以"关闭"才是默认的 RAG 语料库。
 * 不用 blockedHint —— 它是"当前配置下不生效"的通用文案，本开关不受该限制。
 */
const knowledgeSourceHint = computed(() => {
  if (settingsStore.webSearchEnabled) {
    return { level: 'sd__hint--ok' as const, text: '已开启：改用联网搜索（每次按需联网检索最新信息）' }
  }
  return { level: 'sd__hint--keep' as const, text: '已关闭（默认）：使用 RAG 语料库（本地知识库检索，速度更快）' }
})
/**
 * 「沉浸式对话模式」提示行
 *
 * 三种模式 + 单聊/群聊都已落实(后端过滤或前端本地过滤)→ 永不置灰,
 * 因此不再走 blockedHint,只按开关状态给描述。
 */
const immersiveHint = computed(() => {
  const on = settingsStore.immersiveMode
  return {
    level: on ? 'sd__hint--ok' : 'sd__hint--warn',
    text: on
      ? '已开启：角色只输出对话语句，不显示括号动作描写'
      : '已关闭：角色保留括号内动作/神态/情景描写',
  }
})
const useNewPromptHint = computed(() =>
  blockedHint(
    newPromptBlocked.value,
    NEW_PROMPT_BLOCKED_NOTE,
    settingsStore.useNewPrompt,
    '已开启：加载 characters_v2 新版角色提示词',
    '已关闭：使用默认旧版角色提示词',
  ),
)

/**
 * 「沉浸式对话模式」开启时,两个括号样式开关一起锁住
 *
 * 该模式要求后端**不写**括号动作/神态(只留台词),回复里压根不会出现括号描写,
 * 于是「括号描写居中」「彩色括号描写」都无从生效 —— 置灰并说明原因,
 * 免得玩家拨了开关却看不到任何变化。
 *
 * 与上面几个 blocked 判据的区别:那些是"当前 API 模式不生效"(换模式就恢复),
 * 这个是"上游不会产出可居中的内容"(得先把沉浸式关掉)。
 * 两者互相独立,可能同时成立。
 */
const bracketStyleLocked = computed(() => settingsStore.immersiveMode)

/** 被沉浸式锁住时的统一说明(悬浮提示与提示行共用同一句) */
const IMMERSIVE_LOCK_NOTE = '「沉浸式对话模式」开启时，角色不写括号动作 / 神态描写'

/**
 * 「括号描写居中」提示行
 *
 * 三种状态:被沉浸式锁住 → 开关开 / 关。
 * (本项原先在模板里内联三元,加了"锁住"这一态后挪到 computed,避免嵌套太深)
 */
const bracketCenterHint = computed(() => {
  if (bracketStyleLocked.value) {
    return {
      level: 'sd__hint--keep' as const,
      text: `${IMMERSIVE_LOCK_NOTE}，没有可居中的内容；关掉它即可恢复本项（本项设置不会被改动）`,
    }
  }
  return settingsStore.bracketCenter
    ? {
        level: 'sd__hint--ok' as const,
        text: '已开启：() 内的动作 / 神态描写从气泡中取出，单独渲染为一条居中文本（不含括号）',
      }
    : {
        level: 'sd__hint--warn' as const,
        text: '已关闭：括号描写留在气泡里（默认，旧版行为）',
      }
})

/**
 * 「彩色括号描写」提示行
 *
 * 两层依赖,按优先级说明:
 *   1. 「沉浸式对话模式」开着 → 上游不产出括号描写,说什么都白搭
 *   2. 「括号描写居中」关着 → 没有居中行,颜色无从谈起
 * 这不是"当前配置下不生效",所以**不用** blockedHint,单独说明依赖关系。
 */
const bracketColorHint = computed(() => {
  if (bracketStyleLocked.value) {
    return {
      level: 'sd__hint--keep' as const,
      text: `${IMMERSIVE_LOCK_NOTE}，没有可上色的内容；关掉它即可恢复本项（本项设置不会被改动）`,
    }
  }
  if (!settingsStore.bracketCenter) {
    return {
      level: 'sd__hint--keep' as const,
      text: '需先开启上方「括号描写居中」—— 那条决定有没有居中行，本条只决定居中行的颜色',
    }
  }
  return settingsStore.bracketColor
    ? {
        level: 'sd__hint--ok' as const,
        text: '已开启：居中描写按说话人的属性上色（物理 灰 / 灼热 红 / 电磁 黄 / 寒冷 青 / 自然 绿 / 超域 紫）',
      }
    : {
        level: 'sd__hint--warn' as const,
        text: '已关闭（默认）：所有居中描写都用统一的半透明白',
      }
})

/**
 * 「居中我方括号内容」提示行
 *
 * 只影响我方消息的开头那对括号;颜色按"我在当前会话里的身份"取属性
 * (单人 = 管理员 physical;群聊里扮演某角色 = 该角色)。
 */
const centerMyBracketHint = computed(() =>
  settingsStore.centerMyBracket
    ? {
        level: 'sd__hint--ok' as const,
        text: '已开启：我发出的消息里最前面那对（）会抽成居中文本，颜色按我的身份属性（单人 = 管理员，群聊里扮演某角色 = 该角色）；后面的括号不动',
      }
    : {
        level: 'sd__hint--warn' as const,
        text: '已关闭（默认）：我方消息整条一个气泡，括号留在正文里',
      },
)

// ---- 模型列表(主 API / 总结 API 各一份,逻辑在 useModelPicker 里) -------------
// summaryDraft 必须先于这里的 useModelPicker 声明:composable 内部的 watch
// 在 setup 期间就会读一次 source(),那时若 summaryDraft 还在 TDZ 会直接抛错。
/** 智能总结配置草稿(打开时从 store 同步,保存时写回) */
const summaryDraft = ref({ ...settingsStore.summaryConfig })

const {
  options: modelOptions,
  loading: modelListLoading,
  error: modelListError,
  load: loadModels,
} = useModelPicker(() => ({ baseUrl: apiDraft.value.baseUrl, apiKey: apiDraft.value.apiKey }))

const {
  options: summaryModelOptions,
  loading: summaryModelListLoading,
  error: summaryModelListError,
  load: loadSummaryModels,
} = useModelPicker(() => ({ baseUrl: summaryDraft.value.baseUrl, apiKey: summaryDraft.value.apiKey }))

/** 服务商在 /models 里给出的上下文长度(键 = 模型 id) */
const apiContextById = computed(() => {
  const map = new Map<string, number>()
  for (const m of modelOptions.value) {
    if (m.contextLength !== undefined) map.set(m.id, m.contextLength)
  }
  return map
})

// ---- 上下文窗口自动获取(models.dev 在线模型库) --------------------------------
/** 在线库的查询结果(尚未查到 / 查不到时为 null) */
const libraryHit = ref<LibraryHit | null>(null)
/** 是否正在查询 */
const libraryFetching = ref(false)

/**
 * 当前模型名对应的上下文窗口推断结果
 *
 * 推断本身是纯函数(utils/modelContext),这里只负责把"外部探到的值"喂进去:
 * 服务商 /models 的精确值、以及 models.dev 在线库的值。
 */
const contextGuess = computed(() => {
  const id = apiDraft.value.model.trim()
  const lib = libraryHit.value
  return guessContextWindow(id, {
    fromApi: apiContextById.value.get(id),
    // 结果必须属于当前模型:异步回来时用户可能已经改了模型名
    fromLibrary: lib && lib.modelId === id.toLowerCase() ? lib.contextWindow : undefined,
  })
})

/**
 * 是否视为"用户从未设置过上下文窗口"
 *
 * 0 = 现在的默认(空);65536 = 旧版默认值,老配置里存的就是它 ——
 * 一起当作"没设置过",否则老用户打开设置时自动获取就不会生效。
 */
function contextWindowUnset(value: number): boolean {
  return !(value > 0) || value === FALLBACK_CONTEXT_WINDOW
}

/**
 * 把获取到的上下文窗口写入草稿(没获取到时保持原值不动,绝不瞎覆盖)
 *
 * @param mode 'change'  用户刚刚换了模型 → 无条件覆盖
 *             'passive' 打开设置 / 模型列表刷新 / 在线库返回 → 只在用户没设置过时才写
 *
 * 为什么必须分这两种:'passive' 若无条件覆盖,用户刻意设的保守值
 * (省 token,或端点实际上限比模型标称更低)每次打开设置都会被改回去,
 * 而且改完用户还不知道是谁改的。'change' 则相反 —— 用户刚换了模型,
 * 旧窗口已经不属于这个模型了,跟着换才对。
 *
 * 【写草稿的同时立刻落库】这个值是"自动获取"来的,界面已经明确告诉用户
 * "自动获取上下文长度成功" —— 若还要再点一次「保存」才生效,忘了点就白获取了。
 * 本字段是该标签页里唯一写穿的:其余字段(baseUrl / key / 温度 …)仍走草稿 + 保存,
 * 因为那些是用户自己敲的,保留"改完再确认"的语义更安全。
 */
function applyContextGuess(mode: 'change' | 'passive' = 'passive'): void {
  const g = contextGuess.value
  if (g.contextWindow <= 0) return
  if (mode === 'passive' && !contextWindowUnset(apiDraft.value.contextWindow)) return
  // 值没变就不必再写一次 store(避免每次打开设置都触发一轮落库)
  if (apiDraft.value.contextWindow === g.contextWindow) return
  apiDraft.value.contextWindow = g.contextWindow
  settingsStore.updateApiConfig({ contextWindow: g.contextWindow })
}

/** 获取到的值与当前填写值不同(不同才显示"应用"按钮) */
const contextGuessApplicable = computed(
  () => contextGuess.value.contextWindow > 0 && contextGuess.value.contextWindow !== apiDraft.value.contextWindow,
)

/**
 * 上下文窗口输入框的双向绑定
 *
 * 单独做一层映射的原因:未设置时用 0 表示,而 number 输入框会把 0 显示成 "0",
 * 看起来像"窗口是 0"。这里把 0 映射成空串,用户清空输入框也存回 0。
 */
const contextWindowInput = computed({
  get: () => (apiDraft.value.contextWindow > 0 ? String(apiDraft.value.contextWindow) : ''),
  set: (raw: string) => {
    const n = Number(String(raw).replace(/[^\d]/g, ''))
    apiDraft.value.contextWindow = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  },
})

/**
 * 触发压缩占比:用单向 :value + 失焦时夹取回写
 *
 * 不用 v-model 的原因有两个:
 *   1. `.number` 修饰符在输入框为空时会把 `''` 写进 number 字段(类型谎言)
 *   2. 输入过程中不该夹取 —— 否则想输 "100" 时刚敲下 "1" 就被改成 "10"
 * 故只在 change(失焦/回车)时夹到 [10, 100] 并写回 DOM。
 */
function onTriggerPercentChange(event: Event) {
  const el = event.target as HTMLInputElement
  const raw = Number(el.value)
  const clamped = clampTriggerPercent(Number.isFinite(raw) ? raw : DEFAULT_COMPACT_TRIGGER_PERCENT)
  apiDraft.value.compactTriggerPercent = clamped
  el.value = String(clamped)
}

/**
 * 当前设置下的实际触发阈值(Token)
 *
 * 直接调引擎同款的 computeInputBudget,而不是自己算"窗口 × 占比" ——
 * 后者在占比设成 100% 时会给出一个超过窗口的数字,而引擎实际还会被
 * "窗口 − 生成预留 − 安全余量"这道硬上限压住。提示里的数字必须与实际判据一致。
 */
const triggerTokens = computed(() =>
  computeInputBudget(
    apiDraft.value.contextWindow,
    apiDraft.value.maxTokens,
    apiDraft.value.compactTriggerPercent,
  ),
)

/**
 * 查询一次上下文窗口
 *
 * utils/modelsDev 内部有 24 小时内存缓存、single-flight 与失败冷却
 * (解压后 4.5MB,brotli 传输约 330KB),所以"打开设置 / 换模型 / 改 Base URL"
 * 都调一次是安全的 —— 真正打网络的只有本页面加载后的第一次。
 *
 * 查不到时什么都不显示:字段留空,由 placeholder 告诉用户可以手动填。
 */
async function queryContextWindow(): Promise<void> {
  // 只有自定义模式才用得上(其他模式没有 baseUrl/模型可填)
  if (!isCustomMode.value) return
  const model = apiDraft.value.model.trim()
  if (!model) {
    libraryHit.value = null
    return
  }
  libraryFetching.value = true
  const hit = await lookupModelContext(model, apiDraft.value.baseUrl)
  libraryFetching.value = false
  // 结果回来时模型可能已经被改掉,过期结果直接丢弃(否则会给另一个模型套上错的窗口)
  if (apiDraft.value.model.trim() !== model) return
  libraryHit.value = hit
  // 被动应用:只在用户没设置过窗口时才写入
  applyContextGuess()
}

/** 换模型 / 改 Base URL 时重查(轻防抖:连续敲字只查最后一次) */
let contextTimer: number | undefined
watch(
  () => `${apiDraft.value.model}\u0000${apiDraft.value.baseUrl}`,
  () => {
    window.clearTimeout(contextTimer)
    libraryHit.value = null
    if (!apiDraft.value.model.trim()) return
    contextTimer = window.setTimeout(() => void queryContextWindow(), 350)
  },
)

/**
 * 获取模型列表(主 API)
 *
 * @param force true = 忽略缓存(用户手动点击);false = 自动路径,走 utils/modelList 的缓存
 *
 * 列表回来后才可能带出服务商给出的上下文长度,顺势补一次窗口推断
 * (被动模式,不覆盖用户手改过的值)。
 */
async function loadMainModels(force: boolean) {
  await loadModels(force)
  applyContextGuess()
}

/** 手动点击"获取模型列表" */
function onFetchModels() {
  void loadMainModels(true)
}

/**
 * 自动获取(打开弹窗时、切到自定义模式时)
 *
 * 不做"同一组配置只拉一次"的自建去重 —— 去重交给 utils/modelList 的缓存:
 * 成功与失败都缓存 10 分钟,重复调用不会打网络,用户换地址/换 Key 又会自然
 * 变成新的缓存键。多处各写一份去重逻辑反而容易走散。
 */
function maybeAutoFetchModels() {
  if (!isCustomMode.value) return
  if (!apiDraft.value.baseUrl.trim()) return
  void loadMainModels(false)
}

// ---- 模型列表(总结 API):与主 API 同一套,只是不带上下文窗口推断 -------------
/** 手动点击"获取模型列表" */
function onFetchSummaryModels() {
  void loadSummaryModels(true)
}

/** 自动获取(打开弹窗时、切到总结 API 的自定义模式时) */
function maybeAutoFetchSummaryModels() {
  if (!isSummaryCustomMode.value) return
  if (!summaryDraft.value.baseUrl.trim()) return
  void loadSummaryModels(false)
}

/** 是否为后端模式(地址内置,无需填写) */
// ---- 后端路线(测试版:默认 / 备用两个域名,指向同一套后端) --------------------
//
// 渲染位置:「连接设置」页 → 默认 API 模式分支(与它影响的对象在同一处)。
// 自定义/旧版模式不经过这条网关链路,所以不显示。
//
// 部分网络环境无法解析或连通默认域名(api.peilika.beer),切到备用域名
// (api2.peilika.beer)即可。两条路线的上游是同一套后端 —— 网关 5501 +
// 群聊 5810,请求规则与回复完全一致,只有域名不同。
const API_ROUTE_OPTIONS: { value: ApiRoute; label: string; host: string }[] = (
  ['primary', 'backup'] as const
).map((r) => ({
  value: r,
  label: API_ROUTE_LABELS[r],
  host: API_BASES[r].replace(/^https?:\/\//, ''),
}))

/** 当前路线的域名(界面上直接显示出来,方便排查"到底打到哪了") */
const currentRouteHost = computed(
  () => API_ROUTE_OPTIONS.find((o) => o.value === settingsStore.apiRoute)?.host ?? '',
)

const isBackendMode = computed(() => apiDraft.value.apiMode === 'backend')

/** 是否为旧版模式(直连 Agnes API,无需填写) */
const isLegacyMode = computed(() => apiDraft.value.apiMode === 'legacy')

/**
 * 启用 / 停用自定义 API
 *
 * 「连接设置」页只保留 默认 API 与 旧版模式,自定义模式的开关随之挪到
 * 「自定义 API」页 —— "当前用哪套端点"于是只有一个入口,不会两页各说一套。
 * 停用时退回「默认 API」:旧版模式是不推荐的兼容路径,不该作为关闭后的落点。
 */
function toggleCustomApi() {
  switchApiMode(isCustomMode.value ? 'backend' : 'custom')
}

/** 当前对话的角色名(后端模式连接测试用它解析该角色的固定地址) */
const currentCharName = computed(() =>
  chatStore.activeSub !== null
    ? chatStore.conversations[chatStore.activeSub]?.name ?? ''
    : '',
)

// ---- 提示词编辑 ---------------------------------------------------------
/** 所有可编辑提示词的角色名列表(内置角色) */
const characterNames = computed(() => Object.keys(CHARACTER_PROMPTS))

/**
 * 当前提示词绑定的角色(跟随当前对话,不可手动切换)
 *
 * 无选中对话 / 角色不在内置表 → 空串(草稿为空,编辑区禁用)。
 */
const selectedCharacter = computed<string>(() =>
  currentCharName.value && characterNames.value.includes(currentCharName.value)
    ? currentCharName.value
    : '',
)
/** 当前角色的提示词草稿 */
const characterPromptDraft = ref('')

/** 当前角色是否为内置角色(有默认提示词可恢复) */
const isBuiltinCharacter = computed(() =>
  selectedCharacter.value ? selectedCharacter.value in CHARACTER_PROMPTS : false,
)

// 打开弹窗时同步本地缓存
watch(
  () => props.open,
  (open) => {
    if (open) {
      apiDraft.value = { ...settingsStore.apiConfig }
      // 智能总结草稿(打开时从 store 同步)
      summaryDraft.value = { ...settingsStore.summaryConfig }
      // 提示词草稿跟随当前对话角色(角色由 currentCharName 派生,无需手动同步)
      characterPromptDraft.value = settingsStore.getCharacterPrompt(selectedCharacter.value)
      // 自动填上下文窗口(被动模式:仅当用户没设置过,绝不覆盖手改过的值)
      applyContextGuess()
      // 再查一次在线模型库(内部有 24h 缓存与失败冷却,重复打开不会重复下载)
      void queryContextWindow()
      // 自定义模式下自动拉一次模型列表(已缓存则瞬时返回,不打网络)
      maybeAutoFetchModels()
      maybeAutoFetchSummaryModels()
    }
  },
)

/** 智能总结是否为默认模式(内置 Agnes API) */
const isSummaryDefaultMode = computed(() => summaryDraft.value.apiMode === 'default')

/** 智能总结是否为自定义模式(用户自填 Base URL/Key/模型) */
const isSummaryCustomMode = computed(() => summaryDraft.value.apiMode === 'custom')

/** 切换智能总结 API 模式(默认/自定义),同步草稿(落库由写穿 watch 负责) */
function switchSummaryApiMode(mode: 'default' | 'custom') {
  summaryDraft.value.apiMode = mode
  // 切到自定义就顺手拉一次该端点的模型列表(已缓存则瞬时返回)
  if (mode === 'custom') maybeAutoFetchSummaryModels()
}

/**
 * 智能总结开关的提示行
 *
 * 该开关只被 applySmartSummary 读取,而自定义模式单聊不走那条路径
 * (由 token 预算压缩接管)→ 仅该组合置灰,共用 blockedHint 的处理。
 */
const summaryHint = computed(() =>
  blockedHint(
    summaryBlocked.value,
    SUMMARY_BLOCKED_NOTE,
    summaryDraft.value.enabled,
    '已开启：不看条数；用量达到上下文窗口 80% 时自动总结 80% 以外的历史（留 20% 给 RAG）',
    '已关闭：固定截断最近 50 条消息',
  ),
)

/**
 * 智能总结配置草稿 → store 的即时写穿
 *
 * 与 API 配置同一套做法:开关、总结 API 模式、自定义地址/密钥/模型,改一处即落库,
 * 不再需要点「保存总结设置」—— 那个按钮已随之移除。
 */
watch(
  summaryDraft,
  (draft) => {
    settingsStore.updateSummaryConfig({ ...draft })
  },
  { deep: true },
)

// 当前对话角色变化时同步提示词草稿(空角色 → 空提示词)
watch(selectedCharacter, (name) => {
  if (name) {
    characterPromptDraft.value = settingsStore.getCharacterPrompt(name)
  } else {
    characterPromptDraft.value = ''
  }
})

/**
 * API 配置草稿 → store 的即时写穿
 *
 * 自定义 API 模式下的这些配置(Base URL / 密钥 / 模型名 / 温度 / 最大 Token /
 * 上下文窗口 / 触发占比 / 自动压缩 / 流式用量 …)一律**改一处即落库**,
 * 不再需要点底部的「保存」—— 那个按钮已随之移除,免得留一个点了没意义的按钮。
 *
 * 为什么保留草稿层而不是把输入框直接双向绑定到 store:
 *   打开弹窗时要先把 store 快照一次性灌进草稿(见上面的 watch(props.open)),
 *   写穿则负责"编辑 → store"这一个方向。两者分开,各自只做一件事。
 *
 * 成本:每次按键写一次 localStorage,载荷只有几百字节(与 worldView 的现有写法
 * 一致);IndexedDB 那一侧还有 300ms 防抖兜底,不会每次击键都落盘。
 */
watch(
  apiDraft,
  (draft) => {
    settingsStore.updateApiConfig({ ...draft })
  },
  { deep: true },
)

/**
 * 切换 API 模式(默认 API / 自定义 API / 旧版模式):立即持久化,无需点保存。
 * 切换时同步草稿与 store,关闭弹窗再打开仍是新模式。
 */
function switchApiMode(mode: 'custom' | 'backend' | 'legacy') {
  apiDraft.value.apiMode = mode
  // 模式以外的字段由上面的写穿 watch 一并同步,这里只需保证模式立即生效
  maybeAutoFetchModels()
}

/** 连接测试状态 */
const testState = ref<'idle' | 'testing' | 'success' | 'fail'>('idle')
const testMessage = ref('')

/** 测试 API 连接 */
async function onTestConnection() {
  testState.value = 'testing'
  testMessage.value = ''
  try {
    const result = isBackendMode.value
      ? await testBackendConnection({ ...apiDraft.value }, currentCharName.value)
      : await testApiConnection({ ...apiDraft.value })
    testState.value = result.ok ? 'success' : 'fail'
    testMessage.value = result.message
  } catch {
    testState.value = 'fail'
    testMessage.value = '连接失败: 未知错误'
  }
}

/** 保存角色提示词 */
function saveCharacterPrompt() {
  if (!selectedCharacter.value) return
  settingsStore.setPromptOverride(selectedCharacter.value, characterPromptDraft.value)
}

/** 重置角色提示词为内置默认 */
function resetCharacterPrompt() {
  if (!selectedCharacter.value) return
  settingsStore.resetPromptOverride(selectedCharacter.value)
  characterPromptDraft.value = settingsStore.getCharacterPrompt(selectedCharacter.value)
}

/** 重置全部设置 */
function resetAll() {
  settingsStore.resetAll()
  apiDraft.value = { ...settingsStore.apiConfig }
  if (selectedCharacter.value) {
    characterPromptDraft.value = settingsStore.getCharacterPrompt(selectedCharacter.value)
  }
}

</script>

<template>
  <Transition name="ab">
    <!-- 设置面板:居中窗口。左侧为页签栏(手机版改为顶部横向可滑动),右侧为当前页内容。
         点面板外的半透明黑遮罩即关闭(回到对话主界面),与左上角「退出」按钮等价。
         用 @click.self 精确判定"点的是遮罩本身",面板内部的点击不会冒泡到这里。 -->
    <div v-if="open" class="sd" @click.self="emit('close')">
      <div class="sd__panel">
        <!-- 关闭(×):窄屏全屏时唯一的退出入口(桌面端由页签栏头部的箭头承担,这里隐藏) -->
        <button class="sd__close" type="button" aria-label="关闭设置" @click="emit('close')">×</button>
        <!-- ============ 页签栏 ============
             桌面:常驻一列(左侧竖直,图标 + 文字,没有收起态);
             窄屏:浮层抽屉 —— 收起时只剩一条图标窄栏($nav-rail-w-sm),
                   点箭头展开成一栏完整菜单并压住内容、弹出遮罩(见媒体查询) -->
        <aside
          class="sd__nav"
          :class="{
            'sd__nav--open': navOpen,
            'sd__nav--scrollable': navScrollable,
            'sd__nav--at-start': navAtStart,
            'sd__nav--at-end': navAtEnd,
          }"
        >
          <div class="sd__nav-head">
            <!-- 收起 / 展开按钮(仅窄屏渲染):单个箭头,展开时旋转 180°(向左 = 收起)。
                 桌面端页签栏常驻一列,不需要它。 -->
            <button
              class="sd__nav-toggle"
              type="button"
              :aria-expanded="navOpen"
              :aria-label="navOpen ? '收起页签栏' : '展开页签栏'"
              @click="navOpen = !navOpen"
            >
              <svg viewBox="0 0 48 48" aria-hidden="true">
                <path
                  d="M20 10 L33 24 L20 38"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <!-- 退出按钮:关闭整个设置窗口,回到对话主界面。
                 两端统一(左向箭头图标)。窄屏抽屉收起时它被窄栏裁掉,
                 展开后回到头部右端;点面板外的黑遮罩同样能退出。 -->
            <button
              class="sd__nav-exit"
              type="button"
              aria-label="退出设置"
              @click="emit('close')"
            >
              <svg viewBox="0 0 48 48" aria-hidden="true">
                <path
                  d="M28 10 L15 24 L28 38"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <span class="sd__nav-text sd__nav-title">设置</span>
          </div>

          <div class="sd__nav-list" ref="navListEl" @scroll.passive="updateNavScrollState">
            <button
              v-for="t in SETTINGS_NAV"
              :key="t.key"
              class="sd__nav-item"
              :class="{ 'sd__nav-item--active': activeTab === t.key }"
              :ref="(el) => setNavItemEl(t.key, el)"
              type="button"
              :title="t.label"
              @click="onSelectTab(t.key)"
            >
              <!-- 图标:实心片段用 currentColor 填充,其余一律描边(见 constants/settingsNav) -->
              <span class="sd__nav-icon">
                <svg viewBox="0 0 48 48" aria-hidden="true">
                  <path
                    v-for="(p, i) in t.icon"
                    :key="i"
                    :d="p.d"
                    :fill="p.filled ? 'currentColor' : 'none'"
                    :stroke="p.filled ? 'none' : 'currentColor'"
                    stroke-width="4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </span>
              <span class="sd__nav-text">{{ t.label }}</span>
            </button>

            <!-- 选中项最左侧的竖黄条(跟随激活项;首次定位后才开动画,见 indicatorReady) -->
            <div
              class="sd__nav-indicator"
              :class="{ 'is-ready': indicatorReady }"
              :style="navIndicatorStyle"
            ></div>
          </div>
        </aside>

        <!-- 窄屏抽屉展开时的遮罩:点它收起(桌面端页签栏是常驻列,不需要) -->
        <div
          v-if="isMobileView"
          class="sd__nav-scrim"
          :class="{ 'sd__nav-scrim--on': navOpen }"
          @click="navOpen = false"
        ></div>

        <!-- 当前页标题:主区第一行(两端都在页签栏右侧;抽屉收起时只露图标,
             全靠这一行知道当前在哪一页,所以窄屏不再隐藏它) -->
        <h2 class="sd__title">{{ activeLabel }}</h2>

        <div class="sd__body" ref="bodyEl">
          <!-- API 配置:顶部是模式开关,下面按模式分支;页面末尾是连接测试 / 重置全部 -->
          <div v-if="activeTab === 'connection'" class="sd__section">
            <!-- 模式切换:三列(默认 / 自定义 / 旧版),黄块跟随当前模式 -->
            <div class="sd__field sd__field--row">
              <span class="sd__label">API 模式</span>
              <div class="sd__mode-toggle">
                <!-- 黄色滑动指示条(跟随当前模式)。三列时一格 = 1/3,
                     步进仍是 100% / 200%(位移基准是指示条自身宽度):
                     第 2 格 = 自定义 API、第 3 格 = 旧版模式。 -->
                <div
                  class="sd__mode-indicator sd__mode-indicator--three"
                  :class="{
                    'sd__mode-indicator--step-1': isCustomMode,
                    'sd__mode-indicator--step-2': isLegacyMode,
                  }"
                ></div>
                <button
                  class="sd__mode-btn"
                  :class="{ 'sd__mode-btn--active': isBackendMode }"
                  type="button"
                  @click="switchApiMode('backend')"
                >默认模式</button>
                <button
                  class="sd__mode-btn"
                  :class="{ 'sd__mode-btn--active': isCustomMode }"
                  type="button"
                  @click="switchApiMode('custom')"
                >自定义API</button>
                <button
                  class="sd__mode-btn"
                  :class="{ 'sd__mode-btn--active': isLegacyMode }"
                  type="button"
                  @click="switchApiMode('legacy')"
                >旧版模式</button>
              </div>
              <p v-if="isLegacyMode" class="sd__hint sd__hint--warn">旧版模式（不推荐）：直连API，功能受限，建议使用默认模式</p>
            </div>

            <template v-if="isBackendMode">
              <p class="sd__desc sd__desc--keep">当前干员：{{ currentCharName || '未选中' }}</p>
              <p class="sd__desc">服务方免费 API 模式下无法自定义提示词与世界观背景，请切换到「自定义 API」以启用。</p>

              <!-- 后端路线(默认 / 备用两个域名,指向同一套后端)。
                   部分网络环境连不上默认域名,切到备用即可 —— 上游完全相同,只是域名不同。 -->
              <div class="sd__field">
                <span class="sd__label">后端路线</span>
                <div class="sd__route">
                  <button
                    v-for="opt in API_ROUTE_OPTIONS"
                    :key="opt.value"
                    type="button"
                    class="sd__btn"
                    :class="{ 'sd__btn--primary': settingsStore.apiRoute === opt.value }"
                    @click="settingsStore.setApiRoute(opt.value)"
                  >{{ opt.label }}</button>
                </div>
                <p class="sd__hint sd__hint--ok sd__hint--keep">
                  当前：{{ currentRouteHost }}<span class="sd__pc-only">　两条路线指向同一套测试后端，连不上默认域名时切「备用」</span>
                </p>
              </div>
            </template>

            <template v-if="isLegacyMode">
              <p class="sd__desc sd__desc--keep">当前干员：{{ currentCharName || '未选中' }}</p>
              <p class="sd__desc">此模式功能受限，建议使用「默认 API」。</p>
              <p class="sd__desc">服务方免费 API 模式下无法自定义提示词与世界观背景，请切换到「自定义 API」以启用。</p>
              <div class="sd__field sd__field--row">
                <span class="sd__label">完整历史模式</span>
                <button
                  type="button"
                  class="sd__switch"
                  :class="{ 'sd__switch--on': settingsStore.legacyUnlimitedHistory }"
                  @click="settingsStore.legacyUnlimitedHistory = !settingsStore.legacyUnlimitedHistory"
                >{{ settingsStore.legacyUnlimitedHistory ? '开启 ✓' : '关闭' }}</button>
                <p class="sd__hint" :class="settingsStore.legacyUnlimitedHistory ? 'sd__hint--ok' : 'sd__hint--warn'">
                  {{ settingsStore.legacyUnlimitedHistory ? '已开启：不限制历史条数，不触发智能总结，与旧版项目行为一致' : '已关闭：限制 50 条历史，可配合智能总结使用' }}
                </p>
              </div>
            </template>

              <!-- 自定义 API 分支:端点配置 + 提示词 + 世界观背景(仅自定义模式下可见/生效) -->
              <template v-if="isCustomMode">
<div class="sd__divider"></div>

              <label class="sd__field">
                <span class="sd__label">Base URL</span>
                <input
                  v-model="apiDraft.baseUrl"
                  class="sd__input"
                  type="text"
                  placeholder="https://api.openai.com/v1"
                />
              </label>
              <label class="sd__field">
                <span class="sd__label">API Key</span>
                <input
                  v-model="apiDraft.apiKey"
                  class="sd__input"
                  type="password"
                  placeholder="sk-..."
                />
              </label>
              <label class="sd__field">
                <span class="sd__label">模型名</span>
                <input
                  v-model="apiDraft.model"
                  class="sd__input"
                  type="text"
                  placeholder="deepseek-v4-flash / glm-5.2 / kimi-k3 / ..."
                  @change="applyContextGuess('change')"
                />
              </label>

              <!-- 模型列表:从 Base URL 的 /models 拉取,下拉直接选(免手敲模型名) -->
              <div class="sd__field">
                <div class="sd__actions">
                  <button
                    class="sd__btn sd__btn--preset"
                    type="button"
                    :disabled="modelListLoading"
                    @click="onFetchModels"
                  >{{ modelListLoading ? '获取中…' : '获取模型列表' }}</button>
                </div>
                <p v-if="modelListError" class="sd__hint sd__hint--warn sd__hint--keep">{{ modelListError }}</p>
                <p v-else-if="modelOptions.length" class="sd__hint sd__hint--ok sd__hint--keep">
                  已获取 {{ modelOptions.length }} 个模型，可从下方选择
                </p>
                <select
                  v-if="modelOptions.length"
                  v-model="apiDraft.model"
                  class="sd__input sd__select"
                  @change="applyContextGuess('change')"
                >
                  <option value="">— 从列表选择 —</option>
                  <option v-for="m in modelOptions" :key="m.id" :value="m.id">{{ m.id }}</option>
                </select>
              </div>

              <!-- 温度 + 最大 Token -->
              <label class="sd__field">
                <span class="sd__label">温度 ({{ apiDraft.temperature.toFixed(1) }})</span>
                <input
                  v-model.number="apiDraft.temperature"
                  class="sd__slider"
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                />
              </label>
              <label class="sd__field">
                <span class="sd__label">最大 Token 数</span>
                <input
                  v-model.number="apiDraft.maxTokens"
                  class="sd__input"
                  type="number"
                  min="1"
                  max="32768"
                />
              </label>

              <!-- 上下文窗口:输入预算与"上下文已用"百分比的分母。
                   无法从 API 探测,只能由用户按所用模型填写 —— 填错会让
                   用量面板的占用率与自动压缩时机都不准。 -->
              <div class="sd__field">
                <span class="sd__label">上下文窗口 (Token)</span>
                <!-- 这里**不能**挂 @change="applyContextGuess('change')" ——
                     那个"无条件覆盖"是给"模型名变了"用的;挂在这个框自己身上,
                     会导致用户手改(或清空)窗口值、一失焦就被重新填回去 -->
                <input
                  v-model="contextWindowInput"
                  class="sd__input"
                  type="number"
                  min="1024"
                  step="1024"
                  placeholder="留空则自动获取，获取不到请手动填写"
                />
                <!-- 只有"已获取到、且与当前填写值不同"时才给一键应用 -->
                <div v-if="contextGuessApplicable" class="sd__actions">
                  <button
                    class="sd__btn sd__btn--preset"
                    type="button"
                    @click="applyContextGuess('change')"
                  >应用 {{ contextGuess.contextWindow }}</button>
                </div>
                <p v-if="contextGuess.contextWindow > 0" class="sd__hint sd__hint--ok sd__hint--keep">
                  自动获取上下文长度成功：{{ contextGuess.contextWindow }}
                </p>
                <p v-else-if="libraryFetching" class="sd__hint sd__hint--keep">正在自动获取上下文长度…</p>
              </div>

              <!-- 触发压缩的占比:占用达到"窗口 × 该占比"就压缩,不等塞满 -->
              <div class="sd__field">
                <span class="sd__label">触发压缩的上下文占比 (%)</span>
                <input
                  :value="apiDraft.compactTriggerPercent"
                  class="sd__input"
                  type="number"
                  :min="MIN_COMPACT_TRIGGER_PERCENT"
                  :max="MAX_COMPACT_TRIGGER_PERCENT"
                  step="5"
                  @change="onTriggerPercentChange"
                />
                <p class="sd__hint sd__hint--keep">
                  达到 {{ triggerTokens.toLocaleString('en-US') }} Token 触发压缩<span class="sd__pc-only">（占窗口的 {{ apiDraft.compactTriggerPercent }}%，默认 {{ DEFAULT_COMPACT_TRIGGER_PERCENT }}%）</span>
                </p>
              </div>

              <!-- 自动压缩:只控制自动路径是否调用总结 API,手动压缩不受它影响 -->
              <div class="sd__field sd__field--row">
                <span class="sd__label">自动压缩上下文</span>
                <button
                  type="button"
                  class="sd__switch"
                  :class="{ 'sd__switch--on': apiDraft.autoCompact }"
                  @click="apiDraft.autoCompact = !apiDraft.autoCompact"
                >{{ apiDraft.autoCompact ? '开启 ✓' : '关闭' }}</button>
                <p class="sd__hint" :class="apiDraft.autoCompact ? 'sd__hint--ok' : 'sd__hint--warn'">
                  {{ apiDraft.autoCompact
                    ? '接近预算时：早期对话总结成冻结摘要后再丢弃，剧情记忆保留在摘要里'
                    : '接近预算时：直接丢弃早期对话，不调用总结 API（省费用，但会丢掉细节）' }}
                </p>
              </div>

              <!-- 流式 usage:缓存命中数唯一的来源,关掉后面板只剩本地估算 -->
              <div class="sd__field sd__field--row">
                <span class="sd__label">请求流式用量 (usage)</span>
                <button
                  type="button"
                  class="sd__switch"
                  :class="{ 'sd__switch--on': apiDraft.requestUsage }"
                  @click="apiDraft.requestUsage = !apiDraft.requestUsage"
                >{{ apiDraft.requestUsage ? '开启 ✓' : '关闭' }}</button>
                <p class="sd__hint" :class="apiDraft.requestUsage ? 'sd__hint--ok' : 'sd__hint--warn'">
                  {{ apiDraft.requestUsage
                    ? '发送 stream_options.include_usage，可拿到输入/输出/缓存命中 token 数（不支持的端点会自动降级并记住）'
                    : '不请求 usage：用量面板只能显示本地估算值，缓存命中情况不可知' }}
                </p>
              </div>

              <!-- 自定义提示词(仅自定义 API 模式) —— 恢复正式版位置：
                   本轮之前它被错放到「实验性功能」页，这里补回「自定义 API」目录下。 -->
              <div class="sd__divider"></div>
              <p class="sd__desc sd__desc--keep">自定义提示词（当前干员：{{ selectedCharacter || '未选中' }}）</p>
              <div class="sd__char-textarea-wrap">
                <textarea
                  v-model="characterPromptDraft"
                  class="sd__textarea sd__textarea--tall"
                  rows="10"
                  :placeholder="selectedCharacter ? '输入提示词…' : '请先选择一个对话'"
                  :disabled="!selectedCharacter"
                ></textarea>
              </div>
              <div class="sd__actions">
                <button class="sd__btn sd__btn--primary" type="button" :disabled="!selectedCharacter" @click="saveCharacterPrompt">保存</button>
                <button v-if="isBuiltinCharacter" class="sd__btn" type="button" @click="resetCharacterPrompt">恢复默认</button>
              </div>

              <!-- 全局世界观背景(文本,仅自定义 API 模式) -->
              <div class="sd__divider"></div>
              <p class="sd__desc sd__desc--keep">世界观背景<span class="sd__pc-only">（全局世界观设定，将注入角色对话上下文）</span></p>
              <textarea
                v-model="settingsStore.worldView"
                class="sd__textarea sd__textarea--tall"
                rows="6"
                placeholder="输入全局世界观，例如：这是终末地工业时代，源石技艺与科技并存…"
              ></textarea>

            </template>


<!-- 本页所有配置都已即时写穿(见 apiDraft 的 watch),故不再有「保存」按钮 -->
            <div class="sd__actions">
              <button
                class="sd__btn"
                type="button"
                :disabled="testState === 'testing'"
                @click="onTestConnection"
              >{{ testState === 'testing' ? '测试中...' : '连接测试' }}</button>
              <button class="sd__btn" type="button" @click="resetAll">重置全部</button>
            </div>
            <p v-if="testState === 'success'" class="sd__hint sd__hint--ok sd__hint--keep">{{ testMessage }}</p>
            <p v-else-if="testState === 'fail'" class="sd__hint sd__hint--warn sd__hint--keep">{{ testMessage }}</p>
            <p v-else-if="settingsStore.isApiConfigured" class="sd__hint sd__hint--ok sd__hint--keep">API 已配置</p>
            <p v-else class="sd__hint sd__hint--warn sd__hint--keep">API 未配置</p>
            </div>

            <!-- 显示和内容输出:渲染层开关(本地怎么画) + 角色输出行为开关(随请求体发出) -->
            <div v-if="activeTab === 'display'" class="sd__section">
<!-- 智能消息分条(全局,实时持久化,默认开启)。
                 它只决定"本地怎么把一段回复切成几条气泡",
                 三种模式与群聊都走同一条分段链路,故不随后端模式置灰。 -->
            <div class="sd__field sd__field--row">
              <span class="sd__label">智能消息分条</span>
              <button
                type="button"
                class="sd__switch"
                :class="{ 'sd__switch--on': settingsStore.smartSplit }"
                @click="settingsStore.smartSplit = !settingsStore.smartSplit"
              >{{ settingsStore.smartSplit ? '开启 ✓' : '关闭' }}</button>
              <p class="sd__hint" :class="settingsStore.smartSplit ? 'sd__hint--ok' : 'sd__hint--warn'">
                {{ settingsStore.smartSplit
                  ? `已开启：括号描写与每句台词各自成条（换行 / 左括号前 / 句末标点后三处切；成对的括号描写整体不拆开）；不足 ${MIN_SEGMENT_CHARS} 字的短句不单独成条，并入下一条`
                  : `已关闭：只按换行分条，括号与句子都留在原段落中（旧版行为）；不足 ${MIN_SEGMENT_CHARS} 字的短句仍会并入下一条` }}
              </p>
            </div>

            <div class="sd__divider"></div>

            <!-- 括号描写居中(全局,实时持久化,默认关闭)。
                 同样是纯渲染层开关:只决定 `()` 内的动作/神态描写是留在气泡里,
                 还是抽出来单独渲染成一条居中文本(去掉括号)。不碰任何落库数据。 -->
            <div class="sd__field sd__field--row">
              <span class="sd__label">括号描写居中</span>
              <button
                type="button"
                class="sd__switch"
                :class="{ 'sd__switch--on': settingsStore.bracketCenter && !bracketStyleLocked }"
                :disabled="bracketStyleLocked"
                :title="bracketStyleLocked ? IMMERSIVE_LOCK_NOTE : undefined"
                @click="settingsStore.bracketCenter = !settingsStore.bracketCenter"
              >{{ settingsStore.bracketCenter ? '开启 ✓' : '关闭' }}</button>
              <p class="sd__hint" :class="bracketCenterHint.level">{{ bracketCenterHint.text }}</p>
            </div>

            <div class="sd__divider"></div>

            <!-- 彩色括号描写(全局,实时持久化,默认关闭)。
                 两层依赖:
                   1. 「括号描写居中」—— 那条决定"有没有居中行",这条只决定居中行什么颜色
                   2. 「沉浸式对话模式」—— 开着时后端不写括号描写,没有可上色的内容
                 任一不满足即置灰并说明原因(渲染层同样按
                 bracketCenter && bracketColor 双重判定,见 useChatRows)。 -->
            <div class="sd__field sd__field--row">
              <span class="sd__label">彩色括号描写</span>
              <button
                type="button"
                class="sd__switch"
                :class="{ 'sd__switch--on': settingsStore.bracketColor && settingsStore.bracketCenter && !bracketStyleLocked }"
                :disabled="!settingsStore.bracketCenter || bracketStyleLocked"
                :title="bracketStyleLocked ? IMMERSIVE_LOCK_NOTE : (settingsStore.bracketCenter ? undefined : '需先开启上方「括号描写居中」')"
                @click="settingsStore.bracketColor = !settingsStore.bracketColor"
              >{{ settingsStore.bracketColor ? '开启 ✓' : '关闭' }}</button>
              <p class="sd__hint" :class="bracketColorHint.level">{{ bracketColorHint.text }}</p>
            </div>

            <div class="sd__divider"></div>

            <!-- 居中我方括号内容(全局,实时持久化,默认关闭)。
                 与我方消息排版有关:识别我发出的消息**最前面**那一对括号,抽成居中文本,
                 颜色按我的身份属性(单人 = 管理员;群聊里扮演某角色 = 该角色)。
                 后面再出现的括号不动 —— 玩家自己写的正文不切碎。 -->
            <div class="sd__field sd__field--row">
              <span class="sd__label">居中我方括号内容</span>
              <button
                type="button"
                class="sd__switch"
                :class="{ 'sd__switch--on': settingsStore.centerMyBracket }"
                @click="settingsStore.centerMyBracket = !settingsStore.centerMyBracket"
              >{{ settingsStore.centerMyBracket ? '开启 ✓' : '关闭' }}</button>
              <p class="sd__hint" :class="centerMyBracketHint.level">{{ centerMyBracketHint.text }}</p>
            </div>

            <div class="sd__divider"></div>

            <!-- 新版输入面板(全局,实时持久化,默认关闭)。
                 只控制移动端面板是否分两行 —— 群聊「暂停 / 恢复」按钮已固定
                 在底部面板里,与本开关无关(见 stores/settings 的说明)。 -->
            <div class="sd__field sd__field--row">
              <span class="sd__label">新版输入面板</span>
              <button
                type="button"
                class="sd__switch"
                :class="{ 'sd__switch--on': settingsStore.newInputPanel }"
                @click="settingsStore.newInputPanel = !settingsStore.newInputPanel"
              >{{ settingsStore.newInputPanel ? '开启 ✓' : '关闭' }}</button>
              <p class="sd__hint" :class="settingsStore.newInputPanel ? 'sd__hint--ok' : 'sd__hint--warn'">
                {{ settingsStore.newInputPanel
                  ? '已开启：输入框最多两行，超过两行时出现扩大按钮，可展开成 2/3 屏大输入框（仅移动端）'
                  : '已关闭：输入框最多两行（超出部分框内滚动），没有扩大按钮' }}
              </p>
            </div>

              <div class="sd__divider"></div>

<!-- 思考模式开关(原 API 页移入;全局,实时持久化,随请求体传给后端)
                 仅"默认 API 模式 / 群聊"生效 → 其余情况置灰并说明原因 -->

            <!-- 强制每条搜索开关(全局,实时持久化,随请求体传 force_search) -->

            <!-- AI 推荐回复开关(全局,实时持久化,默认开启)
                 关闭后输入面板不再显示「推荐选项」按钮 -->
            <div class="sd__field sd__field--row">
              <span class="sd__label">推荐回复</span>
              <button
                type="button"
                class="sd__switch"
                :class="{ 'sd__switch--on': settingsStore.choicesEnabled }"
                @click="settingsStore.choicesEnabled = !settingsStore.choicesEnabled"
              >{{ settingsStore.choicesEnabled ? '开启 ✓' : '关闭' }}</button>
              <p class="sd__hint" :class="settingsStore.choicesEnabled ? 'sd__hint--ok' : 'sd__hint--warn'">
                {{ settingsStore.choicesEnabled ? '已开启：输入框显示推荐选项按钮（单聊 / 群聊通用）' : '已关闭：完全隐藏推荐选项按钮' }}
              </p>
            </div>

            <div class="sd__divider"></div>

            <!-- SSE 流式回复开关(全局,实时持久化,**默认关闭**)。
                 开启后单聊「默认 API」模式改走 /chat/stream:后端每吐一个增量,
                 前端就追加到正在生成的那条助手消息上,最后用 done 帧的权威全文覆盖。
                 属于实验性功能:关闭(默认)时行为与改动前完全一致。 -->
            <div class="sd__field sd__field--row">
              <span class="sd__label">SSE 流式回复</span>
              <button
                type="button"
                class="sd__switch"
                :class="{ 'sd__switch--on': settingsStore.sseStreaming }"
                @click="settingsStore.sseStreaming = !settingsStore.sseStreaming"
              >{{ settingsStore.sseStreaming ? '开启 ✓' : '关闭' }}</button>
              <p class="sd__hint" :class="settingsStore.sseStreaming ? 'sd__hint--ok' : 'sd__hint--warn'">
                {{ settingsStore.sseStreaming
                  ? '已开启：单聊逐字流式输出（实验性，仅「默认 API」模式生效；流式不可用时自动回退）'
                  : '已关闭（默认）：等完整回复到达后按分段规则显示，与旧版行为一致' }}
              </p>
            </div>

            <div class="sd__divider"></div>

            <!-- 沉浸式对话模式开关(全局,实时持久化)
                 后端模式:随请求体传 immersive_mode,由后端过滤;
                 自定义 / 旧版直连:前端自己截提示词 + 文本层过滤(见 utils/immersive.ts)。
                 三种模式 + 单聊/群聊都已落实 → 本开关永不置灰。 -->
            <div class="sd__field sd__field--row">
              <span class="sd__label">沉浸式对话模式</span>
              <button
                type="button"
                class="sd__switch"
                :class="{ 'sd__switch--on': settingsStore.immersiveMode }"
                @click="settingsStore.immersiveMode = !settingsStore.immersiveMode"
              >{{ settingsStore.immersiveMode ? '开启 ✓' : '关闭' }}</button>
              <p class="sd__hint" :class="immersiveHint.level">{{ immersiveHint.text }}</p>
            </div>

            <div class="sd__divider"></div>

            <!-- 智能总结
                 开关本身只管"历史超 50 条时总结前段",只被 applySmartSummary 读取;
                 自定义模式不走那条路径(由 token 预算压缩接管)→ 同样置灰 -->
            </div>

            <div v-if="activeTab === 'experimental'" class="sd__section">

            <div class="sd__field sd__field--row">
              <span class="sd__label">思考模式</span>
              <button
                type="button"
                class="sd__switch"
                :class="{ 'sd__switch--on': settingsStore.thinkEnabled && !thinkBlocked }"
                :disabled="thinkBlocked"
                :title="thinkTitle"
                @click="settingsStore.thinkEnabled = !settingsStore.thinkEnabled"
              >{{ settingsStore.thinkEnabled ? '开启 ✓' : '关闭' }}</button>
              <p class="sd__hint" :class="thinkHint.level">{{ thinkHint.text }}</p>
            </div>

            <div class="sd__divider"></div>

            <!-- 知识源切换：RAG 语料库(默认) / 联网搜索。
                 请求体契约：关闭时**不带 use_rag**（后端默认走 RAG）；
                 开启时带 use_rag: false + force_search: true（走联网搜索）。 -->
            <div class="sd__field sd__field--row">
              <span class="sd__label">联网搜索（替代 RAG）</span>
              <button
                type="button"
                class="sd__switch"
                :class="{ 'sd__switch--on': settingsStore.webSearchEnabled }"
                @click="settingsStore.webSearchEnabled = !settingsStore.webSearchEnabled"
              >{{ settingsStore.webSearchEnabled ? '开启 ✓' : '关闭' }}</button>
              <p class="sd__hint" :class="knowledgeSourceHint.level">{{ knowledgeSourceHint.text }}</p>

              <!-- 子选项：强制每条搜索。
                   只在「联网搜索」打开时出现 —— 因为只走 RAG 时后端根本不会联网，
                   这个开关切了也没有任何效果（避免给用户"切了却在空转"的错觉）。 -->
              <div v-if="settingsStore.webSearchEnabled" class="sd__subfield">
                <span class="sd__label">└ 强制每条搜索</span>
                <button
                  type="button"
                  class="sd__switch"
                  :class="{ 'sd__switch--on': settingsStore.forceSearch }"
                  @click="settingsStore.forceSearch = !settingsStore.forceSearch"
                >{{ settingsStore.forceSearch ? '开启 ✓' : '关闭' }}</button>
                <p class="sd__hint" :class="forceSearchHint.level">
                  {{ settingsStore.forceSearch
                    ? '已开启：每条消息都强制联网搜索，不再做智能判断'
                    : '已关闭（推荐）：由后端智能判断这条消息是否需要联网搜索' }}
                </p>
              </div>

              <!-- 非默认 API 模式下的明确降级说明(审计要求:不能悄悄失效)。
                   检索(联网 / RAG 语料库)由后端提供;自定义与旧版直连没有检索服务,
                   前端也**不会**为了这个功能偷偷回退到后端网关。 -->
              <p v-if="apiDraft.apiMode !== 'backend'" class="sd__hint sd__hint--keep">
                当前 API 模式下本组开关不生效：联网搜索 / RAG 语料库由后端提供，自定义 / 旧版直连没有检索服务（不会回退到后端）。
              </p>
            </div>

            <div class="sd__divider"></div>

            <div class="sd__field sd__field--row">
              <span class="sd__label">使用新版提示词</span>
              <button
                type="button"
                class="sd__switch"
                :class="{ 'sd__switch--on': settingsStore.useNewPrompt && !newPromptBlocked }"
                :disabled="newPromptBlocked"
                :title="newPromptTitle"
                @click="settingsStore.useNewPrompt = !settingsStore.useNewPrompt"
              >{{ settingsStore.useNewPrompt ? '开启 ✓' : '关闭' }}</button>
              <p class="sd__hint" :class="useNewPromptHint.level">{{ useNewPromptHint.text }}</p>
            </div>

            <div class="sd__divider"></div>

            <div class="sd__field sd__field--row">
              <span class="sd__label">智能总结</span>
              <button
                type="button"
                class="sd__switch"
                :class="{ 'sd__switch--on': summaryDraft.enabled && !summaryBlocked }"
                :disabled="summaryBlocked"
                :title="summaryTitle"
                @click="summaryDraft.enabled = !summaryDraft.enabled"
              >{{ summaryDraft.enabled ? '开启 ✓' : '关闭' }}</button>
              <p class="sd__hint" :class="summaryHint.level">{{ summaryHint.text }}</p>
              <!-- 自定义模式下开关失效,但总结 API 仍被压缩流程使用 —— 必须说清楚 -->
              <p v-if="summaryBlocked" class="sd__hint sd__hint--keep">
                「总结 API」在左侧「自定义 API」页配置<span class="sd__pc-only">；自定义模式下由压缩流程使用（自动压缩 / 面板里的手动压缩），与上方开关无关</span>
              </p>
            </div>

            <!-- 总结 API 配置:仅在「智能总结」开启时显示(它就是这个开关用的端点)。
                 与主 API 相互独立 —— 主 API 用默认/旧版模式时,这里照样可以自定义。 -->
            <template v-if="summaryDraft.enabled">
              <div class="sd__divider"></div>
              <div class="sd__divider"></div>

              <!-- 总结 API:压缩流程(自动压缩 / 用量面板的手动压缩)与「智能总结」开关都用它。
                   与上面的主 API 相互独立 —— 主 API 用默认/旧版模式时,这里照样可以自定义。 -->
              <p class="sd__desc">总结 API（把早期对话压成冻结摘要，自动压缩与用量面板的手动压缩都用它）</p>
              <div class="sd__field sd__field--row">
                <span class="sd__label">总结 API 模式</span>
                <div class="sd__mode-toggle">
                  <!-- 两列:第二列只需前进一格(--step-1)。
                       早先误用了三列语义的 --right(前进两格),黄条会滑出容器。 -->
                  <div
                    class="sd__mode-indicator"
                    :class="{ 'sd__mode-indicator--step-1': isSummaryCustomMode }"
                  ></div>
                  <button
                    class="sd__mode-btn"
                    :class="{ 'sd__mode-btn--active': isSummaryDefaultMode }"
                    type="button"
                    @click="switchSummaryApiMode('default')"
                  >默认 API</button>
                  <button
                    class="sd__mode-btn"
                    :class="{ 'sd__mode-btn--active': isSummaryCustomMode }"
                    type="button"
                    @click="switchSummaryApiMode('custom')"
                  >自定义 API</button>
                </div>
                <p class="sd__hint sd__hint--keep" v-if="isSummaryDefaultMode">
                  使用默认内置API(无需填写密钥)。
                </p>
              </div>

              <!-- 自定义总结 API 配置(与主 API 同一套:填地址 → 拉模型 → 下拉选) -->
              <template v-if="isSummaryCustomMode">
                <label class="sd__field">
                  <span class="sd__label">Base URL</span>
                  <input
                    v-model="summaryDraft.baseUrl"
                    class="sd__input"
                    type="text"
                    placeholder="https://api.agnes-ai.cn/v1"
                  />
                </label>
                <label class="sd__field">
                  <span class="sd__label">API Key</span>
                  <input
                    v-model="summaryDraft.apiKey"
                    class="sd__input"
                    type="password"
                    placeholder="sk-..."
                    autocomplete="off"
                  />
                </label>
                <label class="sd__field">
                  <span class="sd__label">模型名</span>
                  <input
                    v-model="summaryDraft.model"
                    class="sd__input"
                    type="text"
                    placeholder="agnes-2.5-flash"
                  />
                </label>

                <div class="sd__field">
                  <div class="sd__actions">
                    <button
                      class="sd__btn sd__btn--preset"
                      type="button"
                      :disabled="summaryModelListLoading"
                      @click="onFetchSummaryModels"
                    >{{ summaryModelListLoading ? '获取中…' : '获取模型列表' }}</button>
                  </div>
                  <p v-if="summaryModelListError" class="sd__hint sd__hint--warn sd__hint--keep">{{ summaryModelListError }}</p>
                  <p v-else-if="summaryModelOptions.length" class="sd__hint sd__hint--ok sd__hint--keep">
                    已获取 {{ summaryModelOptions.length }} 个模型，可从下方选择
                  </p>
                  <select
                    v-if="summaryModelOptions.length"
                    v-model="summaryDraft.model"
                    class="sd__input sd__select"
                  >
                    <option value="">— 从列表选择 —</option>
                    <option v-for="m in summaryModelOptions" :key="m.id" :value="m.id">{{ m.id }}</option>
                  </select>
                </div>

                <!-- 上下文总长：智能总结的触发分母。
                     前端累计后端上报的 usage，达到「窗口 × 75%」就主动总结前段历史再上传。 -->
                <label class="sd__field">
                  <span class="sd__label">上下文总长 (Token)</span>
                  <input
                    v-model.number="summaryDraft.contextWindow"
                    class="sd__input"
                    type="number"
                    min="1000"
                    step="1000"
                    placeholder="512000"
                  />
                  <p class="sd__hint sd__hint--keep">
                    固定提示词长度 + 累计输出 token 达到该值的 80% 时，把 80% 以外的历史全部总结；
                    剩下 20% 留给 RAG 语料库（默认 512000 = Agnes 2.5 Flash 上下文窗口）
                  </p>
                </label>

                </template>
            </template>
            
            </div>

          <!-- 数据管理(内嵌 DataManagerDialog 功能:统计/导出/导入/清空) -->
          <div v-if="activeTab === 'data'" class="sd__section">
            <DataManagerDialog :open="open" embedded />
          </div>

          <!-- 关于 -->
          <div v-if="activeTab === 'about'" class="sd__section sd__about">
            <h3 class="sd__about-title">明日方舟：终末地 Baker AI</h3>

            <!-- QQ 群入口:两行居中。群名白色,只有群号是超链接(强调黄);
                 点群号既跳转加群页,又把群号复制到剪贴板 -->
            <div class="sd__about-groups">
              <p v-for="g in QQ_GROUPS" :key="g.code" class="sd__about-group">
                {{ g.label }}：<a
                  class="sd__about-group-link"
                  :href="g.url"
                  target="_blank"
                  rel="noopener"
                  @click="copyText(g.code)"
                >{{ g.code }}</a>
              </p>
              <!-- 操作说明:白字,字号比上面两行小一档 -->
              <p class="sd__about-group-tip">点击相应群号可复制并跳转到群聊页面</p>
            </div>

            <div class="sd__about-block">
              <h4 class="sd__about-heading">相关链接</h4>
              <ul class="sd__about-links">
                <li><a href="https://github.com/NCreeper233/endfield-baker-chat" target="_blank" rel="noopener">GitHub</a></li>
                <li><a href="https://space.bilibili.com/1143315127" target="_blank" rel="noopener">哔哩哔哩</a></li>
              </ul>
            </div>

            <div class="sd__about-block">
              <h4 class="sd__about-heading">相关项目</h4>
              <ul class="sd__about-links">
                <li><a href="https://ark.ncreeper.top/" target="_blank" rel="noopener">明日方舟：终末地风格LOGO生成器</a></li>
                <li><a href="https://baker.ncreeper.top/" target="_blank" rel="noopener">明日方舟：终末地 Baker 模拟器</a></li>
              </ul>
            </div>

            <!-- ⛔ 临时彩蛋(可删):中秋兑换码。
                 兑换成功才显示下面那行绿色小字,并**从那一刻起**才开始下载月亮资源
                 (在月亮被渲染之前,three / cannon-es / glb / draco 一个字节都不请求)。
                 状态只在内存里,刷新即失效。删法见 src/easteregg/moon/README.md -->
            <div class="sd__about-block">
              <h4 class="sd__about-heading">兑换码</h4>
              <div class="egg-redeem">
                <input
                  v-model="eggCode"
                  class="sd__input egg-redeem__input"
                  type="text"
                  placeholder="输入兑换码"
                  @keyup.enter="onRedeemEgg"
                />
                <button class="sd__btn" type="button" @click="onRedeemEgg">兑换</button>
              </div>
              <p v-if="eggWrong" class="egg-redeem__err">兑换码不正确</p>
              <p v-else-if="moonRedeemed" class="egg-redeem__ok">{{ MOON_HINT }}</p>
            </div>
            <!-- /⛔ 临时彩蛋 -->
          </div>

          <div v-if="activeTab === 'disclaimer'" class="sd__section sd__disclaimer">
            <h3 class="sd__disclaimer-title">免责声明</h3>
            <div class="sd__disclaimer-content">
              <p><strong>一、用户责任与合规使用</strong></p>
              <p>您明确知晓并同意，您是使用本工具生成内容的唯一责任人。您承诺：</p>
              <p>1. 严格遵守您所使用AI模型服务商的所有使用政策与安全准则。</p>
              <p>2. 遵守您所在地及服务商所在地的现行法律法规，绝不利用本工具生成任何涉及政治敏感、淫秽色情、暴力恐怖、仇恨歧视、侵犯他人合法权益以及其他一切违法和不良信息。</p>
              <p>3. 理解并接受本工具仅用于合法的《明日方舟：终末地》同人角色扮演娱乐，任何超出此用途的使用风险自担。</p>

              <p><strong>二、知识产权与同人声明</strong></p>
              <p>《明日方舟：终末地》是上海鹰角网络科技有限公司的游戏产品。本工具为第三方同人作品，无任何盈利性质，与上海鹰角网络科技有限公司及《明日方舟：终末地》官方开发商、运营商无任何关联。</p>
              <p>本工具中使用的所有与《明日方舟：终末地》相关的角色形象、世界观设定、剧情元素、图片资源等知识产权，均归上海鹰角网络科技有限公司所有。本工具仅供爱好者学习与交流，严禁用于任何商业用途。</p>

              <p><strong>三、免责条款</strong></p>
              <p>在法律允许的最大范围内，本工具开发者不对以下情况承担任何明示或默示的担保或责任：</p>
              <p>1. 用户因违反本声明或第三方服务商条款而产生的任何纠纷、处罚或损失；</p>
              <p>2. 用户因篡改代码等自主行为所引发的一切后果；</p>
              <p>3. 对第三方AI模型服务商提供的服务质量、内容准确性及合规性。</p>
              <p>请您在使用前务必仔细阅读并同意以上全部条款。继续使用即代表您已充分理解并自愿承担所有相关风险。</p>
            </div>
          </div>
        </div>

        <!-- 右上角关闭按钮(×)已移除(2026-09-25):退出统一走左侧栏顶部的「退出」按钮 -->
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// =============================================================================
// 版式常量(改这里即可整体调节,勿在各处散写数值)
// -----------------------------------------------------------------------------
// 页签栏宽度:桌面常驻一档(图标 + 文字),2026-09-25 起取消收起态 ——
// 于是不再需要「收起 / 展开」两档宽度,窄屏也改成顶部横向条(见媒体查询)。
// 宽度由「左右内边距 × 2 + 图标框 + 文字」推出,不再是纯计算值,故直接写死。
// 顶栏高度 $head-h 为页签栏头部与主区标题行共用 —— 两者顶在同一基线上,
// 视觉上才是一条贯通的横带。
// =============================================================================
$head-h: 64px;          // 顶栏高度(桌面)
$head-h-sm: 52px;       // 顶栏高度(窄屏)
$nav-w: 196px;          // 页签栏宽度(桌面:常驻一列,图标 + 文字)
$nav-rail-w-sm: 58px;   // 页签栏收起宽度(窄屏抽屉:只露图标的一条窄栏)
$nav-open-w-sm: 180px;  // 页签栏展开宽度(窄屏抽屉)
$nav-pad-x: 19px;       // 页签栏左右内边距(桌面)
$nav-pad-x-sm: 17px;    // 页签栏左右内边距(窄屏)
$nav-item-h: 44px;      // 页签项高度(两端一致;黄条定位依赖它固定)
$nav-anim: 0.28s;       // 页签栏宽度 / 指示条的动画时长
$icon-box: 24px;        // 图标框边长
$body-pad-x: 32px;      // 主区左右内边距(桌面)
$body-pad-x-sm: 16px;   // 主区左右内边距(窄屏)

/// 菜单底色 + 24px 灰色网格纹理(设置面板主区的"面板材质")
///
/// 只有主区用:侧边栏刻意**不铺网格**(见 &__nav 的底色注释)。
@mixin sd-surface {
  background-color: $color-dialog-bg;
  // 灰色正方形网格纹理(菜单背景):横竖 1px 细线交叉成 24px 格子
  background-image:
    linear-gradient(to right, rgba(134, 134, 133, 0.12) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(134, 134, 133, 0.12) 1px, transparent 1px);
  background-size: 24px 24px;
}

.sd {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.75);
  // 两端都是居中显示的「窗口」而不是铺满整屏(与旧版设置面板形态一致):
  // 桌面留 24px、窄屏留 12px(见媒体查询),四周透出后面的对话界面。
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;

  &__panel {
    position: relative;
    // 窗口尺寸:够放下「侧边栏 + 内容」两列,又不占满大屏。
    // 用 min() 兜底小窗口,避免窄桌面下溢出到屏幕外。
    width: min(1040px, calc(100vw - 48px));
    height: min(720px, calc(100vh - 48px));
    border-radius: 0;
    // 窗口有外框(全屏时四周留 1px 描边会显得"框住"整块界面,窗口则正需要)
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.55);
    @include sd-surface;
    // 两列 × 两行:左列侧边栏跨满两行(导航 + 选中竖条),
    // 右列上格是当前页标题,下格是可滚动内容。
    // 用 grid 而不是嵌套 flex,是为了让页内容(六个 section)直接留在面板下,
    // 不必再套一层容器。
    display: grid;
    grid-template-columns: auto 1fr;
    grid-template-rows: auto 1fr;
    grid-template-areas:
      'nav title'
      'nav body';
    // 侧边栏宽度动画期间,内容不得溢出到面板外
    overflow: hidden;

    // 菜单内所有元素一律直角(含伪元素,如滑块圆点)
    *,
    *::before,
    *::after {
      border-radius: 0 !important;
    }

    // 主区内容压在装饰之上。侧边栏 / 遮罩 / 关闭按钮各有自己的定位方式,排除在外
    // (窄屏页签栏是浮层、遮罩要铺满面板、× 要钉在面板右上角,这里的
    //  position: relative 会把它们的 absolute 压掉)。
    > *:not(.sd__close):not(.sd__nav):not(.sd__nav-scrim) {
      position: relative;
      z-index: 1;
    }
  }

  // ---- 左侧边栏(窄屏:顶部横向一条,见媒体查询) -----------------------------
  &__nav {
    grid-area: nav;
    position: relative;
    z-index: 3;
    display: flex;
    flex-direction: column;
    // 不再有收起态:桌面常驻"图标 + 文字"这一档宽度
    width: $nav-w;
    // 底色必须**不透明**(窗口下也不透出后面的对话界面),但刻意**不铺那层 24px
    // 网格纹理** —— 网格是主区的材质,铺到侧边栏上会从图标/文字的缝隙里透出细线,显脏。
    background-color: $color-dialog-bg;
    // 长标签不换行、不溢出(超出部分裁掉)
    overflow: hidden;
    border-right: 1px solid rgba(255, 255, 255, 0.08);
  }

  &__nav-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    height: $head-h;
    padding: 0 $nav-pad-x;
  }

  // 退出按钮(取代原折叠按钮;右上角 × 已移除,退出入口统一到这里)
  // 用左向箭头图标,点击即关闭整个设置窗口 —— 与点面板外的黑遮罩等价。
  &__nav-exit {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px;
    margin: -8px;
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.55);
    cursor: pointer;
    transition: color 0.2s;

    svg {
      width: 20px;
      height: 20px;
    }

    &:hover { color: $color-text-primary; }
  }

  // 收起 / 展开按钮(仅窄屏抽屉用;桌面端页签栏常驻一列,不需要它)
  // 命中区补偿与 &__nav-exit 同一套:图标 20px 偏小,用「等量 padding + 负 margin」
  // 把可点区域撑到 36×36,图标位置不动。
  &__nav-toggle {
    display: none;
    flex: none;
    align-items: center;
    justify-content: center;
    padding: 8px;
    margin: -8px;
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.55);
    cursor: pointer;
    transition: color 0.2s;

    svg {
      width: 20px;
      height: 20px;
      // 箭头翻转与页签栏宽度同步(翻向规则见窄屏媒体查询)
      transition: transform $nav-anim $ease-out;
    }

    &:hover { color: $color-text-primary; }
  }

  // 关闭按钮(×):窄屏全屏面板的唯一退出入口(见媒体查询);
  // 桌面端不渲染 —— 那边的退出入口是页签栏头部的箭头按钮。
  &__close {
    display: none;
    position: absolute;
    top: 12px;
    right: 16px;
    z-index: 4;
    // 命中区补偿(与 &__nav-exit 同一套):× 字形本身约 14×24,
    // 用「等量 padding + 负 margin」把可点区域撑到约 30×36,字形位置不变。
    padding: 6px 8px;
    margin: -6px -8px;
    background: none;
    border: none;
    color: $color-text-primary;
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.5;
    transition: opacity 0.2s;

    &:hover { opacity: 1; }
  }

  // 窄屏抽屉展开时的浮层遮罩(仅窄屏渲染,见模板 v-if)
  &__nav-scrim {
    position: absolute;
    inset: 0;
    z-index: 2;
    background: rgba(0, 0, 0, 0.45);
    opacity: 0;
    pointer-events: none;
    transition: opacity $nav-anim $ease-out;

    &--on {
      opacity: 1;
      pointer-events: auto;
    }
  }

  // 侧边栏内的文字(头部「设置」与各页签标签共用一套排版)
  &__nav-text {
    white-space: nowrap;
  }

  &__nav-title {
    font-family: $font-harmony;
    font-size: 15px;
    font-weight: 600;
    color: $color-text-primary;
  }

  // 导航项列表(黄条以它为定位基准,故这里必须是 relative)
  &__nav-list {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 0;
    // 极矮屏(横屏手机)兜底:页签放不下时就地滚动;
    // 黄条是列表的子元素,会跟着一起滚,不会错位
    overflow-y: auto;
    scrollbar-width: none;

    &::-webkit-scrollbar { display: none; }
  }

  &__nav-item {
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    // 高度固定:黄条定位不因内容变化失效(见脚本注释)
    height: $nav-item-h;
    padding: 0 $nav-pad-x;
    background: none;
    border: none;
    // 文字与图标一律用**不透明白**,未选中的淡化交给整项的 opacity(见下)。
    // 图标是 currentColor 描边,颜色一旦带 alpha,同一图标里的线条交叉处就会
    // 叠成更深的一笔(实测交叉点亮度 201,单笔 152),看起来就是"线条重叠"。
    color: $color-text-primary;
    font-family: $font-harmony;
    font-size: 14px;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
    // 半透明写在整项上:整项先按不透明合成、再整体淡出 ——
    // 图标内部笔画重叠处颜色完全一致,文字与图标也共用同一个淡化系数。
    opacity: 0.5;
    transition: opacity $anim-fast;

    &:hover { opacity: 0.85; }

    // 选中态:整项不透明,选择标记交给最左侧的竖黄条
    &--active {
      opacity: 1;
    }
  }

  &__nav-icon {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: $icon-box;
    height: $icon-box;

    svg {
      width: 22px;
      height: 22px;
    }
  }

  // 选中项的黄条
  //
  // 桌面:贴在页签栏最左侧的竖条,长度 = 激活项高度、位置 = 激活项的 offsetTop;
  // 窄屏:贴在横向页签行底部,长度 = 激活项宽度、位置 = 激活项的 offsetLeft(见媒体查询)。
  // 四项数值全部由脚本算好挂在 --ind-* 上,两端只是各取所需,不必两套测量逻辑。
  &__nav-indicator {
    position: absolute;
    top: 0;
    left: 0;
    width: 3px;
    height: var(--ind-h, #{$nav-item-h});
    background: #ffef00;
    pointer-events: none;
    will-change: transform;
    transform: translateY(var(--ind-y, 0));

    // 首次定位落位后才开过渡(见脚本 indicatorReady):
    // 否则打开面板的瞬间,黄条会从列表起点滑到激活项上
    &.is-ready {
      transition:
        transform $nav-anim $ease-out,
        height $nav-anim $ease-out;
    }
  }

  // 当前页标题:主区第一行,高度与页签栏头部一致(顶在同一条横带上)
  &__title {
    grid-area: title;
    display: flex;
    align-items: center;
    height: $head-h;
    margin: 0;
    padding: 0 $body-pad-x;
    font-family: $font-harmony;
    font-size: 20px;
    font-weight: 600;
    color: $color-text-primary;
  }

  // 内容区:横向铺满侧边栏右侧的整块宽度(只留左右内边距,不再另外限宽)
  &__body {
    grid-area: body;
    overflow-y: auto;
    min-height: 0;
    padding: 4px $body-pad-x 24px;
    // 隐藏滚动条(但保留滚动功能)
    scrollbar-width: none; // Firefox
    -ms-overflow-style: none; // IE/Edge
    &::-webkit-scrollbar {
      display: none; // Chrome/Safari/Webkit
    }
  }

  // ---- 窄屏 ---------------------------------------------------------------
  // 断点 768 与 composables/useMobile 的 MOBILE_BREAKPOINT 同一数值(改一处要一起改)。
  //
  // 窄屏不铺满整屏,而是回到老版那个「小窗口」形态:
  //   宽度 560 封顶、高度约 78%、四周留白 —— 一屏内容不必被拉满,看着才不臃肿。
  // 页内布局也全部改成**上下布局**(老版就是纵向的):
  //   一行标签 + 一行控件(控件铺满整行) + 至多一行状态;
  // 桌面那套「标签在左、控件在右」的两列样式在窄屏一律取消 —— 窄屏横排必然换行。
  //
  // 页签栏在这里取 2.0 的**抽屉**形态:平时是一条只露图标的窄栏($nav-rail-w-sm),
  // 点头部箭头展开成一栏完整菜单($nav-open-w-sm),压在内容之上并弹出遮罩;
  // 选中任意页、点遮罩、或再点一次箭头都收起。桌面端完全不走这套(见上面的基础样式)。
  @media (max-width: 768px) {
    // 窄屏:设置面板**铺满整屏**(与旧版一致),四周不留白 ——
    // 留白那圈黑边本来是"点空白关窗"的命中区,全屏后这个入口没有了,
    // 关闭改走右上角的 ×(见模板 &__close)。
    padding: 0;

    &__panel {
      // 全屏:宽高都吃满容器(旧版就是 100% × 100%)
      width: 100%;
      height: 100%;
      max-height: none;
      // 抽屉脱离文档流后,auto 那条列会塌成 0 —— 必须显式写出这一条图标列,
      // 内容才会被让开 $nav-rail-w-sm;标题行仍在右上格(auto 高)。
      grid-template-columns: $nav-rail-w-sm 1fr;
      grid-template-rows: auto 1fr;
      grid-template-areas:
        'nav title'
        'nav body';
    }

    // 关闭按钮(×):全屏后唯一的"退出设置"入口,只在窄屏出现
    &__close {
      display: block;
    }

    // 页签栏:浮层窄栏 / 展开成完整一栏
    &__nav {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: $nav-rail-w-sm;
      // 宽度动画只在窄屏需要(桌面常驻一列,宽度不变)
      transition: width $nav-anim $ease-out;

      // 展开时压住内容,给一道右侧投影拉开层次
      &--open {
        width: $nav-open-w-sm;
        box-shadow: 0 0 24px rgba(0, 0, 0, 0.55);
      }

      // 收起时窄栏里只放得下图标:文字(「设置」与各页标签)只在展开后浮出。
      // 展开时让文字**最后**入场 —— 先等宽度撑开,再出现,不然文字会被挤着走。
      .sd__nav-text {
        opacity: 0;
        transform: translateX(-6px);
        pointer-events: none;
        transition:
          opacity 0.14s $ease-out,
          transform 0.16s $ease-out;
      }

      &--open .sd__nav-text {
        opacity: 1;
        transform: none;
        transition:
          opacity 0.2s $ease-out 0.1s,
          transform 0.22s $ease-out 0.1s;
      }

      // 箭头翻向:向右 = 可展开,旋转 180° 后向左 = 可收起
      &--open .sd__nav-toggle svg {
        transform: rotate(180deg);
      }
    }

    &__nav-head {
      height: $head-h-sm;
      padding: 0 $nav-pad-x-sm;
    }

    // 收起 / 展开箭头:仅窄屏存在(桌面端页签栏常驻,不需要)
    &__nav-toggle {
      display: flex;
    }

    // 头部只留「箭头 + 设置」这一组 —— 旧版窄屏正是如此。
    // 退出按钮在窄屏收起(全屏后由右上角的 × 承担退出),免得头部冒出第二个箭头。
    &__nav-exit {
      display: none;
    }

    &__nav-item {
      gap: 10px;
      padding: 0 $nav-pad-x-sm;
      font-size: 13px;
    }

    &__nav-icon svg {
      width: 20px;
      height: 20px;
    }

    // 页标题:抽屉收起时只露图标,全靠这一行知道当前在哪一页 —— 窄屏要留着
    &__title {
      height: $head-h-sm;
      padding: 0 $body-pad-x-sm;
      font-size: 17px;
    }

    // 内容区:左右与标题行同一档,上下各留一点(免得第一行选项贴着标题行)
    &__body {
      padding: 4px $body-pad-x-sm 20px;
    }

    // ---- 页内一律上下布局 ---------------------------------------------------
    // 桌面是「标签在左、控件在右」的两列;窄屏两列必然换行,所以改成一列:
    // 标签一行、控件一行,控件(开关 / 模式切换 / 输入框)一律铺满整行 —— 这也是老版的排法。
    &__field--row {
      grid-template-columns: 1fr;
      row-gap: 8px;
    }

    // 开关按钮独占一行,但**不铺满**:整行通到两边会顶到弹窗边缘,
    // 收成固定宽度的小按钮(左对齐),两侧自然留出余白
    &__field--row > .sd__switch {
      width: auto;
      min-width: 112px;
      justify-self: start;
    }

    // 标签永不换行:一个选项的文字就一行
    // (超长兜底裁成省略号;现有文案最长 16 个汉字,窄屏一行放得下)
    &__label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    // 按钮行:按钮等分整行,行内不再出现横向滚动
    &__actions,
    &__route {
      width: 100%;

      > .sd__btn {
        flex: 1;
      }
    }

    // ---- 文字:只留一行 -----------------------------------------------------
    // 窄屏一行约 24 个汉字,说明性文字必然换行 —— 老版的做法是干脆不写。
    // 规则:
    //   · .sd__hint / .sd__desc 默认隐藏(解释"为什么"、复述开关状态都属非必要);
    //   · 动态反馈(连接测试结果、拉取失败、被禁用原因、当前选项值)加 --keep 保留;
    //   · 长句里的补充说明用 .sd__pc-only 包住,窄屏只留前半句。
    &__hint,
    &__desc {
      display: none;
    }

    &__hint--keep,
    &__desc--keep {
      display: block;
      // 保留的多是报错 / 状态文本,里面可能夹着长 URL:允许在任意处断行,免得撑破面板
      overflow-wrap: anywhere;
    }

    // 桌面专有的补充说明:窄屏不渲染
    &__pc-only {
      display: none;
    }
  }

  &__section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  // 后端路线的「默认 / 备用」并排按钮(复用 &__btn 外观,只负责排布)
  &__route {
    display: flex;
    gap: 8px;
  }

  &__field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  /**
   * 开关行:标签在左、控件在右,说明/提示行独占下方整行。
   *
   * 为什么不用默认的纵排列:控件(开关 / 两段模式切换)被 flex 的 stretch 拉成
   * 满行宽 —— 在整屏宽度下就是一条横贯页面的长条,既难看出"这是个开关",
   * 也和模式切换那种"一小块黄底"的选中语汇对不上。
   * 改成网格后控件只占自身宽度,同页所有开关右边缘对齐成一列。
   */
  &__field--row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    column-gap: 16px;
    row-gap: 4px;

    // 提示行不受两列限制,通栏排在下方
    > .sd__hint {
      grid-column: 1 / -1;
    }

    // 子选项(如「联网搜索」下的「强制每条搜索」):
    // 通栏排 + 左侧竖线缩进,视觉上明确是从属关系而不是并列开关。
    > .sd__subfield {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      column-gap: 16px;
      row-gap: 4px;
      margin-top: 8px;
      padding-left: 12px;
      border-left: 2px solid rgba(255, 239, 0, 0.28);   // 与强调黄同色系

      > .sd__hint {
        grid-column: 1 / -1;
      }

      > .sd__label {
        font-size: 12px;
      }
    }

    // 两段模式切换在行内收窄:每段各占一半,黄条位移的百分比仍以自身宽度为准
    > .sd__mode-toggle {
      width: 340px;
      max-width: 100%;
    }
  }

  /**
   * 开关按钮(开启 / 关闭)
   *
   * 状态型控件,沿用「模式切换」那套选中语汇:开 = 黄块 + 深色字,
   * 关 = 细灰框 + 弱化白字。定宽是为了同一页里所有开关对齐、
   * 且「开启 ✓ / 关闭」两种文案切换时宽度不跳动。
   */
  &__switch {
    flex: none;
    min-width: 92px;
    padding: 7px 14px;
    background: none;
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: rgba(255, 255, 255, 0.55);
    font-family: $font-harmony;
    font-size: 13px;
    text-align: center;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color $anim-fast,
      border-color $anim-fast,
      color $anim-fast;

    &:hover:not(:disabled) {
      border-color: rgba(255, 255, 255, 0.35);
      color: $color-text-primary;
    }

    // 开启态(黄底上保持深色字,不被 hover 变白)
    &--on,
    &--on:hover:not(:disabled) {
      background: #ffef00;
      border-color: #ffef00;
      color: #1a1a1a;
    }

    &:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
  }

  // 开关行在窄屏上的唯一调整:两段模式切换(340px)在手机上放不进右侧那一格,
  // 让它跨两列掉到标签下方、占满整行;开关按钮本身够窄,仍与标签同行。
  // 注意必须写在 &__field--row 之后 —— 同权重下后写的规则才生效。
  @media (max-width: 768px) {
    &__field--row > .sd__mode-toggle {
      grid-column: 1 / -1;
      width: 100%;
    }
  }

  &__label {
    font-family: $font-harmony;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.6);
  }

  &__input {
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    color: $color-text-primary;
    font-family: $font-harmony;
    font-size: 14px;
    outline: none;
    transition: border-color 0.2s;

    &:focus { border-color: rgba(255, 255, 255, 0.3); }
    &::placeholder { color: rgba(255, 255, 255, 0.25); }
  }

  // 模型下拉:外观沿用 &__input,额外补上原生 option 的深色底
  // (option 由系统绘制,不继承 select 的半透明背景 —— 不显式指定的话,
  //  在浅色系统主题下会变成白底白字,整个列表看不见)
  &__select {
    option {
      background: $color-dialog-bg;
      color: $color-text-primary;
    }
  }

  // 隐藏的背景图文件选择框(由"上传背景"按钮触发)
  &__file {
    display: none;
  }

  &__slider {
    width: 100%;
    accent-color: #ffef00;
  }

  &__textarea {
    width: 100%;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    color: $color-text-primary;
    font-family: $font-harmony;
    font-size: 13px;
    line-height: 1.6;
    resize: vertical;
    outline: none;
    transition: border-color 0.2s;
    // 确保 textarea 滚动条可见(不被父级隐藏)
    scrollbar-width: auto; // Firefox
    -ms-overflow-style: auto; // IE/Edge
    &::-webkit-scrollbar {
      display: block; // Chrome/Safari/Webkit
      width: 8px;
    }
    &::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.2);
      border-radius: 4px;
    }
    &::-webkit-scrollbar-track {
      background: rgba(255, 255, 255, 0.05);
    }

    &:focus { border-color: rgba(255, 255, 255, 0.3); }
    &::placeholder { color: rgba(255, 255, 255, 0.25); }
    &:disabled { opacity: 0.4; cursor: not-allowed; }

    &--tall { min-height: 320px; }
  }

  &__select {
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    color: $color-text-primary;
    font-family: $font-harmony;
    font-size: 14px;
    outline: none;
    cursor: pointer;

    option { background: $color-dialog-bg; }
  }

  &__mode-toggle {
    position: relative;
    display: flex;
    gap: 0;
    border-radius: 0;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.12);
  }

  // 黄色滑动指示条:宽度 = 一格(两列各 50%),按"格数"滑动
  //
  // 位移百分比以**指示条自身宽度**为基准,而它的宽度恰好是一格宽 →
  // 前进 N 格就是 translateX(N×100%)。
  //
  // 这里刻意按"步数"而不是"列位"命名:早先叫 --middle / --right(列位语义),
  // 两列的总结 API 开关复用了 --right 想表达"第二列",结果按三列的语义
  // 滑了两格(492px,整个容器宽),黄条直接滑出容器外被 overflow 裁掉,
  // 而激活按钮的深色文字(#1a1a1a,本是给黄底用的)落在深色面板上就看不见了。
  &__mode-indicator {
    position: absolute;
    top: 0;
    left: 0;
    width: 50%;
    height: 100%;
    background: #ffef00;
    pointer-events: none;
    transition:
      transform 0.25s ease,
      opacity 0.2s ease;

    /** 前进一格(两列开关的第二列) */
    &--step-1 {
      transform: translateX(100%);
    }

    /**
     * 三列变体(API 模式:默认 / 自定义 / 旧版)
     *
     * 不加这条时指示条会沿用两列的 50% 宽 —— 黄块横跨第 1、2 个按钮，
     * 第三个按钮永远没有黄底，看起来"选不中"，这就是之前 API 模式选不了的原因。
     * 三列时一格 = 1/3，步进仍是 100%/200%（位移基准是指示条自身宽度）。
     */
    &--three {
      width: 33.3333%;

      // 第二格(自定义 API)
      &.sd__mode-indicator--step-1 {
        transform: translateX(100%);
      }

      // 第三格(旧版模式)
      &.sd__mode-indicator--step-2 {
        transform: translateX(200%);
      }
    }

    /**
     * 当前模式不在本开关内(如「连接设置」页的开关里没有"自定义 API")。
     *
     * 直接隐藏:黄块若停在"默认 API"上,会被误读成该模式已选中 ——
     * 而实际上此刻生效的是自定义 API。此时由旁边的提示行说明当前模式。
     */
    &.is-hidden {
      opacity: 0;
    }
  }

  &__mode-btn {
    position: relative;
    z-index: 1;
    flex: 1;
    padding: 8px 12px;
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.5);
    font-family: $font-harmony;
    font-size: 13px;
    cursor: pointer;
    transition: color 0.2s;

    &:hover { color: rgba(255, 255, 255, 0.8); }

    // 激活态(黄底上)悬停时保持深色文字,不被 hover 变白
    &--active,
    &--active:hover {
      color: #1a1a1a;
    }
  }

  &__char-textarea-wrap {
    position: relative;
  }

  // 分区分隔线(自定义 API 分支内的提示词/世界观区块)
  &__divider {
    height: 1px;
    margin: 12px 0;
    background: rgba(255, 255, 255, 0.12);
  }

  &__desc {
    margin: 0 0 4px;
    font-family: $font-harmony;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.5);
    line-height: 1.5;
  }

  &__actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
    // 窄屏放不下时让按钮整体换行,而不是把它们挤到内容宽以下
    // (挤窄的后果是按钮内的中文被拆成两行,很难看)
    flex-wrap: wrap;
  }

  &__btn {
    padding: 8px 20px;
    border: 1px solid #f0eeee;
    border-radius: 0;
    background: #f0eeee; // 不透明亮灰(次要操作按钮)
    color: #1a1a1a;
    font-family: $font-harmony;
    font-size: 14px;
    // 按钮文字永不换行:中文在窄按钮里会被逐字拆行(「保存」→「保/存」)。
    // 空间不够时交给 &__actions 的 flex-wrap 整体换行
    white-space: nowrap;
    cursor: pointer;
    transition: all 0.2s;

    // 禁用态不得再响应悬停变色:浏览器对 disabled 按钮依然会匹配 :hover,
    // 加了 :not(:disabled) 才能让它真正"看起来按不动"
    &:hover:not(:disabled) { background: #dcdcdc; }
    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    &--primary {
      background: #ffef00;
      border-color: #ffef00;
      color: #1a1a1a;

      &:hover:not(:disabled) { background: #e6d936; }
    }

    // 上下文窗口预设(8K/16K/…):一排五个,按默认内边距会撑爆面板宽度
    &--preset {
      padding: 6px 10px;
      font-size: 13px;
    }
  }

  // 窄屏(≤400px):面板内容宽 = 100vw − 88,「保存 / 连接测试 / 重置全部」
  // 按 20px 内边距需要 276px,360px 视口只有 272px 就放不下了。
  // 收到 12px 后总宽降到 228px,320px 视口(内容宽 232px)仍能排成一行。
  @media (max-width: 400px) {
    &__btn {
      padding: 8px 12px;
    }
  }

  &__hint {
    margin: 0;
    font-family: $font-harmony;
    font-size: 13px;
    // 基色必须显式给:--ok / --warn 是修饰类,只有它们带颜色。
    // 缺了这行,不带修饰的提示会一路继承到浏览器默认的黑色(面板是深色底 → 黑字看不见)。
    // 取值与 __desc / __label 同一族的弱化白,保证"提示文字"读起来是一套。
    color: rgba(255, 255, 255, 0.5);

    &--ok { color: rgba(100, 255, 100, 0.7); }
    &--warn { color: rgba(255, 180, 80, 0.8); }
  }

  // ---- 关于样式 -------------------------------------------------------------
  &__about {
    gap: 16px;
  }

  &__about-title {
    margin: 0 0 4px;
    font-family: $font-harmony;
    font-size: 18px;
    font-weight: 600;
    color: $color-text-primary;
    text-align: center;
  }

  // QQ 群入口:两行,整体居中(与上方标题同一轴线)
  &__about-groups {
    display: flex;
    flex-direction: column;
    gap: 4px;
    text-align: center;
  }

  &__about-group {
    margin: 0;
    font-family: $font-harmony;
    font-size: 15px;
    line-height: 1.8;
    // 群名(汉字 + 英文)一律白色;只有群号是超链接,颜色在 &-link 里单独给
    color: $color-text-primary;
  }

  // 群号说明:白字,比上面两行群名小一档
  &__about-group-tip {
    margin: 2px 0 0;
    font-family: $font-harmony;
    font-size: 13px;
    line-height: 1.6;
    color: $color-text-primary;
  }

  // 关于页所有外链共用同一套外观:强调黄 / 悬停变浅黄 / 不加下划线。
  // 「相关链接」的列表项与上方 QQ 群号都走这条,避免两处各写一份后分叉。
  &__about-links a,
  &__about-group-link {
    color: #ffef00;
    text-decoration: none;

    &:hover {
      color: #fff983;
    }
  }

  &__about-block {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  &__about-heading {
    margin: 0;
    font-family: $font-harmony;
    font-size: 15px;
    font-weight: 500;
    color: $color-text-primary;
  }

  &__about-log {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  &__about-log-date {
    margin: 8px 0 2px;
    font-family: $font-harmony;
    font-size: 16px;
    font-weight: 600;
    color: $color-text-primary;

    &:first-child {
      margin-top: 0;
    }
  }

  &__about-log-desc {
    margin: 0;
    padding-left: 10px;
    font-family: $font-harmony;
    font-size: 13px;
    line-height: 1.8;
    color: rgba(255, 255, 255, 0.65);
  }

  &__about-links {
    margin: 0;
    padding: 0;
    font-family: $font-harmony;
    font-size: 13px;
    line-height: 1.8;
    color: rgba(255, 255, 255, 0.65);
    list-style: none;
    // 链接外观统一在上方 &__about-links a / &__about-group-link 的合并规则里
  }

  // ---- 免责声明样式 ---------------------------------------------------------
  &__disclaimer {
    gap: 16px;
  }

  &__disclaimer-title {
    margin: 0 0 4px;
    font-family: $font-harmony;
    font-size: 18px;
    font-weight: 600;
    color: $color-text-primary;
    text-align: center;
  }

  &__disclaimer-content {
    font-family: $font-harmony;
    font-size: 13px;
    line-height: 1.8;
    color: rgba(255, 255, 255, 0.65);

    p {
      margin: 0 0 8px;

      &:last-child {
        margin-bottom: 0;
      }
    }

    strong {
      color: $color-text-primary;
      font-size: 14px;
    }
  }
}

/* ⛔ 临时彩蛋(可删):关于页「兑换码」那一块 —— 删掉本块 + 模板里的 ⛔ 块 +
   脚本里的 ⛔ 两处即可(见 src/easteregg/moon/README.md)。
   刻意写成独立顶层选择器(不塞进上面的 .sd 嵌套),为的就是"整块可删"。 */
.egg-redeem {
  display: flex;
  align-items: center;
  gap: 8px;

  &__input {
    flex: 1;
    min-width: 0;
  }

  /* 兑换成功后显示的操作提示(绿色小字);文案来自 redeem.ts 的 MOON_HINT */
  &__ok {
    margin: 8px 0 0;
    color: #5fd07a;
    font-family: $font-harmony;
    font-size: 12px;
    line-height: 1.5;
  }

  &__err {
    margin: 8px 0 0;
    color: #ff6b6b;
    font-family: $font-harmony;
    font-size: 12px;
    line-height: 1.5;
  }
}
</style>
