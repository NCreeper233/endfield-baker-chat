<script setup lang="ts">
// =============================================================================
// 单条消息行
// -----------------------------------------------------------------------------
// 职责:渲染一条 ChatRow 的完整消息(头像/文字气泡/图片),
//       全部定位样式由父级注入的 row 计算。
// 设计理由:从 ChatArea 消息循环中抽出,模板行数减负;
//          头像点击以 emit 上报,父组件统一处理 store 写入。
// =============================================================================
import { computed, inject, onMounted, onUnmounted, ref, toValue } from 'vue'
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
import type { ChatRow, MessageSpeaker } from '../../types/chat'
import ChatAvatar from './ChatAvatar.vue'
import ChatBubble from './ChatBubble.vue'

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
  // 【已注释停用】角色名称显示功能整体停用
  // /** 说话人显示名解析(useChatRows.resolveSpeakerName) */
  // resolveSpeakerName: SpeakerNameResolver
  // /** 是否显示角色名称悬浮(store.showCharacterNames) */
  // showCharacterNames: boolean
}>()

const emit = defineEmits<{
  'avatar-click': [row: ChatRow]
}>()

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
</script>

<template>
  <ChatAvatar
    v-if="row.showAvatar"
    :stack="row.stack"
    :base-x="row.avatarX"
    :base-y="row.avatarTop"
    :portrait-url="resolveSpeakerAvatar(row.msg)"
    :class="{ 'chat-avatar--pickable': row.msg.side === 'mine' }"
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
  <ChatBubble
    v-if="!row.msg.image"
    :text="row.displayText"
    :box="row.box"
    :side="row.msg.side"
    :left="row.left"
    :top="row.bubbleTop"
    :prev-rect="row.prevRect"
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
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

// 图片消息:纯图片无气泡,按真实显示尺寸渲染(无底色)
.chat-image {
  position: absolute;
  border-radius: 12px;
}

// 我方头像可点击(点击切换管理员性别)
.chat-avatar--pickable {
  cursor: pointer;
}
</style>