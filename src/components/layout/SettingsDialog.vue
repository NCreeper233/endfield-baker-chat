<script setup lang="ts">
// =============================================================================
// 设置弹窗(SettingsDialog)
// -----------------------------------------------------------------------------
// AI API 配置 + 提示词编辑,全部持久化到 localStorage(settings store)
// 打开/关闭状态由父组件 App 持有
// =============================================================================
import { ref, computed, watch } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import { testApiConnection } from '../../utils/llm'
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
import { RAG_MAX_TOP_K } from '../../utils/rag'
import { useChatStore } from '../../stores/chat'
import { CHARACTER_PROMPTS } from '../../constants/prompts'
import {
  API_BASES,
  API_ROUTE_LABELS,
  type ApiRoute,
} from '../../constants/apiRoutes'
import { SETTINGS_NAV } from '../../constants/settingsNav'
import type { SettingsTabKey } from '../../constants/settingsNav'
import DataManagerDialog from './DataManagerDialog.vue'
// 面板设计系统的三个小组件(分组标题 / 设置行 / 分段控件)
import SetSection from './ui/SetSection.vue'
import SetRow from './ui/SetRow.vue'
import SegControl from './ui/SegControl.vue'
import { MATERIALS } from '../../constants/materials'

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

/** 提示行语气(与 SetRow 的 tone 一一对应:成功 / 警示 / 中性) */
type HintTone = 'ok' | 'warn' | 'keep'

/**
 * 布尔开关的分段控件选项
 *
 * 设置页里绝大多数开关都只有两档,统一用这一份选项表:
 * 分段控件只认字符串值,布尔状态由调用方映射成 'on' / 'off'。
 */
const BOOL_SEG = [
  { value: 'on', label: '开启' },
  { value: 'off', label: '关闭' },
]

/** 接口模式三选一 → switchApiMode(值来自分段控件的字符串) */
function onApiModeChange(value: string): void {
  if (value === 'backend' || value === 'custom' || value === 'legacy') switchApiMode(value)
}

/** 后端路线(默认 / 备用两条域名) */
function onApiRouteChange(value: string): void {
  const hit = API_ROUTE_OPTIONS.find(o => o.value === value)
  if (hit) settingsStore.setApiRoute(hit.value)
}

/** 总结 API 模式(默认 / 自定义) */
function onSummaryModeChange(value: string): void {
  if (value === 'default' || value === 'custom') switchSummaryApiMode(value)
}

/** 内容滚动容器(切页时回到顶部用) */
const bodyEl = ref<HTMLElement | null>(null)

/**
 * 切换标签页
 *
 * 换页后把内容区滚回顶部:各页高度差很大(API 页很长、关于页很短),
 * 沿用上一页的滚动位置会落在半空中。
 */
function onSelectTab(key: SettingsTabKey) {
  if (activeTab.value === key) return
  activeTab.value = key
  if (bodyEl.value) bodyEl.value.scrollTop = 0
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
const THINK_BLOCKED_NOTE = '旧版模式不支持思考开关'
/** 新版提示词禁用时的说明 */
const NEW_PROMPT_BLOCKED_NOTE = '仅「默认 API」模式可用'
/** 智能总结开关禁用时的说明 */
const SUMMARY_BLOCKED_NOTE = '当前模式下不生效'

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
): { text: string; level: HintTone } {
  if (blocked) return { text: note, level: 'warn' }
  return { text: on ? onText : offText, level: on ? 'ok' : 'warn' }
}

const thinkHint = computed(() =>
  blockedHint(
    thinkBlocked.value,
    THINK_BLOCKED_NOTE,
    settingsStore.thinkEnabled,
    '已开启：角色先思考再回答（更慢，但更稳）',
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
    return { level: 'warn' as const, text: '已开启：每条消息都联网搜索，消耗更高' }
  }
  return { level: 'ok' as const, text: '已关闭（推荐）：由系统判断是否需要联网' }
})
/**
 * 知识源提示（RAG 语料库 / 联网搜索）
 *
 * 注意语义方向：这里**开启**代表切换到联网搜索，所以"关闭"才是默认的 RAG 语料库。
 * 不用 blockedHint —— 它是"当前配置下不生效"的通用文案，本开关不受该限制。
 */
const knowledgeSourceHint = computed(() => {
  if (settingsStore.webSearchEnabled) {
    return { level: 'ok' as const, text: '已开启：需要时联网查最新资料' }
  }
  return { level: 'keep' as const, text: '已关闭：用后端 RAG 语料库检索，速度更快' }
})
/**
 * 「沉浸式对话模式」提示行
 *
 * 三种模式 + 单聊/群聊都已落实(后端过滤或前端本地过滤)→ 永不置灰,
 * 因此不再走 blockedHint,只按开关状态给描述。
 */
const immersiveHint = computed<{ text: string; level: HintTone }>(() => {
  const on = settingsStore.immersiveMode
  return {
    level: on ? 'ok' : 'warn',
    text: on
      ? '已开启：角色只说话，不写动作描写'
      : '已关闭：角色会写括号里的动作与神态',
  }
})
const useNewPromptHint = computed(() =>
  blockedHint(
    newPromptBlocked.value,
    NEW_PROMPT_BLOCKED_NOTE,
    settingsStore.useNewPrompt,
    '已开启：使用新版角色设定',
    '已关闭：使用默认角色设定',
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
const IMMERSIVE_LOCK_NOTE = '「沉浸式对话模式」开着时，角色不写括号描写'

/**
 * 「括号描写居中」提示行
 *
 * 三种状态:被沉浸式锁住 → 开关开 / 关。
 * (本项原先在模板里内联三元,加了"锁住"这一态后挪到 computed,避免嵌套太深)
 */
const bracketCenterHint = computed(() => {
  if (bracketStyleLocked.value) {
    return {
      level: 'keep' as const,
      text: '沉浸式模式下没有括号描写，关掉它才能设置这一项',
    }
  }
  return settingsStore.bracketCenter
    ? {
        level: 'ok' as const,
        text: '已开启：括号里的动作与神态单独成行、居中显示',
      }
    : {
        level: 'warn' as const,
        text: '已关闭：括号描写留在气泡里',
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
      level: 'keep' as const,
      text: '沉浸式模式下没有可上色的内容',
    }
  }
  if (!settingsStore.bracketCenter) {
    return {
      level: 'keep' as const,
      text: '需先开启上方「括号描写居中」',
    }
  }
  return settingsStore.bracketColor
    ? {
        level: 'ok' as const,
        text: '已开启：居中描写按角色属性上色（灰 / 红 / 黄 / 青 / 绿 / 紫）',
      }
    : {
        level: 'warn' as const,
        text: '已关闭：所有居中描写统一用半透明白',
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
        level: 'ok' as const,
        text: '已开启：我方消息开头的括号单独居中，颜色随我的身份',
      }
    : {
        level: 'warn' as const,
        text: '已关闭：我方消息整条一个气泡',
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

/** 当前对话的角色名是否在内置表里(用于默认选中) */
const selectedCharacter = computed<string>(() =>
  currentCharName.value && characterNames.value.includes(currentCharName.value)
    ? currentCharName.value
    : '',
)

/**
 * 「提示词」页当前编辑的角色
 *
 * 与旧实现不同:这里**不跟随当前对话**,而是由用户在下拉里自己选 ——
 * 想改谁就选谁,不必先切对话。
 */
const promptChar = ref<string>('')

/** 提示词草稿(对应 promptChar 的角色) */
const characterPromptDraft = ref('')

/** 只有自定义 API 模式下提示词才生效,所以也只有那时可编辑 */
const promptsEditable = computed(() => isCustomMode.value)

/** 当前角色是否已经用了自定义提示词(决定「恢复默认」是否出现) */
const promptOverridden = computed(
  () => !!promptChar.value && promptChar.value in settingsStore.promptOverrides,
)

/** 把 promptChar 对应的提示词读进草稿 */
function loadPromptDraft(): void {
  characterPromptDraft.value = promptChar.value
    ? settingsStore.getCharacterPrompt(promptChar.value)
    : ''
}

// 切换角色时同步草稿
watch(promptChar, () => loadPromptDraft())

// 打开弹窗时同步本地缓存
watch(
  () => props.open,
  (open) => {
    if (open) {
      apiDraft.value = { ...settingsStore.apiConfig }
      // 智能总结草稿(打开时从 store 同步)
      summaryDraft.value = { ...settingsStore.summaryConfig }
      // 提示词页:默认选中当前对话的角色,没有就取第一个
      if (!promptChar.value || !characterNames.value.includes(promptChar.value)) {
        promptChar.value = selectedCharacter.value || characterNames.value[0] || ''
      }
      loadPromptDraft()
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
    '已开启：对话快满时自动把早期内容总结成摘要',
    '已关闭：只保留最近 50 条消息',
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

/** 保存角色提示词(保存到「提示词」页当前选中的角色) */
function saveCharacterPrompt() {
  if (!promptChar.value) return
  settingsStore.setPromptOverride(promptChar.value, characterPromptDraft.value)
}

/** 重置角色提示词为内置默认 */
function resetCharacterPrompt() {
  if (!promptChar.value) return
  settingsStore.resetPromptOverride(promptChar.value)
  loadPromptDraft()
}

/** 重置全部设置 */
function resetAll() {
  settingsStore.resetAll()
  apiDraft.value = { ...settingsStore.apiConfig }
  loadPromptDraft()
}

</script>

<template>
  <Transition name="pn-fade">
    <div v-if="open" class="st">
      <div class="pn-scrim" aria-hidden="true"></div>

      <!-- 全屏面板:顶部分类页签 + 内容滚动区 -->
      <div class="pn-win st__win" role="dialog" aria-modal="true" :aria-label="`设置 · ${activeLabel}`">
        <div class="st__top">
          <!-- 左上角:与主界面同款的小图 + 标题 -->
          <div class="st__brand" aria-hidden="true">
            <img class="st__brand-deco" :src="MATERIALS.headerDeco" alt="" />
            <p class="st__brand-title">//设置</p>
          </div>

          <!-- 分类页签 -->
          <nav class="pn-tabs" role="tablist" aria-label="设置分类">
            <span class="pn-tabs__backdrop" aria-hidden="true"></span>
            <button
              v-for="t in SETTINGS_NAV"
              :key="t.key"
              class="pn-tab"
              :class="{ 'is-active': activeTab === t.key }"
              type="button"
              role="tab"
              :aria-selected="activeTab === t.key"
              :title="t.label"
              @click="onSelectTab(t.key)"
            >
              <span
                class="pn-tab__block"
                aria-hidden="true"
                :style="activeTab === t.key ? { backgroundImage: `url(${MATERIALS.panelTabTexture})` } : undefined"
              ></span>
              <span class="pn-tab__icon">
                <svg viewBox="0 0 48 48" aria-hidden="true">
                  <path
                    v-for="(p, i) in t.icon"
                    :key="i"
                    :d="p.d"
                    :fill="p.filled ? 'currentColor' : 'none'"
                    :stroke="p.filled ? 'none' : 'currentColor'"
                    stroke-width="3.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </span>
              <span class="pn-tab__label">{{ t.short }}</span>
            </button>
          </nav>

          <button class="pn-close" type="button" aria-label="关闭设置" @click="emit('close')">
            <svg viewBox="0 0 205 205" fill="currentColor" fill-rule="evenodd" aria-hidden="true">
              <path d="M0 25L25 0L205 180L180 205ZM25 205L0 180L180 0L205 25Z"></path>
            </svg>
          </button>
        </div>

        <!-- ==================== 内容区 ==================== -->
        <div ref="bodyEl" class="pn-body st__body">
          <!-- ============ 1. API 配置 ============ -->
          <template v-if="activeTab === 'connection'">
            <SetSection title="接口模式">
              <SetRow label="API 模式" desc="选择聊天使用哪套接口">
                <SegControl
                  :model-value="apiDraft.apiMode"
                  :options="[
                    { value: 'backend', label: '默认模式' },
                    { value: 'custom', label: '自定义API' },
                    { value: 'legacy', label: '旧版模式' },
                  ]"
                  aria-label="API 模式"
                  @update:model-value="onApiModeChange"
                />
              </SetRow>

              <!-- 默认 API:后端地址由服务端下发,这里只选线路 -->
              <SetRow
                v-if="isBackendMode"
                label="当前干员"
                desc="默认接口免费提供，提示词由官方维护"
              >
                <span class="st__ro">{{ currentCharName || '未选中' }}</span>
              </SetRow>

              <SetRow
                v-if="isBackendMode"
                label="后端路线"
                :hint="`当前：${currentRouteHost}　默认线路不通时可切到「备用」`"
                tone="ok"
                stack
              >
                <div class="st__stack">
                  <SegControl
                    :model-value="settingsStore.apiRoute"
                    :options="API_ROUTE_OPTIONS.map(o => ({ value: o.value, label: o.label }))"
                    aria-label="后端路线"
                    auto
                    @update:model-value="onApiRouteChange"
                  />
                </div>
              </SetRow>

              <!-- 旧版模式 -->
              <SetRow
                v-if="isLegacyMode"
                label="完整历史模式"
                :hint="settingsStore.legacyUnlimitedHistory
                  ? '已开启：保留全部历史，不做总结'
                  : '已关闭：只保留最近 50 条'"
                :tone="settingsStore.legacyUnlimitedHistory ? 'ok' : 'warn'"
              >
                <SegControl
                  :model-value="settingsStore.legacyUnlimitedHistory ? 'on' : 'off'"
                  :options="BOOL_SEG"
                  aria-label="完整历史模式"
                  @update:model-value="(v) => (settingsStore.legacyUnlimitedHistory = v === 'on')"
                />
              </SetRow>

              <SetRow
                v-if="isLegacyMode"
                label="当前干员"
                desc="旧版 API 功能有限，建议改用默认模式"
              >
                <span class="st__ro">{{ currentCharName || '未选中' }}</span>
              </SetRow>
            </SetSection>

            <template v-if="isCustomMode">
              <SetSection title="自定义接口">
                <SetRow label="Base URL" stack>
                  <div class="st__stack">
                    <input
                      v-model="apiDraft.baseUrl"
                      class="pn-input"
                      type="text"
                      placeholder="https://api.openai.com/v1"
                    />
                  </div>
                </SetRow>

                <SetRow label="API Key" stack>
                  <div class="st__stack">
                    <input
                      v-model="apiDraft.apiKey"
                      class="pn-input"
                      type="password"
                      placeholder="sk-..."
                      autocomplete="off"
                    />
                  </div>
                </SetRow>

                <SetRow label="模型名" stack>
                  <div class="st__stack">
                    <input
                      v-model="apiDraft.model"
                      class="pn-input"
                      type="text"
                      placeholder="deepseek-v4-flash / glm-5.2 / kimi-k3 / ..."
                      @change="applyContextGuess('change')"
                    />
                  </div>
                </SetRow>

                <!-- 从 Base URL 的 /models 拉取,下拉直接选(免手敲模型名) -->
                <SetRow
                  label="模型列表"
                  :hint="modelListError
                    ? modelListError
                    : (modelOptions.length ? `已获取 ${modelOptions.length} 个，可在下方选择` : '')"
                  :tone="modelListError ? 'warn' : 'ok'"
                  stack
                >
                  <div class="st__stack">
                    <div class="st__btnrow">
                      <button
                        class="pn-pill"
                        type="button"
                        :disabled="modelListLoading"
                        @click="onFetchModels"
                      >{{ modelListLoading ? '获取中…' : '获取模型列表' }}</button>
                    </div>
                    <select
                      v-if="modelOptions.length"
                      v-model="apiDraft.model"
                      class="pn-select"
                      @change="applyContextGuess('change')"
                    >
                      <option value="">— 从列表选择 —</option>
                      <option v-for="m in modelOptions" :key="m.id" :value="m.id">{{ m.id }}</option>
                    </select>
                  </div>
                </SetRow>
              </SetSection>

              <SetSection title="生成参数">
                <SetRow label="温度" :desc="`当前 ${apiDraft.temperature.toFixed(1)}，越高越发散`" stack>
                  <div class="st__stack">
                    <input
                      v-model.number="apiDraft.temperature"
                      class="st__range"
                      type="range"
                      min="0"
                      max="2"
                      step="0.1"
                    />
                  </div>
                </SetRow>

                <SetRow label="最大 Token 数" stack>
                  <div class="st__stack">
                    <input
                      v-model.number="apiDraft.maxTokens"
                      class="pn-input"
                      type="number"
                      min="1"
                      max="32768"
                    />
                  </div>
                </SetRow>

                <!-- 上下文窗口:输入预算与"上下文已用"百分比的分母,无法从 API 探测 -->
                <SetRow
                  label="上下文窗口 (Token)"
                  :hint="contextGuess.contextWindow > 0
                    ? `已自动识别：${contextGuess.contextWindow}`
                    : (libraryFetching ? '正在识别模型上下文…' : '留空会自动识别，识别不到再手动填')"
                  :tone="contextGuess.contextWindow > 0 ? 'ok' : 'keep'"
                  stack
                >
                  <div class="st__stack">
                    <!-- 不能挂 @change="applyContextGuess('change')" ——
                         那个"无条件覆盖"是给"模型名变了"用的,挂在这里会让手改的值被填回去 -->
                    <input
                      v-model="contextWindowInput"
                      class="pn-input"
                      type="number"
                      min="1024"
                      step="1024"
                      placeholder="留空会自动识别，识别不到再手动填"
                    />
                    <div v-if="contextGuessApplicable" class="st__btnrow">
                      <button class="pn-pill" type="button" @click="applyContextGuess('change')">
                        应用 {{ contextGuess.contextWindow }}
                      </button>
                    </div>
                  </div>
                </SetRow>

                <SetRow
                  label="触发压缩的上下文占比 (%)"
                  :hint="`约 ${triggerTokens.toLocaleString('en-US')} Token 时开始压缩（占窗口 ${apiDraft.compactTriggerPercent}%）`"
                  stack
                >
                  <div class="st__stack">
                    <input
                      :value="apiDraft.compactTriggerPercent"
                      class="pn-input"
                      type="number"
                      :min="MIN_COMPACT_TRIGGER_PERCENT"
                      :max="MAX_COMPACT_TRIGGER_PERCENT"
                      step="5"
                      @change="onTriggerPercentChange"
                    />
                  </div>
                </SetRow>

                <SetRow
                  label="自动压缩上下文"
                  :hint="apiDraft.autoCompact
                    ? '已开启：快满时先把早期对话总结成摘要，再丢掉原文'
                    : '已关闭：快满时直接丢掉最早的对话'"
                  :tone="apiDraft.autoCompact ? 'ok' : 'warn'"
                >
                  <SegControl
                    :model-value="apiDraft.autoCompact ? 'on' : 'off'"
                    :options="BOOL_SEG"
                    aria-label="自动压缩上下文"
                    @update:model-value="(v) => (apiDraft.autoCompact = v === 'on')"
                  />
                </SetRow>

                <SetRow
                  label="请求流式用量 (usage)"
                  :hint="apiDraft.requestUsage
                    ? '已开启：能读到真实的输入 / 输出 / 缓存用量'
                    : '已关闭：用量面板只显示估算值'"
                  :tone="apiDraft.requestUsage ? 'ok' : 'warn'"
                >
                  <SegControl
                    :model-value="apiDraft.requestUsage ? 'on' : 'off'"
                    :options="BOOL_SEG"
                    aria-label="请求流式用量"
                    @update:model-value="(v) => (apiDraft.requestUsage = v === 'on')"
                  />
                </SetRow>
              </SetSection>
            </template>

            <SetSection title="连接">
              <SetRow
                label="连接测试"
                :desc="settingsStore.isApiConfigured ? 'API 已配置' : 'API 未配置'"
                :hint="testState === 'success' || testState === 'fail' ? testMessage : ''"
                :tone="testState === 'success' ? 'ok' : (testState === 'fail' ? 'warn' : '')"
                stack
              >
                <div class="st__stack">
                  <div class="st__btnrow">
                    <button
                      class="pn-pill"
                      type="button"
                      :disabled="testState === 'testing'"
                      @click="onTestConnection"
                    >{{ testState === 'testing' ? '测试中…' : '连接测试' }}</button>
                    <button class="pn-pill st__danger" type="button" @click="resetAll">重置全部</button>
                  </div>
                </div>
              </SetRow>
            </SetSection>
          </template>

          <!-- ============ 2. 提示词 ============ -->
          <template v-if="activeTab === 'prompts'">
            <!-- 非自定义 API 模式:提示词不参与请求,整页置为只读说明 -->
            <SetSection v-if="!promptsEditable" title="当前模式不可编辑">
              <SetRow
                label="提示词只在「自定义 API」模式下生效"
                desc="默认 API 和旧版模式的提示词是固定的；切到「自定义 API」后，就能在这里逐个角色修改"
              >
                <span class="st__ro">只读</span>
              </SetRow>
            </SetSection>

            <SetSection title="选择角色">
              <SetRow
                label="编辑对象"
                :hint="`带「已修改」的角色用的是你写的版本（共 ${Object.keys(settingsStore.promptOverrides).length} 个）`"
                tone="keep"
              >
                <select
                  v-model="promptChar"
                  class="pn-select"
                  :disabled="!promptsEditable"
                  aria-label="选择要修改提示词的角色"
                >
                  <option v-for="name in characterNames" :key="name" :value="name">
                    {{ name }}{{ name in settingsStore.promptOverrides ? '（已修改）' : '' }}
                  </option>
                </select>
              </SetRow>
            </SetSection>

            <SetSection title="角色提示词">
              <SetRow
                :label="`${promptChar || '未选择角色'} 的提示词`"
                :desc="promptOverridden ? '正在使用你写的版本，可随时恢复默认' : '当前是内置版本，保存后改用你的版本'"
                stack
              >
                <div class="st__stack">
                  <textarea
                    v-model="characterPromptDraft"
                    class="pn-area"
                    rows="14"
                    :placeholder="promptsEditable ? '输入这个角色的提示词…' : '切换到自定义 API 模式后可编辑'"
                    :disabled="!promptsEditable || !promptChar"
                  ></textarea>
                  <div class="st__btnrow">
                    <button
                      class="pn-pill pn-pill--primary"
                      type="button"
                      :disabled="!promptsEditable || !promptChar"
                      @click="saveCharacterPrompt"
                    >保存</button>
                    <button
                      v-if="promptOverridden"
                      class="pn-pill pn-pill--ghost"
                      type="button"
                      :disabled="!promptsEditable"
                      @click="resetCharacterPrompt"
                    >恢复默认</button>
                  </div>
                </div>
              </SetRow>
            </SetSection>

            <SetSection title="世界观背景">
              <SetRow
                label="全局世界观"
                desc="会附加给所有角色，影响整体氛围与设定"
                stack
              >
                <div class="st__stack">
                  <textarea
                    v-model="settingsStore.worldView"
                    class="pn-area"
                    rows="8"
                    placeholder="输入全局世界观，例如：这是终末地工业时代，源石技艺与科技并存…"
                    :disabled="!promptsEditable"
                  ></textarea>
                </div>
              </SetRow>
            </SetSection>
          </template>

          <!-- ============ 3. 显示和内容输出 ============ -->
          <template v-if="activeTab === 'display'">
            <SetSection title="消息分条">
              <SetRow
                label="智能消息分条"
                :hint="settingsStore.smartSplit
                  ? '已开启：动作描写和每句台词各自成行；太短的句子会并到下一行'
                  : '已关闭：只按换行分行，动作描写留在原段落里'"
                :tone="settingsStore.smartSplit ? 'ok' : 'warn'"
              >
                <SegControl
                  :model-value="settingsStore.smartSplit ? 'on' : 'off'"
                  :options="BOOL_SEG"
                  aria-label="智能消息分条"
                  @update:model-value="(v) => (settingsStore.smartSplit = v === 'on')"
                />
              </SetRow>
            </SetSection>

            <SetSection title="括号描写">
              <SetRow
                label="括号描写居中"
                :hint="bracketCenterHint.text"
                :tone="bracketCenterHint.level"
              >
                <SegControl
                  :model-value="settingsStore.bracketCenter ? 'on' : 'off'"
                  :options="BOOL_SEG"
                  :disabled="bracketStyleLocked"
                  :title="bracketStyleLocked ? IMMERSIVE_LOCK_NOTE : ''"
                  aria-label="括号描写居中"
                  @update:model-value="(v) => (settingsStore.bracketCenter = v === 'on')"
                />
              </SetRow>

              <SetRow
                label="彩色括号描写"
                :hint="bracketColorHint.text"
                :tone="bracketColorHint.level"
              >
                <SegControl
                  :model-value="settingsStore.bracketColor ? 'on' : 'off'"
                  :options="BOOL_SEG"
                  :disabled="!settingsStore.bracketCenter || bracketStyleLocked"
                  :title="bracketStyleLocked
                    ? IMMERSIVE_LOCK_NOTE
                    : (settingsStore.bracketCenter ? '' : '需先开启上方「括号描写居中」')"
                  aria-label="彩色括号描写"
                  @update:model-value="(v) => (settingsStore.bracketColor = v === 'on')"
                />
              </SetRow>

              <SetRow
                label="居中我方括号内容"
                :hint="centerMyBracketHint.text"
                :tone="centerMyBracketHint.level"
              >
                <SegControl
                  :model-value="settingsStore.centerMyBracket ? 'on' : 'off'"
                  :options="BOOL_SEG"
                  aria-label="居中我方括号内容"
                  @update:model-value="(v) => (settingsStore.centerMyBracket = v === 'on')"
                />
              </SetRow>
            </SetSection>

            <SetSection title="输入面板">
              <SetRow
                label="新版输入面板"
                :hint="settingsStore.newInputPanel
                  ? '已开启：输入框超过两行会出现放大按钮，可展开成大半屏（手机端）'
                  : '已关闭：输入框固定两行高，超出部分在框内滚动'"
                :tone="settingsStore.newInputPanel ? 'ok' : 'warn'"
              >
                <SegControl
                  :model-value="settingsStore.newInputPanel ? 'on' : 'off'"
                  :options="BOOL_SEG"
                  aria-label="新版输入面板"
                  @update:model-value="(v) => (settingsStore.newInputPanel = v === 'on')"
                />
              </SetRow>

              <SetRow
                label="推荐回复"
                :hint="settingsStore.choicesEnabled
                  ? '已开启：输入框旁显示推荐回复按钮'
                  : '已关闭：不显示推荐回复按钮'"
                :tone="settingsStore.choicesEnabled ? 'ok' : 'warn'"
              >
                <SegControl
                  :model-value="settingsStore.choicesEnabled ? 'on' : 'off'"
                  :options="BOOL_SEG"
                  aria-label="推荐回复"
                  @update:model-value="(v) => (settingsStore.choicesEnabled = v === 'on')"
                />
              </SetRow>
            </SetSection>

            <SetSection title="回复行为">
              <SetRow
                label="SSE 流式回复"
                :hint="settingsStore.sseStreaming
                  ? '已开启：单聊里回复逐字出现（仅默认 API 生效，不支持时会自动改回整段显示）'
                  : '已关闭：等整段回复生成完再显示'"
                :tone="settingsStore.sseStreaming ? 'ok' : 'warn'"
              >
                <SegControl
                  :model-value="settingsStore.sseStreaming ? 'on' : 'off'"
                  :options="BOOL_SEG"
                  aria-label="SSE 流式回复"
                  @update:model-value="(v) => (settingsStore.sseStreaming = v === 'on')"
                />
              </SetRow>

              <SetRow
                label="沉浸式对话模式"
                :hint="immersiveHint.text"
                :tone="immersiveHint.level"
              >
                <SegControl
                  :model-value="settingsStore.immersiveMode ? 'on' : 'off'"
                  :options="BOOL_SEG"
                  aria-label="沉浸式对话模式"
                  @update:model-value="(v) => (settingsStore.immersiveMode = v === 'on')"
                />
              </SetRow>
            </SetSection>
          </template>

          <!-- ============ 3. 实验性功能 ============ -->
          <template v-if="activeTab === 'experimental'">
            <SetSection title="模型能力">
              <SetRow
                label="思考模式"
                :hint="thinkHint.text"
                :tone="thinkHint.level"
                :off="thinkBlocked"
              >
                <SegControl
                  :model-value="settingsStore.thinkEnabled ? 'on' : 'off'"
                  :options="BOOL_SEG"
                  :disabled="thinkBlocked"
                  :title="thinkTitle || ''"
                  aria-label="思考模式"
                  @update:model-value="(v) => (settingsStore.thinkEnabled = v === 'on')"
                />
              </SetRow>

              <SetRow
                label="使用新版提示词"
                :hint="useNewPromptHint.text"
                :tone="useNewPromptHint.level"
                :off="newPromptBlocked"
              >
                <SegControl
                  :model-value="settingsStore.useNewPrompt ? 'on' : 'off'"
                  :options="BOOL_SEG"
                  :disabled="newPromptBlocked"
                  :title="newPromptTitle || ''"
                  aria-label="使用新版提示词"
                  @update:model-value="(v) => (settingsStore.useNewPrompt = v === 'on')"
                />
              </SetRow>
            </SetSection>

            <SetSection title="知识源">
              <!-- 默认 API:知识源由后端二选一 -->
              <template v-if="apiDraft.apiMode === 'backend'">
                <SetRow
                  label="联网搜索（替代 RAG）"
                  desc="效果极差，除特殊需求极其不推荐开启"
                  :hint="knowledgeSourceHint.text"
                  :tone="knowledgeSourceHint.level"
                >
                  <SegControl
                    :model-value="settingsStore.webSearchEnabled ? 'on' : 'off'"
                    :options="BOOL_SEG"
                    aria-label="联网搜索"
                    @update:model-value="(v) => (settingsStore.webSearchEnabled = v === 'on')"
                  />
                </SetRow>

                <SetRow
                  v-if="settingsStore.webSearchEnabled"
                  label="强制每条搜索"
                  :hint="settingsStore.forceSearch
                    ? '已开启：每条都联网，不再判断'
                    : '已关闭（推荐）：自动判断要不要联网'"
                  :tone="forceSearchHint.level"
                >
                  <SegControl
                    :model-value="settingsStore.forceSearch ? 'on' : 'off'"
                    :options="BOOL_SEG"
                    aria-label="强制每条搜索"
                    @update:model-value="(v) => (settingsStore.forceSearch = v === 'on')"
                  />
                </SetRow>
              </template>

              <!-- 自定义 API:没有联网能力(那是后端网关的功能),只有语料库开关 -->
              <template v-else-if="apiDraft.apiMode === 'custom'">
                <SetRow
                  label="RAG 语料库"
                  :hint="settingsStore.ragEnabled
                    ? '已开启：回复前先检索一次设定资料，与默认 API 用的是同一套语料'
                    : '已关闭：不检索设定资料，回复只依赖提示词与对话历史'"
                  :tone="settingsStore.ragEnabled ? 'ok' : 'warn'"
                >
                  <SegControl
                    :model-value="settingsStore.ragEnabled ? 'on' : 'off'"
                    :options="BOOL_SEG"
                    aria-label="RAG 语料库"
                    @update:model-value="(v) => (settingsStore.ragEnabled = v === 'on')"
                  />
                </SetRow>

                <!-- 检索条数:服务端固定返回 5 条,这里决定实际带几条进请求 -->
                <SetRow
                  label="每次检索条数"
                  :hint="settingsStore.ragEnabled
                    ? `每轮最多带 ${settingsStore.ragTopK} 条语料进请求；带得越多越占 token，也越容易混进无关内容`
                    : '语料库已关闭，本项暂不生效'"
                  :tone="settingsStore.ragEnabled ? 'keep' : 'keep'"
                >
                  <select
                    v-model.number="settingsStore.ragTopK"
                    class="pn-select st__topk"
                    :disabled="!settingsStore.ragEnabled"
                    aria-label="每次检索条数"
                  >
                    <option v-for="n in RAG_MAX_TOP_K" :key="n" :value="n">{{ n }} 条</option>
                  </select>
                </SetRow>
              </template>

              <!-- 旧版模式:不接检索 -->
              <SetRow
                v-else
                label="旧版模式不接检索"
                desc="旧版走内置端点，既没有语料库也不支持联网"
              >
                <span class="st__ro">—</span>
              </SetRow>
            </SetSection>

            <SetSection title="智能总结">
              <SetRow
                label="智能总结"
                :hint="summaryHint.text"
                :tone="summaryHint.level"
                :off="summaryBlocked"
              >
                <SegControl
                  :model-value="summaryDraft.enabled ? 'on' : 'off'"
                  :options="BOOL_SEG"
                  :disabled="summaryBlocked"
                  :title="summaryTitle || ''"
                  aria-label="智能总结"
                  @update:model-value="(v) => (summaryDraft.enabled = v === 'on')"
                />
              </SetRow>

              <SetRow
                v-if="summaryBlocked"
                label="总结 API 的用途"
                desc="总结 API 在「API 配置」页填写；压缩历史时会用到它"
              >
                <span class="st__ro">—</span>
              </SetRow>

              <!-- 总结 API:仅在「智能总结」开启时显示(它就是这个开关用的端点) -->
              <template v-if="summaryDraft.enabled">
                <SetRow label="总结 API 模式" desc="把早期对话压缩成摘要，自动和手动压缩都用它">
                  <SegControl
                    :model-value="summaryDraft.apiMode"
                    :options="[{ value: 'default', label: '默认 API' }, { value: 'custom', label: '自定义 API' }]"
                    aria-label="总结 API 模式"
                    @update:model-value="onSummaryModeChange"
                  />
                </SetRow>

                <SetRow
                  v-if="isSummaryDefaultMode"
                  label="内置总结端点"
                  desc="使用内置 API，不用填密钥"
                >
                  <span class="st__ro">Agnes 2.5 Flash</span>
                </SetRow>

                <template v-if="isSummaryCustomMode">
                  <SetRow label="Base URL" stack>
                    <div class="st__stack">
                      <input
                        v-model="summaryDraft.baseUrl"
                        class="pn-input"
                        type="text"
                        placeholder="https://api.agnes-ai.cn/v1"
                      />
                    </div>
                  </SetRow>

                  <SetRow label="API Key" stack>
                    <div class="st__stack">
                      <input
                        v-model="summaryDraft.apiKey"
                        class="pn-input"
                        type="password"
                        placeholder="sk-..."
                        autocomplete="off"
                      />
                    </div>
                  </SetRow>

                  <SetRow label="模型名" stack>
                    <div class="st__stack">
                      <input
                        v-model="summaryDraft.model"
                        class="pn-input"
                        type="text"
                        placeholder="agnes-2.5-flash"
                      />
                    </div>
                  </SetRow>

                  <SetRow
                    label="模型列表"
                    :hint="summaryModelListError
                      ? summaryModelListError
                      : (summaryModelOptions.length ? `已获取 ${summaryModelOptions.length} 个，可在下方选择` : '')"
                    :tone="summaryModelListError ? 'warn' : 'ok'"
                    stack
                  >
                    <div class="st__stack">
                      <div class="st__btnrow">
                        <button
                          class="pn-pill"
                          type="button"
                          :disabled="summaryModelListLoading"
                          @click="onFetchSummaryModels"
                        >{{ summaryModelListLoading ? '获取中…' : '获取模型列表' }}</button>
                      </div>
                      <select v-if="summaryModelOptions.length" v-model="summaryDraft.model" class="pn-select">
                        <option value="">— 从列表选择 —</option>
                        <option v-for="m in summaryModelOptions" :key="m.id" :value="m.id">{{ m.id }}</option>
                      </select>
                    </div>
                  </SetRow>

                  <SetRow
                    label="上下文总长 (Token)"
                    hint="对话累计到该长度的 80% 时，把更早的内容总结成摘要（默认 512000）"
                    tone="keep"
                    stack
                  >
                    <div class="st__stack">
                      <input
                        v-model.number="summaryDraft.contextWindow"
                        class="pn-input"
                        type="number"
                        min="1000"
                        step="1000"
                        placeholder="512000"
                      />
                    </div>
                  </SetRow>
                </template>
              </template>
            </SetSection>
          </template>

          <!-- ============ 4. 数据管理 ============ -->
          <div v-if="activeTab === 'data'" class="st__data">
            <DataManagerDialog :open="open" embedded />
          </div>

          <!-- ============ 5. 免责声明 ============ -->
          <div v-if="activeTab === 'disclaimer'" class="st__doc">
            <section class="st__doc-sec">
              <h3 class="st__doc-h">一、用户责任与合规使用</h3>
              <p>您明确知晓并同意，您是使用本工具生成内容的唯一责任人。您承诺：</p>
              <ol class="st__doc-list">
                <li>严格遵守您所使用 AI 模型服务商的所有使用政策与安全准则。</li>
                <li>遵守您所在地及服务商所在地的现行法律法规，绝不利用本工具生成任何涉及政治敏感、淫秽色情、暴力恐怖、仇恨歧视、侵犯他人合法权益以及其他一切违法和不良信息。</li>
                <li>理解并接受本工具仅用于合法的《明日方舟：终末地》同人角色扮演娱乐，任何超出此用途的使用风险自担。</li>
              </ol>
            </section>

            <section class="st__doc-sec">
              <h3 class="st__doc-h">二、知识产权与同人声明</h3>
              <p>《明日方舟：终末地》是上海鹰角网络科技有限公司的游戏产品。本工具为第三方同人作品，无任何盈利性质，与上海鹰角网络科技有限公司及《明日方舟：终末地》官方开发商、运营商无任何关联。</p>
              <p>本工具中使用的所有与《明日方舟：终末地》相关的角色形象、世界观设定、剧情元素、图片资源等知识产权，均归上海鹰角网络科技有限公司所有。本工具仅供爱好者学习与交流，严禁用于任何商业用途。</p>
            </section>

            <section class="st__doc-sec">
              <h3 class="st__doc-h">三、免责条款</h3>
              <p>在法律允许的最大范围内，本工具开发者不对以下情况承担任何明示或默示的担保或责任：</p>
              <ol class="st__doc-list">
                <li>用户因违反本声明或第三方服务商条款而产生的任何纠纷、处罚或损失；</li>
                <li>用户因篡改代码等自主行为所引发的一切后果；</li>
                <li>对第三方 AI 模型服务商提供的服务质量、内容准确性及合规性。</li>
              </ol>
              <p class="st__doc-note">请您在使用前务必仔细阅读并同意以上全部条款。继续使用即代表您已充分理解并自愿承担所有相关风险。</p>
            </section>
          </div>

        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

// =============================================================================
// 设置面板(全屏分类面板)
// -----------------------------------------------------------------------------
// 结构:遮罩 + 全屏窗口(顶部页签栏 / 内容滚动区)。
// 通用的面板外观(遮罩、页签、分组标题、设置行、分段控件、胶囊按钮与输入框)
// 全部来自全局设计系统 `styles/panel.scss`(`.pn-` 前缀),这里只写本页特有
// 的栅格与少量补充样式(只读值、按钮行、滑块、危险按钮、文档与关于页)。
// =============================================================================

.st {
  position: fixed;
  inset: 0;
  z-index: 500;

  // 设置面板的遮罩比公告页更不透明:把后面的聊天界面压暗,控件更清楚
  .pn-scrim {
    background: rgba(8, 9, 10, 0.88);
  }
}

.st__win {
  // 顶部不留白:页签栏紧贴页面顶端
  padding-top: 0;
}

.st__top {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: flex-start;
  justify-content: center;
  min-height: 56px;
}

// 左上角:与主界面顶部一致的「小图 + //BAKER/…」标题
.st__brand {
  position: absolute;
  left: 22px;
  top: 6px;
  pointer-events: none;
  user-select: none;
}

.st__brand-deco {
  display: block;
  width: 63px;
  height: 12px;
  opacity: 0.85;
}

.st__brand-title {
  margin: 5px 0 0;
  color: $color-text-primary;
  font-family: $font-harmony;
  font-size: 21px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: -0.5px;
  white-space: nowrap;
}

.st__body {
  // 内容与页签栏之间留一点呼吸
  padding-top: 6px;
}

// ---- 只读值(当前干员 / 内置端点等) ----------------------------------------
.st__ro {
  color: #e6e6e6;
  font-size: 13.5px;
  white-space: nowrap;
}

// 「每次检索条数」下拉:只占一小段,不拉满控件列
.st__topk {
  width: 132px;
}

// ---- 控件列里的纵向堆叠 ----------------------------------------------------
.st__stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

// ---- 按钮行 ----------------------------------------------------------------
.st__btnrow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

// ---- 温度滑块:轨道压成细线,拇指用标识黄 ---------------------------------
.st__range {
  width: 100%;
  height: 20px;
  margin: 0;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  cursor: pointer;

  &::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.24);
  }

  &::-webkit-slider-thumb {
    width: 16px;
    height: 16px;
    margin-top: -6px;
    border: 0;
    border-radius: 50%;
    background: #ffee34;
    box-shadow: 0 0 4px rgba(0, 0, 0, 0.45);
    appearance: none;
    -webkit-appearance: none;
  }

  &::-moz-range-track {
    height: 4px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.24);
  }

  &::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border: 0;
    border-radius: 50%;
    background: #ffee34;
  }
}

// ---- 危险操作(重置全部) --------------------------------------------------
.st__danger {
  background: rgba(214, 74, 74, 0.22);
  color: #ffb3b3;
  box-shadow: 0 0 0 1.5px rgba(255, 120, 120, 0.42) inset;

  &:hover:not(:disabled) {
    background: rgba(214, 74, 74, 0.36);
    color: #ffd0d0;
  }
}

// ---- 数据管理页(内嵌组件,铺满内容宽度) ----------------------------------
.st__data {
  padding: 0 44px;

  // 组件本身带一层 16px 内边距(弹窗居中用的),内嵌时必须归零:
  // 否则整页内容比其它页多缩进 16px,左边缘对不齐。
  :deep(.dm) {
    padding: 0;
  }

  // 分组标题:与设置页各分类同一套(黄色竖条 + 通栏细线)
  // 数值逐项对齐 .pn-sec__head + .pn-rows:字号 17 / 上 2px 下 10px,
  // 标题与下方内容之间留 8px(其它页由 .pn-rows 的 margin-top 提供)
  :deep(.dm__group) {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 12px 0 8px;
    padding: 2px 0 10px;
    color: #ffef00;
    font-size: 17px;
    font-weight: 700;
    line-height: 1.4;

    &::before {
      content: '';
      flex: 0 0 4px;
      width: 4px;
      height: 20px;
      background: #ffef00;
    }

    &::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 1px;
      background: rgba(255, 255, 255, 0.32);
    }
  }

  // 顶部统计行后面紧跟的第一个分组标题:不要再加间距
  :deep(.dm__stats + .dm__group) {
    margin-top: 0;
  }

  :deep(.dm__group--danger) {
    color: #ff8f8f;

    &::before {
      background: #ff8f8f;
    }
  }

  :deep(.dm__stats) {
    margin: 0 0 12px;
    color: rgba(255, 255, 255, 0.72);
    font-size: 13px;
  }

  :deep(.dm__subtitle) {
    // 标题下方那行灰字(云同步说明):离分割线再远一点,别贴着看
    margin: 6px 0 10px;
    color: rgba(255, 255, 255, 0.6);
    font-size: 13px;
  }

  // 按钮组做成一张卡片,与设置行同色、同内边距、同圆角、同最小高度
  // (圆角要 !important:弹窗那套 shell 会给子元素强制直角)
  :deep(.dm__actions) {
    gap: 10px;
    min-height: 62px;
    padding: 10px 24px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 3px !important;
    background: #323234;
  }

  // 危险操作:一行排开(手机上自动换行),不再竖着堆四条
  :deep(.dm__actions--menu) {
    flex-flow: row wrap;
    gap: 10px;
  }

  :deep(.dm__divider) {
    display: none;
  }

  :deep(.dm__btn) {
    border-radius: 999px !important;
    padding: 6px 16px !important;
    background: #edebec !important;
    color: #373537 !important;
    font-size: 13.5px !important;
    line-height: 1.4 !important;
    box-shadow: 0 0 3px rgba(0, 0, 0, 0.27);
    transition: background-color 0.15s ease;

    &:hover:not(:disabled) {
      background: #e0e0e0 !important;
    }

    &:disabled {
      opacity: 0.45;
    }
  }

  :deep(.dm__btn--primary) {
    background: #2a2728 !important;
    color: #fefcfc !important;

    &:hover:not(:disabled) {
      background: #1e1c1c !important;
    }
  }

  :deep(.dm__btn--danger) {
    background: rgba(214, 74, 74, 0.22) !important;
    color: #ffb3b3 !important;

    &:hover:not(:disabled) {
      background: rgba(214, 74, 74, 0.36) !important;
    }
  }

  :deep(.dm__input) {
    border-radius: 999px !important;
    background: #edebec !important;
    color: #2c2c2c !important;
  }

  :deep(.dm__code-value) {
    color: #ffee34;
  }

  // 二次确认弹窗的正文在白底弹窗里,文字颜色由 DataManagerDialog 自己定,
  // 这里不要再覆盖(曾经写过 #fff,导致白底白字)
}

// ---- 免责声明 / 关于:长文档排版 ------------------------------------------
.st__doc {
  padding: 2px 44px 44px;
  color: rgba(255, 255, 255, 0.82);
  font-family: $font-harmony;
  font-size: 13.5px;
  line-height: 1.9;
}

.st__doc-sec {
  margin: 0 0 6px;
}

// 与小节标题同一套语言:黄色竖条 + 通栏细线
.st__doc-h {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 20px 0 10px;
  padding: 0 0 10px;
  color: #ffee34;
  font-size: 16px;
  font-weight: 700;

  &::before {
    content: '';
    flex: 0 0 4px;
    width: 4px;
    height: 18px;
    background: #ffee34;
  }

  &::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 1px;
    background: rgba(255, 255, 255, 0.32);
  }
}

.st__doc p {
  max-width: 96ch;
  margin: 0 0 10px;
}

// 条款列表:黄色序号 + 悬挂缩进
.st__doc-list {
  max-width: 96ch;
  margin: 0 0 12px;
  padding-left: 1.6em;

  li {
    margin-bottom: 5px;

    &::marker {
      color: #ffee34;
      font-variant-numeric: tabular-nums;
    }
  }
}

// 结尾提示:左侧黄条 + 淡黄底,和正文区分开
.st__doc-note {
  max-width: 96ch;
  margin: 14px 0 0;
  padding: 10px 14px;
  border-left: 3px solid #ffee34;
  border-radius: 0 3px 3px 0;
  background: rgba(255, 238, 52, 0.08);
  color: rgba(255, 255, 255, 0.92);
}

// ---------------------------------------------------------------------------
// 移动端
// ---------------------------------------------------------------------------
@media (max-width: 768px) {
  // 手机端不显示左上角的「//设置」与小图,把顶部整条让给页签
  .st__brand {
    display: none;
  }

  .st__top {
    min-height: 44px;
  }

  .st__data,
  .st__doc {
    padding-left: 12px;
    padding-right: 12px;
  }
}
</style>
