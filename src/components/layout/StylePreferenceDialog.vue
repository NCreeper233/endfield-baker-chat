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
//   - 外观是一张"小工具卡片":贴在右上角、无遮罩,不打断阅读。
//     左上角有一枚 Q 版立绘从卡片顶端探出(见样式里的 .sp__chibi)
// =============================================================================
import { computed, ref, watch } from 'vue'
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

/** 卡片标题随步骤变化 */
const cardTitle = computed(() => (step.value === 'ask' ? '动作 / 神态描写' : '显示样式'))

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
    desc: '描写居中显示，并按角色的属性上色',
  },
  {
    mode: 'mono',
    image: MATERIALS.prefBracketColorOff,
    title: '灰色居中文字',
    desc: '仍居中显示，统一用半透明白',
  },
  {
    mode: 'off',
    image: MATERIALS.prefBracketCenterOff,
    title: '默认括号样式',
    desc: '括号留在气泡里（旧版效果）',
  },
]
</script>

<template>
  <Transition name="sp">
    <div v-if="open" class="sp" role="dialog" aria-modal="false" :aria-label="cardTitle">
      <div class="sp__card">
        <!-- ================= 顶部:品牌条 + 斜切标题栏 ================= -->
        <header class="sp__head">
          <div class="sp__strip">
            <span class="sp__strip-y" aria-hidden="true"></span>
            <span class="sp__strip-g">
              <svg class="sp__brand" viewBox="0 0 120 10" aria-hidden="true">
                <polygon points="0,2 7,2 3.5,8" fill="#363636"></polygon>
                <text x="7" y="7" font-size="7" font-style="italic" fill="#363636" font-weight="bold" font-family="Outfit">//</text>
                <text x="16" y="7" font-size="7" fill="#363636" font-weight="bold" font-family="Outfit">ARKNIGHTS:ENDFIELD</text>
              </svg>
              <svg class="sp__plus" viewBox="0 0 10 10" aria-hidden="true">
                <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="#363636" stroke-width="1"></rect>
                <line x1="5" y1="2.5" x2="5" y2="7.5" stroke="#363636" stroke-width="1"></line>
                <line x1="2.5" y1="5" x2="7.5" y2="5" stroke="#363636" stroke-width="1"></line>
              </svg>
            </span>
          </div>

          <div class="sp__titlebar">
            <div class="sp__slant"><span class="sp__dots" aria-hidden="true"></span></div>
            <div class="sp__title">{{ cardTitle }}</div>
            <span class="sp__watermark" aria-hidden="true">ENDFIELD</span>
          </div>

          <button class="sp__close" type="button" aria-label="关闭" @click="emit('later')">
            <svg viewBox="0 0 205 205" fill="currentColor" fill-rule="evenodd" aria-hidden="true">
              <path d="M0 25L25 0L205 180L180 205ZM25 205L0 180L180 0L205 25Z"></path>
            </svg>
          </button>

          <!-- Q 版立绘:从卡片顶端探出 -->
          <div class="sp__chibi" aria-hidden="true">
            <img :src="MATERIALS.prefChibi" alt="" />
          </div>

          <div class="sp__rule" aria-hidden="true"></div>
        </header>

        <!-- ================= 正文 ================= -->
        <div class="sp__body">
          <div class="sp__pad">
            <!-- ---------- 第一步 ---------- -->
            <template v-if="step === 'ask'">
              <p class="sp__hint">是否开启「动作 / 神态描写」？</p>
              <p class="sp__sub">
                角色有时会在括号里写动作与神态，例如「（微微一笑）交给我吧」。开启后可以再挑显示样式；不开启则让角色只输出台词。之后随时可以在「设置 → 显示和内容输出」里更改。
              </p>

              <div class="sp__actions">
                <button class="ma-btn ma-btn--dark" type="button" @click="step = 'style'">
                  <span class="ma-btn__label">开启</span>
                </button>
                <button class="ma-btn ma-btn--light" type="button" @click="emit('choose', 'none')">
                  <span class="ma-btn__label">不开启</span>
                </button>
              </div>
            </template>

            <!-- ---------- 第二步 ---------- -->
            <template v-else>
              <p class="sp__hint">选择「动作 / 神态描写」的显示样式</p>

              <div class="sp__options">
                <button
                  v-for="opt in OPTIONS"
                  :key="opt.mode"
                  class="sp__opt"
                  type="button"
                  @click="emit('choose', opt.mode)"
                >
                  <img class="sp__thumb" :src="opt.image" :alt="opt.title" />
                  <span class="sp__opt-name">{{ opt.title }}</span>
                  <span class="sp__opt-desc">{{ opt.desc }}</span>
                </button>
              </div>
            </template>

            <p class="sp__foot">点击任意一项即生效，此后不再询问</p>
          </div>
        </div>

        <!-- ================= 底部:浅色次按钮 → 三色线 → 灰装饰条 ================= -->
        <div class="sp__later">
          <button class="ma-btn ma-btn--light" type="button" @click="emit('later')">
            <span class="ma-btn__label">稍后再说</span>
          </button>
        </div>

        <div class="sp__tricolor" aria-hidden="true"></div>

        <footer class="sp__footer" aria-hidden="true">
          <span class="sp__deco-solid"></span>
          <span class="sp__deco-outline"></span>
          <span class="sp__deco-hatch"></span>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

$ma-yellow: #ffff21;
$ma-ink: #363636;
$ma-strip-gray: #999;
$ma-footer-gray: #ababab;
$ma-deco: #838383;

.sp {
  position: fixed;
  top: 96px;
  right: 16px;
  z-index: 320;
  width: 320px;
  max-width: calc(100vw - 32px);
  // 无遮罩:卡片之外仍可正常操作聊天界面
  pointer-events: none;
}

.sp__card {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-height: calc(100vh - 128px);
  pointer-events: auto;
  filter: drop-shadow(0 10px 26px rgba(0, 0, 0, 0.4));
}

// ---------------------------------------------------------------------------
// 顶部品牌条 + 标题栏
// ---------------------------------------------------------------------------
.sp__head {
  position: relative;
  flex-shrink: 0;
}

.sp__strip {
  display: flex;
  align-items: stretch;
  width: 100%;
  height: 0.9375rem;
  transform-origin: left center;
}

.sp__strip-y {
  flex: 0 0 1.7rem;
  background: $ma-yellow;
}

.sp__strip-g {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  padding: 0 0.2rem;
  background: $ma-strip-gray;
}

.sp__brand {
  display: block;
  width: auto;
  height: 0.5rem;
}

.sp__plus {
  display: block;
  flex-shrink: 0;
  width: 0.5rem;
  height: 0.5rem;
}

.sp__titlebar {
  position: relative;
  display: flex;
  min-height: 2.75rem;
  overflow: hidden;
  background: $ma-ink;
}

// 左侧黄色平行四边形(右侧斜切)
.sp__slant {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 26%;
  background: $ma-yellow;
  clip-path: polygon(0 0, 100% 0, calc(100% - 18px) 100%, 0 100%);
}

// 斜块上的圆点纹理(自下而上渐隐)
.sp__dots {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 67%;
  background-image: radial-gradient(circle, $ma-ink 0.8px, transparent 1px);
  background-size: 4px 4px;
  opacity: 0.45;
  -webkit-mask-image: linear-gradient(to top, #000, transparent);
  mask-image: linear-gradient(to top, #000, transparent);
  pointer-events: none;
}

.sp__title {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  padding: 0.5rem 2.6rem 0.5rem 0.6rem;
  overflow: hidden;
  color: #fff;
  font-family: $font-harmony;
  font-size: 1.05rem;
  font-weight: 700;
  line-height: 1.25;
  word-break: break-word;
}

.sp__watermark {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  color: rgba(255, 255, 255, 0.05);
  font-family: 'Outfit', sans-serif;
  font-size: 5.4rem;
  font-weight: 700;
  letter-spacing: -0.6rem;
  line-height: 1;
  pointer-events: none;
  user-select: none;
}

.sp__close {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 20;
  display: grid;
  place-content: center;
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  border: 0;
  background: $ma-yellow;
  color: $ma-ink;
  cursor: pointer;

  svg {
    display: block;
    width: 0.7rem;
    height: 0.7rem;
  }
}

// Q 版立绘:向左上探出卡片(不拦截点击)
.sp__chibi {
  position: absolute;
  top: -45px;
  left: 8px;
  z-index: 20;
  width: 88px;
  height: 88px;
  pointer-events: none;

  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
}

// 黄/灰分隔线 + 黄三角(比大弹窗的小一号)
.sp__rule {
  position: relative;
  z-index: 10;
  height: 0.375rem;
  background: linear-gradient(90deg, #ffff1b 0 50%, #d3d3d3 50% 100%);
  filter: drop-shadow(0 0 0.1875rem rgba(0, 0, 0, 0.5));
  transform-origin: left center;

  &::after {
    content: '';
    position: absolute;
    left: 40px;
    bottom: -8px;
    display: block;
    border-left: 9px solid transparent;
    border-right: 9px solid transparent;
    border-top: 9px solid #ffff1b;
  }
}

// ---------------------------------------------------------------------------
// 正文(白底斜纹)
// ---------------------------------------------------------------------------
.sp__body {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  background: #fff;
  background-image: repeating-linear-gradient(
    -45deg,
    transparent,
    transparent 2px,
    rgba(204, 204, 204, 0.133) 2px,
    rgba(204, 204, 204, 0.133) 3px
  );
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.sp__pad {
  padding: 0.75rem;
}

.sp__hint {
  margin: 0;
  padding: 0.15rem 0;
  color: #111827;
  font-family: $font-harmony;
  font-size: 0.95rem;
  font-weight: 500;
  line-height: 1.5;
}

.sp__sub {
  margin: 6px 0 0;
  color: rgba(17, 24, 39, 0.66);
  font-family: $font-harmony;
  font-size: 12px;
  line-height: 1.7;
}

.sp__actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.85rem;
}

// 三个样式选项:浅色卡片,纵向「图 + 标题 + 说明」
.sp__options {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.6rem;
}

.sp__opt {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  width: 100%;
  padding: 0.4rem 0.4rem 0.5rem;
  border: 0;
  background: #f2f1ef;
  box-shadow: 0 0 0 0.05em #f2f1ef, 0 0 0 0.05em #a0a2a3 inset;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.15s ease, box-shadow 0.15s ease;

  &:hover {
    background: #e4e3e1;
    box-shadow: 0 0 0 0.05em #e4e3e1, 0 0 0 0.05em #8d8f90 inset;
  }

  &:focus-visible {
    outline: 2px solid #b8a800;
    outline-offset: 1px;
  }
}

.sp__thumb {
  display: block;
  width: 100%;
  height: auto;
  margin-bottom: 4px;
  border: 1px solid rgba(0, 0, 0, 0.08);
}

.sp__opt-name {
  padding: 0 0.2rem;
  color: #2f2f2f;
  font-family: $font-harmony;
  font-size: 13px;
  font-weight: 600;
}

.sp__opt-desc {
  padding: 0 0.2rem;
  color: rgba(47, 47, 47, 0.66);
  font-family: $font-harmony;
  font-size: 11.5px;
  line-height: 1.5;
}

.sp__foot {
  margin: 10px 0 0;
  color: rgba(17, 24, 39, 0.5);
  font-family: $font-harmony;
  font-size: 11px;
  text-align: center;
}

// 三色渐变条:放在「稍后再说」下面、灰装饰条上面,右端对齐
.sp__tricolor {
  flex-shrink: 0;
  height: 0.25rem;
  background-color: #fff;
  background-image: linear-gradient(90deg, #00ffa2 0 42.5%, $ma-yellow 42.5% 79.2%, #ff00f0 79.2% 100%);
  background-repeat: no-repeat;
  background-size: 8rem 100%;
  background-position: right 0.9rem top;
  pointer-events: none;
}

// ---------------------------------------------------------------------------
// 底部条
// ---------------------------------------------------------------------------
.sp__later {
  flex-shrink: 0;
  padding: 0.5rem 0.75rem;
  background: #fff;
  border-top: 1px solid #e5e7eb;
}

.sp__footer {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  height: 0.9375rem;
  padding: 0 0.75rem;
  background: $ma-footer-gray;
}

.sp__deco-solid {
  width: 0.4rem;
  height: 0.4rem;
  background: $ma-deco;
}

.sp__deco-outline {
  width: 0.4rem;
  height: 0.4rem;
  margin-left: 2px;
  border: 1px solid $ma-deco;
  -webkit-mask-image: linear-gradient(#fff, #fff 0.1rem, transparent 0.1rem, transparent 0.3rem, #fff 0.3rem);
  mask-image: linear-gradient(#fff, #fff 0.1rem, transparent 0.1rem, transparent 0.3rem, #fff 0.3rem);
}

.sp__deco-hatch {
  width: 2rem;
  height: 0.4rem;
  margin-left: 3px;
  background-image: repeating-linear-gradient(-45deg, transparent, transparent 1px, $ma-deco 1px, $ma-deco 2px);
}

// ---------------------------------------------------------------------------
// 卡片内按钮(深色主按钮 / 浅色次按钮)
// ---------------------------------------------------------------------------
.ma-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 2.35rem;
  padding: 0.4rem 1rem;
  border: 0;
  overflow: hidden;
  cursor: pointer;
  font-family: $font-harmony;
  font-size: 0.875rem;
  line-height: 1.25;
  transition: background-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;

  &--dark {
    background: #2a2728;
    color: #fefcfc;
    box-shadow: 0 0 0 0.05em #2a2728, 0 0 0 0.05em #81807f inset;

    &:hover {
      background: #1e1c1c;
      color: #f3f1f1;
      box-shadow: 0 0 0 0.05em #1e1c1c, 0 0 0 0.05em #81807f inset;
    }
  }

  &--light {
    background: #f2f1ef;
    color: #4d4d4d;
    box-shadow: 0 0 0 0.05em #f2f1ef, 0 0 0 0.05em #a0a2a3 inset;

    &:hover {
      background: #d4d3d1;
      color: #5a5a5a;
      box-shadow: 0 0 0 0.05em #d4d3d1, 0 0 0 0.05em #a0a2a3 inset;
    }
  }

  &__label {
    position: relative;
    z-index: 1;
  }
}

// ---------------------------------------------------------------------------
// 入场 / 出场(与大弹窗同款补间:缩放 + 淡入淡出)
// ---------------------------------------------------------------------------
.sp-enter-active {
  transition-duration: 0.18s;

  .sp__card {
    animation: sp-in 0.18s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }

  .sp__strip {
    animation: sp-strip 0.18s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }

  .sp__rule {
    animation: sp-rule 0.22s 0.06s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }

  .sp__footer {
    animation: sp-rule 0.24s 0.1s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }
}

.sp-leave-active {
  transition-duration: 0.35s;

  .sp__card {
    animation: sp-out 0.35s cubic-bezier(0.55, 0.06, 0.68, 0.19) both;
  }

  .sp__strip {
    animation: sp-strip-out 0.35s cubic-bezier(0.55, 0.06, 0.68, 0.19) both;
  }
}

@keyframes sp-in {
  from {
    opacity: 0;
    transform: scale(0.9);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes sp-out {
  from {
    opacity: 1;
    transform: none;
  }

  to {
    opacity: 0;
    transform: scale(0.9);
  }
}

@keyframes sp-strip {
  from {
    transform: scaleX(0.85);
    opacity: 0;
  }

  to {
    transform: none;
    opacity: 1;
  }
}

@keyframes sp-strip-out {
  0% {
    transform: none;
    opacity: 1;
  }

  60% {
    transform: scaleX(0.4);
    opacity: 1;
  }

  to {
    transform: scaleX(0);
    opacity: 0;
  }
}

@keyframes sp-rule {
  from {
    transform: scaleX(0);
  }

  to {
    transform: none;
  }
}

// ---------------------------------------------------------------------------
// 移动端:卡片铺满宽度,贴在顶部
// ---------------------------------------------------------------------------
@media (max-width: 768px) {
  .sp {
    top: auto;
    right: 10px;
    bottom: 12px;
    left: 10px;
    width: auto;
    max-width: none;
  }

  .sp__card {
    max-height: min(72vh, calc(100vh - 90px));
  }

  .sp__chibi {
    width: 72px;
    height: 72px;
    top: -38px;
  }

  .sp__title {
    font-size: 0.98rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sp-enter-active,
  .sp-leave-active {
    .sp__card,
    .sp__strip,
    .sp__rule,
    .sp__footer {
      animation: none !important;
    }
  }
}
</style>
