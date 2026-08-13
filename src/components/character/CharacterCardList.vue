<script setup lang="ts">
// =============================================================================
// 左侧干员卡片列表(主卡数量任意,每张主卡下子卡数量任意 ≥1)
// -----------------------------------------------------------------------------
// 职责:
// 1. 渲染滚动容器 + 双 mask(顶/底/右渐隐)
// 2. 按每张主卡的折叠状态 + 子卡数量计算所有主卡的 top 偏移
// 3. 渲染尾部 .card-pad 占位
// =============================================================================
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../../stores/chat'
import {
  computeUnitTops,
  computeCardPadTop,
} from '../../constants/characterCard'
import CharacterCardItem from './CharacterCardItem.vue'

const chatStore = useChatStore()
const { collapsed, cards } = storeToRefs(chatStore)

/** 每张主卡的子卡数量 */
const subCounts = computed(() => cards.value.map((c) => c.conversations.length))

/** 所有主卡的顶部 y 偏移(已含 TOP_PAD) */
const unitTops = computed(() => computeUnitTops(collapsed.value, subCounts.value))

/** 列表尾部留白的 top 坐标(复用 unitTops,避免 computeCardPadTop 内部重复 O(n) 遍历) */
const cardPadTop = computed(() => computeCardPadTop(collapsed.value, subCounts.value, unitTops.value))
</script>

<template>
  <section class="character-card">
    <div class="card-pad card-pad--top" />
    <CharacterCardItem
      v-for="(top, index) in unitTops"
      :key="index"
      :index="index"
      :top="top"
    />
    <div class="card-pad" :style="{ top: cardPadTop + 'px' }" />
  </section>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

.character-card {
  position: absolute;
  left: 0;
  top: 122.57px;
  width: 526px;
  height: 897.27px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: $color-scrollbar-character transparent;
  // 顶部 5px 渐隐 + 底部 40-80px 渐隐 + 右侧 14px 渐隐
  @include scroll-mask(0, 5px, calc(100% - 80px), calc(100% - 40px), 14px);
}

.card-pad {
  position: absolute;
  left: 0;
  width: 1px;
  height: 80px;
  pointer-events: none;

  &--top {
    top: 0;
    height: 10px;
  }
}
</style>
