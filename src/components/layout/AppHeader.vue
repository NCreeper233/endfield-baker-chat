<script setup lang="ts">
// AppHeader —— 页面顶栏：左品牌标题，中单聊 / 群聊页签（相对页面居中，不是相对聊天区）
import { MATERIALS } from '../../constants/materials'
import ChatModeTabs from '../chat/ChatModeTabs.vue'
import type { ChatMode } from '../chat/ChatModeTabs.vue'

const props = withDefaults(
  defineProps<{
    /** 当前会话模式 */
    mode: ChatMode
    /** 端:桌面端走设计画布绝对定位,移动端是贴视口顶部的 fixed 条 */
    variant?: 'desktop' | 'mobile'
  }>(),
  { variant: 'desktop' },
)

const emit = defineEmits<{
  (e: 'update:mode', mode: ChatMode): void
}>()
</script>

<template>
  <header class="app-bar" :class="`app-bar--${props.variant}`">
    <div class="app-bar__brand">
      <img class="app-bar__deco" :src="MATERIALS.headerDeco" alt="" />
      <p class="app-bar__title">//BAKER/会话消息</p>
    </div>

    <ChatModeTabs :mode="mode" @update:mode="emit('update:mode', $event)" />
  </header>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

.app-bar {
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  align-items: flex-start;
  // 页签相对整条横栏居中 = 相对页面居中
  justify-content: center;
  pointer-events: none;

  // 顶栏本身完全透明:斜纹只来自页签自己的 .pn-tabs__backdrop(与设置弹窗一致),
  // 这里再画一层就会变成两层斜纹。
  &__brand {
    position: absolute;
    left: 43px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    gap: 2px;
    pointer-events: none;
  }

  &__deco {
    display: block;
    width: 63px;
    height: 12px;
  }

  &__title {
    margin: 0;
    line-height: 1;
    white-space: nowrap;
    color: $color-text-primary;
    font-size: $font-size-title;
    font-weight: 500;
    letter-spacing: -0.5px;
    user-select: text;
  }

  // ---- 桌面端:1920 设计画布坐标 ------------------------------------------
  // 顶栏整体加高,**宽高同比放大**(页签 66×56 → 86×72),但里面的图标/文字
  // 尺寸保持原样。页签背板仍紧贴页面顶端(与设置菜单一致),图标靠 flex 居中
  // 自动下沉,不会贴住上边缘。
  &--desktop {
    width: 1920px;
    height: 80px;
    z-index: 4;

    :deep(.pn-tabs) {
      height: 72px;
    }

    :deep(.pn-tab) {
      width: 86px;
      height: 72px;
    }
  }

  // ---- 移动端:贴视口顶部的固定条 ----------------------------------------
  &--mobile {
    position: fixed;
    right: 0;
    width: auto;
    height: calc(50px + var(--safe-top, 0px));
    padding-top: var(--safe-top, 0px);
    box-sizing: border-box;
    z-index: 120;

    .app-bar__brand {
      left: 12px;
      gap: 1px;
    }

    .app-bar__deco {
      width: 40px;
      height: 8px;
    }

    .app-bar__title {
      font-size: 13px;
    }

    // 手机屏窄:页签不能再按桌面比例放大,否则会压到左边的标题。
    // 这里取 56×50(触控仍够大),同样紧贴页面顶端,图标靠居中自动下沉。
    :deep(.pn-tabs) {
      height: 50px;
      padding: 0 14px;
    }

    :deep(.pn-tab) {
      width: 56px;
      height: 50px;
    }

    :deep(.pn-tab__icon) {
      width: 20px;
      height: 20px;
    }
  }
}
</style>
