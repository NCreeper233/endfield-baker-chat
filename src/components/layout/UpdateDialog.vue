<script setup lang="ts">
// UpdateDialog —— 版本更新提示：服务端 version 大于当前版本时弹，仅客户端弹
// 「不再提示」只忽略该版本，更高版本仍会提示；「前往下载」按平台打开对应安装包。
import { computed } from 'vue'

import { APP_VERSION, type RuntimePlatform } from '../../constants/popups'
import VersionDialogShell from './VersionDialogShell.vue'

const props = defineProps<{
  /** 是否显示 */
  open: boolean
  /** 服务端最新版本号 */
  version: string
  /** 下载地址(调用方已按平台选好;空串表示该平台暂无链接) */
  downloadUrl: string
  /** 运行平台(用于"手机版 / 电脑版"文案) */
  platform: RuntimePlatform
}>()

const emit = defineEmits<{
  (e: 'ignore'): void
}>()

/** 当前版本(直接取常量,避免调用方多传一个 prop) */
const currentVersion = APP_VERSION

/**
 * 蓝奏云提取码(下载页需要输入),显示在「前往下载」下方的小字中
 *
 * 若后续密码变更,改这一处即可。
 */
const downloadPassword = '6666'

/** 平台文案:安卓 = 手机版,Windows = 电脑版 */
const platformLabel = computed(() => {
  if (props.platform === 'android') return '手机版'
  if (props.platform === 'windows') return '电脑版'
  return ''
})

/** 下载按钮文案 */
const downloadText = computed(() =>
  platformLabel.value ? `前往下载（${platformLabel.value}）` : '前往下载',
)
</script>

<template>
  <VersionDialogShell
    :open="open"
    title="发现新版本"
    kind="update"
    :version="`v${version}`"
    @close="emit('ignore')"
  >
    <p class="ud__text">
      新版本 v{{ version }} 已发布（当前 v{{ currentVersion }}）。
      建议更新后再继续使用，以获得更好的体验。
    </p>

    <p v-if="!downloadUrl" class="ud__hint">该平台下载地址暂未提供，请稍后再试。</p>

    <template #actions>
      <button class="pn-btn pn-btn--light" type="button" @click="emit('ignore')">
        <span class="pn-btn__label">不再提示</span>
      </button>

      <!-- 用 a 标签,确保在 WebView / Electron 中都能正常打开;两行:主文案 + 提取码 -->
      <a
        v-if="downloadUrl"
        class="pn-btn ud__link"
        :href="downloadUrl"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span class="pn-btn__tex" aria-hidden="true"></span>
        <span class="pn-btn__deco" aria-hidden="true"></span>
        <span class="pn-btn__label ud__link-label">
          <span class="ud__link-main">{{ downloadText }}</span>
          <span class="ud__link-sub">密码 {{ downloadPassword }}</span>
        </span>
      </a>
    </template>
  </VersionDialogShell>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

.ud {
  &__text {
    margin: 0;
    color: #111827;
    font-family: $font-harmony;
    font-size: 14px;
    line-height: 1.75;
    white-space: pre-line;
  }

  &__hint {
    margin: 12px 0 0;
    color: rgba(17, 24, 39, 0.55);
    font-family: $font-harmony;
    font-size: 13px;
    line-height: 1.6;
  }

  // a 标签按钮:两行布局(主文案 + 提取码小字),去掉下划线
  &__link {
    text-decoration: none;
  }

  &__link-label {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    line-height: 1.25;
  }

  &__link-main {
    font-size: 14px;
  }

  &__link-sub {
    color: rgba(254, 252, 252, 0.72);
    font-size: 11px;
    letter-spacing: 0.5px;
  }
}
</style>
