<script setup lang="ts">
// =============================================================================
// 群聊「继续对话」小浮窗(GroupContinueNudge)
// -----------------------------------------------------------------------------
// 出现时机:群聊里**所有角色加起来**每说满 GROUP_CONTINUE_EVERY(20)条消息
// 浮出一次。计数在 store,由群聊回合循环逐轮上报(useGroupChat → noteGroupRound)。
//
// 只有两条交互:
//   · 点「继续对话」→ 关窗 + 重新计数,对话照常往下走,再过 20 条才又出现
//   · 一直不点      → 再多聊一轮后自动暂停对话(判定在 store,这里只负责显示)
//
// 样式与层级**照抄选中消息那条导出条**(MessageSelectBar):
//   position: fixed; bottom: 22px; left: 50%; z-index: 180;面板材质 / 字号 /
//   按钮 / 移动端收紧幅度全部一致 —— 两者是同一类"贴着窗口底的浮条"。
//
// ⚠️ 所以它挂在 App 根层(与 DeleteModeBar / MessageSelectBar 并列),
// **不能**放回 ChatArea:那里是零尺寸原点容器,且整块在缩放过的设计画布里
// (1600×900 下 zoom≈0.745),栅格、描边、阴影都会被一起缩放,和这条条的
// 真实像素观感对不上。
// =============================================================================
import { computed } from 'vue'
import { useChatStore } from '../../stores/chat'

const chatStore = useChatStore()

/** 是否显示:群聊 + 浮窗开着(切到单聊时 store 侧已复位,这里再兜一层) */
const visible = computed(() => chatStore.groupContinueOpen && chatStore.activeIsGroup)

/** 自上次确认以来角色们又说了多少条(文案里的数字,跟着计数走) */
const count = computed(() => chatStore.groupMessagesSinceAck)
</script>

<template>
  <Transition name="nudge">
    <div v-if="visible" class="nudge" role="status">
      <span class="nudge__count">群内已累积 {{ count }} 条消息</span>
      <span class="nudge__hint">点「继续对话」接着聊；不点的话，再聊一轮就自动暂停</span>
      <button class="nudge__btn nudge__btn--primary" type="button" @click="chatStore.ackGroupContinue()">
        继续对话
      </button>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

// 尺寸一律与 MessageSelectBar(.pickbar)逐条对齐 —— 两条浮条同宽同高同层,
// 摆在同一个窗口底部位置。改这里时请顺手看一眼那条。
.nudge {
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  z-index: 180;
  display: flex;
  align-items: center;
  gap: 16px;
  // 宽度必须写 max-content,不能靠 width:auto 的收缩宽度:
  // left:50% 之后"可用宽度"只剩右半屏,width:auto 会按半屏算 → 内容被迫换行。
  width: max-content;
  max-width: calc(100vw - 24px);
  padding: 10px 14px;
  // 与删除模式底部条、选中消息导出条、各弹窗同一块"面板材质"
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

  &__btn {
    flex: none;
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

    &--primary {
      background: #ffef00;
      border-color: #ffef00;

      &:hover:not(:disabled) { background: #e6d936; }
    }
  }

  // 入场:从下往上一点(基准 transform 是 translateX(-50%),补间要带着它一起写)
  &-enter-active,
  &-leave-active {
    transition: opacity 0.18s ease-out, transform 0.18s ease-out;
  }

  &-enter-from,
  &-leave-to {
    opacity: 0;
    transform: translateX(-50%) translateY(10px);
  }

  // 窄屏:与导出条同一套收紧值(说明收掉,计数 + 按钮一行放得下)
  @media (max-width: 768px) {
    gap: 8px;
    padding: 8px 9px;
    bottom: 12px;

    &__count { font-size: 12px; }
    &__hint { display: none; }
    &__btn { padding: 5px 9px; font-size: 12px; }
  }
}
</style>
