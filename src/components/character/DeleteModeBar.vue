<script setup lang="ts">
// =============================================================================
// 删除模式底部条(DeleteModeBar)
// -----------------------------------------------------------------------------
// 删除模式由操作带上的删除按钮进入(chatStore.toggleDeleteMode),此时:
//   · 列表里的对话可多选(点卡片 = 勾选,不再切会话)
//   · 勾选项左缘出现悬浮黄条(见 SubCard / GroupCardItem)
//   · 本组件贴在窗口底部:选"删什么" + 看已选数量 + 执行 / 取消
//
// 三种删除对象对应 store 的三个动作(见 stores/chat 的 runDelete):
//   删除对话 = 整段对话连同消息与上下文;内置角色的最后一段改为清空
//   删除历史 = 只清屏幕上的聊天记录,AI 记忆保留
//   删除上下文 = 只清 AI 记忆,聊天记录保留
//
// 位置:fixed 贴窗口底、水平居中,层级低于各个弹窗(200),高于聊天界面。
// =============================================================================
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useChatStore } from '../../stores/chat'
import type { DeleteKind } from '../../stores/chat'
import { setDeleteBarH } from '../../composables/useDeleteBar'

const chatStore = useChatStore()

/**
 * 实测自身高度并上报
 *
 * 列表要靠这个值在尾部留出等高空档(否则最后一张卡被本条盖住);
 * 手机上本条是两行、桌面一行,高度不同,所以必须量而不是写死。
 * 由 App 用 v-if 控制挂载,故挂载即显示、卸载即归零。
 */
const rootEl = ref<HTMLElement | null>(null)
let ro: ResizeObserver | null = null

function measure(): void {
  setDeleteBarH(rootEl.value?.offsetHeight ?? 0)
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(measure)
    if (rootEl.value) ro.observe(rootEl.value)
  }
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  setDeleteBarH(0)
})

/** 三种删除对象(顺序即底部条上的顺序) */
const KINDS: { key: DeleteKind; label: string }[] = [
  { key: 'conversation', label: '删除对话' },
  { key: 'history', label: '删除历史' },
  { key: 'context', label: '删除上下文' },
]

/** 当前选中项在开关里的下标(黄条滑动用) */
const kindIndex = computed(() => {
  const i = KINDS.findIndex((k) => k.key === chatStore.deleteKind)
  return i === -1 ? 0 : i
})

/** 已选数量 */
const count = computed(() => chatStore.deleteCount)

/** 当前删除对象的说明(一行,随时告诉玩家这一下会删掉什么) */
const kindHint = computed(() => {
  const linked = chatStore.deleteLinked
  switch (chatStore.deleteKind) {
    case 'history':
      return linked
        ? '聊天记录与 AI 记忆一起清空，对话本身保留'
        : '只清空聊天记录，AI 仍记得之前的对话'
    case 'context':
      return linked
        ? 'AI 记忆与聊天记录一起清空，对话本身保留'
        : '只清空 AI 的记忆，聊天记录保留'
    default:
      return '整段对话连同聊天记录与 AI 记忆一起删除（内置角色的最后一段只清空）'
  }
})

/**
 * 「连带清除」勾选框的文案
 *
 * 只在 history / context 两种对象下渲染,文案随当前对象变化:
 * 删历史 → 同时删除上下文;删上下文 → 同时清除历史。
 */
const linkedLabel = computed(() =>
  chatStore.deleteKind === 'history' ? '同时删除上下文' : '同时清除历史',
)

/** 勾选框变化 */
function onToggleLinked(e: Event): void {
  chatStore.setDeleteLinked((e.target as HTMLInputElement).checked)
}

/** 执行(没勾选时按钮禁用,这里只做兜底) */
function onConfirm(): void {
  if (count.value === 0) return
  chatStore.runDelete()
}
</script>

<template>
  <div ref="rootEl" class="delbar">
    <span class="delbar__count">已选 {{ count }} 段</span>

    <!-- 删什么:三段开关,黄块跟随(与设置面板的模式切换同一套语汇) -->
    <div class="delbar__kinds">
      <span class="delbar__slider" :style="{ transform: `translateX(${kindIndex * 100}%)` }" />
      <button
        v-for="k in KINDS"
        :key="k.key"
        class="delbar__kind"
        :class="{ 'is-active': chatStore.deleteKind === k.key }"
        type="button"
        @click="chatStore.setDeleteKind(k.key)"
      >{{ k.label }}</button>
    </div>

    <!-- 连带清除:只在「删除历史 / 删除上下文」时出现。
         「删除对话」是整段连根拔除,不存在连带项,故不显示这个勾选框。
         窄屏上这一行独占一行(见样式),出现时自下而上平移就位。 -->
    <Transition name="delbar-link">
      <label v-if="chatStore.deleteKind !== 'conversation'" class="delbar__link">
        <input
          type="checkbox"
          class="delbar__link-box"
          :checked="chatStore.deleteLinked"
          @change="onToggleLinked"
        />
        <span class="delbar__link-text">{{ linkedLabel }}</span>
      </label>
    </Transition>

    <span class="delbar__hint">{{ kindHint }}</span>

    <div class="delbar__actions">
      <button class="delbar__btn" type="button" @click="chatStore.exitDeleteMode()">取消</button>
      <button
        class="delbar__btn delbar__btn--danger"
        type="button"
        :disabled="count === 0"
        @click="onConfirm"
      >删除</button>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

.delbar {
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  z-index: 180;
  display: flex;
  align-items: center;
  gap: 16px;
  max-width: calc(100vw - 24px);
  padding: 10px 14px;
  // 与各弹窗同一块"面板材质":深色底 + 24px 灰色网格
  background-color: $color-dialog-bg;
  background-image:
    linear-gradient(to right, rgba(134, 134, 133, 0.12) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(134, 134, 133, 0.12) 1px, transparent 1px);
  background-size: 24px 24px;
  border: 1px solid $color-dialog-border;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  font-family: $font-harmony;

  &__count {
    flex: none;
    font-size: 14px;
    color: $color-text-primary;
    white-space: nowrap;
  }

  // ---- 连带清除勾选框(仅"删除历史 / 删除上下文"时出现) ----------------------
  &__link {
    flex: none;
    display: flex;
    align-items: center;
    gap: 7px;
    cursor: pointer;
    user-select: none;
  }

  // 用原生 checkbox + accent-color:各端表现一致,不必自己画方块和勾
  &__link-box {
    flex: none;
    width: 15px;
    height: 15px;
    margin: 0;
    accent-color: #ffef00;
    cursor: pointer;
  }

  &__link-text {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.78);
    white-space: nowrap;
  }

  // ---- 三段开关 -------------------------------------------------------------
  &__kinds {
    position: relative;
    flex: none;
    display: flex;
    border: 1px solid rgba(255, 255, 255, 0.14);
    overflow: hidden;
  }

  &__slider {
    position: absolute;
    top: 0;
    left: 0;
    width: 33.333%;
    height: 100%;
    background: #ffef00;
    pointer-events: none;
    transition: transform 0.22s ease;
  }

  &__kind {
    position: relative;
    z-index: 1;
    flex: none;
    padding: 7px 16px;
    border: none;
    background: none;
    color: rgba(255, 255, 255, 0.6);
    font-family: $font-harmony;
    font-size: 13px;
    white-space: nowrap;
    cursor: pointer;
    transition: color 0.2s;

    &:hover { color: $color-text-primary; }

    // 黄块上的深色字(hover 时也不变白)
    &.is-active,
    &.is-active:hover {
      color: #1a1a1a;
    }
  }

  &__hint {
    min-width: 0;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__actions {
    flex: none;
    display: flex;
    gap: 8px;
  }

  &__btn {
    padding: 7px 18px;
    border: 1px solid #f0eeee;
    background: #f0eeee;
    color: #1a1a1a;
    font-family: $font-harmony;
    font-size: 14px;
    white-space: nowrap;
    cursor: pointer;
    transition: background 0.2s, border-color 0.2s;

    &:hover:not(:disabled) { background: #dcdcdc; }

    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    &--danger {
      background: #7a2e2e;
      border-color: #7a2e2e;
      color: #f0eeee;

      &:hover:not(:disabled) { background: #8f3838; }
    }
  }

  // 窄屏:横向排不下(三段开关 + 勾选框 + 计数 + 两个按钮 ≈ 460px),改成三行 ——
  //   第 1 行 三段开关铺满(每段等宽)
  //   第 2 行 连带清除勾选框(只在"删除历史 / 删除上下文"时才有这一行)
  //   第 3 行 左侧计数、右侧取消 / 删除
  // 条本身贴底固定,所以多出一行时整体向上长:开关被顶上去一行,
  // 勾选框正好插在开关与按钮之间,按钮位置不动 —— 手指下方的按钮不会跳。
  // 不这么排的话整条会超出视口,"删除"按钮被挤到屏幕外。
  @media (max-width: 768px) {
    width: calc(100vw - 24px);
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    bottom: 12px;

    &__count {
      order: 3;
      font-size: 13px;
    }

    // 三段开关独占第一行,每段等宽铺满
    &__kinds {
      order: 1;
      flex: 1 1 100%;
    }

    &__kind {
      flex: 1;
      padding: 6px 8px;
      font-size: 12px;
    }

    // 勾选框独占第二行(整行宽 —— 换行由它触发,不必再靠 order 硬排)
    &__link {
      order: 2;
      flex: 1 1 100%;
    }

    // 说明行在手机上收掉(点删除前已能看清三段开关的文案)
    &__hint { display: none; }

    &__actions {
      order: 4;
      margin-left: auto;
    }
    &__btn { padding: 6px 12px; font-size: 13px; }
  }
}

// 勾选框行的入场 / 退场:自下而上平移一小段 + 淡入(出场反向)。
// 只做平移,不做高度动画 —— 条贴底固定,高度变化本身就会把上面两行顶上去。
.delbar-link-enter-active,
.delbar-link-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.delbar-link-enter-from,
.delbar-link-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
