<script setup lang="ts">
// =============================================================================
// 单条消息行
// -----------------------------------------------------------------------------
// 职责:渲染一条 ChatRow 的完整消息(头像/文字气泡/图片),
//       全部定位样式由父级注入的 row 计算。
// 设计理由:从 ChatArea 消息循环中抽出,模板行数减负;
//          头像点击以 emit 上报,父组件统一处理 store 写入。
// =============================================================================
import { computed, inject, onMounted, onUnmounted, ref, toValue, watch, type CSSProperties } from 'vue'
import {
  chatGeometryKey,
  globalChatGeometry,
  DESKTOP_GEOM,
  type ChatGeometry,
} from '../../constants/chatGeometry'
import {
  pos,
  // speakerNameStyle, // 【已注释停用】角色名称显示功能整体停用
} from '../../utils/chatPosition'
import { emojiByMood } from '../../constants/emoji'
import { BUBBLE_FONT } from '../../utils/measure'
import { CENTER_ACTION_COLOR } from '../../constants/colors'
import type { ChatRow, MessageSpeaker } from '../../types/chat'
import { useChatStore } from '../../stores/chat'
import { useAiChat } from '../../composables/useAiChat'
import { useGroupChat } from '../../composables/useGroupChat'
import { closeMessageMenu, messageMenuKey, openMessageMenu } from '../../composables/useMessageMenu'
import ChatAvatar from './ChatAvatar.vue'
import ChatBubble from './ChatBubble.vue'
import MessageActionMenu from './MessageActionMenu.vue'

/** 头像解析函数(由父级传入,与 store/菜单解析链一致) */
type SpeakerAvatarResolver = (msg: MessageSpeaker) => string

// 【已注释停用】(角色名称显示功能整体停用)
// /** 说话人显示名解析函数(角色名称悬浮用) */
// type SpeakerNameResolver = (msg: MessageSpeaker) => string

const props = defineProps<{
  /** 消息行布局结果(rows[i],坐标为滚动容器相对坐标) */
  row: ChatRow
  /** 说话人头像解析(useChatRows.resolveSpeakerAvatar) */
  resolveSpeakerAvatar: SpeakerAvatarResolver
  /**
   * 该行头像能否点击切换形象(useChatRows.isAvatarSwitchable)
   *
   * 只用来决定光标:能点才给手型。other 侧目前只有带两张形象的「管理员」为真。
   */
  isAvatarSwitchable: (msg: MessageSpeaker) => boolean
  // 【已注释停用】角色名称显示功能整体停用
  // /** 说话人显示名解析(useChatRows.resolveSpeakerName) */
  // resolveSpeakerName: SpeakerNameResolver
  // /** 是否显示角色名称悬浮(store.showCharacterNames) */
  // showCharacterNames: boolean
}>()

const emit = defineEmits<{
  'avatar-click': [row: ChatRow]
}>()

const chatStore = useChatStore()
const ai = useAiChat()
/** 群聊走独立服务;单聊/群聊共用同一套"整轮清理 + 重发"的准备逻辑 */
const groupChat = useGroupChat()

/**
 * 重新生成(错误气泡按钮 / 长按菜单共用)
 *
 * 先由 store.prepareRegenerate 清理该轮旧 AI 回复(错误气泡则删除自身),
 * 再以对应的用户消息重新触发 AI。
 *
 * 群聊直接套用同一套准备逻辑:清掉本轮全部角色回复后,让群聊服务按
 * 发言模式重新生成一整轮 —— 与单聊"整轮重生成"的语义完全对齐。
 */
function onRegenerate() {
  const prep = chatStore.prepareRegenerate(props.row.msg.id)
  if (!prep) return
  if (chatStore.activeIsGroup) {
    void groupChat.runTurn({ newTurn: true })
    return
  }
  ai.regenerate(prep.id)
}

// =============================================================================
// 长按 / 右键操作菜单(删除)
// - 移动端:长按 500ms 弹出;触摸移动超过阈值取消
// - 桌面端:右键(contextmenu)弹出
// =============================================================================
const LONG_PRESS_MS = 500
const MOVE_THRESHOLD = 10

/** 菜单是否显示 */
const menuOpen = computed(() => messageMenuKey.value === menuKey.value)
/** 菜单锚点(屏幕坐标) */
const menuPos = ref({ x: 0, y: 0 })

/**
 * 本行菜单的标识
 *
 * 带上会话下标:行标识只保证同一会话内唯一(消息 id 是会话内自增),
 * 切会话后会出现同名的行 —— 带上会话,切换时旧菜单的判据自然失效而关闭。
 */
const menuKey = computed(() => `${chatStore.activeSub ?? -1}:${props.row.key}`)

/**
 * 打开时实际占用的标识
 *
 * 关闭必须用**打开时那个值**,不能在关闭时重算 menuKey:切会话/换行之后
 * menuKey 已经变了,拿新值去释放会认不出自己是持有者,页面级状态(禁止选中)
 * 就永远摘不掉。
 */
let openedKey: string | null = null

/** 打开菜单:抢占占用权 —— 已打开的别的消息菜单会随之关闭 */
function openMenu(clientX: number, clientY: number) {
  menuPos.value = { x: clientX, y: clientY }
  openedKey = menuKey.value
  openMessageMenu(openedKey)
}

/** 关闭菜单(非持有者调用时不会动全局状态,别人的菜单不受影响) */
function closeMenu() {
  if (!openedKey) return
  closeMessageMenu(openedKey)
  openedKey = null
}

let pressTimer: number | undefined
let pressStartX = 0
let pressStartY = 0
/** 长按已触发(用于拦截随后的 click,避免误触头像等) */
let pressTriggered = false

function clearPressTimer() {
  if (pressTimer !== undefined) {
    clearTimeout(pressTimer)
    pressTimer = undefined
  }
}

function onTouchStart(e: TouchEvent) {
  if (menuOpen.value) return
  clearPressTimer()
  const t = e.touches[0]
  pressStartX = t.clientX
  pressStartY = t.clientY
  pressTriggered = false
  pressTimer = window.setTimeout(() => {
    pressTriggered = true
    // Android 触觉反馈
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(12)
    }
    openMenu(pressStartX, pressStartY)
  }, LONG_PRESS_MS)
}

function onTouchMove(e: TouchEvent) {
  if (pressTimer === undefined) return
  const t = e.touches[0]
  if (
    Math.abs(t.clientX - pressStartX) > MOVE_THRESHOLD ||
    Math.abs(t.clientY - pressStartY) > MOVE_THRESHOLD
  ) {
    clearPressTimer()
  }
}

function onTouchEnd() {
  clearPressTimer()
}

function onTouchCancel() {
  clearPressTimer()
}

function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  if (menuOpen.value) {
    closeMenu()
    return
  }
  pressTriggered = false
  openMenu(e.clientX, e.clientY)
}

/** 长按触发后拦截随后的 click(capture 阶段),避免误触头像/其他交互 */
function onCaptureClick(e: MouseEvent) {
  if (pressTriggered) {
    pressTriggered = false
    e.preventDefault()
    e.stopPropagation()
  }
}

/**
 * 选中消息模式:点这一行 = 勾选 / 取消勾选
 *
 * 该模式下所有交互都让位给"选消息"(头像点击等仍按各自语义走,
 * 错误气泡上的「重新生成」按钮带 @click.stop,不会被这里抢走)。
 */
function onRowClick(): void {
  if (!chatStore.msgSelectMode) return
  chatStore.toggleMsgSelect(props.row.msg.id)
}

/** 该行是否已被勾选(选中消息模式) */
const picked = computed(
  () => chatStore.msgSelectMode && chatStore.isMsgSelected(props.row.msg.id),
)

/** 勾选描边环:与气泡/图片同一矩形(不碰气泡组件本身,纯叠加一层) */
const pickRingStyle = computed(() => ({
  ...pos(props.row.left, props.row.bubbleTop, props.row.box.rectW, props.row.box.rectH),
}))

onUnmounted(() => {
  clearPressTimer()
  closeMenu()
})

// 会话切换 / 行标识变化:把占用权与页面级状态一并收干净
// (切会话后本行的判据已不成立,菜单不再显示,此时必须主动释放,
//  否则 body 上的"禁止选中"会一直挂着)
watch(menuKey, () => closeMenu())

/** 注入几何(头像盒尺寸等;默认全局,导出模式由 ChatExportStage 覆盖)。
 * 注意:inject 必须在 setup 期间立即调用(见 ChatArea 同款注释)。 */
const injectedGeom = inject(chatGeometryKey, globalChatGeometry) ?? DESKTOP_GEOM
const geom = computed<ChatGeometry>(() => toValue(injectedGeom))

/**
 * 图片消息展开动画
 *
 * 图片消息不显示 LoadingBubble,改为自身"从中心点展开淡入":
 * - 追加新消息(row.prevRect 存在):从 scale(0.3) + opacity 0 过渡到原尺寸
 * - 首屏:无动画,直接原尺寸显示
 * 用与 ChatBubble 相同的双 rAF 手法:先 paint 初始态,再切换目标值触发 CSS transition。
 */
const imageExpanded = ref(false)

/** 是否需要图片展开动画(非首屏追加) */
const imageAnimating = computed(() => !!props.row.prevRect)

/**
 * 展开动画的双层 rAF 句柄
 *
 * 保存到实例变量,组件卸载时统一 cancelAnimationFrame,
 * 避免已卸载组件的 imageExpanded 被回调写入。
 */
let imgRaf1 = 0
let imgRaf2 = 0

onMounted(() => {
  if (imageAnimating.value) {
    imgRaf1 = requestAnimationFrame(() => {
      imgRaf2 = requestAnimationFrame(() => {
        imageExpanded.value = true
      })
    })
  }
})

// 卸载时清理未触发的 rAF,避免回调写入已卸载组件的 imageExpanded
onUnmounted(() => {
  if (imgRaf1) cancelAnimationFrame(imgRaf1)
  if (imgRaf2) cancelAnimationFrame(imgRaf2)
})

/** 图片展开动画的 style:从锚定侧(对方左缘 / 我方右缘)向外展开 + 淡入 */
const imageAnimStyle = computed(() => {
  if (!imageAnimating.value) return {}
  return {
    transform: imageExpanded.value ? 'scale(1)' : 'scale(0.3)',
    opacity: imageExpanded.value ? 1 : 0,
    'transform-origin': props.row.msg.side === 'mine' ? 'right center' : 'left center',
    transition: 'transform 0.14s ease-out, opacity 0.14s ease-out',
  }
})

/**
 * 心情表情(气泡角落图标)
 *
 * 后端可选返回 mood 字段(token 形式如 "sns_emoji_001"),
 * 此处映射到表情包图片并贴在气泡角落;缺失/未知 token 时不渲染。
 */
const moodEmoji = computed(() => {
  const mood = props.row.msg.mood
  return mood ? emojiByMood(mood) : undefined
})

/** 心情表情图标尺寸(px,方形统一大小;异形表情按原宽高比缩放) */
const MOOD_ICON_SIZE = 26

/** 心情表情的定位:贴气泡角落(other 左上 / mine 右上),略微内收避免压到文字 */
const moodStyle = computed<CSSProperties>(() => {
  const left = props.row.left
  const top = props.row.bubbleTop
  const isMine = props.row.msg.side === 'mine'
  const margin = 6
  const x = isMine ? left + props.row.box.rectW - MOOD_ICON_SIZE - margin : left + margin
  return {
    position: 'absolute',
    left: `${x}px`,
    top: `${top + margin}px`,
    width: `${MOOD_ICON_SIZE}px`,
    height: `${MOOD_ICON_SIZE}px`,
    zIndex: 2,
  }
})

/** 错误气泡定位:占满 useChatRows 为该消息预留的高度(含按钮区域) */
/** 「新话题」提示行的样式(无头像无气泡,一行半透明灰字) */
const topicStyle = computed<CSSProperties>(() => {
  const row = props.row
  const g = geom.value
  return {
    position: 'absolute',
    left: `${row.left}px`,
    top: `${row.bubbleTop}px`,
    // 宽度交给浏览器自适应,只给上限 —— 绝不用测量出来的精确宽度,
    // 那会因亚像素差异把最后一个字挤到下一行
    width: 'auto',
    maxWidth: `${g.bubbleInnerMaxW}px`,
    // 高度取测量值(收窄测量 → 行数是上限),不会与下一条重叠
    height: `${row.box.rectH}px`,
    fontSize: `${g.topicFontSize}px`,
    lineHeight: `${g.topicLineHeight}px`,
  }
})

const errorBubbleStyle = computed<CSSProperties>(() => {
  const row = props.row
  const isMine = row.msg.side === 'mine'
  return {
    position: 'absolute',
    left: `${row.left}px`,
    top: `${row.bubbleTop}px`,
    width: `${row.box.rectW}px`,
    height: `${row.box.rectH}px`,
    alignItems: isMine ? 'flex-end' : 'flex-start',
  }
})

// =============================================================================
// 括号描写居中行(设置项「括号描写居中」)
// -----------------------------------------------------------------------------
// 形态:一行**纯居中文本**(无气泡、无头像、无左右归属),左右各内缩
// centerTextPadX 以免长句顶到聊天框边缘。
// 样式为什么走 inline(而不是 scoped CSS):
//   1. 几何必须与 useChatRows 的测量口径同源,一律取几何层
//   2. 颜色(尤其 -webkit-text-fill-color)必须 inline:html-to-image 克隆节点时会把
//      计算样式整份内联,该属性会带上根节点的黑色并继承下去、压过 color,
//      导致导出图里的居中文字变黑(与 ChatBubble 的内文同款处理)
// =============================================================================

/** 居中行容器:几何全部由几何层内联注入(文本宽/字号/内缩与测量口径一致) */
const centeredStyle = computed<CSSProperties>(() => {
  const g = geom.value
  return {
    position: 'absolute',
    left: `${g.centerTextPadX}px`,
    top: `${props.row.bubbleTop}px`,
    width: `${g.scrollW - g.centerTextPadX * 2}px`,
    height: `${props.row.box.rectH}px`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }
})

/** 居中文字:宽度取测量值(容器内居中) */
const centeredTextStyle = computed<CSSProperties>(() => {
  // 「彩色括号描写」/「居中我方括号内容」:按说话人属性上色(useChatRows 算好);
  // 没有颜色时回退到统一的居中文本色
  const color = props.row.centerColor || CENTER_ACTION_COLOR
  return {
    fontFamily: BUBBLE_FONT,
    fontSize: `${geom.value.bubbleFontSize}px`,
    lineHeight: `${geom.value.bubbleLineHeight}px`,
    textAlign: 'center',
    whiteSpace: 'pre-line',
    wordBreak: 'break-word',
    color,
    '-webkit-text-fill-color': color,
    userSelect: 'text',
  }
})
</script>

<template>
  <!-- 群聊「新话题」提示行:小字 + 半透明灰,不画头像/气泡,
       也不挂长按菜单(它不是一条真实消息) -->
  <div v-if="row.isTopic" class="chat-topic-line" :style="topicStyle">
    新话题：{{ row.msg.text }}
  </div>

  <!-- 事件包裹层:长按/右键弹操作菜单;0×0 定位不干扰子元素绝对定位 -->
  <div
    v-else
    class="chat-message-row"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend="onTouchEnd"
    @touchcancel="onTouchCancel"
    @contextmenu="onContextMenu"
    @click.capture="onCaptureClick"
    @click="onRowClick"
  >
    <ChatAvatar
      v-if="row.showAvatar"
      :stack="row.stack"
      :base-x="row.avatarX"
      :base-y="row.avatarTop"
      :portrait-url="resolveSpeakerAvatar(row.msg)"
      :class="{ 'chat-avatar--pickable': row.msg.side === 'mine' || isAvatarSwitchable(row.msg) }"
      :style="pos(row.avatarX, row.avatarTop, geom.avatarBox, geom.avatarBox)"
      @click="emit('avatar-click', row)"
    />
    <!-- 角色名称悬浮(已注释停用):贴在带头像消息的气泡上缘上方,悬浮于消息间空隙(不占布局);
          锚定跟随气泡侧缘(other 左缘起向右 / mine 右缘起向左),仅带头像行显示 -->
    <!-- <span
      v-if="row.showAvatar && showCharacterNames"
      class="chat-speaker-name"
      :style="speakerNameStyle(row.msg.side, row.left, row.left + row.box.rectW, row.bubbleTop)"
    >{{ resolveSpeakerName(row.msg) }}</span> -->
    <!-- 括号描写居中行(实验性功能「括号描写居中」):无气泡 / 无头像 / 无左右归属,
         一行纯居中文本;displayText 已去掉最外层括号(见 aiText.splitBracketParts)。
         每次挂载都播入场动画(淡入 + 上浮),与 maker 播放模式的居中文本一致 ——
         逐拍显示时它先单独出现,动画因此看得见 -->
    <div v-if="row.isCentered" class="chat-centered" :style="centeredStyle">
      <span class="chat-centered__text" :style="centeredTextStyle">{{ row.displayText }}</span>
    </div>
    <ChatBubble
      v-else-if="!row.msg.image && !row.msg.isError"
      :text="row.displayText"
      :box="row.box"
      :side="row.msg.side"
      :left="row.left"
      :top="row.bubbleTop"
      :prev-rect="row.prevRect"
      :picked="picked"
    />
    <!-- 错误消息:红色错误气泡 + 下方"重新生成"按钮(不写入上下文历史) -->
    <div
      v-else-if="row.msg.isError"
      class="chat-error-bubble"
      :style="errorBubbleStyle"
    >
      <div class="chat-error-bubble__text">{{ row.displayText }}</div>
      <button class="chat-error-bubble__retry" @click.stop="onRegenerate">
        ↻ 重新生成
      </button>
    </div>
    <!-- 心情表情:后端 mood 字段映射的表情包图片,贴在气泡角落(无 mood 不渲染)。
         一条消息拆成多行时只挂首条气泡行(moodRow);居中行没有气泡可挂,不渲染 -->
    <img
      v-if="!row.msg.image && moodEmoji && row.moodRow && !row.isCentered"
      class="chat-mood-emoji"
      :src="moodEmoji.src"
      :alt="moodEmoji.token"
      :style="moodStyle"
    />
    <!-- 图片消息:纯图片无气泡(固定显示区域,contain 等比完整显示);
          追加时带展开动画,首屏直接显示 -->
    <img
      v-else-if="row.msg.image"
      class="chat-image"
      :class="{ 'chat-image--anim': imageAnimating }"
      :src="row.msg.image"
      :style="[pos(row.left, row.bubbleTop, row.box.rectW, row.box.rectH), imageAnimStyle]"
      alt=""
    />

    <!-- 选中消息模式:图片 / 错误气泡没有 SVG 轮廓可描,用同尺寸的框标出;
         文字气泡的标记由 ChatBubble 自己沿着气泡(含尾巴)描边,不在这里叠框 -->
    <div
      v-if="picked && (row.msg.image || row.msg.isError)"
      class="chat-pick-ring"
      :style="pickRingStyle"
    />

    <!-- 长按/右键操作菜单(重新生成 / 导出选中消息 / 删除) -->
    <MessageActionMenu
      :open="menuOpen"
      :x="menuPos.x"
      :y="menuPos.y"
      :can-regenerate="row.msg.side === 'other'"
      @close="closeMenu"
      @regenerate="onRegenerate"
      @pick-messages="chatStore.startMsgSelect(row.msg.id)"
      @delete-round="chatStore.deleteRound(row.msg.id)"
      @delete-message="chatStore.deleteMessage(row.msg.id)"
    />
  </div>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

// 事件包裹层:0×0 锚点,不干扰子元素绝对定位(子元素坐标仍相对滚动容器)
// 「新话题」提示行:半透明灰,字体与正文同族,只是小一档
.chat-topic-line {
  color: rgba(255, 255, 255, 0.38);
  font-family: $font-harmony;
  white-space: pre-wrap;
  word-break: break-word;
  pointer-events: none;
  user-select: none;
}

// 选中消息模式的勾选标记:沿气泡/图片矩形描一圈黄边(纯叠加层,不碰气泡组件)。
//
// position: absolute 必须显式写 —— pos() 只给 left/top/width/height,不给定位方式;
// 少了它,这个环就是普通静态块,left/top 会被忽略、直接落在行容器原点(聊天区左上角),
// 看起来就是"跑到别处去了"。行容器自身是 0×0 的 absolute 锚点,坐标系与气泡一致。
.chat-pick-ring {
  position: absolute;
  border: 2px solid $color-subcard-selected;
  border-radius: 4px;
  box-shadow: 0 0 12px rgba(255, 239, 0, 0.35);
  pointer-events: none;
}

// 括号描写居中行:纯居中文本(结构样式;几何与颜色都在 inline style)
.chat-centered {  position: absolute;
  // 入场:淡入 + 轻微上浮(节奏与 keyframes 同 maker 的 centered-in;
  // 每次挂载都播,故"关掉→再打开"也能看到它入场)
  animation: centered-in $anim-chat-in $ease-default backwards;

  &__text {
    word-break: break-word;
  }
}

.chat-message-row {
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
}

// 图片消息:纯图片无气泡,按真实显示尺寸渲染(无底色)
.chat-image {
  position: absolute;
  border-radius: 12px;
}

// 我方头像可点击(点击切换管理员性别)
.chat-avatar--pickable {
  cursor: pointer;
}

// 心情表情图标(气泡角落):透明背景直接显示表情图,轻微描边阴影增强可读性
.chat-mood-emoji {
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.12);
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.25));
  object-fit: contain;
  pointer-events: none;
  user-select: none;
}

// 错误消息气泡:深红底色 + 错误文本 + "重新生成"按钮(按钮固定在气泡底部)
.chat-error-bubble {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  box-sizing: border-box;
  padding: 10px 12px;
  background: rgba(120, 28, 38, 0.82);
  border: 1px solid rgba(255, 90, 90, 0.5);
  border-radius: 12px;
  backdrop-filter: blur(4px);
  user-select: none;

  &__text {
    font-size: 13px;
    line-height: 1.5;
    color: #ffb3b3;
    word-break: break-all;
    white-space: pre-wrap;
  }

  &__retry {
    align-self: flex-start;
    margin-top: 8px;
    padding: 5px 12px;
    border: 1px solid rgba(255, 120, 120, 0.6);
    border-radius: 999px;
    background: rgba(255, 90, 90, 0.18);
    color: #ffb3b3;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;

    &:hover {
      background: rgba(255, 90, 90, 0.35);
      color: #fff;
    }
  }
}
</style>