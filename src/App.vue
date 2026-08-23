<script setup lang="ts">
// =============================================================================
// 应用根组件
// -----------------------------------------------------------------------------
// 组装:背景层 + 等比缩放画布(顶部标题 + 干员卡片列表 + 聊天区 + 顶部工具栏)。
// 删除确认弹窗为独立组件(DeleteConfirmDialog),打开状态与删除动作在此持有。
// 调试模式:URL 包含 #debug 时,useDebugMode 会在左下角渲染气泡尺寸信息。
// =============================================================================
import { ref, computed, inject, provide, toValue, watch, onMounted, onBeforeUnmount } from 'vue'
import AppBackground from './components/layout/AppBackground.vue'
import DesignCanvas from './components/layout/DesignCanvas.vue'
import HeaderTop from './components/header/HeaderTop.vue'
import CharacterCardList from './components/character/CharacterCardList.vue'
import ChatArea from './components/chat/ChatArea.vue'
import DeleteConfirmDialog from './components/layout/DeleteConfirmDialog.vue'
import ChatExportDialog from './components/layout/ChatExportDialog.vue'
import SettingsDialog from './components/layout/SettingsDialog.vue'
import MigrationNoticeDialog from './components/layout/MigrationNoticeDialog.vue'
import { useChatStore } from './stores/chat'
import { useMobile } from './composables/useMobile'
import {
  chatGeometryKey,
  globalChatGeometry,
  DESKTOP_GEOM,
  type ChatGeometry,
} from './constants/chatGeometry'
import { MATERIALS } from './constants/materials'
import { useDebugMode } from './composables/useDebugMode'
import { useCustomBackground } from './composables/useCustomBackground'

const chatStore = useChatStore()

// 调试浮层(非调试模式下为空操作)
useDebugMode()

// 自定义页面背景(带 localStorage 持久化:刷新保留、不随 .baker 导出、
// 不受清空对话影响;上传成功赋值后自动落库)
const { customBg } = useCustomBackground()

// ---- 移动端视图 -----------------------------------------------------------
// ≤768px 视口进入移动端模式:
//   list 视图 = 对话列表全屏;选中对话后切 chat 视图 = 全屏聊天窗口。
// 移动端聊天窗口是独立自适应组件(MobileChat),不复用 1920 设计稿画布。
const { isMobile, width, height } = useMobile()

/** 移动端视图:list=对话列表 / chat=聊天窗口 */
const mobileView = ref<'list' | 'chat'>('list')

/** 移动端列表画布设计尺寸(与 CharacterCardList 一致) */
const MOBILE_LIST_W = 526
const MOBILE_LIST_H = 897.27
/** 移动端列表页顶部预留(px,视口坐标):避开 fixed 工具栏,容纳 HeaderTop 标题 */
const MOBILE_LIST_TOP_PAD = 40
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

// 移动端双击子对话进入聊天视图(由 SubCard 双击触发;桌面端不生效)
provide('enterMobileChat', () => {
  if (isMobile.value) mobileView.value = 'chat'
})

// ---- 聊天区可见性自愈 -------------------------------------------------------
// Edge/夸克等 Chromium 内核在软键盘弹出/收起时,对 fixed 容器内绝对定位元素
// 存在合成层残留 bug:元素布局值正常但渲染丢失(页面只剩背景+返回按钮)。
// 方案:键盘/视口变化后自检 .chat-scroll 是否在可视区域内,异常则通过
// chatEpoch 变更强制重挂载 ChatArea,触发浏览器重新合成,黑屏自愈。
//
// 误判防护(避免"键盘闪退"):
//   1. 键盘压缩中(innerHeight < 几何高度)跳过检测——布局本来就按小视口排布
//   2. rAF 后读数,确保渲染稳定
//   3. 连续误判保护:同一次键盘会话最多自愈 3 次,防止无限重挂载循环
//   4. 重挂载后恢复输入焦点(若之前聚焦在输入框),键盘不因重挂载收起
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

function checkChatVisible() {
  // 键盘压缩中:innerHeight 明显小于几何高度 → 键盘还开着,跳过检测
  if (window.innerHeight < height.value - 30) return
  requestAnimationFrame(() => {
    const el = document.querySelector('.m-chat .chat-scroll') as HTMLElement | null
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const visible =
      r.width > 50 &&
      r.height > 50 &&
      r.left >= -10 &&
      r.right <= vw + 10 &&
      r.top >= -10 &&
      r.bottom <= vh + 10
    if (!visible) {
      // 连续误判保护:同一次键盘会话最多自愈 3 次
      if (healCount >= 3) {
        console.warn('[App] 聊天区不可见且自愈已达上限,停止尝试', {
          rect: { l: r.left, t: r.top, w: r.width, h: r.height },
          vw,
          vh,
        })
        return
      }
      healCount++
      console.warn('[App] 检测到聊天区不可见,强制重挂载自愈', {
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

/** 键盘/视口变化监听(自愈触发源):输入聚焦/失焦 + visualViewport 变化 */
function onHealSignal(event?: Event) {
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

/** 返回按钮(51px 圆形)在头部内的垂直居中偏移(+1px 视觉微调) */
const mBackTop = computed(() =>
  mobileGeom.value.stripSegmented ? (mobileGeom.value.stripH - 51) / 2 + 1 : 6,
)

/**
 * 右上角工具栏是否可见(E 键切换)
 *
 * 仅会话内生效,不持久化,刷新页面即恢复可见。
 */
const showToolbar = ref(true)

/** 是否应忽略该键盘事件(输入框 / textarea / contenteditable 内按 E 不切换) */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

/** E 键切换工具栏显隐 */
function onToolbarToggleKeydown(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== 'e') return
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (isEditableTarget(event.target)) return
  showToolbar.value = !showToolbar.value
}

onMounted(() => {
  document.addEventListener('keydown', onToolbarToggleKeydown)
  // 聊天区可见性自愈监听:输入聚焦/失焦(键盘弹出/收起) + visualViewport 变化
  document.addEventListener('focusin', onHealSignal)
  document.addEventListener('focusout', onHealSignal)
  window.visualViewport?.addEventListener('resize', onHealSignal)
  window.visualViewport?.addEventListener('scroll', onHealSignal)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onToolbarToggleKeydown)
  document.removeEventListener('focusin', onHealSignal)
  document.removeEventListener('focusout', onHealSignal)
  window.visualViewport?.removeEventListener('resize', onHealSignal)
  window.visualViewport?.removeEventListener('scroll', onHealSignal)
  if (healTimer !== null) clearTimeout(healTimer)
})

/** 删除确认弹窗是否展开(删除按钮 toggle) */
const confirmOpen = ref(false)

/** 导出聊天截图弹窗是否展开(分享按钮 toggle) */
const shareOpen = ref(false)

/** 设置弹窗是否展开(API 配置 + 提示词编辑 + 数据管理 + 背景) */
const settingsOpen = ref(false)

/** "请先选中角色卡片"提示弹窗(新建对话时未选中任何角色触发) */
const needSelectOpen = ref(false)

/**
 * 聊天按钮(chat09)行为:
 * - 已选中主卡(点击父级角色卡片或子对话,activeCardIndex 非 null)
 *   → 在选中主卡下追加子会话(无需进入子对话)
 * - 未选中任何角色 → 弹出"请先选中角色"提示
 */
function onChatNew() {
  if (chatStore.activeCardIndex === null) {
    needSelectOpen.value = true
    return
  }
  chatStore.createChildConversation()
}
</script>

<template>
  <AppBackground :custom-url="customBg" />

  <!-- ==================== 桌面端(>768px):1920 设计稿等比画布 ==================== -->
  <template v-if="!isMobile">
    <DesignCanvas>
      <HeaderTop />
      <CharacterCardList />
      <ChatArea @open-settings="settingsOpen = true" />
    </DesignCanvas>
  </template>

  <!-- ==================== 移动端(≤768px):列表 ↔ 聊天 双视图 ==================== -->
  <template v-else>
    <!-- 列表视图:对话列表等比缩放铺满视口(选中对话后自动切到聊天视图)。
         含 HeaderTop(//BAKER/会话消息 标题 + 装饰图)与卡片列表,
         负 margin 抵消卡片设计坐标右偏,使内容视觉居中 -->
    <div v-if="mobileView === 'list'" class="m-list">
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
          <HeaderTop />
          <CharacterCardList />
        </div>
      </div>
    </div>
    <!-- 聊天视图:直接复用桌面端 ChatArea 组件与样式。
         布局由几何层(chatGeometry)按视口驱动;输入面板贴底。
         fixed + 合成层 + 自愈,移动端输入框为原生 textarea -->
    <div v-else class="m-chat">
      <!-- 返回列表按钮:白色圆形 SVG(源自 baker-maker 任务面板装饰按钮样式),
           位于头部右侧垂直居中 -->
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
      <ChatArea :key="chatEpoch" @open-settings="settingsOpen = true" />
    </div>
  </template>

  <!-- 右上角工具栏(E 键整体隐藏/显示,刷新恢复可见)。
       移动端:仅列表视图显示(聊天视图由 MobileChat 顶栏提供设置入口) -->
  <div v-show="showToolbar && (!isMobile || mobileView === 'list')">
  <!-- 新建对话按钮:右上角起始位;选中子对话时在选中父级卡片下追加子会话(无论是否展开);
       未选中任何对话时弹出"请先选中会话"提示 -->
  <button
    class="edit-toggle edit-toggle--chat09"
    type="button"
    @click="onChatNew"
  >
    <img :src="MATERIALS.editBtnChat09" alt="聊天" />
  </button>
  <!-- 角色名称开关按钮(已注释停用):位于 chat09(建会话)与背景(自定义背景)之间;
       点击切换"每条带头像的气泡上方是否显示小号灰字角色名"(localStorage 持久化)。
       角色名称显示功能整体停用,按钮一并注释保留,便于日后恢复。 -->
  <!-- <button
    class="edit-toggle edit-toggle--character"
    :class="{ 'edit-toggle--active': chatStore.showCharacterNames }"
    type="button"
    :aria-pressed="chatStore.showCharacterNames"
    @click="chatStore.toggleShowCharacterNames()"
  >
    <img :src="MATERIALS.editBtnCharacter" alt="角色名" />
  </button> -->
  <!-- 背景自定义按钮与数据管理按钮已移除:功能并入设置弹窗("背景"/"数据管理"标签页) -->
  <!-- 删除对话按钮:与 chat09 按钮同列(正下方),始终可见;点击弹出确认弹窗 -->
  <button
    class="edit-toggle edit-toggle--delete"
    type="button"
    @click="confirmOpen = !confirmOpen"
  >
    <img :src="MATERIALS.editBtnDeleteIndeed" alt="删除对话" />
  </button>

  <!-- 右侧操作按钮:横向等距排列,始终可见。
       分享 → 打开导出聊天截图弹窗 -->
  <button class="edit-toggle edit-toggle--share" type="button" @click="shareOpen = true">
    <img :src="MATERIALS.editBtnShare" alt="分享" />
  </button>
  <!-- 设置按钮:位于按钮列最左侧(share 左侧),login_btn_setting 图标;
       点击打开 API 配置 + 提示词编辑 + 数据管理 + 背景 + 免责声明 + 关于 弹窗 -->
  <button
    class="edit-toggle edit-toggle--settings"
    type="button"
    @click="settingsOpen = true"
  >
    <img :src="MATERIALS.loginBtnSetting" alt="设置" />
  </button>
  </div>

  <!-- 删除对话确认弹窗:fixed 视口定位,1920 原始尺寸不缩放 -->
  <DeleteConfirmDialog :open="confirmOpen" @close="confirmOpen = false" />
  <!-- 导出聊天截图弹窗:分享按钮触发(右侧工具栏显示) -->
  <ChatExportDialog
    :open="shareOpen"
    :conversation-title="chatStore.counterpartName"
    :custom-bg-url="customBg"
    @close="shareOpen = false"
  />
  <!-- "请先选中会话"提示弹窗:新建对话时未选中任何对话触发 -->
  <Transition name="ns">
    <div v-if="needSelectOpen" class="ns" @click.self="needSelectOpen = false">
      <div class="ns__panel">
        <p class="ns__text">请先选中角色卡片</p>
        <button class="ns__btn" type="button" @click="needSelectOpen = false">确定</button>
      </div>
    </div>
  </Transition>
  <!-- 设置弹窗:API 配置 + 系统提示词 + 角色提示词编辑 + 数据管理 + 背景 -->
  <SettingsDialog
    :open="settingsOpen"
    :custom-bg="customBg"
    :on-bg-change="(v) => (customBg = v)"
    @close="settingsOpen = false"
  />
  <!-- 迁移公告弹窗:进入网站时弹出(自行管理显隐与"不再显示"持久化) -->
  <MigrationNoticeDialog />
</template>

<style scoped lang="scss">
@use './styles/variables' as *;
@use './styles/mixins' as *;

// "请先选中会话"提示弹窗:复用 dialog-shell 基础面板 + 过渡
@include dialog-shell(ns, 280px, 0);

.ns {
  &__text {
    text-align: center;
    color: $color-text-primary;
    font-size: 16px;
  }

  &__btn {
    display: block;
    margin: 0 auto;
  }
}

.edit-toggle {
  position: fixed;
  right: 60px;
  // 整列按钮改到页面顶端,横向等距排布(不再纵向叠在右侧)
  top: 44px;
  z-index: 100;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  width: auto;
  height: auto;

  // 新建对话按钮:位于按钮列最右端
  &--chat09 {
    right: 60px;
  }

  // 背景自定义按钮:位于 chat09 按钮左侧(同排横向等距,75px)
  // 删除对话按钮:与 chat09 同排横向等距(间距 75px)
  &--delete {
    right: 135px;
  }

  // 分享按钮(导出聊天截图):横向等距排列
  &--share {
    right: 210px;
  }

  // 设置按钮:位于按钮列最左侧(share 左侧,同排横向等距)
  &--settings {
    right: 285px;
  }

  img {
    display: block;
    width: 25px;
    height: auto;
    opacity: 0.5;
  }

  // 唯一特效:hover 时图标染为 #999898 灰色
  &:hover img {
    filter: $icon-hover-gray-filter;
  }
}

// ---- 移动端列表视图 --------------------------------------------------------
// 对话列表(526×897 设计稿)等比缩放铺满手机视口;列表自身可滚动。
// stage 顶部预留 MOBILE_LIST_TOP_PAD 空间(fixed 工具栏 + HeaderTop 标题区)。
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
    padding-top: 40px;
  }

  &__zoom {
    position: relative;
    flex: none;
  }
}

// ---- 移动端聊天视图 --------------------------------------------------------
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
    right: 8px;
    top: 0;
    z-index: 130;
    width: 51px;
    height: 51px;
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

// ---- 移动端适配 -----------------------------------------------------------
// 移动端工具栏:图标放大到 28px(触控友好)、间距 38px、起点贴近右边缘 12px,
// 四个按钮(chat09/delete/share/settings)在 ≥320px 视口下完整可见。
@media (max-width: 600px) {
  .edit-toggle {
    right: 12px;
    top: 12px;

    img {
      width: 28px;
    }

    &--chat09 {
      right: 12px;
    }

    &--delete {
      right: 78px;
    }

    &--share {
      right: 144px;
    }

    &--settings {
      right: 210px;
    }
  }
}
</style>
