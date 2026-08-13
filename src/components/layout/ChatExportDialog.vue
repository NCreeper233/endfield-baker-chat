<script setup lang="ts">
// =============================================================================
// 导出聊天截图弹窗(ChatExportDialog)
// -----------------------------------------------------------------------------
// 工具栏点「分享」打开:离屏渲染当前对话全量消息 → 预览 PNG(固定 1×) → 下载。
// 结构沿用 DataManagerDialog 的 dialog-shell 外壳(类前缀 ce);
// 离屏画布 v-if 按需挂载(打开才渲染、关闭即卸载),不常驻占用内存。
// =============================================================================
import { computed, ref, watch } from 'vue'
import { useChatStore } from '../../stores/chat'
import { MATERIALS } from '../../constants/materials'
import { downloadDataUrl } from '../../utils/captureImage'
import ChatExportStage from '../chat/ChatExportStage.vue'

const props = defineProps<{
  /** 是否展开(App 的「分享」按钮控制) */
  open: boolean
  /** 当前对话标题(下载文件名用) */
  conversationTitle: string
  /** 自定义背景图(data URL,与应用背景一致) */
  customBgUrl?: string | null
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

/** 下载文件名:{对话标题}-对话截图.png */
function filename() {
  return `${props.conversationTitle || '对话'}-对话截图.png`
}

function onDownload() {
  const src = stageRef.value?.imageSrc
  if (src) downloadDataUrl(src, filename())
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
    }
  },
)
</script>

<template>
  <Transition name="ce">
    <div v-if="open" class="ce" @click.self="emit('close')">
      <div class="ce__panel">
        <!-- 右上角 × 关闭按钮 -->
        <button class="ce__close" type="button" aria-label="关闭" @click="emit('close')">×</button>
        <h2 class="ce__title">导出聊天截图</h2>
        <p class="ce__text">{{ conversationTitle }}</p>

        <!-- 未选中对话:提示先行选中(不渲染离屏画布) -->
        <p v-if="!hasSub" class="ce__empty-hint">请先在左侧选中一段对话，再点击「分享」导出。</p>

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

          <div class="ce__actions">
            <button
              class="ce__btn ce__btn--primary"
              type="button"
              :disabled="!imageSrc || capturing"
              @click="onDownload"
            >下载 PNG</button>
          </div>
        </template>

      </div>
    </div>
  </Transition>

  <!-- 离屏画布:仅打开且有选中对话时挂载。
       必须 Teleport 到 body:若放在 .ce__panel 内,dialog-shell 的
       `> * { position: relative }` 会覆盖 stage 的 fixed 定位,
       使离屏画布参与面板布局(高度约 1000px)把弹窗内容挤出视口。 -->
  <Teleport to="body">
    <ChatExportStage
      v-if="open && hasSub"
      ref="stageRef"
      :scale="1"
      :custom-bg-url="customBgUrl"
    />
  </Teleport>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 导出聊天截图弹窗:半透明遮罩 + 居中深色面板(类前缀 ce)
@include dialog-shell(ce, 720px, 14px, 'text', true);

// 弹窗专属补充:预览区 / 倍率按钮 / 空态提示
.ce {
  &__empty-hint {
    margin: 0 0 18px;
    font-family: $font-harmony;
    font-size: 15px;
    color: $color-subcard-text;
  }

  // 预览容器:等比缩小适配面板(点击切原大可滚动)
  &__preview {
    position: relative;
    max-height: 420px;
    margin: 0 0 16px;
    overflow: hidden;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: rgba(0, 0, 0, 0.25);
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
    padding: 120px 0;
    font-family: $font-harmony;
    font-size: 15px;
    color: $color-subcard-text;
  }

  &__error {
    margin: 0 0 14px;
    font-family: $font-harmony;
    font-size: 14px;
    color: #ff8f8f;
  }
}
</style>
