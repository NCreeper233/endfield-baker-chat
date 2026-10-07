<script setup lang="ts">
// =============================================================================
// 群聊流程控制条(GroupFlowControl) —— 第三版群聊
// -----------------------------------------------------------------------------
// 位置:群聊会话里「最后一条消息的下方」,随消息一起滚动(由 ChatArea 放进
//       .chat-scroll 内绝对定位,top 取自布局管线的 flowTop)。
//
// 形态:与「AI 推荐回复」的选项按钮同一套小方框样式(白底胶囊、深色字)。
//
// 只负责「指定模式」的左右分段胶囊:
//        ┌──────────┬────────┐
//        │ 指定发言  │ 卡缪 ▾ │
//        └──────────┴────────┘
//      点左半「指定发言」→ 直接让当前选中的角色发言一次
//      点右半「角色名」  → 展开下拉菜单换人
//
// 【已移除】旁观/轮转模式的「开启 / 暂停 / 恢复对话」胶囊:那颗按钮改为
// 底部输入面板里的圆形按钮(ChatInput,与单聊"停止"同款),不再随本组件渲染。
//
// 纯前端状态:选择结果写 Card.assignTarget,由 useChatPersistence 落盘。
// =============================================================================
import { computed, inject, ref, toValue, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../../stores/chat'
import { useGroupChat } from '../../composables/useGroupChat'
import {
  chatGeometryKey,
  globalChatGeometry,
  DESKTOP_GEOM,
  type ChatGeometry,
} from '../../constants/chatGeometry'
import { flowMetrics } from '../../constants/groupFlow'
import { devWarn } from '../../utils/logger'

const emit = defineEmits<{
  /** 需要提示用户(由上层弹提示框) */
  (e: 'hint', text: string): void
  /** 需要打开设置(API 未配置时) */
  (e: 'open-settings'): void
}>()

/**
 * 注入几何:此处只用来判断"是不是移动端"
 *
 * 判据与 ChatInput / ChoicePanel 一致(几何层 stripSegmented),不另用视口宽度 ——
 * 两套判据并存时,临界宽度下会出现"按钮已按移动端缩小、预留高度还按桌面算"的错位。
 */
const injectedGeom = inject(chatGeometryKey, globalChatGeometry) ?? DESKTOP_GEOM
const geom = computed<ChatGeometry>(() => toValue(injectedGeom))

/** 当前端的控件尺寸(与 ChatArea 的滚动预留共用 constants/groupFlow 同一份) */
const flow = computed(() => flowMetrics(geom.value.stripSegmented))

/** 尺寸下发为 CSS 变量:样式侧一律 var(--flow-*),不再重复写死数字 */
const flowVars = computed(() => {
  const m = flow.value
  return {
    '--flow-pill-h': `${m.pillH}px`,
    '--flow-font': `${m.font}px`,
    '--flow-seg-go-pad-x': `${m.segGoPadX}px`,
    '--flow-seg-pick-pad-x': `${m.segPickPadX}px`,
    '--flow-seg-name-max-w': `${m.segNameMaxW}px`,
    '--flow-gap': `${m.pillGap}px`,
    '--flow-menu-item-h': `${m.menuItemH}px`,
    '--flow-menu-max-h': `${m.menuMaxH}px`,
    '--flow-menu-gap': `${m.menuGap}px`,
    '--flow-menu-font': `${m.menuFont}px`,
    '--flow-menu-pad-x': `${m.menuPadX}px`,
  }
})

const chatStore = useChatStore()
/** 群聊走独立服务(与本项目已修好的回合/暂停逻辑对接) */
const groupChat = useGroupChat()
const {
  activeIsGroup,
  activeIsObserver,
  activeSpeakMode,
  activeCard,
  groupPickerOpen,
} = storeToRefs(chatStore)

/** 群内成员 */
const members = computed(() => activeCard.value?.members ?? [])

/** 当前被指定的成员(缺省取第一位) */
const assignTarget = computed(
  () => activeCard.value?.assignTarget ?? members.value[0] ?? '',
)

/*
 * 是否显示胶囊 —— 判据统一取自 store(唯一来源)。
 * 此前组件与 ChatArea 各写一份,改一处漏一处会导致"组件改了但整块不渲染"。
 */
/** 指定模式:左半"发言一次" + 右半"换人" */
const showAssign = computed(() => chatStore.activeShowAssign)

/** 是否有任何控件(无则不渲染、不占高度) */
const visible = computed(() => showAssign.value)

defineExpose({ visible })

// ---- 指定发言:发言一次 ----------------------------------------------------

/** 是否正在请求该角色发言(防连点) */
const speaking = ref(false)

/** 点左半「指定发言」:让当前选中的角色直接发言一次 */
async function onAssignSpeak(): Promise<void> {
  if (speaking.value) return
  if (!assignTarget.value) return
  speaking.value = true
  try {
    // 后端在 assign 模式下只回被指定的那一位,一次调用即一条
    await groupChat.speakAssigned()
  } catch (e) {
    devWarn('[group] 指定发言失败:', e)
    emit('hint', '群聊发言失败,请稍后重试')
  } finally {
    speaking.value = false
  }
}

// ---- 指定发言:换人 --------------------------------------------------------

/** 选择角色并收起下拉 */
function pickMember(name: string): void {
  chatStore.setActiveAssignTarget(name)
  chatStore.closeGroupPicker()
}

// 下拉只在三种情况下收起:点右半段切换、选中某个角色、控件整体隐藏(见下方 watch)。
// 刻意不做"点空白处关闭":群聊里点聊天区多半是想接着看消息,
// 顺带把菜单关掉反而打断操作。

// 收起控件时顺手关掉下拉,避免下次进来还开着
watch(visible, (on) => {
  if (!on) chatStore.closeGroupPicker()
})
</script>

<template>
  <div v-if="visible" class="flow" :style="flowVars">
    <!-- 指定模式:左半"发言一次" + 右半"换人" -->
    <div v-if="showAssign" class="flow__assign">
      <button
        class="flow__btn flow__seg flow__seg--go"
        type="button"
        :disabled="speaking"
        :aria-label="`让 ${assignTarget} 发言一次`"
        @click="onAssignSpeak"
      >{{ speaking ? '发言中…' : '指定发言' }}</button>

      <button
        class="flow__btn flow__seg flow__seg--pick"
        type="button"
        :aria-expanded="groupPickerOpen"
        aria-haspopup="listbox"
        :aria-label="`指定发言角色：${assignTarget}`"
        @click="chatStore.toggleGroupPicker()"
      >
        <span class="flow__seg-name">{{ assignTarget }}</span>
        <svg
          class="flow__caret"
          :class="{ 'is-open': groupPickerOpen }"
          viewBox="0 0 12 8"
          aria-hidden="true"
        >
          <path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <!-- 角色下拉:向下展开;ChatArea 已按展开状态预留滚动高度,不会被裁切 -->
      <div v-if="groupPickerOpen" class="flow__menu" role="listbox">
        <button
          v-for="m in members"
          :key="m"
          class="flow__menu-item"
          type="button"
          role="option"
          :aria-selected="m === assignTarget"
          @click="pickMember(m)"
        >{{ m }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 尺寸全部来自 constants/groupFlow,由脚本按端下发为 CSS 变量(见 flowVars)。
// ChatArea 用同一份常量预留滚动高度,故此处不再写死任何数值 ——
// 写死就会两边分叉,出现"胶囊已按移动端缩小、预留还按桌面算"的错位。

.flow {
  // 绝对定位由 ChatArea 的外层包裹提供;这里只负责内部排布
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--flow-gap);
  pointer-events: none;

  &__btn {
    @include flow-pill-core;

    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    // 覆盖 flow-pill-core 里写死的 22px / 46px(那是桌面口径)
    height: var(--flow-pill-h);
    font-size: var(--flow-font);
    line-height: var(--flow-pill-h);
    // 左右内边距由下面 &__seg 按"左半 / 右半"分别给,这里不设
    cursor: pointer;
    pointer-events: auto;
    transition: background 0.2s ease, color 0.2s ease, transform 0.1s ease;

    &:hover {
      background: #999898;
      color: #ffffff;
    }

    &:active {
      transform: scale(0.98);
    }

    &:disabled {
      cursor: default;
      opacity: 0.75;
      transform: none;
    }
  }

  // ---- 指定发言:左右分段 ------------------------------------------------
  &__assign {
    position: relative;
    display: flex;
    align-items: stretch;
    pointer-events: auto;
  }

  // 两段共用胶囊外形,只有外侧圆角
  &__seg {
    padding: 0 var(--flow-seg-go-pad-x);

    &--go {
      border-radius: 999px 0 0 999px;
    }

    &--pick {
      border-radius: 0 999px 999px 0;
      // 细分割线,区分"发言"与"换人"两个动作
      border-left: 1px solid rgba(42, 42, 42, 0.28);
      padding: 0 var(--flow-seg-pick-pad-x);
    }
  }

  &__seg-name {
    max-width: var(--flow-seg-name-max-w);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__caret {
    flex-shrink: 0;
    width: 12px;
    height: 8px;
    opacity: 0.7;
    transition: transform 0.2s ease;

    &.is-open {
      transform: rotate(180deg);
    }
  }

  // ---- 角色下拉菜单 ------------------------------------------------------
  &__menu {
    position: absolute;
    top: calc(100% + var(--flow-menu-gap));
    left: 0;
    z-index: 4;
    min-width: 100%;
    max-height: var(--flow-menu-max-h);
    overflow-y: auto;
    // 刻意不留上下内边距:菜单项要一直顶到菜单的上下边缘,
    // 这样首项/末项悬停时的灰底才能被 overflow 按 12px 圆角裁切、铺满两端圆角。
    // 若加 4px 内边距,两端会各留一条白边,圆角处的悬停是缺的。
    // (高度预留见 ChatArea 的 flowMenuH,同样按"无内边距"计算)
    border-radius: 12px;
    background: #ffffff;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  &__menu-item {
    display: block;
    width: 100%;
    height: var(--flow-menu-item-h);
    padding: 0 var(--flow-menu-pad-x);
    border: none;
    background: transparent;
    color: #2a2a2a;
    font-family: $font-bubble;
    font-size: var(--flow-menu-font);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;

    &:hover {
      background: #999898;
      color: #ffffff;
    }
  }
}
</style>
