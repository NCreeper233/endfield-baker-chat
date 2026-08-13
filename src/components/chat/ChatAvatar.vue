<script setup lang="ts">
// =============================================================================
// 聊天头像(bg + portrait + ring 三层)
// -----------------------------------------------------------------------------
// 独立组件,接收 side/stack/baseX/baseY,内部计算 img 相对偏移,
// 与消息循环解耦。
//
// 容器位置与尺寸(left/top/width/height)由父组件通过 :style fallthrough 设置
// (依赖 row 数据,ChatArea 计算)。
// =============================================================================
import { computed } from 'vue'
import { MATERIALS } from '../../constants/materials'
import type { AvatarStack } from '../../constants/design'

const props = defineProps<{
  /** 头像三层槽位(绝对坐标,由 avatarStack 计算) */
  stack: AvatarStack
  /** 头像容器左上 x(绝对坐标,用于换算 img 相对偏移) */
  baseX: number
  /** 头像容器左上 y(绝对坐标,用于换算 img 相对偏移) */
  baseY: number
  /**
   * portrait 头像 URL(本地资源)
   *
   * 由父组件按 side 与当前对话派生传入:
   *   - other : 当前对话对方干员的头像 URL(来自 character.ts,本地托管)
   *   - mine  : 我方默认头像 URL
   */
  portraitUrl: string
}>()

/** bg 层样式:贴满容器(left/top=0,width/height=100%) */
const bgStyle = computed(() => ({
  left: '0px',
  top: '0px',
  width: '100%',
  height: '100%',
}))

/** 圆形头像(portrait)相对容器/头像框的 x 位移(仅移动圆形头像,不动头像框与背景) */
const PORTRAIT_X_ADJ = -1

/** portrait 层样式:相对容器偏移 = 绝对坐标 - baseX/baseY
 *
 * left 再叠加 PORTRAIT_X_ADJ:圆形头像相对头像框/背景左移 2px(视觉微调,非裁剪位置)
 * top:头像框在聊天区域整体垂直对齐(视觉微调,非裁剪位置) */
const portraitStyle = computed(() => ({
  left: `${props.stack.portrait.x - props.baseX + PORTRAIT_X_ADJ}px`,
  top: `${props.stack.portrait.y - props.baseY}px`,
  width: `${props.stack.portrait.w}px`,
  height: `${props.stack.portrait.h}px`,
}))

/**
 * ring 层样式:bg_snscharentry_head_Line.png 旋转 180 度 + scale 放大
 *
 * scale(1.03) 让 frame 整体外扩 3%,内圆相对变大,portrait(0.8) 比环小一圈、居中,视觉更突出。
 * transform-origin: center 保证以 ring 中心为缩放原点,外扩均匀。
 */
const RING_SCALE = 1.03
const ringStyle = computed(() => ({
  left: `${props.stack.ring.x - props.baseX}px`,
  top: `${props.stack.ring.y - props.baseY}px`,
  width: `${props.stack.ring.w}px`,
  height: `${props.stack.ring.h}px`,
  transform: `rotate(180deg) scale(${RING_SCALE})`,
  transformOrigin: 'center',
}))

/**
 * 是否 NPC 占位头像(icon_sns_npc_single_a)
 *
 * 这张素材是 72×131 的竖幅小图(私聊默认),用 cover 裁切会被
 * 放大到只剩下中心一角;换成 contain 完整显示。干员(character)头像本来就是
 * 方形构图,保持 cover 不动。这张图也不参与 scale 收紧裁剪(保持原样显示)。
 *
 * 用 includes 匹配文件名关键字:Vite 构建可能给资源 URL 追加 hash 后缀(如
 * icon_sns_npc_single_a-[hash].webp),若 portraitUrl 经由其他路径(如导入数据)
 * 传入同一资源的不同 URL 形式,全等比较会失败。按文件名关键字匹配更健壮。
 */
const NPC_AVATAR_KEYS = ['icon_sns_npc_single_a']
const isNpcPortrait = computed(() =>
  !!props.portraitUrl && NPC_AVATAR_KEYS.some((k) => props.portraitUrl.includes(k)),
)
</script>

<template>
  <div class="chat-avatar chat-avatar--stack">
    <img class="chat-avatar__bg" :style="bgStyle" :src="MATERIALS.avatarBase" alt="" />
    <!-- portrait 头像 wrapper:overflow:hidden + border-radius:50% 形成圆形裁剪夹层,
         内部 img 用 transform: scale 放大收紧裁剪范围(只保留脑袋部分) -->
    <div class="chat-avatar__portrait-wrap" :style="portraitStyle">
      <img
        class="chat-avatar__portrait"
        :class="{
          'chat-avatar__portrait--npc': isNpcPortrait,
        }"
        :src="portraitUrl"
        alt=""
      />
    </div>
    <img class="chat-avatar__ring" :style="ringStyle" :src="MATERIALS.avatarFrame" alt="" />
  </div>
</template>

<style scoped lang="scss">
.chat-avatar {
  position: absolute;
  transform-origin: 0 0;

  &--stack {
    z-index: 0;
  }

  &__bg {
    position: absolute;
    z-index: 0;
  }

  // portrait 头像 wrapper:绝对定位(由 portraitStyle 设置 left/top/width/height),
  // border-radius:50% + overflow:hidden 形成圆形裁剪夹层,内部 img 放大后只露出圆形范围
  &__portrait-wrap {
    position: absolute;
    z-index: 1;
    overflow: hidden;
    border-radius: 50%;
  }

  &__portrait {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    // 头像原图为竖长方形(如 456x564),取上端正方形区域显示;
    // 再 scale 放大收紧裁剪范围,只保留脑袋部分(去掉周围留白)
    object-position: center top;
    transform: scale(1.4);
    transform-origin: center 50%;
  }

  // NPC 占位头像(icon_sns_npc_single_a,72×131 竖幅):
  // cover 裁切会放大到只剩中心一角,改用 contain 完整显示(居中,不裁切)
  &__portrait--npc {
    object-fit: contain;
    object-position: center center;
    // NPC 用 contain 完整显示,不需要 scale 放大
    transform: none;
  }

  &__ring {
    position: absolute;
    z-index: 2;
  }
}
</style>
