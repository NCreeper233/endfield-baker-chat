<script setup lang="ts">
// =============================================================================
// AI 聊天输入框(ChatInput)
// -----------------------------------------------------------------------------
// 复用底部面板的视觉风格(PanelShell + 胶囊输入框 + 圆形按钮),
// 连接 AI 聊天流程(useAiChat):
//   - contenteditable 输入框(回车发送,Ctrl/Shift+Enter 换行)
//   - 图片按钮:上传图片并直接发送(等比缩放到 CHAT_IMAGE 上限)
//   - 表情按钮:弹出表情网格,点击在光标处插入表情
//   - 发送按钮(AI 响应中变为停止按钮)
//   - API 未配置时上抛 open-settings 事件
// =============================================================================
import { ref, computed, inject, watch, onMounted, onBeforeUnmount, toValue } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../../stores/chat'
import { useAiChat } from '../../composables/useAiChat'
import { useGroupChat } from '../../composables/useGroupChat'
import { useSettingsStore } from '../../stores/settings'
import { useUsageStore } from '../../stores/usage'
import { useGroupRunControl } from '../../composables/useGroupRunControl'
import { setExtraInputH } from '../../composables/useInputHeight'
import { MATERIALS } from '../../constants/materials'
import {
  chatGeometryKey,
  globalChatGeometry,
  DESKTOP_GEOM,
  type ChatGeometry,
} from '../../constants/chatGeometry'
import { CHAT_IMAGE } from '../../constants/design'
import { EMOJIS, emojiImgHtml, htmlToEmojiText } from '../../constants/emoji'
import type { Emoji } from '../../constants/emoji'
import PanelShell from './PanelShell.vue'
import ChoicePanel from './ChoicePanel.vue'
import { devWarn } from '../../utils/logger'

const chatStore = useChatStore()
const { isAiResponding } = storeToRefs(chatStore)
const { sendAndWaitForAi, respondAfterImage, abort, fetchSuggestions } = useAiChat()
/** 群聊:backend/legacy 走后端群聊服务(:5810),custom 走前端本地链路(自定义 API) */
const groupChat = useGroupChat()
const settingsStore = useSettingsStore()
/** 草稿上报给用量面板(面板据此实时预估下一次请求的上下文体积) */
const usageStore = useUsageStore()

const emit = defineEmits<{
  (e: 'open-settings'): void
  /** 需要给玩家一句提示(群聊限速 / 生成失败等) */
  (e: 'hint', text: string): void
}>()

/** 注入几何(面板位置/尺寸;默认全局,导出模式由 ChatExportStage 覆盖)。
 * 注意:inject 必须在 setup 期间立即调用(见 ChatArea 同款注释)。 */
const injectedGeom = inject(chatGeometryKey, globalChatGeometry) ?? DESKTOP_GEOM
const geom = computed<ChatGeometry>(() => toValue(injectedGeom))

/** 是否移动端输入(几何层 stripSegmented 仅移动端为 true):移动端用原生 textarea
 * 替代 contenteditable——夸克等魔改内核浏览器对 contenteditable 的焦点支持差,
 * 会导致键盘弹出后闪退;textarea 为原生控件,焦点稳定。 */
const isMobileInput = computed(() => geom.value.stripSegmented)

/** 面板高度(px,几何层:桌面 80 / 移动端 56) */
const PANEL_H = computed(() => geom.value.panelHeight)

/** 面板顶 = 几何层面板顶(桌面 = detail 底边 - 面板高 - 3px) */
const panelTop = computed(() => geom.value.panelTop)

/** contenteditable 输入框 DOM ref(桌面端) */
const inputEl = ref<HTMLDivElement | null>(null)

/** textarea 输入框 DOM ref(移动端) */
const mobileInputEl = ref<HTMLTextAreaElement | null>(null)

/** 移动端输入文本(v-model) */
const mobileText = ref('')

// ---- 输入框最多几行 ----------------------------------------------------------
/**
 * 新版输入面板 = 输入框"最多两行 + 可展开成 2/3 屏大输入框"
 *
 *   1 行      :普通单行,面板高 50
 *   超过 1 行 :输入框与面板一起向上长一行(聊天区同步变矮,免得挡住消息)
 *   达到 3 行 :输入框不再长高(框内滚动),按钮组上方浮出半透明「扩大」按钮
 *   点扩大    :升成 2/3 屏的大输入框(浮层,压在聊天之上,聊天区**不动**),
 *              三个小按钮移到最下方一行,扩大按钮移到右上角变成「缩小」
 *   点缩小 / 点上方遮罩:复原
 *
 * 关掉时:**输入框仍是两行封顶**(见 MOBILE_MAX_LINES),只是没有扩大按钮。
 * (2026-09-25 之前这个开关对应的是"两行布局"——输入框+发送一行、按钮另起一行,
 *  那种排法已废弃。)
 */
const newPanelUi = computed(() => settingsStore.newInputPanel)

/** 新版输入面板是否在当前形态下生效(桌面端恒为旧行为) */
const newPanelActive = computed(() => newPanelUi.value && isMobileInput.value)

// ---- 输入框随内容长高 --------------------------------------------------------
/**
 * 输入框未增高时的高度(px,设计口径)
 *
 * 必须与样式里 &__field(桌面 45)/ &--mobile .chat-input__field(移动 36)一致 ——
 * 那两处只作首帧初值,之后由这里量出的高度以内联样式接管。
 */
const INPUT_BASE_H = computed(() => (isMobileInput.value ? 36 : 45))

/** 桌面:输入框最多长到几行,再多就在框内滚动(一次长粘贴不至于把聊天区吃光) */
const INPUT_MAX_LINES = 10

/**
 * 移动端:输入框**一律两行封顶**(新旧面板一致)
 *
 * 两行以上不再往上长 —— 框内滚动。这与「新版输入面板」开关无关:
 *   · 开关关闭:两行封顶,没有扩大按钮(老版那个"随行数往上长"的行为已废弃)
 *   · 开关打开:同样两行封顶,第三行起另给一个「扩大」按钮,可展开成 2/3 屏
 * 桌面不参与这条规则(面板宽、上行空间足,仍是十行)。
 */
const MOBILE_MAX_LINES = 2

/** 当前允许的最大行数 */
const maxLines = computed(() => (isMobileInput.value ? MOBILE_MAX_LINES : INPUT_MAX_LINES))

/** 输入框当前高度(px,设计口径);0 = 尚未量过,用基础高度 */
const fieldH = ref(0)

/** 高度上限:行高 = 字号 × 1.4,与 CSS 的 line-height 同口径 */
const INPUT_MAX_H = computed(() => {
  const font = isMobileInput.value ? 16 : 20.88
  return INPUT_BASE_H.value + (maxLines.value - 1) * font * 1.4
})

// ---- 展开态(新版输入面板:2/3 屏大输入框) ----------------------------------
/**
 * 是否展开成大输入框
 *
 * 展开态是一层**浮层**:只改自身的样式与内联高度,几何层一点都不动 ——
 * 所以上方的聊天内容不会被顶上去。这与"长到两行"是两回事:那种情况必须
 * 把聊天区抬高一行,否则末尾消息会被面板盖住。
 */
const expanded = ref(false)

/** 内容是否已经超过封顶行数(到第三行才给扩大按钮) */
const contentOverflow = ref(false)

/**
 * 展开态的三个尺寸(px)
 *
 * 定位基准是**底部面板自身**(约 50px 高、贴屏幕底;软键盘弹出时贴键盘上沿),
 * 大面板从它底边往上长 2/3 可视高。所以"大面板顶边往下 48px"这类位置
 * 不能写成 top: 48px(那是相对面板顶边,会落到屏幕外),必须换算成
 * "面板底边往上 sheet − 48";这里算好直接以 px 下发,样式里不做二次推导。
 *
 * 视口高度取几何层的 viewportH:移动端它是"键盘以上的可视高度",
 * 所以 2/3 永远不被键盘遮住。
 */
const sheetH = computed(() => Math.round(geom.value.viewportH * (2 / 3)))
/** 遮罩高度 = 可视高度 − 大面板高度(盖住上方剩余的那 1/3) */
const scrimH = computed(() => Math.max(0, geom.value.viewportH - sheetH.value))
/** 大面板里输入框的高度:顶部让开缩小按钮 48、底部让开按钮行 58,极矮视口兜底 72 */
const sheetFieldH = computed(() => Math.max(72, sheetH.value - 106))
/**
 * 缩小按钮离面板底边多远:大面板顶边往下 40(按钮自身 26 高 → 顶边往下 14,
 * 下方再留 8px 才是输入框顶边)
 *
 * 下限 56:大面板被压得很矮时(横屏 + 键盘),按钮不能掉到下方按钮行上
 * (按钮行顶部距底 47)。
 */
const shrinkBtnBottom = computed(() => Math.max(56, sheetH.value - 40))

/** 扩大 / 缩小按钮是否显示(新版面板 + 未锁输入 + 已展开或内容到第三行) */
const expandToggleVisible = computed(
  () => newPanelActive.value && !inputLocked.value && (expanded.value || contentOverflow.value),
)

/**
 * 展开 / 收起大输入框
 *
 * **不动 DOM 结构**:输入框元素始终是同一个,只是被换了一套 CSS 定位 ——
 * 重建 DOM 会丢焦点、iOS 上会直接把键盘收掉,所以这里连 v-if 都不换位置。
 * 展开时内联高度交还给样式(铺满大面板);收起时立刻写回实测高度,
 * 免得等下一帧测量期间先闪一下单行高度。
 */
function setExpanded(next: boolean): void {
  if (next === expanded.value) return
  if (next && !newPanelActive.value) return
  expanded.value = next
  if (next) {
    // 表情 / 选项浮层都锚在小面板上,展开时先收起,免得叠在大输入框中间
    showEmojiPop.value = false
    if (chatStore.choicesOpen) chatStore.clearChoicesVisibility()
  }
  const el = isMobileInput.value ? mobileInputEl.value : inputEl.value
  if (el) el.style.height = next ? '' : `${fieldH.value || INPUT_BASE_H.value}px`
  // 刻意**不动** extraInputH:展开前为了"长到两行"已经让出的那一行保持原样,
  // 于是展开这一下聊天区一动不动 —— 大面板纯粹是压在上面的一层。
  if (!next) scheduleInputHeight()
}

/** 新版输入面板被关掉 / 切到桌面:展开态必须复位,否则大面板会一直留在屏幕上 */
watch(newPanelActive, (on) => {
  if (!on) setExpanded(false)
})

/**
 * 点按保护:动作放在 pointerdown 里做,并当场 preventDefault
 *
 * 为什么不等 click:触屏上按下按钮会先把焦点从输入框抢走,iOS 收到 blur 就会
 * 收起键盘 —— 展开 / 收起大输入框时键盘一收一弹非常难受。preventDefault 挡掉
 * 焦点转移,动作也就地执行;随后的 click 只作键盘(Enter / Space)兜底,
 * 500ms 内不重复执行(部分浏览器在 pointerdown 被取消后仍会派发 click)。
 */
let lastPointerAction = 0

function runOnPointer(ev: Event, run: () => void): void {
  ev.preventDefault()
  lastPointerAction = Date.now()
  run()
}

function runOnClick(run: () => void): void {
  if (Date.now() - lastPointerAction < 500) return
  run()
}

/** 扩大 / 缩小按钮(见 runOnPointer 注释) */
function onExpandPointerDown(ev: Event): void {
  runOnPointer(ev, () => setExpanded(!expanded.value))
}

function onExpandClick(): void {
  runOnClick(() => setExpanded(!expanded.value))
}

/** 展开态上方遮罩:点哪都收起 */
function onScrimPointerDown(ev: Event): void {
  runOnPointer(ev, () => setExpanded(false))
}

function onScrimClick(): void {
  runOnClick(() => setExpanded(false))
}

/**
 * 输入框内联高度
 *
 * 普通态 = 实测高度(没量过用基础高度);展开态 = 大面板里那一块的高度 ——
 * 两种都是内联 px,不做"清空内联高度让样式接管"的花活:Vue 只在自身 patch
 * 时重写内联样式,清空后若样式没跟上,就会看到输入框先缩回单行再弹回去。
 */
const fieldStyle = computed(() =>
  expanded.value
    ? { height: `${sheetFieldH.value}px` }
    : { height: `${fieldH.value || INPUT_BASE_H.value}px` },
)

/**
 * 输入框是否已因内容长高
 *
 * 长高后不再是胶囊形(见样式 &--grown):胶囊的圆角本来就是"高度的一半",
 * 一旦高度变了,再按 999px 去夹就会把四角拉成半圆跑道;改用固定圆角
 * (即单行时的那个半径),观感上就是从"胶囊"过渡成"圆角矩形"。
 */
const fieldGrown = computed(() => fieldH.value > INPUT_BASE_H.value)

/**
 * 量一次输入框内容高度,并上报"增高量"
 *
 * 量法:先把高度置为 auto 让元素按内容自然撑开,读 scrollHeight,**随即把量到的
 * 高度写回**。写回这一步不能省,也不能只清成空串 —— 清了内联高度就会退回样式里
 * 的固定高度(桌面 45 / 移动 36),而 Vue 只在自己那次 patch 时才重写内联样式,
 * 于是会出现"缩回单行 → 又长回来"的反复跳动;同一帧内量完即写,浏览器不会画出
 * 中间态,视觉上完全无感。
 *
 * scrollHeight 是元素自身坐标系的 CSS px(不经画布 zoom 缩放),与几何层同一口径,
 * 可直接相减。增高量交给几何层后,底部面板会跟着变高、聊天区可视高度同步变矮。
 */
function syncInputHeight(): void {
  const el = isMobileInput.value ? mobileInputEl.value : inputEl.value
  if (!el) return
  // 展开态:高度由样式(铺满大面板)接管,不量也不再上报增高量 ——
  // 浮层不该改变几何,否则聊天区会跟着往上跳
  if (expanded.value) return
  el.style.height = 'auto'
  const content = el.scrollHeight
  const next = Math.min(Math.max(INPUT_BASE_H.value, content), INPUT_MAX_H.value)
  el.style.height = `${next}px`
  if (next !== fieldH.value) fieldH.value = next
  // 内容高过封顶高度 = 已经写到第三行 → 该浮出「扩大」按钮了
  // (留 1px 容差:字号 × 1.4 的小数累计会让两行的实测值略高于上限)
  contentOverflow.value = newPanelActive.value && content > INPUT_MAX_H.value + 1
  setExtraInputH(next - INPUT_BASE_H.value)
}

/** 合并到下一帧再量:逐字输入时不必每敲一个字符量一次 */
let heightRaf = 0
function scheduleInputHeight(): void {
  if (heightRaf) return
  heightRaf = requestAnimationFrame(() => {
    heightRaf = 0
    syncInputHeight()
  })
}

// 移动端文本变化(桌面端由模板的 @input 触发)
watch(mobileText, () => scheduleInputHeight())

// 换形态(桌面 contenteditable ↔ 移动 textarea)与宽度变化都会改变折行,重量一次
watch([isMobileInput, () => geom.value.scrollW], () => scheduleInputHeight())

/** 桌面端输入事件:记账 + 重量 */
function onInput(): void {
  reportDraft()
  scheduleInputHeight()
}

/** 隐藏的图片文件选择框(上传图片按钮触发) */
const fileInput = ref<HTMLInputElement | null>(null)

/** 是否正在等待 AI 响应 */
const isResponding = computed(() => isAiResponding.value)

/** 当前是否为群聊会话 */
const isGroupChat = computed(() => chatStore.activeIsGroup)

/**
 * 群聊「暂停 / 恢复对话」按钮是否显示
 *
 * 位置只有这一处(与单聊"停止"同款的圆形按钮),聊天区末尾的旧胶囊已删除。
 * 判据取自 store 的 activeShowRun(非指定模式的群聊一律显示,与玩家身份无关)。
 */
const showGroupRun = computed(
  () => chatStore.activeIsGroup && chatStore.activeShowRun,
)

/** 暂停 / 恢复的唯一实现(与旧版胶囊共用同一份文案与点击语义) */
const {
  running: groupRunning,
  runLabel,
  onToggleRun,
} = useGroupRunControl((text) => emit('hint', text))

/**
 * 旁观模式且对话**正在生成**中(此时必须先「暂停对话」才能给新话题)
 *
 * 判据用 groupChat.busy(本回合是否真的在跑),而不是持久化的 groupRunning:
 * 页面刚重开时 groupRunning 可能仍为 true 但并没有任何回合在跑,
 * 那种情况下输入框不该被锁住。
 */
const observerRunning = computed(
  () => isObserverGroup.value && groupChat.busy.value,
)

/**
 * 输入 / 发送按钮是否锁定
 *
 * - 单聊:AI 回复期间照旧锁定(保持原有行为)
 * - 群聊:AI 回复期间**不锁**。智能模式会持续产出,一旦锁住输入玩家就没法
 *   插话;而"发消息"本身就是打断当前回合的手段,必须始终可用。
 * - 旁观模式且对话进行中:锁定,并提示先暂停 —— 避免玩家在角色们正说着的时候
 *   又塞新话题进去。
 */
const inputLocked = computed(() => {
  if (observerRunning.value) return true
  if (isGroupChat.value) return false
  return isResponding.value
})

/** 表情弹窗是否展开 */
const showEmojiPop = ref(false)

// ---- AI 推荐选项面板(纯 UI) -------------------------------------------------
/** 待选推荐项 */
const pendingChoices = computed(() => chatStore.pendingChoices)
/** 面板是否展开 */
const choicesOpen = computed(() => chatStore.choicesOpen)

/**
 * 群聊是否处于「指定模式」
 *
 * 指定模式的语义是"我点名谁、谁回复",与"我的身份"无关 ——
 * 所以它比旁观模式优先。
 */
const isAssignGroup = computed(
  () => chatStore.activeIsGroup && chatStore.activeSpeakMode === 'assign',
)

/**
 * 是否走"旁观 → 给出话题"的流程
 *
 * 此时"我"不参与对话,只能投喂话题:底部只保留话题输入框 + 一颗发送按钮
 * (与普通对话同一颗圆形图标按钮,不另做文字按钮),
 * 图片 / 表情 / 推荐回复按钮全部隐藏。
 *
 * 注意这里要**排除指定模式**:指定模式下发言模式已经明确指定了回复人,
 * 发消息就该让对方回一条,不应再被旁观分支拦掉(否则会出现"点了指定发言
 * 按钮才回复、直接发消息不回复")。
 */
const isObserverGroup = computed(
  () =>
    chatStore.activeIsGroup &&
    chatStore.activeIsObserver &&
    !isAssignGroup.value,
)
/** 面板最大高度:以消息区高度为上限,避免选项多时盖满整个聊天区 */
const choicePanelMaxH = computed(() => geom.value.scrollH)

// ---- 表情弹窗网格(桌面 16 列 60px 格;放不下时退小格子,列数按可用宽度自适应) ----
/** 弹窗四周内边距(px) */
const POP_PAD = 24
/** 单格边长档位(px):宽版(桌面设计稿)/ 窄版(手机) */
const POP_CELL_WIDE = 60
const POP_CELL_NARROW = 36
/** 格间距档位(px) */
const POP_GAP_WIDE = 16
const POP_GAP_NARROW = 10

/**
 * 宽版网格(16 列 × 60px 格 + 16px 间距)连同左右内边距所需的最小面板宽(px)
 *
 * 1248 = 16×60 + 15×16 + 2×24。
 * 面板比这更窄时若仍按 16 列排版,固定宽 1200px 的网格会撑出弹窗,被
 * overflow-x:hidden 裁掉左右两端的表情(平板 / 横屏手机必现,桌面
 * 因 panelWidth 固定 1319 而看不出问题)。
 * 所以判据必须是"面板放不放得下",不能是"是不是手机"。
 */
const POP_WIDE_MIN_W = 16 * POP_CELL_WIDE + 15 * POP_GAP_WIDE + POP_PAD * 2

/** 是否窄屏弹窗(放不下宽版网格时退回小格子) */
const isNarrowPop = computed(() => geom.value.panelWidth < POP_WIDE_MIN_W)

/** 单格边长(px) */
const POP_CELL = computed(() => (isNarrowPop.value ? POP_CELL_NARROW : POP_CELL_WIDE))
/** 格间距(px) */
const POP_GAP = computed(() => (isNarrowPop.value ? POP_GAP_NARROW : POP_GAP_WIDE))

/**
 * 每行表情数
 *
 * n 列占宽 = n×格宽 + (n-1)×间距 = n×(格宽+间距) - 间距,
 * 取满足"占宽 ≤ 可用宽度"的最大列数,并封顶 16 列。
 * 桌面 1319px → 16 列(与设计稿一致);手机竖屏 → 自然落在 7 列。
 */
const POP_COLS = computed(() => {
  const usable = Math.max(0, geom.value.panelWidth - POP_PAD * 2)
  const unit = POP_CELL.value + POP_GAP.value
  const fit = Math.floor((usable + POP_GAP.value) / unit)
  return Math.max(1, Math.min(16, fit))
})
/** 行数 */
const POP_ROWS = computed(() => Math.ceil(EMOJIS.length / POP_COLS.value))

/**
 * 表情弹窗高度(px):上下边距 + 行×格高 + 行距(不出现滚动条)
 */
const POP_H_EMOTICON = computed(
  () => POP_PAD * 2 + POP_ROWS.value * POP_CELL.value + (POP_ROWS.value - 1) * POP_GAP.value,
)

/** 表情弹窗样式:紧贴面板顶边向上延伸,与面板同宽 */
const emojiPopStyle = computed(() => ({
  left: '0px',
  top: `-${POP_H_EMOTICON.value}px`,
  width: `${geom.value.panelWidth}px`,
  height: `${POP_H_EMOTICON.value}px`,
}))

/** 表情网格样式(列数/格宽/间距随宽度变化,inline 覆盖 scoped CSS 默认值) */
const emojiGridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${POP_COLS.value}, ${POP_CELL.value}px)`,
  columnGap: `${POP_GAP.value}px`,
  rowGap: `${POP_GAP.value}px`,
}))

/** 序列化输入框内容为纯文本(表情 <img> → [sns_emoji_xxx] token;桌面 contenteditable) */
function serializeInput(): string {
  if (!inputEl.value) return ''
  return htmlToEmojiText(inputEl.value.innerHTML)
}

// ---- 草稿实时上报(用量面板据此预估"下一次请求"的上下文体积) ----------------
/**
 * 把当前输入框内容上报给 usage store
 *
 * 面板据此把"还没发出去的这段字"也算进上下文占用,不必等发送就能看到
 * 下一次请求的体积 —— 这是面板"实时"的主要来源之一。
 * 直接改 innerHTML 不会触发 input 事件,故清空时由 clearInput 手动清零。
 */
function reportDraft() {
  usageStore.setDraft(isMobileInput.value ? mobileText.value : serializeInput())
}

/** 移动端草稿:走 v-model,值变化即上报 */
watch(mobileText, () => {
  if (isMobileInput.value) reportDraft()
})

/** 桌面 ↔ 移动切换输入控件时,用当前实际内容刷新一次(否则面板留着另一侧的旧值) */
watch(isMobileInput, reportDraft)

/** 清空输入框(桌面清 innerHTML / 移动端清 v-model) */
function clearInput() {
  if (isMobileInput.value) {
    mobileText.value = ''
  } else if (inputEl.value) {
    inputEl.value.innerHTML = ''
  }
  // 直接改 innerHTML 不触发 input 事件,需手动清零草稿(否则面板一直显示旧体积)
  usageStore.setDraft('')
  // 发送后收起大输入框:发完就该回到普通形态
  setExpanded(false)
  // 同理:清空后输入框要缩回单行(移动端的 watch 会自己触发,桌面端靠这里)
  scheduleInputHeight()
}

/** 发送消息 */
async function onSend() {
  const text = isMobileInput.value ? mobileText.value.trim() : serializeInput().trim()
  if (!text || inputLocked.value) return

  // 旁观模式(且非指定模式):底部按钮语义是「给出话题」。
  // 话题只落成一条我方消息并写入后端会话状态,不触发回复;
  // 之后由聊天区末尾的「开启对话」胶囊推进。
  //
  // 顺序要紧:isObserverGroup 已排除指定模式,所以指定模式会落到下面的
  // 群聊分支,由群聊服务让被点名的角色自动回复。
  if (isObserverGroup.value) {
    clearInput()
    await groupChat.giveTopic(text)
    return
  }

  // 群聊:交给群聊服务,按"聊天形式"推进。
  // 必须绕过 sendAndWaitForAi —— 单聊链路用会话名当角色名,而群聊的会话名
  // 是群名,查不到任何人设;群聊还必须带上"每条是谁说的"。
  if (chatStore.activeIsGroup) {
    clearInput()
    await groupChat.sendMessage(text)
    return
  }

  // 检查 API 配置
  if (!settingsStore.isApiConfigured) {
    emit('open-settings')
    return
  }

  clearInput()

  try {
    await sendAndWaitForAi(text)
  } catch {
    // 错误已在 useAiChat 中处理
  }
}

/** 中止 AI 响应 */
function onAbort() {
  abort()
}

/**
 * 选择图片后:读取为 dataURL,按自然尺寸等比计算显示尺寸(不超过 CHAT_IMAGE 上限,
 * 小图不放大),作为图片消息发送并触发 AI 回复。
 *
 * AI 响应中或 API 未配置时不发送图片。读取完成后重置 input.value,
 * 允许连续选择同一文件。
 */
function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  // v5: 图片大小与格式限制
  // 大小: 超过 5MB 阻止发送
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024
  if (file.size > MAX_IMAGE_BYTES) {
    alert('图片过大，请选择 5MB 以下的图片')
    input.value = ''
    return
  }
  // 格式: 仅允许 png / jpeg / webp
  const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    alert('不支持的图片格式（仅支持 PNG / JPG / WebP）')
    input.value = ''
    return
  }

  // 输入被锁定(单聊回复中 / 旁观模式对话进行中)时不发送图片
  if (inputLocked.value) {
    input.value = ''
    return
  }

  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = reader.result
    if (typeof dataUrl !== 'string') return
    const img = new Image()
    img.onload = async () => {
      const nw = img.naturalWidth || CHAT_IMAGE.w
      const nh = img.naturalHeight || CHAT_IMAGE.h
      if (nw <= CHAT_IMAGE.w && nh <= CHAT_IMAGE.h) {
        chatStore.sendImage(dataUrl, nw, nh)
      } else {
        const scale = Math.min(CHAT_IMAGE.w / nw, CHAT_IMAGE.h / nh)
        chatStore.sendImage(dataUrl, Math.round(nw * scale), Math.round(nh * scale))
      }
      input.value = ''

      // 群聊:图片同样是"玩家说的一句话",发完按发言模式让成员接话。
      // 图片数据归为玩家类(与单聊一致);AI 永远不会发图。
      if (chatStore.activeIsGroup) {
        // 先打断正在进行的回合(图片同样是一次"玩家发言")
        groupChat.abort()
        await groupChat.runTurn({ newTurn: true })
        return
      }

      // 检查 API 配置,触发 AI 回复
      if (!settingsStore.isApiConfigured) {
        emit('open-settings')
        return
      }
      try {
        await respondAfterImage()
      } catch {
        // 错误已在 useAiChat 中处理
      }
    }
    img.onerror = () => {
      devWarn('[ChatInput] 图片解码失败,可能是损坏或不受支持的格式')
      input.value = ''
    }
    img.src = dataUrl
  }
  reader.readAsDataURL(file)
}

/** 触发文件选择(图片按钮点击) */
function openFilePicker() {
  fileInput.value?.click()
}

/**
 * 点击表情:聚焦输入框并在光标处插入表情(紧跟在文字后面)
 *
 * 表情输出内联 em 尺寸(高度 1em、宽度按原图宽高比),随输入框字号
 * 自动缩放且保持真实比例。
 *
 * 桌面(contenteditable):用 Range API 插入表情
 *   - 有选区且在输入框内:删除选区内容 → 插入表情片段 → 光标移到表情后
 *   - 无选区或选区不在输入框内:追加到输入框末尾
 * 移动端(textarea):在光标处插入表情 token(表情在发送时显示为图片)
 */
function insertEmoji(emoji: Emoji) {
  if (isMobileInput.value) {
    const el = mobileInputEl.value
    if (!el) return
    el.focus()
    const token = emoji.token
    const start = el.selectionStart ?? mobileText.value.length
    const end = el.selectionEnd ?? start
    mobileText.value =
      mobileText.value.slice(0, start) + token + mobileText.value.slice(end)
    // 光标移到插入内容之后
    requestAnimationFrame(() => {
      const pos = start + token.length
      el.setSelectionRange(pos, pos)
    })
    return
  }

  const el = inputEl.value
  if (!el) return
  el.focus()
  const imgHtml = emojiImgHtml(emoji.token, emoji.src)
  const sel = window.getSelection()
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0)
    range.deleteContents()
    const tmp = document.createElement('div')
    tmp.innerHTML = imgHtml
    const frag = document.createDocumentFragment()
    while (tmp.firstChild) frag.appendChild(tmp.firstChild)
    range.insertNode(frag)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  } else {
    el.insertAdjacentHTML('beforeend', imgHtml)
  }
  // 直接改 DOM 不触发 input 事件:草稿与输入框高度都手动同步一次
  reportDraft()
  scheduleInputHeight()
}

/** 切换表情弹窗展开/收起 */
function toggleEmojiPop() {
  // 与推荐面板互斥:展开表情时收起推荐面板
  if (!showEmojiPop.value && chatStore.choicesOpen) chatStore.clearChoicesVisibility()
  showEmojiPop.value = !showEmojiPop.value
}

/** 切换推荐面板(与表情弹窗互斥;无选项时也可展开以查看空状态) */
async function toggleChoicesPop() {
  // 「AI 推荐回复」实验性功能关闭时,按钮本就不渲染,这里再兜一层
  if (!settingsStore.choicesEnabled) return

  // 关闭面板:记下"本次对话玩家主动关过",之后不再自动弹出
  if (choicesOpen.value) {
    chatStore.toggleChoices()
    chatStore.setChoicesSuppressed(true)
    return
  }

  showEmojiPop.value = false
  chatStore.toggleChoices()

  // 群聊:推荐改为按需拉取 —— 先把面板打开(已有内容就先显示),再拉最新的一批。
  // 刻意**每次都拉**:推荐要贴合"刚刚发生的对话",复用上一次的结果会出现
  // "显示的还是几轮前那几条"甚至"显示的是别的会话的推荐"。
  // 单聊:同一套按需拉取(走网关 /chat/suggestions),交互与群聊完全一致。
  if (chatStore.activeIsGroup) {
    await groupChat.fetchSuggestions()
  } else {
    await fetchSuggestions()
  }
}
// 群聊限速 / 生成失败的提示:转成 UI 提示条。
// 只在该提示属于**当前正在看的会话**时才弹 —— 群聊回合是后台继续跑的,
// 玩家切到单聊后又冒出一个"群聊生成失败"会很莫名。
watch(
  () => groupChat.notice.value,
  (msg) => {
    if (!msg) return
    const owner = groupChat.noticeSub.value
    if (owner !== null && chatStore.activeSub !== owner) return
    emit('hint', msg)
  },
)

// 设置里刚把「AI 推荐回复」关掉时,已展开的面板立即收起
watch(
  () => settingsStore.choicesEnabled,
  (on) => {
    if (!on && chatStore.choicesOpen) chatStore.clearChoicesVisibility()
  },
)

/**
 * 点击某条推荐 → 作为用户消息发出
 *
 * 与手打发送走完全同一条链路;刻意不清空输入框草稿。
 */
async function onPickChoice(label: string) {
  if (inputLocked.value) return
  if (chatStore.activeSub === null) return
  chatStore.clearPendingChoices()

  // 群聊:点推荐等同于玩家发一句话,必须走群聊服务;
  // 走 sendAndWaitForAi 会用会话名(群名)当角色名去请求单聊网关。
  if (chatStore.activeIsGroup) {
    await groupChat.sendMessage(label)
    return
  }

  if (!settingsStore.isApiConfigured) {
    emit('open-settings')
    return
  }
  try {
    await sendAndWaitForAi(label)
  } catch {
    // 错误已在 useAiChat 中处理
  }
}

/**
 * 点击面板外部关闭**表情弹窗**
 *
 * 规则:表情弹窗展开时,点击除弹窗与表情触发按钮以外的任意位置即收起。
 * 用 pointerdown(先于 click 触发):点到外面任意元素时,弹窗先收起,
 * 按钮自身的 click 动作照常执行。
 *
 * ⚠️ 推荐选项面板**刻意不在这里关闭**:它是"按下去就一直显示"的常驻浮层,
 * 点聊天区/空白处都不收起,只有再点一次选项按钮才关(与表情弹窗行为不同)。
 */
function onDocPointerDown(event: PointerEvent) {
  const target = event.target as Node
  if (!(target instanceof Element)) return
  if (
    target.closest('.chat-input__pop') ||
    target.closest('.is-emoji-trigger')
  ) {
    return
  }
  if (showEmojiPop.value) {
    showEmojiPop.value = false
  }
}

onMounted(() => document.addEventListener('pointerdown', onDocPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown))

/**
 * 键盘事件:
 * - Enter(无修饰键):发送
 * - Ctrl/Cmd/Shift + Enter:插入换行(移动端 textarea 原生支持 Shift+Enter)
 */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter') return
  event.preventDefault()
  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    // 换行: 不手动拼字符串, 让浏览器原生在光标处插入 

    // (原生路径无 DOM 竞态; 桌面 contenteditable 走 execCommand)
    if (isMobileInput.value) {
      const el = mobileInputEl.value
      if (el) {
        el.focus()
        document.execCommand('insertLineBreak')
      }
    } else {
      document.execCommand('insertText', false, String.fromCharCode(10))
    }
    return
  }
  onSend()
}

/** 粘贴:仅插入纯文本(移动端 textarea 原生纯文本粘贴,无需处理) */
function onPaste(event: ClipboardEvent) {
  if (isMobileInput.value) return
  event.preventDefault()
  const text = event.clipboardData?.getData('text/plain') ?? ''
  document.execCommand('insertText', false, text)
}
</script>

<template>
  <PanelShell
    :height="PANEL_H"
    :top="panelTop"
    :class="['chat-input', {
      'chat-input--mobile': geom.stripSegmented,
      'chat-input--expanded': expanded,
    }]"
  >    <!-- 隐藏的图片文件选择框 -->
    <input
      ref="fileInput"
      class="chat-input__file"
      type="file"
      accept="image/*"
      @change="onFileChange"
    />

    <!-- 展开态:上方剩余区域(约 1/3 屏)的半透明遮罩,点它收起大输入框 ——
         与右上角的「缩小」按钮等价。
         mousedown / touchstart 都 preventDefault:收起后焦点仍留在输入框上,
         键盘不会被这一下点掉(触屏上按钮默认会抢走焦点)。 -->
    <div
      v-if="expanded"
      class="chat-input__scrim"
      :style="{ bottom: `${sheetH}px`, height: `${scrimH}px` }"
      @pointerdown="onScrimPointerDown"
      @click="onScrimClick"
    ></div>

    <!-- 展开态:2/3 屏的大面板(纯背景层)。
         内容是下面那几个**原有元素** —— 输入框与按钮都不换 DOM 位置,
         只是被一套新定位撑开:iOS 上重建 DOM 会把键盘直接收掉。 -->
    <div v-if="expanded" class="chat-input__sheet" :style="{ height: `${sheetH}px` }"></div>

    <!-- 胶囊输入框:移动端原生 textarea(夸克等对 contenteditable 焦点支持差) /
         桌面端 contenteditable(支持表情富文本) -->
    <textarea
      v-if="isMobileInput"
      ref="mobileInputEl"
      v-model="mobileText"
      class="chat-input__field chat-input__field--mobile"
      :class="{ 'chat-input__field--grown': fieldGrown }"
      :style="fieldStyle"
      rows="1"
      :aria-label="isObserverGroup ? '话题输入框' : '发消息输入框'"
      :placeholder="observerRunning ? '对话进行中，暂停后可输入新话题' : (isObserverGroup ? '请先输入话题并发送' : '发消息')"
      :disabled="inputLocked"
      @keydown="onKeydown"
    ></textarea>
    <div
      v-else
      ref="inputEl"
      class="chat-input__field"
      :class="{ 'chat-input__field--grown': fieldGrown }"
      :style="fieldStyle"
      :contenteditable="!inputLocked"
      role="textbox"
      :aria-label="isObserverGroup ? '话题输入框' : '发消息输入框'"
      :data-placeholder="observerRunning ? '对话进行中，暂停后可输入新话题' : (isObserverGroup ? '请先输入话题并发送' : '发消息')"
      @keydown="onKeydown"
      @input="onInput"
      @paste="onPaste"
    ></div>

    <!-- 发送 / 停止:靠 CSS order 排在按钮组之后
         (视觉顺序 = [输入框][其余按钮][发送];展开态另有定位)。
         AI 响应中:显示停止按钮(群聊不显示 —— 群聊的响应由「暂停对话」控制) -->
    <button
      v-if="isResponding && !isGroupChat"
      class="chat-input__btn chat-input__btn--stop chat-input__send"
      type="button"
      aria-label="停止"
      @click="onAbort"
    >
      <span class="chat-input__stop-icon"></span>
    </button>
    <!-- 正常状态:显示发送按钮(旁观模式的群聊沿用同一颗 — 只是语义变成
         "把输入框内容作为话题发给群里",外观不再另做文字按钮) -->
    <button
      v-else
      class="chat-input__btn chat-input__send"
      type="button"
      :aria-label="isObserverGroup ? '给出话题' : '发送'"
      @click="onSend"
    >
      <img class="chat-input__btn__icon" :src="MATERIALS.editBtnChat" alt="" />
    </button>

    <!-- 其余按钮组(图片 / 表情 / 选项 / 群聊开关);
         展开态下整组移到最下方一行,见 chat-input--expanded -->
    <div class="chat-input__btns">
      <!-- 图片按钮:上传图片并发送(旁观模式的群聊里隐藏) -->
      <button
        v-if="!isObserverGroup"
        class="chat-input__btn"
        type="button"
        aria-label="上传图片"
        :disabled="inputLocked"
        @click="openFilePicker"
      >
        <img class="chat-input__btn__icon" :src="MATERIALS.editBtnPotential" alt="" />
      </button>
      <!-- 表情按钮:弹出表情选择网格(旁观模式的群聊里隐藏) -->
      <button
        v-if="!isObserverGroup"
        class="chat-input__btn is-emoji-trigger"
        type="button"
        aria-label="表情"
        :disabled="inputLocked"
        @click="toggleEmojiPop"
      >
        <img class="chat-input__btn__icon" :src="MATERIALS.editBtnEmoticon" alt="" />
      </button>
      <!-- 选项按钮:展开 AI 推荐选项面板(位于表情与发送之间)。
           按下即**常驻显示**选项浮层:点聊天区/空白处都不会收起,只有再点一次
           本按钮才关。刻意不在"暂无选项"时禁用 —— 无选项时面板显示空状态提示。
           「实验性功能 → AI 推荐回复」关闭时,该按钮完全不出现。 -->
      <button
        v-if="settingsStore.choicesEnabled && !isObserverGroup"
        class="chat-input__btn is-choices-trigger"
        type="button"
        :aria-label="pendingChoices.length > 0 ? `推荐选项（${pendingChoices.length} 条）` : '推荐选项'"
        :aria-pressed="choicesOpen"
        :disabled="inputLocked"
        @click="toggleChoicesPop"
      >
        <img class="chat-input__btn__icon" :src="MATERIALS.iconEventsOverview" alt="" />
      </button>
      <!-- 群聊:开启 / 暂停 / 恢复对话(与单聊"停止"同款圆形按钮 ——
           生成中显示停止方块,暂停/未开始时显示播放三角)。
           旁观模式下图片/表情/推荐都隐藏,这颗是唯一控件,必须始终可点。 -->
      <button
        v-if="showGroupRun"
        class="chat-input__btn chat-input__btn--stop"
        type="button"
        :aria-label="runLabel"
        :title="runLabel"
        @click="onToggleRun"
      >
        <span v-if="groupRunning" class="chat-input__stop-icon"></span>
        <span v-else class="chat-input__play-icon"></span>
      </button>
    </div>

    <!-- 扩大 / 缩小按钮(仅新版输入面板 + 移动端):
         内容写到第三行时浮在按钮组上方;展开后移到右上角变成「缩小」。
         同样 preventDefault:点它不能把键盘点掉。 -->
    <button
      v-if="expandToggleVisible"
      class="chat-input__expand"
      :class="{ 'chat-input__expand--shrink': expanded }"
      type="button"
      :aria-label="expanded ? '收起输入框' : '扩大输入框'"
      :aria-pressed="expanded"
      :style="expanded ? { bottom: `${shrinkBtnBottom}px` } : undefined"
      @pointerdown="onExpandPointerDown"
      @click="onExpandClick"
    >
      <span class="chat-input__expand-icon"></span>
    </button>

    <!-- 表情弹窗:紧贴面板顶边从下到上展开,与面板同宽 -->
    <Transition name="chat-input-pop">
      <div v-if="showEmojiPop" class="chat-input__pop" :style="emojiPopStyle">
        <!-- 表情选择网格:点击在输入框光标处插入(列数/格宽由 emojiGridStyle 响应式注入) -->
        <div class="chat-input__emoji-grid" :style="emojiGridStyle">
          <button
            v-for="e in EMOJIS"
            :key="e.token"
            class="chat-input__emoji-cell"
            type="button"
            @click="insertEmoji(e)"
          >
            <img class="chat-input__emoji-img" :src="e.src" alt="" />
          </button>
        </div>
      </div>
    </Transition>
    <!-- AI 推荐选项面板:覆盖在输入面板上方向上展开,
         消息区布局不动(与表情弹窗同一套定位思路;两者互斥只开一个) -->
    <Transition name="choice-pop">
      <ChoicePanel
        v-if="settingsStore.choicesEnabled && choicesOpen"
        :choices="pendingChoices"
        :max-height="choicePanelMaxH"
        @pick="onPickChoice"
      />
    </Transition>
  </PanelShell>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

.chat-input {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 24px;
  box-sizing: border-box;
  pointer-events: none;
  // 单行时输入框在面板里上下各留这么多(桌面 (80-45)/2);输入框长高后
  // 按钮改为贴底对齐,底部留白仍用这个值 —— 两者在单行时完全等价,
  // 所以视觉与改动前一致,只是多行时按钮不会飘到面板中间。
  --field-inset: 17.5px;

  // 移动端窄屏:左右 padding 与按钮间距收窄
  @media (max-width: 768px) {
    padding: 0 12px;
    gap: 10px;
  }

  // 隐藏的图片选择框
  &__file {
    display: none;
  }

  // 胶囊输入框样式
  &__field {
    flex: 1;
    min-width: 0;
    height: 45px;
    line-height: 1.4;
    white-space: pre-wrap;
    overflow-x: hidden;
    overflow-y: auto;
    border: none;
    // 单行时是胶囊(999px 会被高度夹成"高度的一半");
    // 长高后换成固定圆角 = 单行胶囊的那个半径,于是变成圆角矩形而不是跑道形。
    // 半径与"--grown"的取值都在这里,移动端在 &--mobile 里各改一处。
    --field-radius: 22.5px; // = 单行高度 45 / 2
    border-radius: 999px;
    background: $color-btn-bg;
    color: #2a2a2a;
    font-family: $font-bubble;
    font-size: 20.88px;
    padding: 8px 24px;
    box-sizing: border-box;
    outline: none;
    user-select: text;
    word-break: break-word;
    scrollbar-width: none;
    pointer-events: auto;

    &:empty::before {
      content: attr(data-placeholder);
      color: rgba(42, 42, 42, 0.5);
      pointer-events: none;
      user-select: none;
    }

    &[contenteditable="false"] {
      opacity: 0.5;
      pointer-events: none;
    }

    // 已长高:圆角矩形(圆角 = 单行胶囊的半径,四角大小与原来一致)
    &--grown {
      border-radius: var(--field-radius);
    }

    // 移动端 textarea 形态:textarea 无 :empty 伪类,用原生 placeholder;
    // 去掉默认外观/缩放,垂直居中微调,支持多行滚动
    &--mobile {
      display: block;
      resize: none;
      overflow-y: auto;
      padding-top: 8px;
      padding-bottom: 8px;
      appearance: none;
      -webkit-appearance: none;

      &::placeholder {
        color: rgba(42, 42, 42, 0.5);
      }

      &:disabled {
        opacity: 0.5;
        pointer-events: none;
      }
    }
  }

  // 按钮组
  &__btns {
    display: flex;
    align-items: center;
    gap: 16px;
    pointer-events: none;
  }

  // 圆形按钮:45px 圆形(所有场景统一,旁观模式同样沿用这一颗)
  &__btn {
    width: 45px;
    height: 45px;
    border: none;
    border-radius: 50%;
    background: $color-btn-bg;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
    position: relative;
    pointer-events: auto;

    // 悬停遮罩:圆角用 inherit 跟随按钮自身的 border-radius
    &::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: $color-hover-overlay-gray;
      opacity: 0;
      transition: opacity 0.15s ease;
    }

    &:hover::after {
      opacity: 1;
    }

    &:disabled {
      opacity: 0.5;
      pointer-events: none;
      cursor: default;
    }

    // 图标:等比铺满按钮(留 8px 边距)
    &__icon {
      position: absolute;
      inset: 8px;
      width: calc(100% - 16px);
      height: calc(100% - 16px);
      object-fit: contain;
      filter: brightness(0.267);
      pointer-events: none;
      user-select: none;
    }

    // 停止按钮:深色圆形 + 白色方形停止图标
    &--stop {
      background: #c44;

      &::after {
        background: rgba(0, 0, 0, 0.15);
      }
    }
  }

  // 停止图标:白色小方形
  &__stop-icon {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 14px;
    height: 14px;
    background: #fff;
    border-radius: 2px;
  }

  // 播放图标:白色小三角(群聊「开启 / 恢复对话」用,与停止图标同一套语言)
  &__play-icon {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-46%, -50%);
    width: 0;
    height: 0;
    border-style: solid;
    border-width: 8px 0 8px 13px;
    border-color: transparent transparent transparent #fff;
  }

  // ---- 单行布局(默认形态:桌面 / 移动端一致) ------------------------------
  // 视觉顺序 = [输入框][其余按钮][发送]:DOM 里发送按钮紧跟输入框,这里用
  // order 把它排到按钮组之后。
  &__btns {
    order: 1;
  }

  &__send {
    order: 2;
  }

  // 输入框长高后:圆形按钮贴底(与最后一行文字齐平)。
  // 单行场景该值与 align-items:center 等价,不改变原观感。
  // 展开态另说:那一套定位在下面 chat-input--expanded 里整块覆盖。
  .chat-input__btns,
  .chat-input__send {
    align-self: flex-end;
    margin-bottom: var(--field-inset);
  }

  // ---- 展开态:2/3 屏大输入框(新版输入面板 + 移动端) ----------------------
  //
  // 定位基准是**底部输入面板自身**:面板贴屏幕底(软键盘弹出时贴键盘上沿),
  // 所谓"往上展开 2/3 屏"就是让大面板从面板底边往上长 2/3 可视高 ——
  // 它是一层浮层,几何层一点没动,所以**上方的聊天内容不会被顶上去**。
  // (这与"输入框长到两行"是两回事:那种情况几何层会同步把聊天区抬高一行,
  //  否则末尾消息会被面板盖住。)
  //
  // 内容全部复用原有元素、只换定位 —— DOM 一个都没重建(见模板注释)。
  // 位置与高度由内联样式给出(见 sheetH / scrimH):这里只管观感
  &__scrim {
    position: absolute;
    left: 0;
    right: 0;
    background: rgba(0, 0, 0, 0.42);
    pointer-events: auto;
    animation: chat-input-scrim-in 0.18s ease-out both;
  }

  @keyframes chat-input-scrim-in {
    from { opacity: 0; }
  }

  &__sheet {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    background: $color-panel-bg;
    pointer-events: auto;
    animation: chat-input-sheet-in 0.2s ease-out both;

    // 顶部羽化:与 PanelShell 的面板顶边同一套做法,免得大面板上沿是硬切
    &::before {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      bottom: 100%;
      height: 20px;
      background: $color-panel-bg;
      -webkit-mask-image: linear-gradient(to top, #000 0%, transparent 100%);
      mask-image: linear-gradient(to top, #000 0%, transparent 100%);
      pointer-events: none;
    }
  }

  @keyframes chat-input-sheet-in {
    from { transform: translateY(28px); }
  }

  &.chat-input--expanded {
    // 输入框:铺满大面板上半部分(顶部让开缩小按钮那一行,底部让开按钮行)
    .chat-input__field {
      position: absolute;
      left: 14px;
      right: 14px;
      // 底边:面板底边往上 58px(让开下面的按钮行);高度由内联样式给
      bottom: 58px;
      width: auto;
      padding: 12px 16px;
      border-radius: var(--field-radius);
      font-size: 16px;
      line-height: 1.4;
    }

    // 三个小按钮:整组移到最下方一行(靠左)
    .chat-input__btns {
      position: absolute;
      left: 14px;
      bottom: 11px;
      order: 0;
      align-self: auto;
      margin-bottom: 0;
    }

    // 发送:最下方一行靠右
    .chat-input__send {
      position: absolute;
      right: 14px;
      bottom: 11px;
      order: 0;
      align-self: auto;
      margin-bottom: 0;
    }
  }

  // ---- 扩大 / 缩小按钮 -----------------------------------------------------
  // 内容写到第三行时浮在按钮组上方(面板刚长了一行,那里正好是空的);
  // 展开后移到右上角变大面板的「缩小」按钮。
  &__expand {
    position: absolute;
    // 与发送按钮右缘对齐(面板内边距 12px)
    right: 12px;
    // 面板"长到两行"时高 = 50 + 表框线缺口 22.4 − 框线 1.5 = 70.9,
    // 按钮行(36 高、距底 7)从 27.9 起。22px 的按钮放在 3 处 →
    // 占 3..25,与按钮行留 2.9px 空隙(26px 时占 3..29,会压到按钮行)。
    top: 3px;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 7px;
    // 半透明:面板底色是深灰 #3c3b39,这里用一层很淡的白
    background: rgba(255, 255, 255, 0.16);
    color: rgba(240, 238, 238, 0.85);
    pointer-events: auto;
    cursor: pointer;
    transition: background 0.15s ease;

    // 命中区补偿(与设置面板的关闭/退出按钮同一套):视觉块只有 22px,
    // 用一圈透明伪元素把可点区域撑到 32×32,外观完全不变
    &::after {
      content: '';
      position: absolute;
      inset: -5px;
    }

    &:active { background: rgba(255, 255, 255, 0.3); }

    // 展开后:右上角(大面板顶边往下 10px,具体 bottom 由内联样式给),块也大一圈
    &--shrink {
      top: auto;
      right: 14px;
      width: 26px;
      height: 26px;
      background: rgba(255, 255, 255, 0.22);
    }
  }

  &__expand-icon {
    position: absolute;
    inset: 0;

    // 两个实心三角:上三角朝上 + 下三角朝下 = 向外撑开(可扩大)
    &::before,
    &::after {
      content: '';
      position: absolute;
      left: 50%;
      width: 0;
      height: 0;
      border-style: solid;
      border-color: transparent;
      transform: translateX(-50%);
    }

    &::before {
      top: 4px;
      border-width: 0 4px 4px 4px;
      border-bottom-color: currentColor;
    }

    &::after {
      bottom: 4px;
      border-width: 4px 4px 0 4px;
      border-top-color: currentColor;
    }

    // 展开态反过来:两个三角朝内收 = 可缩小
    .chat-input__expand--shrink & {
      &::before {
        top: 4px;
        border-width: 4px 4px 0 4px;
        border-top-color: currentColor;
        border-bottom-color: transparent;
      }

      &::after {
        bottom: 4px;
        border-width: 0 4px 4px 4px;
        border-bottom-color: currentColor;
        border-top-color: transparent;
      }
    }
  }

  // 表情弹窗:紧贴面板顶边向上延伸,与面板同宽(圆角矩形,底部直角贴合面板)
  &__pop {
    position: absolute;
    background: #dedcdc;
    border-radius: 16px 16px 0 0;
    z-index: 11;
    overflow: hidden;

    // 背景装饰图:原始尺寸原样贴角,不拉伸不铺满
    &-bg {
      position: absolute;
      pointer-events: none;
      user-select: none;

      &--tl {
        left: 0;
        top: 0;
      }

      &--br {
        right: 0;
        bottom: 0;
      }
    }
  }

  // 表情选择网格:每行 16 个 60px 格,超出面板高度时可滚动
  &__emoji-grid {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 24px;
    box-sizing: border-box;
    display: grid;
    grid-template-columns: repeat(16, 60px);
    justify-content: center;
    column-gap: 12px;
    row-gap: 16px;
    align-content: start;
    scrollbar-width: thin;
    scrollbar-color: $color-scrollbar-chat transparent;
    pointer-events: auto;
    // 面板升起这 0.16s 里先隐着,升完再很快浮现(0.1s)——
    // 顺序读起来是"菜单先升上来,表情随后出现",而不是一边升一边淡入。
    // 用 animation 而不是 transition:这样延迟与时长可以一次排好,
    // both 让升起期间稳稳停在 opacity:0。延迟必须与上面面板的 0.16s 对齐。
    animation: emoji-appear 0.1s ease-out 0.16s both;
  }

  @keyframes emoji-appear {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  // 单个表情:原图等比铺满;点击在输入框光标处插入
  // 宽高由 grid 列宽驱动(桌面 60px / 移动端 36px),不再写死
  &__emoji-cell {
    aspect-ratio: 1;
    border: none;
    border-radius: 8px;
    padding: 0;
    cursor: pointer;
    background: transparent;
    position: relative;

    &::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 8px;
      background: $color-hover-overlay;
      opacity: 0;
      transition: opacity 0.15s ease;
    }

    &:hover::after {
      opacity: 1;
    }
  }

  &__emoji-img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }

  // 表情弹窗过渡:从下到上展开 / 从上到下收起。
  // 只有 transform,没有 opacity —— 升起过程是一块实体面板往上长,
  // 不允许出现"半透明渐显"那种过渡(表情另行延迟浮现,见 __emoji-grid)。
  // 0.16s:面板要"唰"地出来,不能拖。
  .chat-input-pop-enter-active,
  .chat-input-pop-leave-active {
    transition: transform 0.16s ease-out;
    transform-origin: bottom center;
  }

  .chat-input-pop-enter-from,
  .chat-input-pop-leave-to {
    transform: scaleY(0);
  }

  // 收起时表情**直接消失**,不跟着面板一起被压扁 —— scaleY 会把子元素一并压,
  // 所以离场期间把网格整个抹掉。入场动画带 fill-mode: both,收场时 opacity
  // 仍被它钉在 1,故这里连动画一起清掉再置 0(不加 !important 也能生效)。
  .chat-input-pop-leave-active .chat-input__emoji-grid {
    animation: none;
    opacity: 0;
  }

  // ── 移动端缩小 ──
  &--mobile {
    // 单行时输入框在面板里上下各留 (50-36)/2
    --field-inset: 7px;

    .chat-input__field {
      height: 36px;
      font-size: 16px;
      padding: 6px 16px;
      // 移动端单行高度 36 → 胶囊半径 18
      --field-radius: 18px;
    }

    .chat-input__btns {
      gap: 10px;
    }

    .chat-input__btn {
      width: 36px;
      height: 36px;

      &__icon {
        inset: 6px;
        width: calc(100% - 12px);
        height: calc(100% - 12px);
      }
    }
  }
}
</style>
