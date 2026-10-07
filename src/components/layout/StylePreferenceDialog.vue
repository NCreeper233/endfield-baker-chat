<script setup lang="ts">
// =============================================================================
// 首次使用偏好弹窗(StylePreferenceDialog)
// -----------------------------------------------------------------------------
// 本次更新(动作/神态描写新增「彩色」与「居中」两档效果)之后,**第一次**进入
// 网站时问一次偏好,分两步:
//
//   第一步:是否开启「动作 / 神态描写」?
//     不开启 → 角色只输出台词(等价于设置里的「沉浸式对话模式」),**不再问样式**
//     开启   → 进入第二步
//
//   第二步:选显示样式(三选一)
//     1. 开启彩色 → 括号描写居中显示,并按说话人属性上色
//     2. 关闭彩色 → 括号描写仍居中,但统一用半透明白
//     3. 关闭居中 → 括号描写留在气泡里(旧版行为)
//
// 设计要点:
//   - 只负责"展示 + 上报选择",不直接改 store(与 AlertDialog / NoticeDialog 同款分工)
//   - 选项即按钮:点任意一项立刻生效并关闭,没有"确定/取消"两步
//   - 第一步选「不开启」时,第二步的样式选项**根本不会渲染**(不是隐藏而是 v-if 卸载),
//     所以那三张示意图也不会被请求
//   - 三张示意图是聊天截图(宽高比约 2.7:1),桌面端「图左文右」并排,
//     移动端(≤768px)自动改成「图上文下」,面板可整屏滚动 —— 见文件末尾样式
//   - 一次性:选完置标记,之后不再弹出;想改随时去 设置 →「显示和内容输出」
// =============================================================================
import { ref, watch } from 'vue'
import { MATERIALS } from '../../constants/materials'

/**
 * 偏好取值(与 App.vue 的落库逻辑一一对应)
 *
 * 'none' = 第一步选「不开启」,只关括号描写、不问样式。
 *
 * ⚠️ `script setup` 里不能 export 类型,所以这里只作本文件内部约束;
 *    App.vue 那边按同样的字面量联合接收(emit 签名即契约,改这里会立刻报错)。
 */
type StylePreference = 'none' | 'color' | 'mono' | 'off'

const props = defineProps<{
  /** 是否显示 */
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'choose', mode: StylePreference): void
  /**
   * 稍后再说
   *
   * 只关掉本次弹窗、**不写一次性标记**,所以下次进入(刷新 / 重开)照旧会问。
   * "本次会话内别再弹"由 App.vue 的内存标记负责,组件不持有任何状态。
   */
  (e: 'later'): void
}>()

/** 当前步骤:'ask' = 问是否开启;'style' = 挑显示样式 */
const step = ref<'ask' | 'style'>('ask')

// 每次打开都从第一步开始(关掉再打开不该停在上次的第二步)
watch(
  () => props.open,
  (open) => {
    if (open) step.value = 'ask'
  },
)

/** 第二步的样式选项(顺序 = 展示顺序;图与文案一一对应) */
const OPTIONS: Array<{
  mode: StylePreference
  image: string
  title: string
  desc: string
}> = [
  {
    mode: 'color',
    image: MATERIALS.prefBracketColorOn,
    title: '彩色居中文字',
    desc: '描写居中显示，并按角色的属性上色（物理灰 / 灼热红 / 电磁黄 / 寒冷青 / 自然绿 / 超域紫）',
  },
  {
    mode: 'mono',
    image: MATERIALS.prefBracketColorOff,
    title: '灰色居中文字',
    desc: '仍居中显示，但所有描写都用统一的半透明白，不区分属性',
  },
  {
    mode: 'off',
    image: MATERIALS.prefBracketCenterOff,
    title: '默认括号样式',
    desc: '括号描写留在气泡里（旧版显示效果），不单独成行',
  },
]
</script>

<template>
  <Transition name="sp">
    <div v-if="open" class="sp">
      <div class="sp__panel">
        <!-- ================= 第一步:是否开启动作 / 神态描写 ================= -->
        <template v-if="step === 'ask'">
          <h2 class="sp__title">是否开启「动作 / 神态描写」？</h2>
          <p class="sp__text">
            角色有时会在括号里写动作与神态，例如「（微微一笑）交给我吧」。开启后可以再挑它的显示样式；不开启则让角色只输出台词。之后随时可以在「设置 → 显示和内容输出」里更改。
          </p>

          <div class="sp__ask">
            <button type="button" class="sp__ask-btn" @click="step = 'style'">
              <span class="sp__ask-name">开启</span>
              <span class="sp__ask-desc">角色会写括号里的动作 / 神态，下一步挑选显示样式</span>
            </button>
            <button type="button" class="sp__ask-btn" @click="emit('choose', 'none')">
              <span class="sp__ask-name">不开启</span>
              <span class="sp__ask-desc">只保留台词，不再出现括号描写（仅默认 API 模式 / 群聊生效）</span>
            </button>
          </div>

          <p class="sp__foot">点击任意一项即生效，此后不再询问</p>
        </template>

        <!-- ================= 第二步:显示样式三选一 ================= -->
        <template v-else>
          <h2 class="sp__title">选择「动作 / 神态描写」的显示样式</h2>
          <p class="sp__text">之后随时可以在「设置 → 显示和内容输出」里更改。</p>

          <div class="sp__options">
            <button
              v-for="opt in OPTIONS"
              :key="opt.mode"
              type="button"
              class="sp__option"
              @click="emit('choose', opt.mode)"
            >
              <img class="sp__thumb" :src="opt.image" :alt="opt.title" />
              <span class="sp__texts">
                <span class="sp__name">{{ opt.title }}</span>
                <span class="sp__desc">{{ opt.desc }}</span>
              </span>
            </button>
          </div>

          <p class="sp__foot">点击任意一项即生效，此后不再询问</p>
        </template>

        <!-- 稍后再说:不写标记,下次进入还会问一次(只是本次会话内不再打扰) -->
        <div class="sp__later">
          <button type="button" class="sp__later-btn" @click="emit('later')">稍后再说</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 外壳沿用站内统一弹窗样式(深色直角面板 + 网格纹理 + 遮罩)
// 面板给 640px:第二步三行「图左文右」刚好排得下,窄屏由 dialog-shell 的
// max-width:100% + 本文件末尾的移动端规则接管
@include dialog-shell(sp, 640px, 10px);

.sp {
  // ---- 第一步:两个按钮并排 ----
  &__ask {
    display: flex;
    gap: 12px;
    margin-top: 4px;
  }

  &__ask-btn {
    flex: 1 1 0;
    padding: 16px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(255, 255, 255, 0.04);
    cursor: pointer;
    text-align: left;
    transition: border-color $anim-fast $ease-default, background-color $anim-fast $ease-default;

    &:hover,
    &:focus-visible {
      border-color: $color-subcard-selected;
      background: rgba(255, 239, 0, 0.08);
      outline: none;
    }
  }

  &__ask-name {
    display: block;
    font-family: $font-harmony;
    font-size: 18px;
    color: $color-text-primary;
  }

  &__ask-desc {
    display: block;
    margin-top: 8px;
    font-family: $font-harmony;
    font-size: 13px;
    line-height: 1.5;
    color: $color-subcard-text;
  }

  // ---- 第二步:三行选项,行内「图左文右」 ----
  &__options {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 4px;
  }

  &__option {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    padding: 10px 12px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(255, 255, 255, 0.04);
    cursor: pointer;
    text-align: left;
    transition: border-color $anim-fast $ease-default, background-color $anim-fast $ease-default;

    // 悬停/聚焦用站内标识色(子卡选中黄)呼应,不做花哨动效
    &:hover,
    &:focus-visible {
      border-color: $color-subcard-selected;
      background: rgba(255, 239, 0, 0.08);
      outline: none;
    }
  }

  // 示意图:定宽 + 保持原始比例(三张截图比例略有差异,不做裁剪,避免切掉文字)
  &__thumb {
    display: block;
    flex: none;
    width: 300px;
    height: auto;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  &__texts {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0; // 允许长描述换行而不是撑破行
  }

  &__name {
    font-family: $font-harmony;
    font-size: 17px;
    color: $color-text-primary;
  }

  &__desc {
    font-family: $font-harmony;
    font-size: 13px;
    line-height: 1.5;
    color: $color-subcard-text;
  }

  &__foot {
    margin: 16px 0 0;
    font-family: $font-harmony;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.45);
    text-align: center;
  }

  // 稍后再说:黄色按钮(站内标识色;不写标记,下次进入还会问)
  &__later {
    margin-top: 18px;
    text-align: center;
  }

  &__later-btn {
    min-width: 132px;
    padding: 10px 18px;
    border: none;
    background: $color-subcard-selected;
    color: #1c1c1c;
    font-family: $font-harmony;
    font-size: 16px;
    cursor: pointer;
    transition: filter 0.15s ease;

    &:hover,
    &:focus-visible {
      filter: brightness(0.92);
      outline: none;
    }
  }

  // ---- 移动端(≤768px) ----
  //   1. 第一步的两个按钮竖排(并排会挤成两个窄条)
  //   2. 第二步每项改成纵向布局,图片铺满面板宽度
  //   3. 收紧面板内边距与行距,尽量一屏内看完
  //   4. 外层 dialog-shell 已是"整屏可滚 + 面板限高滚动",这里不再锁高
  @media (max-width: 768px) {
    &__panel {
      padding: 20px 14px 14px;
    }

    &__title {
      font-size: 17px;
      line-height: 1.4;
    }

    &__text {
      margin-bottom: 14px;
      font-size: 13px;
      line-height: 1.5;
    }

    &__ask {
      flex-direction: column;
      gap: 10px;
    }

    &__ask-btn {
      padding: 12px;
    }

    &__ask-name {
      font-size: 16px;
    }

    &__ask-desc {
      margin-top: 6px;
      font-size: 12.5px;
    }

    &__options {
      gap: 10px;
    }

    &__option {
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
      padding: 8px;
    }

    &__thumb {
      width: 100%;
    }

    &__name {
      font-size: 16px;
    }

    &__desc {
      font-size: 12.5px;
    }

    &__foot {
      margin-top: 12px;
    }
  }
}
</style>
