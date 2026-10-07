<script setup lang="ts">
// =============================================================================
// 选中消息模式的底部条(MessageSelectBar)
// -----------------------------------------------------------------------------
// 消息右键菜单点「导出选中消息」进入该模式:消息可逐条勾选(选中的描一圈黄边),
// 本条贴在窗口底部给出条数与出口 —— 取消 / 导出选中消息 / 导出全部消息。
// 两个导出按钮同为强调黄:一个是"就导勾的这些",一个是"整段都导",一号两个出口。
//
// 导出走的是**整套既有实现**(离屏画布 → html-to-image → 裁剪 → 下载 PNG),
// 只是把"渲染哪些消息"换成选中的子集(见 ChatExportDialog 的 messages 入参)。
// 「导出全部消息」不传 messages,就是原来的全量导出(与设置里那个「分享」一模一样)。
// 本组件只负责模式与出口,不碰截图。
//
// 位置:fixed 贴窗口底、水平居中,层级低于各弹窗(200)、高于聊天界面。
// =============================================================================
import { computed } from 'vue'
import { useChatStore } from '../../stores/chat'

const emit = defineEmits<{
  /** 点「导出选中消息」:由 App 把选中的子集交给导出弹窗 */
  (e: 'export'): void
  /** 点「导出全部消息」:与设置里原来的「分享」完全同一条路(全量导出) */
  (e: 'export-all'): void
}>()

const chatStore = useChatStore()

/** 已选条数 */
const count = computed(() => chatStore.selectedMsgCount)

/** 一条都没选时给个引导,选了就说明会发生什么 */
const hint = computed(() =>
  count.value === 0
    ? '点消息进行勾选'
    : `将按对话原顺序导出这 ${count.value} 条消息为一张长图`,
)
</script>

<template>
  <div class="pickbar">
    <span class="pickbar__count">已选 {{ count }} 条</span>
    <span class="pickbar__hint">{{ hint }}</span>
    <div class="pickbar__actions">
      <button class="pickbar__btn" type="button" @click="chatStore.exitMsgSelect()">取消</button>
      <button
        class="pickbar__btn pickbar__btn--primary"
        type="button"
        :disabled="count === 0"
        @click="emit('export')"
      >导出选中消息</button>
      <button
        class="pickbar__btn pickbar__btn--primary"
        type="button"
        @click="emit('export-all')"
      >导出全部消息</button>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

.pickbar {
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  z-index: 180;
  display: flex;
  align-items: center;
  gap: 16px;
  // 宽度必须写 max-content,不能靠 width:auto 的收缩宽度:
  // left:50% 之后"可用宽度"只剩右半屏(390 的屏只有 195),width:auto 会按 195
  // 算宽度 → 内容被迫换行,面板也只和其中一行一样宽,按钮就从背景里露出来了。
  // max-content + max-width 兜底:能一行就一行且背景严丝合缝,
  // 窄到真放不下时面板被 max-width 卡住,按钮在背景**内部**换行。
  width: max-content;
  max-width: calc(100vw - 24px);
  flex-wrap: wrap;
  justify-content: center;
  padding: 10px 14px;
  // 与删除模式底部条、各弹窗同一块"面板材质"
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

    &--primary {
      background: #ffef00;
      border-color: #ffef00;

      &:hover:not(:disabled) { background: #e6d936; }
    }
  }

  // 窄屏:说明收掉,并把三件套整体缩小一号 —— 目标是**保持一行**且背景贴合。
  // 一行所需宽度(含内边距)在 360 的屏上约 307px,放得下;
  // 再窄(≤320)才会被 max-width 卡住,届时按钮在背景内部换行,不会露出去。
  @media (max-width: 768px) {
    gap: 8px;
    padding: 8px 9px;
    bottom: 12px;

    &__count { font-size: 12px; }
    &__hint { display: none; }
    &__actions { gap: 6px; }
    &__btn { padding: 5px 9px; font-size: 12px; }
  }
}
</style>
