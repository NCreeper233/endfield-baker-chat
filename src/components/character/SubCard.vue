<script setup lang="ts">
// =============================================================================
// 子卡(可选中,选中后切换当前对话)
// -----------------------------------------------------------------------------
// 职责:
// 1. 渲染子卡视觉(rect/texture/faint/icon-box/icon/arrow/text/deco/line)
// 2. 选中态联动:rect::after 黄层 scaleX + texture/icon-box 透明 + icon 暗化 +
//    text 变色 + deco 显示 + arrow 显示
// 3. click:调用 store.selectSub(subIndex)
//
// 单文件渲染,由 CharacterCardItem 传入 subIndex/isSecond/isHover。
// =============================================================================
import { computed, inject } from 'vue'
import { useChatStore } from '../../stores/chat'
import { MATERIALS } from '../../constants/materials'
import { emojiToHtml } from '../../constants/emoji'
import { findCharacter } from '../../constants/character'

const props = defineProps<{
  /** 子卡全局索引(扁平 conversations 下标) */
  subIndex: number
  /** 是否为第二张及以后的子卡(影响 arrow 过渡时长) */
  isSecond: boolean
  /** 子卡相对主卡顶部的 top 偏移(由父组件按 subTopInCard 计算) */
  top: number
  /** 是否 hover(由父组件管理) */
  isHover: boolean
}>()

/**
 * 移动端双击进入聊天视图(由 App provide;桌面端为 null/空操作)。
 * 单击只高亮选中(selectSub),双击时两次 click 已先完成选中,进入即显示该对话。
 */
const enterMobileChat = inject<(() => void) | null>('enterMobileChat', null)

const chatStore = useChatStore()

/** 该子卡是否选中(全局单选) */
const isSelected = computed(() => chatStore.activeSub === props.subIndex)

/**
 * 子卡预览文本
 *
 * - 有消息时:显示最后一条消息文本(我方或对方)
 * - 无消息时:按会话名(角色名)查性别,显示"和他/她聊聊"
 *   查不到角色的回退"和TA聊聊"
 * 超长由 CSS ellipsis 截断为 "..."。
 */
const previewText = computed(() => {
  // 有消息:直接显示最后一条
  const lastText = chatStore.subPreviewTexts[props.subIndex]
  if (lastText) return lastText

  // 无消息:按角色名查性别
  const convName = chatStore.conversations[props.subIndex]?.name ?? ''
  const character = findCharacter(convName)
  const g = character?.gender
  return g === 'male' ? '和他聊聊' : g === 'female' ? '和她聊聊' : '和TA聊聊'
})

/** 预览渲染 HTML(表情 token → <img>,供 v-html) */
const previewHtml = computed(() => emojiToHtml(previewText.value))

/** 子卡根样式:动态 top 偏移(由父组件传入) */
const rootStyle = computed(() => ({
  top: props.top + 'px',
}))

/** 子卡图标:永远使用 chatBadge(01) + 角标动画 */
const badgeIcon = computed(() => MATERIALS.chatBadge)
</script>

<template>
  <div
    class="subcard"
    :class="{
      'subcard--second': isSecond,
      'is-hover': isHover,
      'is-selected': isSelected,
    }"
    :style="rootStyle"
    @click="chatStore.selectSub(subIndex)"
    @dblclick="enterMobileChat?.()"
  >
    <div class="subcard__rect" />
    <img class="subcard__texture" :src="MATERIALS.cardTexture" alt="" />
    <img class="subcard__faint" :src="MATERIALS.subFaint" alt="" />
    <div class="subcard__icon-box" />
    <img class="subcard__arrow" :src="MATERIALS.subArrow" alt="" />
    <img class="subcard__arrow subcard__arrow--second" :src="MATERIALS.subArrow" alt="" />
    <img class="subcard__icon" :src="badgeIcon" alt="" />
    <p class="subcard__text" v-html="previewHtml"></p>
    <img class="subcard__deco-badge" :src="MATERIALS.decoBadge" alt="" />
    <img class="subcard__deco-wing" :src="MATERIALS.decoWing" alt="" />
    <div class="subcard__line" />
  </div>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

.subcard {
  position: absolute;
  left: 70.77px;
  top: 100.86px;
  width: 0;
  height: 0;
  // hover 白层(与主卡共用 hover-overlay mixin)
  @include hover-overlay(435.53px, 68.95px, 4.12px);

  // top 由父组件通过 :style 传入(支持任意子卡数量);
  // --second 仅保留用于 arrow 过渡时长区分,不再覆盖 top
  &--second {
    // top 不再写死,由父组件传入
  }

  &__rect {
    position: absolute;
    left: 0;
    top: 0;
    width: 435.53px;
    height: 68.95px;
    border-radius: 4.12px;
    background: $color-subcard-bg;
    opacity: 1;

    // 选中黄层(scaleX 从 0 到 1)
    &::after {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      border-radius: inherit;
      background: $color-subcard-selected;
      transform: scaleX(0);
      transform-origin: left center;
      transition: transform 0.1s ease-out;
    }
  }

  &__texture {
    position: absolute;
    left: 0;
    top: 0;
    width: 434.72px;
    height: 68.4px;
    opacity: 0.5;
    transition: opacity 0.25s ease;
  }

  &__faint {
    position: absolute;
    left: 297.93px;
    top: 0.38px;
    width: 137.6px;
    height: 68px;
    opacity: 0.02;
  }

  &__icon-box {
    position: absolute;
    left: 11.93px;
    top: 9.93px;
    width: 49.08px;
    height: 49.08px;
    border-radius: 2.74px;
    background: $color-subcard-icon-box;
    transition: opacity 0.25s ease;
  }

  &__icon {
    position: absolute;
    left: 20.72px;
    top: 24.31px;
    width: 31.5px;
    height: 25.5px;
    filter: brightness(0.882);
    transition: filter 0.25s ease;
  }

  &__arrow {
    position: absolute;
    left: 70.89px;
    top: 0.16px;
    width: 48px;
    height: 71.04px;
    opacity: 0;
    filter: brightness(0.11);
    transform: translateX(-40px);
    transition: transform 0.15s ease-out, opacity 0.15s ease-out;

    // 第二张子卡的 arrow 过渡时长更长(首张 0.15s,其余 0.25s)
    &--second {
      left: 115.45px;
      top: 0;
      transition: transform 0.25s ease-out, opacity 0.25s ease-out;
    }
  }

  &__text {
    position: absolute;
    left: 82.59px;
    top: 24.32px;
    // 可视宽度 = rect 宽 435.53 - text 起点 82.59 - 右侧留白 25.94 ≈ 327px
    // 超出部分由 ellipsis 自动截断为 "..."
    max-width: 327px;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1;
    white-space: nowrap;
    color: $color-subcard-text;
    font-size: $font-size-subcard;
    user-select: text;
    transition: color 0.25s ease;
  }

  &__line {
    position: absolute;
    left: 27.38px;
    top: 54.11px;
    width: 62.71px;
    height: 0.6px;
    background: $color-subcard-line;
    opacity: 0;
    transition: opacity 0.25s ease;
  }

  // 选中态联动:黄层展开 + texture/icon-box 透明 + icon 暗化 +
  //           text 变色 + deco 显示 + arrow 显示
  &.is-selected {
    .subcard__rect::after {
      transform: scaleX(1);
    }

    .subcard__texture,
    .subcard__icon-box {
      opacity: 0;
    }

    .subcard__icon {
      filter: brightness(0.11);
    }

    .subcard__text {
      color: $color-subcard-text-selected;
    }

    .subcard__deco-badge,
    .subcard__deco-wing,
    .subcard__line {
      opacity: 1;
    }

    .subcard__arrow {
      opacity: 0.15;
      transform: translateX(0);
    }
  }

  &__deco-badge {
    position: absolute;
    left: 26.76px;
    top: 11.43px;
    width: 29.19px;
    height: 29.19px;
    opacity: 0;
    filter: brightness(0.11);
    transition: opacity 0.25s ease;
  }

  &__deco-wing {
    position: absolute;
    left: 34.99px;
    top: 5.65px;
    width: 38.13px;
    height: 11.07px;
    transform: scaleX(-1);
    opacity: 0;
    filter: brightness(0.11);
    transition: opacity 0.25s ease;
  }
}
</style>
