<script setup lang="ts">
// =============================================================================
// 底部面板矩形壳(PanelShell)
// -----------------------------------------------------------------------------
// ChatInput 底部面板渲染同一套"矩形背景 + 顶部装饰图 + 内容"几何
// (全部来自 constants/panel 共享常量),收敛于此:
//   - 面板矩形(#3c3b39,底部圆角,贴 chat_strip_detail 底边)
//   - 面板上边缘上方的装饰图(choiceTopDeco,水平居中)
//   - slot 内容(聊天输入区 + 弹出面板)
//
// 装饰图放在面板内部(面板 z10 层叠上下文,天然高于 PanelTopMask 的 z4),
// 与原结构一致。面板上方遮罩横条由 PanelTopMask 渲染——
// 两者要求"双根兄弟"结构:面板组件被包在 <Transition> 之内,Vue 对多根
// 组件不施加 Transition 类(实测确认,现状即无过渡动画),必须保持消费者
// 模板同时输出两个根才能一一对应;合并成单根会让过渡类生效,出现动画差异。
//
// 布局规则(两者的 flex / transform-origin 过渡)由消费者通过 class 透传
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
    <img
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

  // 顶部装饰图:面板为 z10 独立层叠上下文,内部装饰天然高于遮罩横条(z4)
  &__top-deco {
    position: absolute;
    pointer-events: none;
    user-select: none;
  }
}
</style>