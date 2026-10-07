<script setup lang="ts">
// =============================================================================
// 首次打开公告弹窗(NoticeDialog)
// -----------------------------------------------------------------------------
// 每次打开应用弹出,直到用户点击"不再提醒"(持久化标记)。
// 点"确定"仅关闭本次,下次仍弹。
// 正文来源: 优先使用 App 从网络公告源(notice.peilika.beer 的 JSON/TXT)读取的
//           内容(prop content/title),读取失败/离线时回退内置常量。
// 样式: 迁移自网站迁移公告弹窗(MigrationNoticeDialog)的 dialog-shell 外壳
//       (用户选定样式:深色直角面板 + 网格纹理 + 居中按钮)。
// =============================================================================
import { ref, computed } from 'vue'
import {
  NOTICE_TITLE,
  NOTICE_CONTENT,
  NOTICE_CONFIRM_TEXT,
  NOTICE_DISMISS_TEXT,
} from '../../constants/notice'

const props = defineProps<{
  /** 是否显示 */
  open: boolean
  /** 弹窗正文(App 从网络公告源读取;缺省回退内置常量) */
  content?: string
  /** 弹窗标题(网络公告源 JSON 的 title;空则回退内置标题) */
  title?: string
}>()

const emit = defineEmits<{
  (e: 'confirm'): void   // 确认(本次关闭)
  (e: 'dismiss'): void   // 不再提醒(永久)
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

/** 打开免责声明弹窗 */
function openDisclaimer() {
  showDisclaimer.value = true
}

/** 关闭免责声明弹窗 */
function closeDisclaimer() {
  showDisclaimer.value = false
}
</script>

<template>
  <Transition name="mn">
    <div v-if="open" class="mn">
      <div class="mn__panel">
        <h2 class="mn__title">{{ displayTitle }}</h2>

        <p class="mn__text">{{ displayContent }}</p>

        <p class="mn__disclaimer-hint">
          点击「确定」或「不再提醒」即代表你已阅读和理解《<span class="mn__disclaimer-link" @click="openDisclaimer">免责声明</span>》
        </p>

        <div class="mn__actions">
          <button class="mn__btn mn__btn--primary" type="button" @click="onConfirm">
            {{ NOTICE_CONFIRM_TEXT }}
          </button>
          <button class="mn__btn" type="button" @click="onDismiss">
            {{ NOTICE_DISMISS_TEXT }}
          </button>
        </div>
      </div>
    </div>
  </Transition>

  <!-- 免责声明弹窗 -->
  <Transition name="mn">
    <div v-if="showDisclaimer" class="mn">
      <div class="mn__panel mn__disclaimer-panel">
        <h2 class="mn__title">免责声明</h2>

        <div class="mn__text mn__disclaimer-content">
          <p><strong>一、用户责任与合规使用</strong></p>
          <p>您明确知晓并同意，您是使用本工具生成内容的唯一责任人。您承诺：</p>
          <p>1. 严格遵守您所使用AI模型服务商的所有使用政策与安全准则。</p>
          <p>2. 遵守您所在地及服务商所在地的现行法律法规，绝不利用本工具生成任何涉及政治敏感、淫秽色情、暴力恐怖、仇恨歧视、侵犯他人合法权益以及其他一切违法和不良信息。</p>
          <p>3. 理解并接受本工具仅用于合法的《明日方舟：终末地》同人角色扮演娱乐，任何超出此用途的使用风险自担。</p>

          <p><strong>二、知识产权与同人声明</strong></p>
          <p>《明日方舟：终末地》是上海鹰角网络科技有限公司的游戏产品。本工具为第三方同人作品，无任何盈利性质，与上海鹰角网络科技有限公司及《明日方舟：终末地》官方开发商、运营商无任何关联。</p>
          <p>本工具中使用的所有与《明日方舟：终末地》相关的角色形象、世界观设定、剧情元素、图片资源等知识产权，均归上海鹰角网络科技有限公司所有。本工具仅供爱好者学习与交流，严禁用于任何商业用途。</p>

          <p><strong>三、免责条款</strong></p>
          <p>在法律允许的最大范围内，本工具开发者不对以下情况承担任何明示或默示的担保或责任：</p>
          <p>1. 用户因违反本声明或第三方服务商条款而产生的任何纠纷、处罚或损失；</p>
          <p>2. 用户因篡改代码等自主行为所引发的一切后果；</p>
          <p>3. 对第三方AI模型服务商提供的服务质量、内容准确性及合规性。</p>
          <p>请您在使用前务必仔细阅读并同意以上全部条款。继续使用即代表您已充分理解并自愿承担所有相关风险。</p>
        </div>

        <div class="mn__actions">
          <button class="mn__btn mn__btn--primary" type="button" @click="closeDisclaimer">
            我知道了
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 公告弹窗外壳:与迁移公告弹窗同款(dialog-shell 深色直角面板 + 网格纹理)
@include dialog-shell(mn, 480px, 12px);

.mn {
  // 正文保留换行(常量/TXT 中的 \n 生效),长文本可滚动
  &__text {
    white-space: pre-line;
    max-height: 55vh;
    overflow-y: auto;
  }

  // 按钮水平居中(与迁移公告弹窗一致)
  &__actions {
    justify-content: center;
    margin-top: 24px;
  }

  // 免责声明提示文本
  &__disclaimer-hint {
    margin: 16px 0 0;
    font-family: $font-harmony;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
    text-align: center;
  }

  // 免责声明链接(黄色可点击)
  &__disclaimer-link {
    color: #ffef00;
    cursor: pointer;
    text-decoration: none;

    &:hover {
      color: #fff983;
      text-decoration: underline;
    }
  }

  // 免责声明弹窗面板
  &__disclaimer-panel {
    width: 560px;
  }

  // 免责声明内容样式(可滚动但隐藏滚动条)
  &__disclaimer-content {
    max-height: 60vh;
    overflow-y: auto;
    // 隐藏滚动条(但保留滚动功能)
    scrollbar-width: none; // Firefox
    -ms-overflow-style: none; // IE/Edge
    &::-webkit-scrollbar {
      display: none; // Chrome/Safari/Webkit
    }

    p {
      margin: 0 0 8px;
      line-height: 1.6;

      &:last-child {
        margin-bottom: 0;
      }
    }

    strong {
      color: $color-text-primary;
      font-size: 14px;
    }
  }
}
</style>
