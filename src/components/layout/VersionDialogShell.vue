<script setup lang="ts">
// VersionDialogShell —— 公告 / 提醒 / 更新共用的弹窗外壳（品牌条 + 标题栏 + 正文区 + 角标）
// 只负责壳与开合动画：入场 170ms 缩放淡入，出场 350ms 缩放淡出；正文与按钮由插槽给出。

/** 标题栏左侧图标(三种弹窗各一枚;48×48 线框,统一 currentColor) */
export type VersionDialogKind = 'notice' | 'alert' | 'update'

const props = withDefaults(
  defineProps<{
    /** 是否显示 */
    open: boolean
    /** 标题栏文字 */
    title: string
    /** 图标种类 */
    kind?: VersionDialogKind
    /** 版本号(有值才画左上角的小徽标,如 v2.4) */
    version?: string
    /** 日期文字(有值才画在徽标右边,如 2026-10-18) */
    date?: string
    /** 关闭按钮是否可用(如「正在保存」时禁用) */
    closable?: boolean
    /**
     * 呈现方式
     *
     *   modal(默认):全屏遮罩 + 居中弹窗(公告 / 提醒 / 更新 / 各类确认框)
     *   float      :**不**渲染遮罩、不占满屏,只输出卡片本体,由调用方塞进自己的
     *                浮动容器(如可拖动的 TOKEN 用量小窗)
     */
    variant?: 'modal' | 'float'
  }>(),
  { kind: 'notice', version: '', date: '', closable: true, variant: 'modal' },
)

const emit = defineEmits<{
  /** 点了右上角关闭按钮(等价于点面板外的遮罩) */
  (e: 'close'): void
}>()

/** 三种图标对应的路径片段(filled = 实心片段) */
const ICONS: Record<VersionDialogKind, { d: string; filled?: boolean }[]> = {
  // 公告:文档 + 两条横线
  notice: [
    { d: 'M10 6H30L38 14V42H10Z' },
    { d: 'M30 6V14H38' },
    { d: 'M16 22H32' },
    { d: 'M16 30H32' },
    { d: 'M16 38H26' },
  ],
  // 提醒:圆形外框 + 感叹号
  alert: [
    {
      d:
        'M24 44C29.5228 44 34.5228 41.7614 38.1421 38.1421C41.7614 34.5228 44 29.5228 44 24' +
        'C44 18.4772 41.7614 13.4772 38.1421 9.85786C34.5228 6.23858 29.5228 4 24 4' +
        'C18.4772 4 13.4772 6.23858 9.85786 9.85786C6.23858 13.4772 4 18.4772 4 24' +
        'C4 29.5228 6.23858 34.5228 9.85786 38.1421C13.4772 41.7614 18.4772 44 24 44Z',
    },
    { d: 'M24 13V28' },
    {
      d:
        'M24 37C25.3807 37 26.5 35.8807 26.5 34.5C26.5 33.1193 25.3807 32 24 32' +
        'C22.6193 32 21.5 33.1193 21.5 34.5C21.5 35.8807 22.6193 37 24 37Z',
      filled: true,
    },
  ],
  // 更新:向上的箭头 + 底座
  update: [
    { d: 'M24 6L36 18H30V30H18V18H12Z' },
    { d: 'M10 34V42H38V34' },
  ],
}

/** 关闭(不可关闭时忽略点击) */
function onClose(): void {
  if (!props.closable) return
  emit('close')
}
</script>

<template>
  <Transition name="fx">
    <div
      v-if="open"
      class="fx"
      :class="{ 'fx--float': variant === 'float' }"
      @click.self="onClose"
    >
      <div v-if="variant !== 'float'" class="fx__scrim" aria-hidden="true"></div>

      <div class="fx__frame" role="dialog" aria-modal="true" :aria-label="title">
        <!-- ================= 顶部品牌条 ================= -->
        <header class="fx__head">
          <div class="fx__strip">
            <span class="fx__strip-y" aria-hidden="true"></span>
            <span class="fx__strip-g">
              <svg class="fx__brand-svg" viewBox="0 0 120 10" aria-hidden="true">
                <polygon points="0,2 7,2 3.5,8" fill="#363636"></polygon>
                <text x="7" y="7" font-size="7" font-style="italic" fill="#363636" font-weight="bold" font-family="Outfit">//</text>
                <text x="16" y="7" font-size="7" fill="#363636" font-weight="bold" font-family="Outfit">ARKNIGHTS:ENDFIELD</text>
              </svg>
              <svg class="fx__plus" viewBox="0 0 10 10" aria-hidden="true">
                <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="#363636" stroke-width="1"></rect>
                <line x1="5" y1="2.5" x2="5" y2="7.5" stroke="#363636" stroke-width="1"></line>
                <line x1="2.5" y1="5" x2="7.5" y2="5" stroke="#363636" stroke-width="1"></line>
              </svg>
            </span>
          </div>

          <!-- 标题栏 -->
          <div class="fx__titlebar">
            <div class="fx__iconbox">
              <svg viewBox="0 0 48 48" aria-hidden="true">
                <path
                  v-for="(p, i) in ICONS[kind]"
                  :key="i"
                  :d="p.d"
                  :fill="p.filled ? 'currentColor' : 'none'"
                  :stroke="p.filled ? 'none' : 'currentColor'"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </div>
            <h2 class="fx__title">{{ title }}</h2>
            <span class="fx__watermark" aria-hidden="true">ENDFIELD</span>
          </div>

          <!-- 右上角关闭按钮 -->
          <button class="fx__close" type="button" aria-label="关闭" @click="onClose">
            <svg viewBox="0 0 205 205" fill="currentColor" fill-rule="evenodd" aria-hidden="true">
              <path d="M0 25L25 0L205 180L180 205ZM25 205L0 180L180 0L205 25Z"></path>
            </svg>
          </button>

          <!-- 黄/灰分隔线 + 黄色小三角 -->
          <div class="fx__rule" aria-hidden="true"></div>
        </header>

        <!-- ================= 正文 ================= -->
        <div class="fx__body">
          <div class="fx__scroll">
            <div v-if="version || date" class="fx__meta">
              <span v-if="version" class="fx__badge">{{ version }}</span>
              <span v-if="date" class="fx__date">{{ date }}</span>
            </div>
            <slot />
          </div>

          <div class="fx__actions">
            <slot name="actions" />
          </div>

          <div class="fx__tricolor" aria-hidden="true"></div>
        </div>

        <!-- ================= 底部灰装饰条 ================= -->
        <footer class="fx__footer" aria-hidden="true">
          <span class="fx__deco-solid"></span>
          <span class="fx__deco-outline"></span>
          <span class="fx__deco-hatch"></span>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

$fx-yellow: #ffff21;
$fx-ink: #363636;
$fx-ink-2: #484848;
$fx-strip-gray: #999;
$fx-footer-gray: #ababab;
$fx-deco: #838383;
$fx-border: #e5e7eb;
$fx-body-ink: #111827;

.fx {
  position: fixed;
  inset: 0;
  z-index: 400;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  overflow: auto;
  // 仅供 Transition 读取时长:真正的淡入淡出由子元素动画承担
  transition: opacity 0.17s linear;
}

.fx__scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
}

// float 变体：不占满屏、不压暗背景，只作为卡片嵌进调用方的浮动容器（如用量小窗）
.fx--float {
  position: static;
  inset: auto;
  z-index: auto;
  display: block;
  padding: 0;
  overflow: visible;

  .fx__frame {
    width: 100%;
    max-height: none;
    // 浮动小窗:直角(不做圆角)
    border-radius: 0;
    // 浮层投影:让它从后面的界面上"浮"起来
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.45);
    overflow: hidden;
  }

  // 浮窗不需要标题栏左侧的图标块、也不需要背后那层描边水印
  .fx__iconbox,
  .fx__watermark {
    display: none;
  }

  .fx__titlebar {
    padding-left: 16px;
  }
}

.fx__frame {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(44rem, 100%);
  max-height: 100%;
  // 动画作用层:入场 / 出场都以这一层为基准缩放
  transform-origin: center center;
}

// 顶部品牌条
.fx__head {
  position: relative;
  flex-shrink: 0;
}

.fx__strip {
  display: flex;
  align-items: stretch;
  width: 22rem;
  max-width: 100%;
  height: 0.9375rem;
  transform-origin: left center;
}

.fx__strip-y {
  width: 3.1875rem;
  background: $fx-yellow;
}

.fx__strip-g {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  padding: 0 0.25rem;
  background: $fx-strip-gray;
}

.fx__brand-svg {
  display: block;
  width: auto;
  height: 0.625rem;
}

.fx__plus {
  display: block;
  flex-shrink: 0;
  width: 0.625rem;
  height: 0.625rem;
}

// 标题栏
.fx__titlebar {
  position: relative;
  display: flex;
  gap: 1.5rem;
  height: 3.9375rem;
  overflow: hidden;
  background: $fx-ink;
}

.fx__iconbox {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 4.9375rem;
  background: $fx-ink-2;
  color: #d3d3d3;

  svg {
    display: block;
    width: 1.5rem;
    height: 1.5rem;
  }
}

.fx__title {
  display: flex;
  flex: 1;
  align-items: center;
  margin: 0;
  overflow: hidden;
  color: #fff;
  font-family: $font-harmony;
  font-size: 2rem;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.fx__watermark {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  color: rgba(255, 255, 255, 0.05);
  font-family: 'Outfit', sans-serif;
  font-size: 9rem;
  font-weight: 700;
  letter-spacing: -0.875rem;
  line-height: 1;
  pointer-events: none;
  user-select: none;
}

.fx__close {
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
  background: $fx-yellow;
  color: $fx-ink;
  cursor: pointer;
  font-size: 1.5rem;
  line-height: 1;

  svg {
    display: block;
    width: 0.75rem;
    height: 0.75rem;
  }
}

// 黄/灰分隔线 + 黄色小三角
.fx__rule {
  position: relative;
  z-index: 10;
  height: 0.375rem;
  background: linear-gradient(90deg, $fx-yellow 0 50%, #d3d3d3 50% 100%);
  filter: drop-shadow(0 0 0.1875rem rgba(0, 0, 0, 0.5));
  transform-origin: left center;

  &::after {
    content: '';
    position: absolute;
    left: 8.125rem;
    bottom: -0.5rem;
    display: block;
    border-left: 0.75rem solid transparent;
    border-right: 0.75rem solid transparent;
    border-top: 0.75rem solid $fx-yellow;
  }
}

// 正文区（白底 + 斜纹）
.fx__body {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: #fff;
  background-image: repeating-linear-gradient(
    -45deg,
    transparent,
    transparent 2px,
    rgba(204, 204, 204, 0.133) 2px,
    rgba(204, 204, 204, 0.133) 3px
  );
}

.fx__scroll {
  flex: 1;
  min-height: 0;
  max-height: 60vh;
  overflow-y: auto;
  padding: 1.25rem 1.5rem;
}

.fx__meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid $fx-border;
}

.fx__badge {
  display: inline-flex;
  align-items: center;
  padding: 0.125rem 0.375rem;
  border: 1px solid $fx-border;
  color: #6b7280;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.fx__date {
  color: rgba(17, 24, 39, 0.7);
  font-size: 0.75rem;
}

.fx__actions {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  border-top: 1px solid $fx-border;
}

// 右下角三色渐变条
.fx__tricolor {
  position: absolute;
  right: 1.275rem;
  bottom: 0;
  width: 15rem;
  height: 0.25rem;
  background: linear-gradient(90deg, #00ffa2 0 42.5%, $fx-yellow 42.5% 79.2%, #ff00f0 79.2% 100%);
  transform-origin: right center;
  pointer-events: none;
}

// 底部装饰条
.fx__footer {
  display: flex;
  flex-shrink: 0;
  align-items: flex-start;
  justify-content: flex-start;
  height: 0.9375rem;
  margin-right: 2.25rem;
  padding: 0 1rem;
  background: $fx-footer-gray;
  transform-origin: left center;
}

.fx__deco-solid {
  width: 0.5rem;
  height: 0.5rem;
  background: $fx-deco;
}

.fx__deco-outline {
  width: 0.5rem;
  height: 0.5rem;
  margin-left: 0.125rem;
  border: 1px solid $fx-deco;
  -webkit-mask-image: linear-gradient(#fff, #fff 0.125rem, transparent 0.125rem, transparent 0.375rem, #fff 0.375rem);
  mask-image: linear-gradient(#fff, #fff 0.125rem, transparent 0.125rem, transparent 0.375rem, #fff 0.375rem);
}

.fx__deco-hatch {
  width: 3rem;
  height: 0.5rem;
  margin-left: 0.25rem;
  background-image: repeating-linear-gradient(-45deg, transparent, transparent 1px, $fx-deco 1px, $fx-deco 2px);
}

// 开合动画
.fx-enter-active {
  // 时长与 .fx__frame 的入场动画一致(供 Vue 判断何时移除过渡类)
  transition-duration: 0.17s;

  .fx__scrim {
    animation: fx-scrim-in 0.17s linear both;
  }

  .fx__frame {
    animation: fx-enter 0.17s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }

  .fx__strip {
    animation: fx-strip 0.17s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }

  .fx__rule {
    animation: fx-rule 0.22s 0.06s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }

  .fx__footer {
    animation: fx-rule 0.24s 0.1s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }

  .fx__tricolor {
    animation: fx-rule 0.3s 0.12s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }
}

.fx-leave-active {
  // 出场 350ms:品牌条先收拢,整体再缩放淡出
  transition-duration: 0.35s;

  .fx__scrim {
    animation: fx-scrim-out 0.35s ease-in both;
  }

  .fx__frame {
    animation: fx-exit 0.35s cubic-bezier(0.55, 0.06, 0.68, 0.19) both;
  }

  .fx__strip {
    animation: fx-strip-out 0.35s cubic-bezier(0.55, 0.06, 0.68, 0.19) both;
  }
}

@keyframes fx-scrim-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

@keyframes fx-scrim-out {
  from {
    opacity: 1;
  }

  to {
    opacity: 0;
  }
}

@keyframes fx-enter {
  from {
    opacity: 0;
    transform: scale(0.9);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes fx-exit {
  from {
    opacity: 1;
    transform: none;
  }

  to {
    opacity: 0;
    transform: scale(0.9);
  }
}

@keyframes fx-strip {
  from {
    transform: scaleX(0.85);
    opacity: 0;
  }

  to {
    transform: none;
    opacity: 1;
  }
}

@keyframes fx-strip-out {
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

@keyframes fx-rule {
  from {
    transform: scaleX(0);
  }

  to {
    transform: none;
  }
}

// 移动端
@media (max-width: 768px) {
  .fx {
    padding: 10px;
  }

  .fx__strip {
    width: 100%;
  }

  .fx__titlebar {
    height: 3.25rem;
    gap: 0.75rem;
  }

  .fx__iconbox {
    width: 3.5rem;

    svg {
      width: 1.25rem;
      height: 1.25rem;
    }
  }

  .fx__title {
    font-size: 1.35rem;
  }

  .fx__watermark {
    font-size: 5rem;
    letter-spacing: -0.5rem;
  }

  .fx__rule::after {
    left: 3.5rem;
    border-left-width: 0.55rem;
    border-right-width: 0.55rem;
    border-top-width: 0.55rem;
    bottom: -0.4rem;
  }

  .fx__scroll {
    max-height: 56vh;
    padding: 0.9rem 1rem;
  }

  .fx__actions {
    padding: 0.6rem 1rem;
  }

  .fx__tricolor {
    width: 8rem;
    right: 0.75rem;
  }
}

// 偏好减少动态
@media (prefers-reduced-motion: reduce) {
  .fx-enter-active,
  .fx-leave-active {
    .fx__scrim,
    .fx__frame,
    .fx__strip,
    .fx__rule,
    .fx__footer,
    .fx__tricolor {
      animation: none !important;
    }
  }
}
</style>
