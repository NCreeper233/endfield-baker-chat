<script setup lang="ts">
// SubCard —— 子卡（点击切换当前对话）
// 选中态联动：黄层 scaleX、纹理与图标框透明、图标暗化、文字变色、装饰与箭头显示。
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
 * 移动端进入聊天视图(由 App provide;桌面端为空操作 —— 内部会判断 isMobile)
 */
const enterMobileChat = inject<(() => void) | null>('enterMobileChat', null)

/**
 * 移动端单击即进入对话（双击在列表里既慢又容易点空）；桌面端 enterMobileChat 内判
 * isMobile，是空操作。删除模式下点击改为勾选，否则无法多选。
 */
function onTap(): void {
  if (chatStore.deleteMode) {
    chatStore.toggleDeleteSelect(props.subIndex)
    return
  }
  chatStore.selectSub(props.subIndex)
  enterMobileChat?.()
}

const chatStore = useChatStore()

/**
 * 该子卡是否选中(全局单选)
 *
 * 删除模式下不再画常规的"选中黄层":那时的"选中"由左缘的悬浮黄条表达
 * (见下方 isDeleteSelected),两套高亮同时出现会分不清"选了几段"。
 */
const isSelected = computed(() => !chatStore.deleteMode && chatStore.activeSub === props.subIndex)

/** 该子卡是否已在删除模式里被勾选(画悬浮黄条) */
const isDeleteSelected = computed(() => chatStore.isDeleteSelected(props.subIndex))

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
    @click="onTap"
  >
    <div class="subcard__rect" />
    <!-- 删除模式:被勾选的对话在左缘挂一条悬浮黄条 -->
    <span v-if="isDeleteSelected" class="subcard__del-bar" />
    <img class="subcard__texture" :src="MATERIALS.cardTexture" alt="" loading="lazy" decoding="async" />
    <img class="subcard__faint" :src="MATERIALS.subFaint" alt="" loading="lazy" decoding="async" />
    <div class="subcard__icon-box" />
    <img class="subcard__arrow" :src="MATERIALS.subArrow" alt="" loading="lazy" decoding="async" />
    <img class="subcard__arrow subcard__arrow--second" :src="MATERIALS.subArrow" alt="" loading="lazy" decoding="async" />
    <img class="subcard__icon" :src="badgeIcon" alt="" loading="lazy" decoding="async" />
    <p class="subcard__text" v-html="previewHtml"></p>
    <!-- 小方块装饰:原 deco_sns_tweet_decorate_06.webp 只是 21×21 画布左上角
         4×4 的一小块,已弃用素材,改为直接绘制(见样式里的 &__deco-badge) -->
    <span class="subcard__deco-badge" />
    <img class="subcard__deco-wing" :src="MATERIALS.decoWing" alt="" loading="lazy" decoding="async" />
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
  // top 由父组件通过 :style 传入；带过渡，最近活跃的子卡换到最前时整列会滑过去
  // （与主卡 .card-unit 的 0.3s 一致）。挂载时不会播：首帧没有上一个 top 值。
  transition: top 0.3s ease;
  // hover 白层(与主卡共用 hover-overlay mixin)
  @include hover-overlay(435.53px, 68.95px, 4.12px);

  // 勾选黄条入场:从中间长出来(纯视觉,不影响布局)
  @keyframes subcard-del-bar-in {
    from {
      opacity: 0;
      transform: scaleY(0.35);
    }
    to {
      opacity: 1;
      transform: scaleY(1);
    }
  }

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

  // 删除模式的勾选标记:左缘一条悬浮黄条(与 rect 同高,略探出卡片左缘)
  //
  // 用自绘而非沿用选中黄层:黄层会把整张卡刷成黄色,多选时一片黄
  // 反而看不出"选了哪几段";细黄条 + 阵列感更清楚。
  &__del-bar {
    position: absolute;
    left: -5px;
    top: 0;
    width: 5px;
    height: 68.95px;
    border-radius: 2px;
    background: $color-subcard-selected;
    box-shadow: 0 0 12px rgba(255, 239, 0, 0.45);
    pointer-events: none;
    animation: subcard-del-bar-in 0.18s ease-out;
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
  // 选中时同时压制 hover 白层:选中子卡后鼠标停在卡上也会保持 is-hover,
  // 若不压制,白层会因"选中+悬停"而常显。
  &.is-selected {
    &::before {
      opacity: 0;
    }

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

  // 小方块装饰(自绘,不再用素材)
  //
  // 原 deco_sns_tweet_decorate_06.webp 是 21×21 位图,但内容只有左上角 4×4
  // 的一小块(其余全透明,由 42 的同类素材可推知这是裁切留白)。按原显示尺寸
  // 29.19px / 21 = 1.39 换算,这一小块即 4 × 1.39 = 5.56px,正好落在原框左上角。
  //
  // 颜色:原图是纯白 + brightness(0.11),255 × 0.11 ≈ 28 = #1c1c1c,
  // 与 $color-subcard-line 完全同值,故直接上色、不再套滤镜。
  &__deco-badge {
    position: absolute;
    left: 26.76px;
    top: 11.43px;
    width: 5.56px;
    height: 5.56px;
    background: $color-subcard-line;
    opacity: 0;
    transition: opacity 0.25s ease;
  }

  // 虚线装饰(现已改用矢量 deco_sns_tweet_decorate_42.svg)
  //
  // 原 42.webp 是 31×9 位图,内容仅占其中 29×7(左、上各 2px 透明留白,
  // 右、下为 0);而 svg 的 viewBox 28.45×6.93 是**紧贴内容**的裁切。
  // 若沿用原框(38.13×11.07,按 31×9 定尺寸),svg 会被拉伸到 3.444 的
  // 宽高比 —— 纵向拉长约 30%,虚线明显变粗。
  // 故把框改成"内容本身"的尺寸与位置:
  //   缩放 38.13 / 31 = 1.23 → 内容 29×1.23 = 35.67 宽,7×1.23 = 8.61 高
  //   位置也要补回被裁掉的留白:(2,2) × 1.23 = 2.46 → 左 34.99+2.46、上 5.65+2.46
  //   高度按 svg 宽高比 28.45/6.93 = 4.1053 反推:35.67 / 4.1053 = 8.69
  &__deco-wing {
    position: absolute;
    left: 37.45px;
    top: 8.11px;
    width: 35.67px;
    height: 8.69px;
    transform: scaleX(-1);
    opacity: 0;
    filter: brightness(0.11);
    transition: opacity 0.25s ease;
  }
}
</style>
