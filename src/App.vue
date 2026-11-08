<script setup lang="ts">
// App —— 应用根组件：背景 + 等比画布（顶栏 / 卡片列表 / 聊天区）+ 各类浮层
// 删除走「删除模式」多选；URL 带 #debug 时左下角渲染气泡尺寸信息。
import { ref, computed, inject, provide, toValue, watch, onMounted, onBeforeUnmount } from 'vue'
import type { ChatMessage, GroupSpeakMode } from './types/chat'
import AppBackground from './components/layout/AppBackground.vue'
import AppHeader from './components/layout/AppHeader.vue'
import DesignCanvas from './components/layout/DesignCanvas.vue'
import CharacterCardList from './components/character/CharacterCardList.vue'
import ChatArea from './components/chat/ChatArea.vue'
import DeleteModeBar from './components/character/DeleteModeBar.vue'
import MessageSelectBar from './components/chat/MessageSelectBar.vue'
import GroupContinueNudge from './components/chat/GroupContinueNudge.vue'
import ChatExportDialog from './components/layout/ChatExportDialog.vue'
import SettingsDialog from './components/layout/SettingsDialog.vue'
import UsagePanel from './components/layout/UsagePanel.vue'
import GroupCreateDialog from './components/character/GroupCreateDialog.vue'
import GroupSettingsDialog from './components/character/GroupSettingsDialog.vue'
import ExitConfirmDialog from './components/layout/ExitConfirmDialog.vue'
import AlertDialog from './components/layout/AlertDialog.vue'
import NoticeDialog from './components/layout/NoticeDialog.vue'
import StylePreferenceDialog from './components/layout/StylePreferenceDialog.vue'
import UpdateDialog from './components/layout/UpdateDialog.vue'
import VersionDialogShell from './components/layout/VersionDialogShell.vue'
import AnnouncementPage from './components/layout/AnnouncementPage.vue'
import { useChatStore } from './stores/chat'
import { useSettingsStore } from './stores/settings'
import { useMobile, hasEditableFocus } from './composables/useMobile'
import {
  chatGeometryKey,
  globalChatGeometry,
  DESKTOP_GEOM,
  type ChatGeometry,
} from './constants/chatGeometry'
import { useDebugMode } from './composables/useDebugMode'
import { usePopups } from './composables/usePopups'
import { flushPendingWrites } from './composables/useChatPersistence'
import { isLegacyDemoGroupShell } from './utils/groupMeta'
import { deleteBarH } from './composables/useDeleteBar'
import { devInfo, devWarn } from './utils/logger'
import { getPlatform } from './utils/platform'
const chatStore = useChatStore()
const settingsStore = useSettingsStore()

// 创建群聊弹窗（纯 UI）
/** 弹窗是否展开 */
const groupDialogOpen = ref(false)

/** 群聊设置弹窗:打开时记录目标群聊在 cards 中的下标(null = 关闭) */
const groupSettingsIndex = ref<number | null>(null)

/** 点击群聊卡右上角「⋯」→ 打开群聊设置 */
function onOpenGroupSettings(cardIndex: number): void {
  groupSettingsIndex.value = cardIndex
}

/**
 * 弹窗确认创建
 *
 * 只做前端建卡:往 store 的 cards 里插入一张群聊主卡并选中,
 * 建群后自动切到群聊列表。
 */
function onCreateGroup(members: string[], myRole: string, speakMode: GroupSpeakMode) {
  chatStore.createGroupCard(members, myRole, undefined, speakMode)
}

// 群聊演示数据回收（历史遗留清理）
// 老版本播种过的三个演示群残留仍在部分用户的库里：
// 老版白名单净化会丢卡片级字段(members 等)，退化成"群聊名 + 单聊壳"，
// 所以按标题精确匹配清理一次。
// 标题清单与"空壳"判定统一放在 utils/groupMeta:那边新增的群聊识别要用同一份,
// 否则被识别回来的演示群空壳会绕过这里的清理。

/**
 * 清理历史遗留的演示群
 *
 * 只删「没有 members(已退化)+ 首个子对话名恰好等于演示标题」的卡片;
 * 玩家自己建的群都带 members,且名字不会与演示标题重合,不会被误删。
 */
function purgeLegacyDemoGroups(): void {
  const kept = chatStore.cards.filter((c) => !isLegacyDemoGroupShell(c))
  if (kept.length === chatStore.cards.length) return
  chatStore.replaceAllCards(kept)
  devInfo('[群聊] 已清理历史遗留演示群,剩余卡片', kept.length)
}

// 调试浮层(非调试模式下为空操作)
useDebugMode()

// 弹窗（公告 / 提醒 / 更新）
// 三类数据同出一个 JSON（constants/popups），按「公告 → 提醒 → 更新」排队，只渲染一个。
//
// ⚠️ 开关与组件必须成对：队首是该类型却没有对应组件渲染，它就没有任何出口，
// 后面的提醒 / 更新会被永久堵住。要关掉某一类，必须在这里把开关设为 false，
// 而不是仅在模板里不渲染对应组件。
// forceUpdate: false —— 更新弹窗仅在客户端弹出，网页端不弹。
const {
  noticeTitle,
  noticeContent,
  alerts,
  latestVersion,
  platform,
  activePopup,
  loadPopupData,
  onNoticeConfirm,
  onNoticeDismiss,
  confirmAlerts,
  ignoreUpdate,
  downloadUrl,
} = usePopups({ enableNotice: true, enableAlert: true, forceUpdate: false })

// 弹窗类型
// 公测版没有密码门禁；弹窗按队列依次出现：公告 → 提醒 → 更新，同一时刻只有一个。
const popupKind = computed(() => activePopup.value)

// 首次使用偏好弹窗（动作 / 神态描写的显示样式）
/**
 * 一次性标记的 localStorage key
 *
 * 刻意**不进设置快照**(不是设置项,不进导出包):它的语义是"这条询问已经问过",
 * 换设备 / 重装后再问一次是合理行为。
 */
const STYLE_PREF_ASKED_KEY = 'endfield-baker-settings-style-pref-asked'

function readStylePrefAsked(): boolean {
  try {
    return localStorage.getItem(STYLE_PREF_ASKED_KEY) === '1'
  } catch {
    return false
  }
}

/** 是否已经问过(问过就不再弹) */
const stylePrefAsked = ref(readStylePrefAsked())

/**
 * 本次会话是否点过「稍后再说」
 *
 * 刻意**只在内存里**:点过之后本次会话不再打扰,但刷新 / 重开页面时它归位,
 * 弹窗照旧会出现 —— 这正是"稍后再说"与三个选项的区别(选项才写一次性标记)。
 */
const stylePrefSnoozed = ref(false)

/**
 * 启动层是否已**完全退场**
 *
 * 入场弹窗(公告 / 提醒 / 更新)与首次使用偏好都等这个信号。
 * 启动层在 index.html 里，擦幕 + 淡出约 1.1 秒后才移除并广播 `baker:boot-done`；
 * 只等"挂载完成"的话，弹窗会隔着还没退场的黄幕冒出来。
 */
const splashGone = ref(false)

/** 启动层退场 → 放行入场弹窗 */
function onBootDone(): void {
  splashGone.value = true
}

/** 四个条件同时满足才弹：没问过、本次没点「稍后再说」、开屏结束、弹窗队列为空（不插队） */
const stylePrefOpen = computed(
  () =>
    !stylePrefAsked.value &&
    !stylePrefSnoozed.value &&
    splashGone.value &&
    popupKind.value === null,
)

/**
 * 全部落到已有开关上：none 打开沉浸式（不写括号）；其余三种先关掉沉浸式再设样式，
 * 否则后端压根不写括号描写，玩家选的样式永远看不到。选完即落盘。
 */
function onStylePreference(mode: 'none' | 'color' | 'mono' | 'off'): void {
  if (mode === 'none') {
    settingsStore.immersiveMode = true
  } else {
    // 要让后端写括号描写,先关掉「沉浸式对话模式」
    settingsStore.immersiveMode = false
    if (mode === 'color') {
      settingsStore.bracketCenter = true
      settingsStore.bracketColor = true
    } else if (mode === 'mono') {
      settingsStore.bracketCenter = true
      settingsStore.bracketColor = false
    } else {
      settingsStore.bracketCenter = false
      settingsStore.bracketColor = false
    }
  }
  stylePrefAsked.value = true
  try {
    localStorage.setItem(STYLE_PREF_ASKED_KEY, '1')
  } catch {
    // 存储不可用:标记只留在内存里,本次会话内不会重复弹
  }
  flushPendingWrites()
}

/**
 * 样式（居中 / 彩色）按默认值落地，与旧版观感一致；是否开启描写（immersiveMode）
 * 玩家没回答就不动。不写一次性标记：下次进入照旧会问，本次会话内不再打扰。
 */
function onStylePreferenceLater(): void {
  settingsStore.bracketCenter = false
  settingsStore.bracketColor = false
  stylePrefSnoozed.value = true
  flushPendingWrites()
}

// 退出确认（三端统一）
// 电脑版:Electron 主进程拦截窗口关闭后发来 flush-request
// 手机版:系统返回键(Capacitor WebView 会触发 popstate)
// 网页版:浏览器后退(同样走 popstate)
// 玩家点「保存并退出」才真正退出;点「取消」则留在应用内。
const exitOpen = ref(false)

/**
 * 是否已真正退出(用于网页端)
 *
 * 浏览器安全策略不允许脚本关闭"不是由脚本打开"的标签页,window.close() 会
 * 静默失败 —— 用户点完「保存并退出」后仍停在应用里,观感就是"没退出"。
 * 因此网页端补一个明确的退出态:界面整体收起,只留一块"可以关闭此页面"的提示。
 * 打包端(EXE/APK)走原生退出,通常看不到这一屏。
 */
const exited = ref(false)

/** 确认退出时执行的动作 */
let exitCommit: (() => void) | null = null
/** 取消退出时执行的动作 */
let exitRevert: (() => void) | null = null

/** 请求退出:先弹出确认框 */
function requestExit(onCommit: () => void, onRevert?: () => void) {
  exitCommit = onCommit
  exitRevert = onRevert ?? null
  exitOpen.value = true
}

/** 保存并退出:停留片刻展示「正在保存」动画,再执行真正退出 */
function onExitSave() {
  window.setTimeout(() => {
    exitOpen.value = false
    const commit = exitCommit
    exitCommit = null
    exitRevert = null
    commit?.()
  }, 1200)
}

/** 取消:留在应用内 */
function onExitCancel() {
  exitOpen.value = false
  const revert = exitRevert
  exitCommit = null
  exitRevert = null
  revert?.()
}

/** Electron 桥(由 preload 注入;网页端/手机端为 undefined) */
type NativeBridge = { flushDone?: () => void; cancelClose?: () => void }
function nativeBridge(): NativeBridge | undefined {
  return (window as unknown as { nativeStorage?: NativeBridge }).nativeStorage
}

/**
 * 电脑版:主进程在关闭窗口前发来 flush-request
 *
 * 此处不立即冲刷,而是先弹出退出确认框;玩家点「保存并退出」后才
 * 冲刷持久化并通知主进程关闭 —— 否则要等主进程的兜底超时才退出,
 * 表现为"点了关闭后卡几秒才关掉"。
 */
const onFlushRequest = () => {
  requestExit(
    async () => {
      // 必须**等**落盘完成再通知主进程关闭窗口：
      // fire-and-forget 的话主进程收到 flushDone 就 destroy，在途写入随之消失。
      try {
        await flushPendingWrites()
      } catch (err) {
        devWarn('[App] 关闭前保存失败', err)
      }
      nativeBridge()?.flushDone?.()
    },
    () => {
      // 取消关闭:通知主进程复位,下次关闭仍会拦截
      nativeBridge()?.cancelClose?.()
    },
  )
}

/**
 * 是否已进入"真正退出"流程
 *
 * history.go(-n) 本身会再派发一次 popstate。若不屏蔽,拦截器会又压一层栈、
 * 又弹一次确认框 —— 就是"点保存并退出、转完圈又弹同一个窗口、人还留在页面"。
 */
let exiting = false

/**
 * 应用自身 1 层 + 拦截返回的守卫层 1 层 = 2。
 * ⚠️ 守卫层每次回退都是「先退掉再压入」，栈里始终只有一层，这个数字绝不能累加，
 * 否则会一次退到站外。
 */
const EXIT_HISTORY_STEPS = 2

/** 尽力告知原生层退出(APK 走 Capacitor 的 App 插件;网页端无此能力) */
function tryNativeExit(): void {
  try {
    const cap = (window as unknown as {
      Capacitor?: { Plugins?: { App?: { exitApp?: () => void } } }
    }).Capacitor
    cap?.Plugins?.App?.exitApp?.()
  } catch {
    // 非 Capacitor 环境,忽略
  }
}

/** 手机版返回键 / 网页版后退:同样先弹确认框 */
const onPopState = () => {
  // 这是我们自己 history.go() 触发的回退,不是用户按的返回键:直接忽略
  if (exiting) return

  // 重新压栈,保证下次返回仍能被拦截
  history.pushState(null, '', location.href)
  requestExit(() => {
    exiting = true
    // 网页端:先切到明确的退出态,保证用户一定看得到"已退出"
    exited.value = true
    // 退掉守卫层 + 应用自身条目,回到用户原本所在的上一页
    history.go(-EXIT_HISTORY_STEPS)
    // 网页端再尽力关一次窗口(脚本打开的标签页 / 部分 WebView 会生效)。
    // 浏览器安全策略不允许关闭非脚本打开的窗口,那种情况下人只能留在页面,
    // 但至少不会再重复弹确认框。
    window.setTimeout(() => {
      try {
        window.close()
      } catch {
        // 忽略
      }
      tryNativeExit()
    }, 0)
  })
}

// 自定义页面背景(带 localStorage 持久化:刷新保留、不随 .baker 导出、
// 不受清空对话影响;上传成功赋值后自动落库)

// 移动端视图
// ≤768px 视口进入移动端模式:
//   list 视图 = 对话列表全屏;选中对话后切 chat 视图 = 全屏聊天窗口。
// 移动端聊天窗口是独立自适应组件(MobileChat),不复用 1920 设计稿画布。
const { isMobile, width, height, keyboardOffsetTop, keyboardInset, chatViewportHeight } =
  useMobile()

/**
 * 钉在可视视口上：iOS 弹键盘时会把可视视口下移，而 fixed 是相对布局视口定位，
 * 不这样整个界面会被顶到屏幕外。键盘未弹出时 offsetTop 为 0、高度等于视口高度。
 */
const mChatStyle = computed(() => ({
  top: keyboardOffsetTop.value + 'px',
  height: chatViewportHeight.value + 'px',
}))

/** 移动端视图:list=对话列表 / chat=聊天窗口 */
const mobileView = ref<'list' | 'chat'>('list')

/** 移动端列表画布设计尺寸(与 CharacterCardList 一致) */
const MOBILE_LIST_W = 526
/**
 * 移动端列表画布总高度
 *
 * = CharacterCardList 里两张卡的底边:模式切换宿主(62+40=102)与
 * 列表容器(.character-card 顶部 122.57 + 高 897.27 = 1019.84)。
 * **必须算到容器底边**——只算容器自身高度会让缩放系数偏大约 13.7%，
 * 页面下方内容被切掉一截。
 */
const MOBILE_LIST_H = 1019.84
/** 移动端列表页顶部预留(px,视口坐标):让出 AppHeader 那条固定顶栏(52px) */
const MOBILE_LIST_TOP_PAD = 14
/**
 * 卡片居中修正(设计值,zoom 自动缩放):
 * 卡片在设计稿 526 坐标系内从 x=47.42 起(左侧空 47.42,右侧空 20.3),
 * 移动端单独展示列表时内容整体右偏 47.42-(526-458.28)/2 = 13.56,
 * 给 zoom 容器负 margin 抵消,使卡片视觉居中。
 */
const MOBILE_LIST_MARGIN_X = -(47.42 - (526 - 458.28) / 2)

/** 移动端列表缩放系数:列表设计尺寸等比铺满视口(顶部预留工具栏空间) */
const mobileListZoom = computed(() =>
  Math.max(
    0.01,
    Math.min(
      width.value / MOBILE_LIST_W,
      (height.value - MOBILE_LIST_TOP_PAD) / MOBILE_LIST_H,
    ),
  ),
)

// 移动端视图联动:
// - 移动端单击选中子对话只高亮(不自动进入聊天,进入由双击触发)
// - 选中清空(activeSub 为 null,删除/清空等场景) → 回列表视图
watch(
  [isMobile, () => chatStore.activeSub],
  ([m, sub]) => {
    if (!m) return
    if (sub === null) mobileView.value = 'list'
  },
)

// 移动端单击子对话 / 群聊卡进入聊天视图(由列表卡触发;桌面端内部判 isMobile,不生效)
provide('enterMobileChat', () => {
  if (isMobile.value) mobileView.value = 'chat'
})

// 聊天区可见性自愈：Edge / 夸克等 Chromium 内核在键盘收放后会残留合成层，
// 元素布局正常但渲染丢失（只剩背景）。检测到就递增 chatEpoch 强制重挂载 ChatArea。
// 防误判：键盘压缩中跳过、rAF 后读数、同一次键盘会话最多自愈 3 次、重挂载后恢复焦点。
const chatEpoch = ref(0)
let healTimer: number | null = null
let healCount = 0

/** 上次自愈触发前是否聚焦在聊天输入框(重挂载后恢复焦点用) */
let wasChatInputFocused = false

function scheduleChatHeal(focusDelay: boolean) {
  if (!isMobile.value || mobileView.value !== 'chat') return
  if (healTimer !== null) clearTimeout(healTimer)
  // 键盘弹出(focusin)时布局在过渡,延迟加长;收起(focusout)时较短
  const delay = focusDelay ? 1200 : 600
  healTimer = window.setTimeout(() => {
    healTimer = null
    checkChatVisible()
  }, delay)
}

/**
 * 软键盘当前是否顶着可视视口
 *
 * 不能用 `innerHeight < height - 30` 这条守卫：iOS 上键盘弹出时
 * window.innerHeight **不变**，它在 iOS 永远不成立 —— 自愈检测会在键盘展开、
 * 布局过渡中照常执行，一旦误判就强制重挂载聊天区（销毁输入框 → 键盘收起）。
 */
function isKeyboardOpen(): boolean {
  if (keyboardInset.value > 0) return true
  const vv = window.visualViewport
  if (!vv) return window.innerHeight < height.value - 30
  return vv.height < window.innerHeight - 80
}

function checkChatVisible() {
  // 键盘展开中:布局本来就在过渡,跳过检测(避免误判重挂载)
  if (isKeyboardOpen()) return
  requestAnimationFrame(() => {
    const el = document.querySelector('.m-chat .chat-scroll') as HTMLElement | null
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    // getBoundingClientRect 给的是布局视口坐标,所以比较基准也要用布局视口高度
    const vh = window.innerHeight
    const visible =
      r.width > 50 &&
      r.height > 50 &&
      r.left >= -10 &&
      r.right <= vw + 10 &&
      r.top >= -10 &&
      r.bottom <= vh + 10
    if (!visible) {
      // 键盘打开期间**绝不**重挂载:销毁 textarea 会让键盘立刻收起。
      // 安卓 adjustResize 下 innerHeight 与 visualViewport 一起变矮,
      // isKeyboardOpen() 的高度差信号会消失,所以再用"可编辑元素仍聚焦"兜一层;
      // 宁可这次不自愈,等失焦(键盘收起)后的下一轮检测再修。
      if (isKeyboardOpen() || hasEditableFocus()) return
      // 连续误判保护:同一次键盘会话最多自愈 3 次
      if (healCount >= 3) {
        devWarn('[App] 聊天区不可见且自愈已达上限,停止尝试', {
          rect: { l: r.left, t: r.top, w: r.width, h: r.height },
          vw,
          vh,
        })
        return
      }
      healCount++
      devWarn('[App] 检测到聊天区不可见,强制重挂载自愈', {
        rect: { l: r.left, t: r.top, w: r.width, h: r.height },
        vw,
        vh,
      })
      chatEpoch.value++
      // 重挂载后恢复输入焦点(若之前聚焦在输入框),避免键盘闪退
      if (wasChatInputFocused) {
        requestAnimationFrame(() => {
          const field = document.querySelector<HTMLElement>('.m-chat .chat-input__field')
          field?.focus()
        })
      }
    }
  })
}

/**
 * 自愈只针对 Chromium 的合成层 bug；iOS 上全是 WebKit，而重挂载会销毁输入框、
 * 键盘随之收起，故整体关掉。getPlatform 在网页版返回 web，故再用 UA 兜住
 * 套着 Chromium UA 的 iOS 浏览器（iPadOS 13+ 请求桌面 UA，只能靠触点数区分）。
 */
const isIOS = (() => {
  if (getPlatform() === 'ios') return true
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua)) return true
  // iPadOS 13+ 默认请求桌面版 UA,只能靠触点数与 Mac 区分
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
})()

/** 键盘/视口变化监听(自愈触发源):输入聚焦/失焦 + visualViewport 变化 */
function onHealSignal(event?: Event) {
  if (isIOS) return
  const type = event?.type
  // 记录输入框焦点状态(重挂载后恢复用)
  const t = event?.target as Node | null
  wasChatInputFocused =
    !!t && t instanceof Element && !!t.closest('.chat-input')
  // 键盘收起(focusout) = 一次键盘会话结束,重置自愈计数
  if (type === 'focusout') healCount = 0
  // focusin(键盘弹出)延迟加长,避免布局过渡期误判
  scheduleChatHeal(type === 'focusin')
}

/** 返回列表:切回列表视图并清除选中(回到未选中任何对话/角色的初始状态) */
function onMobileBack() {
  mobileView.value = 'list'
  chatStore.clearSelection()
}

/** 移动端聊天区几何(返回按钮垂直对齐头部用;桌面/导出模式由 ChatExportStage 覆盖)。
 * 注意:inject 必须在 setup 期间立即调用(此时 currentInstance 必然存在);
 * 在 computed getter 内惰性调用会在组件上下文之外求值时返回 undefined。 */
const injectedGeom = inject(chatGeometryKey, globalChatGeometry) ?? DESKTOP_GEOM
const mobileGeom = computed<ChatGeometry>(() => toValue(injectedGeom))

/** 返回按钮(36px 圆形)在头部内的垂直居中偏移(+1px 视觉微调) */
const mBackTop = computed(() =>
  mobileGeom.value.stripSegmented ? (mobileGeom.value.stripH - 38) / 2 + 1 : 6,
)



onMounted(() => {
  // 启动层（index.html 里的静态层）黄幕退场并移除后会广播这个事件；
  // 公告 / 首次偏好都要等它，免得弹窗盖在开场上。
  if (document.getElementById('boot-layer')) {
    window.addEventListener('baker:boot-done', onBootDone)
  } else {
    // 没有启动层（旧构建 / 被中途移除）→ 直接放行
    splashGone.value = true
  }

  // 聊天区可见性自愈监听:输入聚焦/失焦(键盘弹出/收起) + visualViewport 变化
  document.addEventListener('focusin', onHealSignal)
  document.addEventListener('focusout', onHealSignal)
  window.visualViewport?.addEventListener('resize', onHealSignal)
  window.visualViewport?.addEventListener('scroll', onHealSignal)
  // 弹窗数据:启动时拉取测试专用 JSON(公告 / 提醒 / 最新版本)
  void loadPopupData()

  // 群聊:清理历史遗留的演示群(不再播种任何假数据)
  purgeLegacyDemoGroups()

  // ---- 退出确认:三端监听 ----
  // 处理函数定义在 setup 顶层(见上方 onFlushRequest / onPopState),
  // 这样 onBeforeUnmount 才能取到同一引用并正确移除。
  window.addEventListener('dsh-flush-request', onFlushRequest)
  // 手机版返回键 / 网页版后退:先压入一条历史记录,
  // 使返回动作触发 popstate 而不是直接离开页面。
  history.pushState(null, '', location.href)
  window.addEventListener('popstate', onPopState)
})
onBeforeUnmount(() => {
  document.removeEventListener('focusin', onHealSignal)
  document.removeEventListener('focusout', onHealSignal)
  window.visualViewport?.removeEventListener('resize', onHealSignal)
  window.visualViewport?.removeEventListener('scroll', onHealSignal)
  window.removeEventListener('dsh-flush-request', onFlushRequest)
  window.removeEventListener('popstate', onPopState)
  window.removeEventListener('baker:boot-done', onBootDone)
  if (healTimer !== null) clearTimeout(healTimer)
})

/**
 * 删除模式:由操作带上的删除按钮 toggle
 *
 * 状态与勾选都在 chat store 里(deleteMode / deleteSelection),因为列表项
 * (要不要画勾选黄条)与底部条(已选数量、删什么)都要读它。
 * 旧版那种"点删除弹菜单、再二次确认"的弹窗已删除。
 */
function onToggleDeleteMode(): void {
  chatStore.toggleDeleteMode()
}

/**
 * 删除模式下移动端列表的尾部留白(px,画布设计口径)
 *
 * 底部条是 fixed 浮层,会盖住列表最后一张卡。移动端列表是满屏滚动的,
 * 所以在删除模式下把尾部留白加到"条高 + 一点间隙"(按当前画布缩放换算回设计值),
 * 内容就能滚到条上方;桌面端列表在左侧、与居中的底部条不重叠,保持原留白。
 */
const listBottomPad = computed(() => {
  const BASE = 80 // 与 .card-pad 的默认高度一致
  if (!chatStore.deleteMode || !isMobile.value) return BASE
  const zoom = Math.max(mobileListZoom.value, 0.01)
  return Math.max(BASE, Math.ceil((deleteBarH.value + 24) / zoom))
})

/** 导出聊天截图弹窗是否展开(选中消息模式底部条的两个出口) */
const shareOpen = ref(false)

/**
 * 导出弹窗这次要导出的消息子集
 *
 * undefined = 全量导出(「导出全部消息」那条路);有值 = 只导出这些消息
 * (「导出选中消息」那条路)。两条路走的是完全同一套截图实现。
 */
const exportMessages = ref<ChatMessage[] | undefined>(undefined)

/** 选中消息模式的「导出选中消息」:把选中的子集交给同一个导出弹窗 */
function onExportSelectedMessages(): void {
  const msgs = chatStore.selectedMessages
  if (msgs.length === 0) return
  exportMessages.value = msgs
  chatStore.exitMsgSelect()
  shareOpen.value = true
}

/**
 * 选中消息模式的「导出全部消息」:不传子集 = 整段对话全量导出
 *
 * 与原来设置菜单里的「分享」是同一条路(同一套离屏截图实现、同一个文件名),
 * 只是入口挪到了这里 —— 顺手把选中模式收掉,弹窗就是这次导出的全部状态。
 */
function onExportAllMessages(): void {
  exportMessages.value = undefined
  chatStore.exitMsgSelect()
  shareOpen.value = true
}

/** 导出弹窗关闭:子集一并清掉,下次打开不会沿用上一次的选择 */
function onCloseExport(): void {
  shareOpen.value = false
  exportMessages.value = undefined
}

/** 设置弹窗是否展开(API 配置 + 提示词编辑 + 数据管理 + 背景) */
const settingsOpen = ref(false)

// 公告页
/**
 * 公告页是否展开
 *
 * 入口有两处:角色列表上方操作带的公告按钮,以及公告弹窗的「全部公告」。
 * 与三类进入弹窗(公告 / 提醒 / 更新)互斥:关掉队首那颗弹窗再开本页,
 * 避免两层全屏叠在一起。
 */
const announceOpen = ref(false)

/** 从公告弹窗跳进公告页:先把弹窗确认掉(推进队列),再打开页面 */
function onNoticeAll(): void {
  onNoticeConfirm()
  announceOpen.value = true
}

/**
 * Token 用量 / 缓存命中面板是否展开(操作带上的用量按钮 toggle)
 *
 * 非模态浮层:开着它照样能聊天,方便边发边看命中率变化。
 * 入口按钮只在自定义 API 模式渲染(见 CharacterCardList)。
 */
const usageOpen = ref(false)

/** 通用提示弹窗(新建对话未选角色 / 群聊流程控制条提示等共用) */
const hintText = ref('')
/** 当前是否有提示在显示 */
const hintOpen = computed(() => hintText.value !== '')

/** 弹一条提示 */
function showHint(text: string): void {
  hintText.value = text
}

/** 关闭提示 */
function closeHint(): void {
  hintText.value = ''
}

/**
 * 聊天按钮：已选中主卡就在其下追加子会话；未选中则提示先选角色
 */
/** 群聊模式下是「创建群聊」，单聊模式下是「新建对话」，由 App 统一分发 */
function onAdd() {
  if (chatStore.chatMode === 'group') {
    groupDialogOpen.value = true
    return
  }
  onChatNew()
}

function onChatNew() {
  if (chatStore.activeCardIndex === null) {
    showHint('请先选中角色卡片')
    return
  }
  // 群聊主卡不支持再建子会话:建出来只会是一个空占位。
  // 这里直接给出提示,store 侧同样会拒绝,双保险。
  if (!chatStore.createChildConversation()) {
    showHint(chatStore.activeIsGroup ? '群聊里不能再新建对话' : '请先选中角色卡片')
  }
}
</script>

<template>
  <!-- 已退出：脚本不能关闭非脚本打开的标签页，只能整体收起并给出明确提示 -->
  <div v-if="exited" class="exit-done">
    <p class="exit-done__title">已保存并退出</p>
    <p class="exit-done__sub">当前进度已写入本地，可以关闭此页面了</p>
  </div>

  <AppBackground :custom-url="settingsStore.customBg" />

  <!-- 桌面端（>768px）：1920 设计稿等比画布 -->
  <template v-if="!isMobile">
    <DesignCanvas>
      <AppHeader variant="desktop" :mode="chatStore.chatMode" @update:mode="chatStore.setChatMode" />
      <CharacterCardList
        @add="onAdd"
        @group-settings="onOpenGroupSettings"
        @open-settings="settingsOpen = true"
        @open-announce="announceOpen = true"
        @open-delete="onToggleDeleteMode"
        @open-usage="usageOpen = !usageOpen"
      />
      <ChatArea @open-settings="settingsOpen = true" @hint="showHint" />
    </DesignCanvas>
  </template>

  <!-- 移动端（≤768px）：列表 ↔ 聊天双视图 -->
  <template v-else>
    <!-- 列表视图:对话列表等比缩放铺满视口(选中对话后自动切到聊天视图)。
         顶栏由 AppHeader 固定承担(标题 + 单聊/群聊页签),列表本身只画卡片;
         负 margin 抵消卡片设计坐标右偏,使内容视觉居中 -->
    <div v-if="mobileView === 'list'" class="m-list">
      <!-- 移动端顶栏:标题 + 单聊/群聊页签(贴视口顶端,不随列表缩放) -->
      <AppHeader variant="mobile" :mode="chatStore.chatMode" @update:mode="chatStore.setChatMode" />
      <div class="m-list__stage">
        <div
          class="m-list__zoom"
          :style="{
            width: MOBILE_LIST_W + 'px',
            height: MOBILE_LIST_H + 'px',
            zoom: String(mobileListZoom),
            marginLeft: MOBILE_LIST_MARGIN_X + 'px',
          }"
        >
          <CharacterCardList
            :bottom-pad="listBottomPad"
                @add="onAdd"
            @group-settings="onOpenGroupSettings"
            @open-settings="settingsOpen = true"
            @open-announce="announceOpen = true"
            @open-delete="onToggleDeleteMode"
            @open-usage="usageOpen = !usageOpen"
          />
        </div>
      </div>
    </div>
    <!-- 聊天视图:直接复用桌面端 ChatArea 组件与样式。
         布局由几何层(chatGeometry)按视口驱动;输入面板贴底。
         fixed + 合成层 + 自愈,移动端输入框为原生 textarea -->
    <div v-else class="m-chat" :style="mChatStyle">
      <!-- 返回列表按钮:白色圆形 SVG,位于头部右侧垂直居中 -->
      <button
        class="m-chat__back"
        type="button"
        aria-label="返回"
        :style="{ top: mBackTop + 'px' }"
        @click="onMobileBack"
      >
        <svg viewBox="0 0 50 50" aria-hidden="true">
          <defs>
            <filter id="mBackShadow" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.35" />
            </filter>
          </defs>
          <!-- 中心实心圆(r≤20,直径 40px;圆环已按要求去掉) -->
          <path
            d="M25,25 m-20,0 a20,20 0 1,0 40,0 a20,20 0 1,0 -40,0"
            fill="#454545"
            filter="url(#mBackShadow)"
          />
          <!-- 中心 "<" 形状(返回语义,相对原版 ">" 镜像):顶点在圆心,两条线段向左开口 -->
          <path
            d="M29,17 L19,25 L29,33"
            fill="none"
            stroke="#fff"
            stroke-width="4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <!-- 自愈重挂载:chatEpoch 变化时强制重建 ChatArea(修复 Chromium 键盘合成残留) -->
      <ChatArea
        :key="chatEpoch"
        @open-settings="settingsOpen = true"
        @hint="showHint"
      />
    </div>
  </template>


  <!-- 删除模式的底部条:多选后在这里选"删什么"(对话 / 历史 / 上下文)并执行。
       仅删除模式下挂载(它挂载时会把自己的高度上报给列表,用于留出尾部空档)。 -->
  <DeleteModeBar v-if="chatStore.deleteMode" />

  <!-- 选中消息模式的底部条:勾选若干条消息 → 导出为一张长图 -->
  <MessageSelectBar
    v-if="chatStore.msgSelectMode"
    @export="onExportSelectedMessages"
    @export-all="onExportAllMessages"
  />

  <!-- 群聊「继续对话」浮条:角色们每聊满 20 条浮出一次,不点则再聊一轮就自动暂停。
       与上面那条导出条同一类"贴窗口底的浮条"(同位置、同层级、同材质),
       所以同样挂在根层 —— 不进缩放过的设计画布,像素观感才一致。 -->
  <GroupContinueNudge />
  <!-- 导出聊天截图弹窗(右侧工具栏的分享入口 + 选中消息底部条的两个出口共用);
        全量与子集只差 messages 一个入参,截图实现同一套 -->
  <ChatExportDialog
    :open="shareOpen"
    :conversation-title="chatStore.counterpartName"
    :messages="exportMessages"
    @close="onCloseExport"
  />
  <!-- 通用提示弹窗(新建对话未选角色 / 群聊流程控制条提示等)
       外观与公告 / 提醒 / 更新弹窗完全一致:共用 VersionDialogShell -->
  <VersionDialogShell
    :open="hintOpen"
    title="提示"
    kind="alert"
    @close="closeHint"
  >
    <p class="hint__text">{{ hintText }}</p>

    <template #actions>
      <button class="pn-btn" type="button" @click="closeHint">
        <span class="pn-btn__tex" aria-hidden="true"></span>
        <span class="pn-btn__deco" aria-hidden="true"></span>
        <span class="pn-btn__label">确定</span>
      </button>
    </template>
  </VersionDialogShell>
  <!-- 设置弹窗:API 配置 + 系统提示词 + 角色提示词编辑 + 数据管理 + 背景 -->
  <!-- 创建群聊弹窗(第三版群聊) -->
  <GroupCreateDialog
    :open="groupDialogOpen"
    @close="groupDialogOpen = false"
    @create="onCreateGroup"
  />
  <!-- 群聊设置:「⋯」打开。
       删除群聊不在这里 —— 那个入口已收敛到操作带的删除按钮(见上方的删除模式) -->
  <GroupSettingsDialog
    :open="groupSettingsIndex !== null"
    :card-index="groupSettingsIndex"
    @close="groupSettingsIndex = null"
  />

  <SettingsDialog
    :open="settingsOpen"
    @close="settingsOpen = false"
  />

  <!-- 公告页:操作带的公告按钮 / 公告弹窗的「全部公告」进入 -->
  <AnnouncementPage :open="announceOpen" @close="announceOpen = false" />

  <!-- Token 用量 / 缓存命中面板:非模态浮层,可拖动,位置持久化。
       入口在角色列表上方的操作带(仅自定义 API 模式渲染)。 -->
  <UsagePanel :open="usageOpen" @close="usageOpen = false" />

  <!--
    弹窗(公告 → 提醒 → 更新):由 popupKind(= usePopups 的 activePopup)决定
    当前渲染哪一个,同一时刻只有一个;关掉队首后自动出下一个
    (队列推进见 composables/usePopups)。
  -->
  <!-- 公告弹窗(每次启动弹,直到点「不再提醒」;服务端公告正文变化会自动重置该标记)
       开屏遮罩彻底退场后才允许出现(见 splashGone)。 -->
  <NoticeDialog
    :open="splashGone && popupKind === 'notice'"
    :title="noticeTitle"
    :content="noticeContent"
    @confirm="onNoticeConfirm"
    @dismiss="onNoticeDismiss"
    @all="onNoticeAll"
  />
  <!-- 提醒弹窗(可能多条:同窗内左右滑动查看,点「确定」一次性确认全部)
       由 usePopups 的 enableAlert 控制当前是否进入队列(现为开启)。 -->
  <AlertDialog
    :open="splashGone && popupKind === 'alert'"
    :alerts="alerts"
    @confirm="confirmAlerts"
  />
  <!-- 更新弹窗(忽略此版本 / 前往下载;网页端不会进入队列) -->
  <UpdateDialog
    :open="splashGone && popupKind === 'update'"
    :version="latestVersion"
    :download-url="downloadUrl()"
    :platform="platform"
    @ignore="ignoreUpdate"
  />

  <!-- 首次使用偏好(动作/神态描写的样式,三选一 + 稍后再说)
       只在"开屏结束 + 上面三类弹窗都关掉 + 本次更新后还没问过 + 本次会话没点稍后"时出现。 -->
  <StylePreferenceDialog
    :open="stylePrefOpen"
    @choose="onStylePreference"
    @later="onStylePreferenceLater"
  />

  <!-- 退出确认弹窗(电脑版关窗 / 手机版返回键 / 网页版后退 均先经此确认) -->
  <ExitConfirmDialog
    :open="exitOpen"
    @save="onExitSave"
    @cancel="onExitCancel"
  />
</template>

<style scoped lang="scss">
@use './styles/variables' as *;
@use './styles/mixins' as *;

// "请先选中角色" 等通用提示:内容 styles(外壳由 VersionDialogShell 提供)
.hint__text {
  margin: 0;
  color: #1f1f1f;
  font-size: 14px;
  line-height: 1.7;
}

// 聊天页顶部页签（单聊 / 群聊）
// 页签在 AppHeader(components/layout/AppHeader.vue) 里渲染:标题与页签同处一条顶栏。
// 这里不再有独立的定位容器。


// 移动端列表视图
// 对话列表(526×897 设计稿)等比缩放铺满手机视口;列表自身可滚动。
// stage 顶部留一条 14px 的呼吸缝(AppHeader 固定顶栏:标题 + 页签)。
.m-list {
  position: fixed;
  inset: 0;
  z-index: 1;
  background: transparent;

  &__stage {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    // 顶部预留 AppHeader 的高度;刘海/挖孔屏再补上安全区,
    // 避免列表被状态栏或摄像头区域遮住。
    // --safe-top 默认 0px（见 styles/_base.scss），普通设备布局零变化。
    padding-top: calc(14px + var(--safe-top, 0px));
  }

  &__zoom {
    position: relative;
    flex: none;
    // touch-action: manipulation —— 去掉移动端 300ms 点击延迟、禁掉双击缩放。
    // 列表里点卡片就是要进对话,若还留着双击缩放,连点两下会被浏览器当成缩放。
    // (模式开关的 touch-action:none 比 manipulation 更严格,不受影响)
    touch-action: manipulation;
  }
}

// 移动端聊天视图
// fixed 全屏 + 强制合成层(规避 Chromium 内核键盘合成残留 bug) + 自愈兜底。
// 移动端输入框用原生 textarea(ChatInput 分支),绕开夸克等对 contenteditable
// 的焦点 bug。
.m-chat {
  position: fixed;
  inset: 0;
  z-index: 110;
  background: transparent;
  // 强制创建合成层:规避 Chromium 内核(Edge/夸克)在软键盘弹出/收起时
  // 对 fixed 容器内绝对定位元素的合成残留 bug(黑屏只剩背景)
  transform: translateZ(0);
  will-change: transform;

  // 返回列表按钮:实心圆 SVG,位于头部右侧垂直居中,
  // 层级高于头图(strip z1)与滚动区
  &__back {
    position: absolute;
    right: 16px;
    top: 0;
    z-index: 130;
    width: 38px;
    height: 38px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;

    svg {
      display: block;
      width: 100%;
      height: 100%;
    }

    &:active {
      transform: scale(0.94);
    }
  }
}

// 移动端适配

// 已退出（网页端）
// 铺满整屏、最高层级:退出后不再渲染任何应用界面
.exit-done {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 0 24px;
  background: $color-bg-root;
  text-align: center;

  &__title {
    font-family: $font-harmony;
    font-size: 20px;
    color: $color-text-primary;
  }

  &__sub {
    font-family: $font-harmony;
    font-size: 14px;
    line-height: 1.6;
    color: rgba(255, 255, 255, 0.45);
  }
}
</style>
