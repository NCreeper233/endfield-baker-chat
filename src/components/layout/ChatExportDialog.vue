<script setup lang="ts">
// =============================================================================
// 导出聊天截图弹窗(ChatExportDialog)
// -----------------------------------------------------------------------------
// 入口只有一个 —— 选中消息模式底部条的「导出选中消息」/「导出全部消息」:
// 离屏渲染当前对话消息 → 预览 PNG(固定 1×) → 下载。
// 结构沿用 DataManagerDialog 的 dialog-shell 外壳(类前缀 ce);
// 离屏画布 v-if 按需挂载(打开才渲染、关闭即卸载),不常驻占用内存。
// =============================================================================
import { computed, ref, watch } from 'vue'
import { useChatStore } from '../../stores/chat'
import { MATERIALS } from '../../constants/materials'
import { downloadDataUrl } from '../../utils/captureImage'
import ChatExportStage from '../chat/ChatExportStage.vue'
import VersionDialogShell from './VersionDialogShell.vue'
import type { ChatMessage } from '../../types/chat'

const props = defineProps<{
  /** 是否展开(选中消息模式底部条的两个导出出口控制) */
  open: boolean
  /** 当前对话标题(下载文件名用) */
  conversationTitle: string
  /**
   * 只导出这几条消息(缺省 = 当前对话全量)
   *
   * 「导出选中消息」用它;截图链路(离屏画布 / 裁剪 / 下载)与全量导出完全同一套。
   */
  messages?: ChatMessage[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const chatStore = useChatStore()

/** 是否有已选中对话(未选中时仅提示,不挂载离屏画布) */
const hasSub = computed(() => chatStore.activeSub !== null)

/** 离屏画布实例(经 defineExpose 暴露截图状态) */
const stageRef = ref<InstanceType<typeof ChatExportStage> | null>(null)

/** 最新预览图(未生成时为 null) */
const imageSrc = computed(() => stageRef.value?.imageSrc ?? null)
const capturing = computed(() => stageRef.value?.capturing ?? false)
const error = computed(() => stageRef.value?.error ?? null)

/** 预览是否按原大查看(默认等比缩小适配面板) */
const zoomed = ref(false)

/** 保存中(原生端弹出系统保存框期间,防止重复点击) */
const saving = ref(false)

/** 保存失败原因(截图生成成功但落盘失败时单独提示) */
const saveError = ref('')

/** 用户主动取消保存(不是错误,用中性提示,不能报成红字"失败") */
const saveHint = ref('')

/** 下载文件名:{对话标题}-对话截图.png(只导出选中时注明"选中") */
function filename() {
  const suffix = isSubset.value ? '-选中消息' : '-对话截图'
  return `${props.conversationTitle || '对话'}${suffix}.png`
}

/** 是否只导出选中消息 */
const isSubset = computed(() => !!props.messages)

/** 面板副标题:全量显示对话名,子集额外注明条数 */
const subtitle = computed(() =>
  isSubset.value
    ? `${props.conversationTitle} · 已选 ${props.messages?.length ?? 0} 条消息`
    : props.conversationTitle,
)

async function onDownload() {
  const src = stageRef.value?.imageSrc
  if (!src || saving.value) return
  saving.value = true
  saveError.value = ''
  saveHint.value = ''
  try {
    // 原生端会走系统保存框(安卓里 <a download> 点了没反应,见 utils/captureImage)
    await downloadDataUrl(src, filename())
  } catch (err) {
    const msg = err instanceof Error ? err.message : '保存失败'
    // 用户在系统保存框点"取消"不是失败：saveExportFileSmart 抛"已取消导出"，
    // 报成红字会让用户以为导出坏了。
    if (msg.includes('取消')) {
      saveError.value = ''
      saveHint.value = '已取消保存'
    } else {
      saveError.value = msg
    }
  } finally {
    saving.value = false
  }
}

function toggleZoom() {
  zoomed.value = !zoomed.value
}

/** 打开弹窗时回到缩小预览 */
watch(
  () => props.open,
  (open) => {
    if (open) {
      zoomed.value = false
      saveError.value = ''
      saveHint.value = ''
    }
  },
)
</script>

<template>
  <VersionDialogShell :open="open" title="导出聊天截图" kind="notice" @close="emit('close')">
    <p class="ce__text">{{ subtitle }}</p>

    <!-- 未选中对话:提示先行选中(不渲染离屏画布) -->
    <p v-if="!hasSub" class="ce__empty-hint">请先在左侧选中一段对话，再导出聊天截图。</p>

    <template v-else>
      <!-- 预览区:点击在"等比缩小 / 原大(可滚动)"间切换 -->
      <div
        class="ce__preview"
        :class="{ 'ce__preview--zoom': zoomed }"
        @click="toggleZoom"
      >
        <img v-if="imageSrc" class="ce__preview-img" :src="imageSrc" alt="聊天截图预览" />
        <p v-else class="ce__preview-placeholder">
          {{ capturing ? '正在生成预览…' : '等待生成预览…' }}
        </p>
      </div>

      <p v-if="error" class="ce__error">{{ error }}</p>
      <p v-if="saveError" class="ce__error">{{ saveError }}</p>
      <p v-if="saveHint" class="ce__hint">{{ saveHint }}</p>
    </template>

    <template #actions>
      <button
        v-if="hasSub"
        class="pn-btn"
        type="button"
        :disabled="!imageSrc || capturing || saving"
        @click="onDownload"
      >
        <span class="pn-btn__tex" aria-hidden="true"></span>
        <span class="pn-btn__deco" aria-hidden="true"></span>
        <span class="pn-btn__label">{{ saving ? '保存中…' : '下载 PNG' }}</span>
      </button>
    </template>
  </VersionDialogShell>

  <!-- 离屏画布:仅打开且有选中对话时挂载。
       必须 Teleport 到 body:若留在弹窗内部,外壳上的定位规则会覆盖 stage 的
       fixed 定位,使离屏画布参与布局(高度约 1000px)把弹窗内容挤出视口。 -->
  <Teleport to="body">
    <ChatExportStage
      v-if="open && hasSub"
      ref="stageRef"
      :scale="1"
      :messages="props.messages"
    />
  </Teleport>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

// 导出截图弹窗:正文用进入弹窗的白底外壳,这里只补预览区与提示文字
.ce {
  &__text {
    margin: 0 0 12px;
    color: rgba(17, 24, 39, 0.7);
    font-family: $font-harmony;
    font-size: 13px;
    line-height: 1.6;
  }

  &__empty-hint {
    margin: 0;
    color: #111827;
    font-family: $font-harmony;
    font-size: 14px;
    line-height: 1.7;
  }

  // 预览容器:等比缩小适配弹窗(点击切原大可滚动)
  &__preview {
    position: relative;
    max-height: 420px;
    margin: 0 0 12px;
    overflow: hidden;
    border: 1px solid rgba(17, 24, 39, 0.14);
    background: rgba(17, 24, 39, 0.05);
    cursor: zoom-in;
    user-select: none;
    text-align: center;

    // 原大查看:容器可滚动,图片原始尺寸显示
    &--zoom {
      overflow: auto;
      cursor: zoom-out;
    }
  }

  &__preview-img {
    display: block;
    max-width: 100%;
    max-height: 420px;
    margin: 0 auto;

    // 原大:不受容器约束,按 1× 像素显示(高倍率图同样原大)
    .ce__preview--zoom & {
      max-width: none;
      max-height: none;
    }
  }

  &__preview-placeholder {
    margin: 0;
    padding: 110px 0;
    color: rgba(17, 24, 39, 0.55);
    font-family: $font-harmony;
    font-size: 14px;
  }

  &__error {
    margin: 0 0 10px;
    color: #c0392b;
    font-family: $font-harmony;
    font-size: 13px;
  }

  // 中性提示(如"已取消保存"):与错误同位置,但不使用警示色
  &__hint {
    margin: 0 0 10px;
    color: rgba(17, 24, 39, 0.6);
    font-family: $font-harmony;
    font-size: 13px;
  }
}
</style>
