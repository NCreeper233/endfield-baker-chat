<script setup lang="ts">
// =============================================================================
// 对话管理弹窗(DeleteConfirmDialog)
// -----------------------------------------------------------------------------
// 三个操作按钮(针对当前选中的子对话):
//   - 删除对话:父卡仅一个子对话时禁用(避免连带删除整张父卡)
//   - 清空消息:清空可见消息,AI 上下文记忆保留
//   - 清空上下文:清空 AI 记忆,可见消息保留
//
// 每个操作均有二次确认页(确认/取消)。操作完成后自动关闭弹窗。
// 未选中对话时仅提示"请先选中",不出现任何操作按钮。
// =============================================================================
import { computed, ref, watch } from 'vue'
import { useChatStore } from '../../stores/chat'
import { MATERIALS } from '../../constants/materials'

const props = defineProps<{
  /** 是否展开(由 App 的删除按钮 toggle) */
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const chatStore = useChatStore()

/** 是否有已选中对话(未选中时仅提示"请先选中",不出现操作按钮) */
const hasSub = computed(() => chatStore.activeSub !== null)

/** 当前子对话是否可删除(父卡含多个子对话时才允许) */
const canDelete = computed(() => chatStore.canDeleteActiveConversation)

// ---- 二次确认状态 -----------------------------------------------------------
type ActionType = 'delete' | 'clearMessages' | 'clearContext' | null
const confirmAction = ref<ActionType>(null)

const confirmTexts: Record<Exclude<ActionType, null>, string> = {
  delete: '确认删除这个会话？',
  clearMessages: '确认清空当前对话的消息？(AI 记忆保留)',
  clearContext: '确认清空当前对话的上下文？(消息保留)',
}

/** 每次展开弹窗都回到主菜单页面 */
watch(
  () => props.open,
  (open) => {
    if (open) {
      confirmAction.value = null
    }
  },
)

function requestAction(action: Exclude<ActionType, null>) {
  confirmAction.value = action
}

function onConfirm() {
  switch (confirmAction.value) {
    case 'delete':
      chatStore.deleteActiveConversation()
      break
    case 'clearMessages':
      chatStore.clearActiveMessages()
      break
    case 'clearContext':
      chatStore.clearActiveContext()
      break
  }
  confirmAction.value = null
  emit('close')
}

function onCancelConfirm() {
  confirmAction.value = null
}
</script>

<template>
  <Transition name="dc">
    <div v-if="open" class="dc" @click.self="emit('close')">
      <div class="dc__panel" :class="{ 'dc__panel--narrow': !!confirmAction }">
        <!-- 右上角 × 关闭按钮 -->
        <button class="dc__close" type="button" aria-label="关闭" @click="emit('close')">×</button>
        <h2 class="dc__title">对话管理</h2>

        <!-- 未选中对话:提示先行选中,不出现操作按钮 -->
        <p v-if="!hasSub" class="dc__empty-hint">请先在左侧选中一段对话，再进行操作。</p>

        <!-- 二次确认页 -->
        <div v-else-if="confirmAction" class="dc__confirm">
          <p class="dc__confirm-text">{{ confirmTexts[confirmAction] }}</p>
          <div class="dc__actions">
            <button class="dc__btn dc__btn--primary" type="button" @click="onConfirm">确认</button>
            <button class="dc__btn" type="button" @click="onCancelConfirm">取消</button>
          </div>
        </div>

        <!-- 主菜单:三个操作按钮 -->
        <div v-else class="dc__actions dc__actions--menu">
          <button
            class="dc__btn dc__btn--danger"
            type="button"
            :disabled="!canDelete"
            :title="canDelete ? '' : '该对话是父卡下唯一的子对话，无法删除'"
            @click="requestAction('delete')"
          >删除对话</button>
          <button class="dc__btn" type="button" @click="requestAction('clearMessages')">清空消息</button>
          <button class="dc__btn" type="button" @click="requestAction('clearContext')">清空上下文</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 遮罩 + 居中深色面板(与数据管理菜单清空确认页完全同款样式)
@include dialog-shell(dc, 348px, 10px);

.dc {
  &__panel--narrow {
    // 确认页:只放两个按钮,宽度收窄
    width: 348px;
  }

  &__empty-hint {
    margin: 0 0 18px;
    font-family: $font-harmony;
    font-size: 15px;
    color: $color-subcard-text;
  }

  &__confirm-text {
    margin: 0 0 14px;
    font-family: $font-harmony;
    font-size: 15px;
    color: $color-subcard-text;
  }

  &__actions--menu {
    flex-direction: column;
    gap: 10px;
  }

  &__btn--danger {
    background: #7a2e2e;
    color: #f0eeee;

    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
  }
}
</style>
