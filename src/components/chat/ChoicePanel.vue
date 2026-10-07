<script setup lang="ts">
// =============================================================================
// AI 推荐选项(ChoicePanel)—— 独立胶囊浮层
// -----------------------------------------------------------------------------
// 形态:每条选项 = 一颗**独立的胶囊形浮层气泡**,上下留间距,**结构完全一致**:
//
//     ┌────────────────────────────────────╌╌╌╌╌╌╌╌
//     │    ( ○ )  纯白文字                 ╎             ← 右侧渐隐,看不到胶囊形状
//     └────────────────────────────────────╌╌╌╌╌╌╌╌
//          ↑ 白色正圆 + 三个镂空点(距左缘留出空隙)
//
// 视觉:
//   - 底色:半透明深灰黑 + backdrop-filter 毛玻璃(**不是实色**,能透出下方聊天内容)
//   - 描边:浅灰、半透明、加粗(桌面 5px / 移动端 4px;同样是毛玻璃的一部分)
//   - 渐隐:整颗按钮用 mask 从左往右做透明度渐变 —— 左侧 100% 不透明,
//           右侧一段淡出到全透明(渐隐宽度 = 右内边距,起始点因此靠左),
//           连底带描边一起消失,看不到右侧的胶囊圆角。
//           渐隐宽度 = 右内边距,所以文字永远不会被削到。
//
// 位置:输入面板正上方、**靠右**排列(bottom:100% + 右对齐)。
// 容器本身透明且不拦事件(pointer-events:none),只有胶囊可点 ——
// 它是一层浮在聊天内容上的气泡,不再是过去那块顶到面板的实色板。
//
// 尺寸口径:按钮高 / 头像直径 / 内边距 / 文字量宽上限 / 测量字体 全部来自同一个
// S 对象,由它下发为 CSS 变量。散成两处一定会漂移:截断位置与 CSS 字体不匹配、
// 头像比气泡还高之类的错位都是这么来的。
// =============================================================================
import { computed, inject, toValue } from 'vue'
import {
  chatGeometryKey,
  globalChatGeometry,
  DESKTOP_GEOM,
  type ChatGeometry,
} from '../../constants/chatGeometry'
import { emojiToHtml, measureTextWithEmoji } from '../../constants/emoji'
import type { PlayerChoice } from '../../types/chat'

const props = defineProps<{
  /** 待渲染的选项(空数组时渲染空状态提示) */
  choices: PlayerChoice[]
  /** 可用最大高度(px):超出则内部滚动,避免盖满整个聊天区 */
  maxHeight: number
}>()

const emit = defineEmits<{
  /** 点击某个选项(label 由父组件作为用户消息发出) */
  (e: 'pick', label: string): void
}>()

/** 注入几何(面板位置/尺寸;导出模式由 ChatExportStage 覆盖) */
const injectedGeom = inject(chatGeometryKey, globalChatGeometry) ?? DESKTOP_GEOM
const geom = computed<ChatGeometry>(() => toValue(injectedGeom))

/** 是否移动端(几何层 stripSegmented 仅移动端为 true,与 ChatInput 同判据) */
const isMobile = computed(() => geom.value.stripSegmented)

/**
 * 尺寸口径(按端区分)
 *
 *   btnH    胶囊高
 *   avatar  头像正圆直径(随胶囊高缩放,保持"圆占高度大部分"的观感)
 *   border  描边粗细(计入宽度预算,量文字时不能漏算)
 *   padL    胶囊左内边距(头像距左缘的空隙)
 *   gap     头像与文字之间
 *   fade    右侧渐隐(渐变)段长度:这一段里底与描边逐渐变淡
 *   hide    右侧**全透明**段长度:这一段彻底不显示 —— 胶囊右端(圆角帽)落在这里,
 *           所以右侧看不到任何胶囊形状。必须 > btnH/2 才能盖住整个圆角帽。
 *   font    文字字号(与量宽用的字体必须一致)
 *   itemGap 两条选项之间的间距
 *   edge    整块气泡距面板左右边缘的留白
 *   bottom  最下面一条距输入面板上缘的留白
 *
 * 右侧总内缩 = fade + hide,文字正好在渐变起点处结束 → 永远不会被削到。
 */
const S = computed(() =>
  isMobile.value
    ? { btnH: 52, avatar: 22, border: 4, padL: 14, gap: 13, fade: 36, hide: 48, font: 14, itemGap: 7, edge: 12, bottom: 8 }
    : { btnH: 68, avatar: 30, border: 5, padL: 20, gap: 16, fade: 56, hide: 72, font: 21, itemGap: 10, edge: 24, bottom: 12 },
)

/** 胶囊右侧总内缩(px)= 渐隐段 + 全透明段 */
const padRight = computed(() => S.value.fade + S.value.hide)

/** 尺寸全部下发为 CSS 变量:模板里不再逐个写 inline 样式,保证每条结构一致 */
const panelStyle = computed(() => {
  const s = S.value
  return {
    maxHeight: `${props.maxHeight}px`,
    '--c-h': `${s.btnH}px`,
    '--c-avatar': `${s.avatar}px`,
    '--c-border-w': `${s.border}px`,
    // 底色与描边色收敛成两个变量:悬停时互换(见 &__bubble:hover)
    '--c-fill': 'rgba(26, 26, 28, 0.34)',
    '--c-stroke': 'rgba(214, 212, 212, 0.42)',
    '--c-pad-l': `${s.padL}px`,
    '--c-gap': `${s.gap}px`,
    '--c-pad-r': `${padRight.value}px`,
    '--c-fade': `${s.fade}px`,
    '--c-hide': `${s.hide}px`,
    '--c-font': `${s.font}px`,
    '--c-item-gap': `${s.itemGap}px`,
    '--c-edge': `${s.edge}px`,
    '--c-bottom': `${s.bottom}px`,
  } as Record<string, string>
})

/** 胶囊最大宽(不超出面板;两侧各留 edge) */
const maxBubbleW = computed(() => Math.max(140, geom.value.panelWidth - S.value.edge * 2))

/** 文字可用宽 = 胶囊最大宽 − 左右描边 − 头像区(左内边距 + 头像 + 间隙) − 右侧总内缩 */
const textMaxW = computed(() =>
  Math.max(
    60,
    maxBubbleW.value -
      (S.value.border * 2 + S.value.padL + S.value.avatar + S.value.gap) -
      padRight.value,
  ),
)

// ---- 文本量宽与省略 ---------------------------------------------------------
// 用 canvas 按真实字体测量,超宽则二分定位最大字符数再加 "..."。
// 纯渲染前裁剪,不动 CSS 盒模型(CSS 只做兜底 overflow:hidden)。

const measureCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
const measureCtx = measureCanvas?.getContext('2d') ?? null

function measureText(text: string): number {
  if (!measureCtx) return text.length * S.value.font
  // 字体必须与胶囊 CSS 实际渲染的一致,否则截断位置会错
  measureCtx.font = `500 ${S.value.font}px "HarmonyOS Sans SC Medium"`
  return measureTextWithEmoji(measureCtx, text)
}

/** 超长文本截断:末尾加 "..."(预留省略号自身宽度,避免贴边) */
function ellipsisText(text: string): string {
  const limit = textMaxW.value
  if (measureText(text) <= limit) return text
  const ellipsisW = measureText('...')
  const room = limit - ellipsisW
  if (room <= 0) return '...'
  let lo = 1
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measureText(text.slice(0, mid)) <= room) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + '...'
}

/** 渲染前预处理:裁剪文字 + 表情 token 转 HTML */
const displayChoices = computed(() =>
  props.choices.map((c) => {
    const label = ellipsisText(c.label)
    return { label, labelHtml: emojiToHtml(label) }
  }),
)

/**
 * 头像正圆路径(白色实心圆 + 三个镂空点)
 *
 * 用 `fill-rule="evenodd"` 把三个小圆从大圆里"挖掉":点内区域被两个子路径
 * 同时包围(偶数次)→ 不填充,于是真正透出下方背景,而不是画三个深色点。
 * 三个点在水平方向均匀分布(圆心 30 / 50 / 70),整体水平居中、垂直居中。
 */
const AVATAR_CIRCLE = 'M0,50a50,50 0 1,0 100,0a50,50 0 1,0 -100,0Z'
const AVATAR_DOTS = [
  'M22,50a8,8 0 1,0 16,0a8,8 0 1,0 -16,0Z',
  'M42,50a8,8 0 1,0 16,0a8,8 0 1,0 -16,0Z',
  'M62,50a8,8 0 1,0 16,0a8,8 0 1,0 -16,0Z',
].join('')
const AVATAR_PATH = AVATAR_CIRCLE + AVATAR_DOTS

/** 点击选项:把原始 label(未截断)交给父组件发送 */
function onPick(index: number): void {
  const choice = props.choices[index]
  if (choice) emit('pick', choice.label)
}
</script>

<template>
  <!-- 浮层容器:透明、不拦事件;整块靠右,只有胶囊自己可点 -->
  <div class="choice-panel" :style="panelStyle">
    <div class="choice-panel__stack">
      <!-- 空状态:对接完成前 pendingChoices 为空,给出明确说明而不是一片空白 -->
      <p v-if="props.choices.length === 0" class="choice-panel__empty">
        暂无推荐选项<br />
        <span class="choice-panel__empty-sub">AI 回复后会自动出现在这里</span>
      </p>

      <!-- 每条选项结构完全一致:[白色圆形头像(三个镂空点)] + [纯白文字] -->
      <button
        v-for="(choice, i) in displayChoices"
        v-else
        :key="i"
        class="choice-panel__bubble"
        type="button"
        :title="choice.label"
        @click="onPick(i)"
      >
        <span class="choice-panel__avatar" aria-hidden="true">
          <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
            <path :d="AVATAR_PATH" fill="#fff" fill-rule="evenodd" />
          </svg>
        </span>
        <span class="choice-panel__label" v-html="choice.labelHtml"></span>
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

// 尺寸(高/头像/内边距/字号)全部来自脚本下发的 CSS 变量,这里只写视觉。
.choice-panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  display: flex;
  flex-direction: column;
  // 靠右:整块气泡贴面板右缘(留 edge 的呼吸)
  align-items: flex-end;
  box-sizing: border-box;
  padding: 0 var(--c-edge) var(--c-bottom);
  // 浮层本身透明、不拦事件:它只是"浮在聊天内容上的一层气泡"
  background: transparent;
  pointer-events: none;

  // 气泡列:宽度取最宽那颗胶囊(容器 fit-content + 子项 100%),于是**每条等宽**,
  // 右缘对齐 → 右侧渐隐的起始位置在所有按钮上完全一致。
  // 只有这一列可点(不遮挡聊天区)。
  &__stack {
    display: flex;
    flex-direction: column;
    // stretch(默认)+ 子项 width:100%:让每条都撑到"最宽那颗"的宽度
    align-items: stretch;
    width: fit-content;
    gap: var(--c-item-gap);
    max-width: 100%;
    max-height: 100%;
    box-sizing: border-box;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    pointer-events: auto;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  // ---- 独立胶囊气泡 --------------------------------------------------------
  &__bubble {
    display: inline-flex;
    align-items: center;
    gap: var(--c-gap);
    // 每条与最宽那颗等宽:右缘对齐 → 渐隐起点在所有按钮上一致
    width: 100%;
    height: var(--c-h);
    padding: 0 var(--c-pad-r) 0 var(--c-pad-l);
    box-sizing: border-box;
    max-width: 100%;
    border-radius: 999px;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
    font-family: $font-bubble;

    // 半透明深灰黑 + 毛玻璃:透明度刻意压得比较低,能明显透出下方背景
    background: var(--c-fill);
    backdrop-filter: blur(8px) saturate(1.15);
    -webkit-backdrop-filter: blur(8px) saturate(1.15);

    // 浅灰描边,同样半透明(毛玻璃的一部分);粗细取自脚本口径(--c-border-w)
    border: var(--c-border-w) solid var(--c-stroke);

    // 纯白文字
    color: #fff;
    font-size: var(--c-font);

    // 右侧隐藏:文字之后先渐隐(fade 段),再**彻底不显示**(hide 段)——
    // 胶囊右端的圆角帽落在 hide 段里,所以右侧看不到任何胶囊形状。
    // 底、描边、内容一起被 mask 裁掉;文字正好在 fade 起点结束,不会被削到。
    mask-image: linear-gradient(
      to right,
      #000 0,
      #000 calc(100% - var(--c-pad-r)),
      transparent calc(100% - var(--c-hide))
    );
    -webkit-mask-image: linear-gradient(
      to right,
      #000 0,
      #000 calc(100% - var(--c-pad-r)),
      transparent calc(100% - var(--c-hide))
    );

    // 入场:逐项淡入 + 轻微上浮(按索引延迟)
    animation: choice-bubble-in 0.25s ease-out backwards;
    transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;

    &:hover {
      // 悬停 = 描边色与底色**互换**:底变成浅灰,描边变成深色
      background: var(--c-stroke);
      border-color: var(--c-fill);
    }

    &:active {
      transform: scale(0.98);
    }

    // 逐项延迟入场;第 9 项起统一 0.54s(= 9×0.06),仍是逐项淡入而非整批突现
    @for $i from 1 through 8 {
      &:nth-child(#{$i}) {
        animation-delay: #{$i * 0.06}s;
      }
    }

    &:nth-child(n + 9) {
      animation-delay: 0.54s;
    }
  }

  // 左侧头像:正圆、纯白底,三个镂空点(镂空由 SVG 的 evenodd 实现)
  &__avatar {
    flex-shrink: 0;
    display: block;
    width: var(--c-avatar);
    height: var(--c-avatar);

    svg {
      display: block;
      width: 100%;
      height: 100%;
    }
  }

  // 右侧文字:纯白,超长已由脚本裁剪,这里只兜底
  &__label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  // ---- 空状态 --------------------------------------------------------------
  &__empty {
    margin: 0;
    padding: 10px 18px;
    border-radius: 999px;
    background: rgba(26, 26, 28, 0.45);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(214, 212, 212, 0.28);
    font-family: $font-harmony;
    font-size: 15px;
    line-height: 1.8;
    color: rgba(255, 255, 255, 0.72);
    text-align: center;
  }

  &__empty-sub {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.42);
  }
}

@keyframes choice-bubble-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

// 浮层整体:淡入 + 轻微上浮(不再是整块面板从下往上撑开)
.choice-pop-enter-active,
.choice-pop-leave-active {
  transition: opacity 0.2s ease-out, transform 0.2s ease-out;
  transform-origin: bottom right;
}

.choice-pop-enter-from,
.choice-pop-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
