<script setup lang="ts">
// =============================================================================
// 提醒弹窗(AlertDialog)
// -----------------------------------------------------------------------------
// 展示服务端下发的"提醒"条目。可能同时存在多条未确认提醒,
// 它们被安排在同一窗口内左右滑动查看(不叠加成多个弹窗):
//   - 桌面端:左右箭头按钮切换,带 1/N 页码指示
//   - 移动端:可直接左右滑动切换(滑动阈值 40px,避免误触)
// 玩家点击「确定」即确认当前全部提醒(见 usePopups.confirmAlerts),
// 这样即便提醒堆积,也只需点一次,不会被迫连续点多次确认。
// 样式复用 dialog-shell 外壳,与站内其他弹窗保持一致的深色直角面板风格。
// =============================================================================
import { ref, computed, watch } from 'vue'

import type { AlertItem } from '../../constants/popups'

const props = defineProps<{
  /** 是否显示 */
  open: boolean
  /** 待展示的提醒列表(已过滤掉确认过的;非空时才显示本弹窗) */
  alerts: AlertItem[]
}>()

const emit = defineEmits<{
  (e: 'confirm'): void
}>()

/** 当前查看的提醒下标 */
const index = ref(0)

/** 当前提醒 */
const current = computed<AlertItem | null>(() => props.alerts[index.value] ?? null)

/** 提醒总数 */
const total = computed(() => props.alerts.length)

/** 是否多条(决定是否显示切换控件) */
const hasMultiple = computed(() => total.value > 1)

// 打开时把下标收敛到合法范围(列表可能在下次拉取后变短)
watch(
  () => [props.open, props.alerts] as const,
  () => {
    if (!props.open) return
    if (index.value >= props.alerts.length) index.value = 0
  },
  { immediate: true },
)

/** 上一条(循环) */
function prev(): void {
  if (total.value <= 1) return
  index.value = (index.value - 1 + total.value) % total.value
}

/** 下一条(循环) */
function next(): void {
  if (total.value <= 1) return
  index.value = (index.value + 1) % total.value
}

// ---- 移动端滑动切换 --------------------------------------------------------
/** 触摸起始横坐标 */
let touchStartX = 0

function onTouchStart(e: TouchEvent): void {
  touchStartX = e.touches[0]?.clientX ?? 0
}

function onTouchEnd(e: TouchEvent): void {
  if (!hasMultiple.value) return
  const endX = e.changedTouches[0]?.clientX ?? 0
  const dx = endX - touchStartX
  // 小于阈值视为点击/轻微抖动,不切换
  if (Math.abs(dx) < 40) return
  if (dx < 0) next()
  else prev()
}
</script>

<template>
  <Transition name="ad">
    <div v-if="open && current" class="ad">
      <div class="ad__panel">
        <h2 class="ad__title">{{ current.title }}</h2>

        <!-- 内容区:移动端可左右滑动切换 -->
        <div
          class="ad__body"
          @touchstart.passive="onTouchStart"
          @touchend.passive="onTouchEnd"
        >
          <p class="ad__text">{{ current.content }}</p>
        </div>

        <!-- 多条提醒:切换箭头 + 页码(左右滑动之外的桌面端操作方式) -->
        <div v-if="hasMultiple" class="ad__nav">
          <button class="ad__arrow" type="button" aria-label="上一条" @click="prev">‹</button>
          <span class="ad__counter">{{ index + 1 }} / {{ total }}</span>
          <button class="ad__arrow" type="button" aria-label="下一条" @click="next">›</button>
        </div>

        <div class="ad__actions">
          <button class="ad__btn ad__btn--primary" type="button" @click="emit('confirm')">
            确定
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 提醒弹窗外壳:与站内其他弹窗同款(dialog-shell 深色直角面板 + 网格纹理)
@include dialog-shell(ad, 520px, 14px);

.ad {
  // 内容区:长文本可滚动,并作为滑动手势的接收区
  &__body {
    max-height: 46vh;
    overflow-y: auto;
    // 隐藏滚动条但保留滚动能力
    scrollbar-width: none;
    -ms-overflow-style: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  // 正文保留换行(服务端 content 中的 \n 生效)
  &__text {
    margin: 0;
    white-space: pre-line;
  }

  // 切换控件行
  &__nav {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    margin-top: 14px;
  }

  // 左右箭头
  &__arrow {
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid $color-dialog-border;
    background: transparent;
    color: $color-text-primary;
    font-family: $font-harmony;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;

    &:hover {
      background: $color-hover-overlay;
      border-color: $color-subcard-selected;
    }
  }

  // 页码指示
  &__counter {
    min-width: 48px;
    font-family: $font-harmony;
    font-size: 13px;
    color: $color-subcard-text;
    text-align: center;
    user-select: none;
  }

  // 确认按钮居中
  &__actions {
    justify-content: center;
    margin-top: 20px;
  }
}
</style>
