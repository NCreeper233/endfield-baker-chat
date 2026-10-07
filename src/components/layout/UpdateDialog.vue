<script setup lang="ts">
// =============================================================================
// 更新弹窗(UpdateDialog)
// -----------------------------------------------------------------------------
// 服务端 JSON 的 version 大于当前版本时,在客户端(Windows / 安卓)弹出。
// 网页端不弹(由 usePopups 依据运行平台决定,本组件不自行判断)。
//
// 两个按钮:
//   - 不再提示 :灰色按钮(与设置弹窗内的次要按钮同款配色)
//                 点击后记录该版本号,同一版本不再提示;更高版本仍会提示
//   - 前往下载   :亮色主按钮,新窗口打开蓝奏云对应平台安装包
//                 (安卓 → apk;Windows → exe)
// 样式复用 dialog-shell 外壳,与站内其他弹窗保持一致的深色直角面板风格。
// =============================================================================
import { computed } from 'vue'

import { APP_VERSION, type RuntimePlatform } from '../../constants/popups'

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
 * 与官网下载卡片保持一致
 *
 * 蓝奏云分享链接带有访问密码,这里固定展示便于玩家复制;
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
  <Transition name="ud">
    <div v-if="open" class="ud">
      <div class="ud__panel">
        <h2 class="ud__title">发现新版本</h2>

        <p class="ud__text">
          新版本 v{{ version }} 已发布（当前 v{{ currentVersion }}）。
          建议更新后再继续使用，以获得更好的体验。
        </p>

        <div class="ud__actions">
          <!-- 不再提示:灰色次要按钮 -->
          <button class="ud__btn" type="button" @click="emit('ignore')">
            不再提示
          </button>

          <!-- 前往下载:亮色主按钮(用 a 标签,确保在 WebView / Electron 中都能正常打开) -->
          <!-- 按钮内两行:主文案「前往下载」+ 小字提示蓝奏云提取码 -->
          <a
            v-if="downloadUrl"
            class="ud__btn ud__btn--primary ud__btn--link"
            :href="downloadUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span class="ud__btn-main">{{ downloadText }}</span>
            <span class="ud__btn-sub">密码 {{ downloadPassword }}</span>
          </a>
        </div>

        <p v-if="!downloadUrl" class="ud__hint">该平台下载地址暂未提供，请稍后再试。</p>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 更新弹窗外壳:与站内其他弹窗同款(dialog-shell 深色直角面板 + 网格纹理)
@include dialog-shell(ud, 500px, 14px);

.ud {
  // 说明文字
  &__text {
    white-space: pre-line;
  }

  // 按钮行:忽略在左、下载在右,窄屏可换行
  &__actions {
    justify-content: center;
    flex-wrap: wrap;
    margin-top: 22px;
  }

  // a 标签按钮:两行布局(主文案「前往下载」+ 提取码小字)
  &__btn--link {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    padding-top: 7px;
    padding-bottom: 7px;
    line-height: 1.25;
    text-decoration: none;
    box-sizing: border-box;
  }

  // 主文案
  &__btn-main {
    font-size: 16px;
  }

  // 提取码小字(蓝奏云密码)
  &__btn-sub {
    font-size: 11px;
    opacity: 0.78;
    letter-spacing: 0.5px;
  }

  // 无下载地址时的提示
  &__hint {
    margin: 14px 0 0;
    font-family: $font-harmony;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.5);
    text-align: center;
  }
}
</style>
