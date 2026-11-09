<script setup lang="ts">
// DisclaimerDialog —— 免责声明弹窗
// 开屏公告弹窗里的「免责声明」与设置 → 关于页底部的按钮共用这一份，
// 文案只维护一次，避免两处条款走散。
import VersionDialogShell from './VersionDialogShell.vue'

withDefaults(
  defineProps<{
    /** 是否显示 */
    open: boolean
    /**
     * 层级
     *
     * 从「设置 → 关于」打开时要压过设置面板(500)，所以默认给 560；
     * 开屏弹窗打开时本来就没有别的面板，560 也不会盖错东西。
     */
    layer?: number
  }>(),
  { layer: 560 },
)

const emit = defineEmits<{
  (e: 'close'): void
}>()
</script>

<template>
  <VersionDialogShell
    :open="open"
    title="免责声明"
    kind="alert"
    :layer="layer"
    @close="emit('close')"
  >
    <div class="ds__legal">
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
      <button class="pn-btn" type="button" @click="emit('close')">
        <span class="pn-btn__tex" aria-hidden="true"></span>
        <span class="pn-btn__deco" aria-hidden="true"></span>
        <span class="pn-btn__label">我知道了</span>
      </button>
    </template>
  </VersionDialogShell>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

// 免责声明正文:白底深字,段间留白
.ds__legal {
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
</style>
