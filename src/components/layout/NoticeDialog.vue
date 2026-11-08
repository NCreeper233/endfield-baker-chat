<script setup lang="ts">
// NoticeDialog —— 首次打开公告：每次启动弹出，直到点「不再提醒」；点「确定」只关本次
// 正文优先用 App 拉到的服务端内容，读取失败 / 离线时回退内置常量。
import { ref, computed } from 'vue'
import {
  NOTICE_TITLE,
  NOTICE_CONTENT,
  NOTICE_CONFIRM_TEXT,
  NOTICE_DISMISS_TEXT,
} from '../../constants/notice'
import VersionDialogShell from './VersionDialogShell.vue'

const props = defineProps<{
  /** 是否显示 */
  open: boolean
  /** 弹窗正文(App 从网络公告源读取;缺省回退内置常量) */
  content?: string
  /** 弹窗标题(网络公告源 JSON 的 title;空则回退内置标题) */
  title?: string
  /** 版本号(公告页里用于左上角徽标,如 v2.4) */
  version?: string
  /** 日期文字 */
  date?: string
}>()

const emit = defineEmits<{
  (e: 'confirm'): void   // 确认(本次关闭)
  (e: 'dismiss'): void   // 不再提醒(永久)
  (e: 'all'): void       // 查看全部公告(打开公告页)
}>()

/** 展示标题:网络 JSON 的 title 优先,为空回退内置常量 */
const displayTitle = computed(() => props.title?.trim() || NOTICE_TITLE)

/** 展示正文:外部公告源优先(响应式跟随),为空/失败时回退内置常量 */
const displayContent = computed(() => props.content?.trim() || NOTICE_CONTENT)

/** 免责声明弹窗是否打开 */
const showDisclaimer = ref(false)

/** 确认:仅关闭本次弹窗(由父级复位 open) */
function onConfirm() {
  emit('confirm')
}

/** 不再提醒:永久关闭(由父级写入持久化标记) */
function onDismiss() {
  emit('dismiss')
}

/** 打开 / 关闭免责声明 */
function openDisclaimer() {
  showDisclaimer.value = true
}

function closeDisclaimer() {
  showDisclaimer.value = false
}
</script>

<template>
  <VersionDialogShell
    :open="open"
    :title="displayTitle"
    kind="notice"
    :version="version"
    :date="date"
    @close="onConfirm"
  >
    <p class="nd__text">{{ displayContent }}</p>

    <p class="nd__hint">
      点击「{{ NOTICE_CONFIRM_TEXT }}」或「{{ NOTICE_DISMISS_TEXT }}」即代表你已阅读和理解
      《<button class="nd__link" type="button" @click="openDisclaimer">免责声明</button>》
    </p>

    <template #actions>
      <button class="pn-btn pn-btn--light" type="button" @click="emit('all')">
        <span class="pn-btn__label">全部公告</span>
      </button>
      <button class="pn-btn pn-btn--light" type="button" @click="onDismiss">
        <span class="pn-btn__label">{{ NOTICE_DISMISS_TEXT }}</span>
      </button>
      <button class="pn-btn" type="button" @click="onConfirm">
        <span class="pn-btn__tex" aria-hidden="true"></span>
        <span class="pn-btn__deco" aria-hidden="true"></span>
        <span class="pn-btn__label">{{ NOTICE_CONFIRM_TEXT }}</span>
      </button>
    </template>
  </VersionDialogShell>

  <!-- 免责声明:同一副外壳,正文长可滚动 -->
  <VersionDialogShell
    :open="showDisclaimer"
    title="免责声明"
    kind="alert"
    @close="closeDisclaimer"
  >
    <div class="nd__legal">
      <p><strong>一、用户责任与合规使用</strong></p>
      <p>您明确知晓并同意，您是使用本工具生成内容的唯一责任人。您承诺：</p>
      <p>1. 严格遵守您所使用 AI 模型服务商的所有使用政策与安全准则。</p>
      <p>2. 遵守您所在地及服务商所在地的现行法律法规，绝不利用本工具生成任何涉及政治敏感、淫秽色情、暴力恐怖、仇恨歧视、侵犯他人合法权益以及其他一切违法和不良信息。</p>
      <p>3. 理解并接受本工具仅用于合法的《明日方舟：终末地》同人角色扮演娱乐，任何超出此用途的使用风险自担。</p>

      <p><strong>二、知识产权与同人声明</strong></p>
      <p>《明日方舟：终末地》是上海鹰角网络科技有限公司的游戏产品。本工具为第三方同人作品，无任何盈利性质，与上海鹰角网络科技有限公司及《明日方舟：终末地》官方开发商、运营商无任何关联。</p>
      <p>本工具中使用的所有与《明日方舟：终末地》相关的角色形象、世界观设定、剧情元素、图片资源等知识产权，均归上海鹰角网络科技有限公司所有。本工具仅供爱好者学习与交流，严禁用于任何商业用途。</p>

      <p><strong>三、免责条款</strong></p>
      <p>在法律允许的最大范围内，本工具开发者不对以下情况承担任何明示或默示的担保或责任：</p>
      <p>1. 用户因违反本声明或第三方服务商条款而产生的任何纠纷、处罚或损失；</p>
      <p>2. 用户因篡改代码等自主行为所引发的一切后果；</p>
      <p>3. 对第三方 AI 模型服务商提供的服务质量、内容准确性及合规性。</p>
      <p>请您在使用前务必仔细阅读并同意以上全部条款。继续使用即代表您已充分理解并自愿承担所有相关风险。</p>
    </div>

    <template #actions>
      <button class="pn-btn" type="button" @click="closeDisclaimer">
        <span class="pn-btn__tex" aria-hidden="true"></span>
        <span class="pn-btn__deco" aria-hidden="true"></span>
        <span class="pn-btn__label">我知道了</span>
      </button>
    </template>
  </VersionDialogShell>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

.nd {
  &__text {
    margin: 0;
    color: #111827;
    font-family: $font-harmony;
    font-size: 14px;
    line-height: 1.75;
    white-space: pre-line;
  }

  &__hint {
    margin: 18px 0 0;
    color: rgba(17, 24, 39, 0.55);
    font-family: $font-harmony;
    font-size: 12px;
    line-height: 1.6;
  }

  &__link {
    padding: 0;
    border: 0;
    background: none;
    color: #b8860b;
    font-family: inherit;
    font-size: inherit;
    text-decoration: underline;
    cursor: pointer;

    &:hover {
      color: #8a6508;
    }
  }

  // 免责声明正文:白底深字,段间留白
  &__legal {
    color: #111827;
    font-family: $font-harmony;
    font-size: 13.5px;
    line-height: 1.8;

    p {
      margin: 0 0 8px;

      &:last-child {
        margin-bottom: 0;
      }
    }

    strong {
      display: block;
      margin-top: 10px;
      color: #000;
      font-size: 14.5px;
    }
  }
}
</style>
