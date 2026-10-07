<script setup lang="ts">
// =============================================================================
// 底部面板矩形壳(PanelShell)
// -----------------------------------------------------------------------------
// ChatInput 底部面板渲染同一套"矩形背景 + 顶部羽化 + 顶部装饰图 + 内容"几何
// (全部来自 constants/panel 共享常量),收敛于此:
//   - 面板矩形(#3c3b39,底部圆角,贴 chat_strip_detail 底边)
//   - 面板上边缘上方的羽化渐隐(两端统一;高度取几何层 panelEdgeMaskH)
//   - 面板上边缘上方的装饰图(choiceTopDeco,水平居中,仅桌面端有该素材)
//   - slot 内容(聊天输入区 + 弹出面板)
//
// 层级顺序靠 DOM:羽化 → 装饰图 → slot。装饰图与羽化在竖直方向有重叠,
// 装饰图在后因而压在渐变之上,不会被面板色洗掉。
//
// 布局规则(flex / transform-origin 过渡)由消费者通过 class 透传
// (单根组件支持属性透传,class 合并到面板元素)。
// =============================================================================
import { computed, inject, toValue } from 'vue'
import {
  chatGeometryKey,
  globalChatGeometry,
  DESKTOP_GEOM,
  type ChatGeometry,
} from '../../constants/chatGeometry'
import { MATERIALS } from '../../constants/materials'

const props = defineProps<{
  /** 面板高度(px) */
  height: number
  /** 面板顶(px,相对 .chat-area;默认取几何层面板顶) */
  top?: number
}>()

/** 注入几何(面板位置/尺寸;默认全局,导出模式由 ChatExportStage 覆盖)。
 * 注意:inject 必须在 setup 期间立即调用(见 ChatArea 同款注释)。 */
const injectedGeom = inject(chatGeometryKey, globalChatGeometry) ?? DESKTOP_GEOM
const geom = computed<ChatGeometry>(() => toValue(injectedGeom))

/** 面板顶(几何层:桌面 = detail 底边 - 面板高 - 3px) */
const panelTop = computed(() => props.top ?? geom.value.panelTop)

/** 面板坐标(贴 chat_strip_detail 底边) */
const panelStyle = computed(() => ({
  left: `${geom.value.panelLeft}px`,
  width: `${geom.value.panelWidth}px`,
  top: `${panelTop.value}px`,
  height: `${props.height}px`,
}))

/** 装饰图相对面板:距上端 5px,水平居中(悬浮于面板上边缘上方) */
const decoStyle = computed(() => ({
  left: `${(geom.value.panelWidth - geom.value.panelTopDecoW) / 2}px`,
  top: `${-geom.value.panelTopDecoH - 5}px`,
  width: `${geom.value.panelTopDecoW}px`,
  height: `${geom.value.panelTopDecoH}px`,
}))
</script>

<template>
  <div class="panel-shell" :style="panelStyle">
    <!-- 面板顶部羽化遮罩:从面板顶向上渐隐到透明,不额外占高度。
         两端统一渲染 —— 桌面端过去只有顶部装饰图、没有羽化,消息滚到面板
         上边缘是被硬切掉的;移动端一直有这块渐变。
         高度取几何层的 panelEdgeMaskH(桌面 60 / 移动端 20),不写死。
         放在装饰图**之前**:同级元素靠 DOM 顺序决定层叠,装饰图在后 →
         压在渐变之上,不会被面板色洗掉。 -->
    <div
      class="panel-shell__edge-mask"
      :style="{ height: `${geom.panelEdgeMaskH}px` }"
    />
    <img
      v-if="!geom.stripSegmented"
      class="panel-shell__top-deco"
      :src="MATERIALS.choiceTopDeco"
      :style="decoStyle"
      alt=""
    />
    <slot />
  </div>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

// 面板矩形:背景/圆角/层叠与两模式一致;布局(内容排列)由消费者 class 提供
.panel-shell {
  position: absolute;
  background: $color-panel-bg;
  border-radius: 0 0 16px 16px;
  z-index: 10;

  // 移动端:去掉底部圆角
  .chat-area--mobile & {
    border-radius: 0;
  }

  // 顶部装饰图:面板为 z10 独立层叠上下文,内部装饰天然高于遮罩横条(z4)
  &__top-deco {
    position: absolute;
    pointer-events: none;
    user-select: none;
  }

  // 面板顶部羽化:绝对定位贴面板顶上方,mask 向上渐隐,不占布局空间。
  // 高度由几何层的 panelEdgeMaskH 内联注入(桌面 60 / 移动端 20),
  // 这里不写死,避免与几何层口径分叉。
  &__edge-mask {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 100%;
    background: $color-panel-bg;
    -webkit-mask-image: linear-gradient(to top, #000 0%, transparent 100%);
    mask-image: linear-gradient(to top, #000 0%, transparent 100%);
    pointer-events: none;
  }
}
</style>