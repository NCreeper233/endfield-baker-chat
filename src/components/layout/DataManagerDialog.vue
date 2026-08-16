<script setup lang="ts">
// =============================================================================
// 数据管理弹窗(DataManagerDialog)
// -----------------------------------------------------------------------------
// 提供全局操作(控制全部对话):
//   - 数据统计(卡片 / 对话 / 消息 / 序列化大小)
//   - 导出工程(.baker 压缩单文件,直接下载)
//   - 导入工程(选文件 → 解压校验 → 二次确认 → 整体替换)
//   - 清空全部对话(删除所有子对话,每个角色保留一个空子对话,清除消息与上下文)
//   - 清空全部消息(仅清空可见消息,AI 上下文记忆保留)
//   - 清空全部上下文(仅清空 AI 记忆,可见消息保留)
//
// 破坏性操作均为两段式确认(弹窗内切换确认态),不动用现有素材图。
// =============================================================================
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../../stores/chat'
import { useSettingsStore, DEFAULT_WORLD_SETTING } from '../../stores/settings'
import { MATERIALS } from '../../constants/materials'
import {
  downloadProject,
  importFromZip,
  EXPORT_FILE_EXT,
  type ProjectPayload,
} from '../../utils/zipExport'
import { flushPendingWrites } from '../../composables/useChatPersistence'
import type { Card } from '../../types/chat'

const props = defineProps<{
  /** 是否展开(由 App 的清除数据按钮控制) */
  open: boolean
  /**
   * 内嵌模式(设置弹窗内嵌时置 true):
   * 不渲染遮罩/关闭按钮/标题,面板铺满所在容器宽度,仅保留功能内容。
   */
  embedded?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const chatStore = useChatStore()
const settingsStore = useSettingsStore()
const { cards } = storeToRefs(chatStore)

/** 数据统计(卡片 / 对话 / 消息 / 序列化大小) */
const stats = computed(() => {
  // 对话只统计有内容的(有消息或有 AI 记忆),空对话不计入
  const hasContent = (cv: { messages: unknown[]; contextHistory?: unknown[] }) =>
    cv.messages.length > 0 || (cv.contextHistory?.length ?? 0) > 0
  const convCount = cards.value.reduce(
    (n, c) => n + c.conversations.filter(hasContent).length,
    0,
  )
  const msgCount = cards.value.reduce(
    (n, c) => n + c.conversations.reduce((m, cv) => m + cv.messages.length, 0),
    0,
  )
  const sizeKB = JSON.stringify({
    cards: cards.value,
  }).length / 1024
  return { cardCount: cards.value.length, convCount, msgCount, sizeKB: sizeKB.toFixed(1) }
})

// ---- 两段式确认状态 ---------------------------------------------------------
type ConfirmKind = 'clear' | 'clearMessages' | 'clearContext' | 'import' | null
const confirmKind = ref<ConfirmKind>(null)
const importError = ref('')
const pendingImport = ref<ProjectPayload | null>(null)

const confirmTexts: Record<Exclude<ConfirmKind, null>, string> = {
  clear: '将删除全部对话，确定吗？',
  clearMessages: '将清空全部对话的消息（上下文记忆保留），确定吗？',
  clearContext: '将清空全部对话的上下文（消息记录保留），确定吗？',
  import: '导入将覆盖当前全部数据，确定吗？',
}

const fileInput = ref<HTMLInputElement | null>(null)

/**
 * 每次展开弹窗都回到主页面
 */
watch(
  () => props.open,
  (open) => {
    if (open) {
      confirmKind.value = null
      pendingImport.value = null
      importError.value = ''
    }
  },
)

/** 导出中状态(ZIP 生成是异步操作) */
const isExporting = ref(false)

async function onExport() {
  if (isExporting.value) return
  isExporting.value = true
  try {
    await downloadProject(
      cards.value,
      chatStore.myGender,
      chatStore.stripVariantIndex,
      settingsStore.promptOverrides,
      settingsStore.worldSetting,
      DEFAULT_WORLD_SETTING,
    )
  } catch (err) {
    importError.value = err instanceof Error ? err.message : '导出失败'
  } finally {
    isExporting.value = false
  }
}

function onRequestClear() {
  confirmKind.value = 'clear'
}

function onRequestClearMessages() {
  confirmKind.value = 'clearMessages'
}

function onRequestClearContext() {
  confirmKind.value = 'clearContext'
}

function onPickFile() {
  importError.value = ''
  fileInput.value?.click()
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    pendingImport.value = await importFromZip(file)
    importError.value = ''
    confirmKind.value = 'import'
  } catch (err) {
    pendingImport.value = null
    confirmKind.value = null
    importError.value = err instanceof Error ? err.message : '文件解析失败'
  }
}

/** 替换卡片树后同步运行时态 */
function applyCards(next: Card[]) {
  chatStore.replaceAllCards(next)
}

function onConfirm() {
  if (confirmKind.value === 'clear') {
    chatStore.clearAllConversations()
    flushPendingWrites()
    emit('close')
  } else if (confirmKind.value === 'clearMessages') {
    chatStore.clearAllMessages()
    flushPendingWrites()
    emit('close')
  } else if (confirmKind.value === 'clearContext') {
    chatStore.clearAllContext()
    flushPendingWrites()
    emit('close')
  } else if (confirmKind.value === 'import' && pendingImport.value) {
    const payload = pendingImport.value
    applyCards(payload.cards)
    chatStore.setMyGender(payload.myGender ?? 'male')
    chatStore.setStripVariant(payload.stripVariantIndex ?? 0)
    // 应用自定义提示词覆盖(有则覆盖,无则不清除现有)
    if (payload.promptOverrides) {
      settingsStore.promptOverrides = { ...payload.promptOverrides }
    }
    // 应用自定义世界观设定(有则覆盖,无则不清除现有)
    if (payload.worldSetting) {
      settingsStore.worldSetting = payload.worldSetting
    }
    flushPendingWrites()
    emit('close')
  }
  // 复位确认态(内嵌模式无 open 翻转驱动 watch,必须主动复位)
  confirmKind.value = null
  pendingImport.value = null
}

function onCancelConfirm() {
  confirmKind.value = null
  pendingImport.value = null
}
</script>

<template>
  <Transition name="dm">
    <div
      v-if="open"
      class="dm"
      :class="{ 'dm--embedded': embedded }"
      @click.self="emit('close')"
    >
      <div class="dm__panel" :class="{ 'dm__panel--narrow': !!confirmKind }">
        <!-- 右上角 × 关闭按钮(内嵌模式不显示) -->
        <button v-if="!embedded" class="dm__close" type="button" aria-label="关闭" @click="emit('close')">×</button>
        <h2 v-if="!embedded" class="dm__title">数据管理</h2>
        <p class="dm__stats">
          干员 {{ stats.cardCount }} · 对话 {{ stats.convCount }} · 消息 {{ stats.msgCount }} · 数据
          {{ stats.sizeKB }} KB
        </p>

        <!-- 二次确认页 -->
        <div v-if="confirmKind" class="dm__confirm">
          <p class="dm__confirm-text">{{ confirmTexts[confirmKind] }}</p>
          <div class="dm__actions">
            <button class="dm__btn dm__btn--primary" type="button" @click="onConfirm">确认</button>
            <button class="dm__btn" type="button" @click="onCancelConfirm">取消</button>
          </div>
        </div>

        <!-- 主页面:导出/导入 + 三个全局清空按钮 -->
        <template v-else>
          <div class="dm__actions">
            <button class="dm__btn dm__btn--primary" type="button" :disabled="isExporting" @click="onExport">
              {{ isExporting ? '导出中…' : '导出数据' }}
            </button>
            <button class="dm__btn" type="button" @click="onPickFile">导入数据</button>
          </div>

          <div class="dm__divider"></div>

          <div class="dm__actions dm__actions--menu">
            <button class="dm__btn dm__btn--danger" type="button" @click="onRequestClear">删除全部对话</button>
            <button class="dm__btn" type="button" @click="onRequestClearMessages">清空全部消息</button>
            <button class="dm__btn" type="button" @click="onRequestClearContext">清空全部上下文</button>
          </div>
        </template>

        <p v-if="importError" class="dm__error">{{ importError }}</p>

        <input ref="fileInput" type="file" :accept="EXPORT_FILE_EXT" hidden @change="onFileChange" />
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 数据管理弹窗:半透明遮罩 + 居中深色面板(CSS 绘制,不新增素材图)
@include dialog-shell(dm, 500px, 14px, 'stats', true);

// 内嵌模式(设置弹窗内):去掉遮罩/居中定位,面板铺满容器宽度
.dm {
  &--embedded {
    position: static;
    inset: auto;
    display: block;
    background: transparent;
    z-index: auto;

    .dm__panel {
      width: 100%;
      max-width: none;
      padding: 0;
      border: none;
      box-shadow: none;
      background: transparent;
    }
  }

  &__panel--narrow {
    width: 348px;
  }

  &__confirm-text {
    margin: 0 0 14px;
    font-family: $font-harmony;
    font-size: 16px;
    color: $color-subcard-text;
  }

  &__divider {
    height: 1px;
    margin: 14px 0;
    background: rgba(255, 255, 255, 0.1);
  }

  &__error {
    margin: 12px 0 0;
    font-family: $font-harmony;
    font-size: 14px;
    color: #ff8f8f;
  }

  &__actions--menu {
    flex-direction: column;
    gap: 10px;
  }

  &__btn--danger {
    background: #7a2e2e;
    color: #f0eeee;
  }
}
</style>
