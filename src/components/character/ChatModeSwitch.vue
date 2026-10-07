<script setup lang="ts">
// =============================================================================
// 侧边栏模式切换控件(ChatModeSwitch) —— 第三版群聊
// -----------------------------------------------------------------------------
// 位置:角色列表上方、水平居中(见 CharacterCardList 的 .mode-switch-host)。
// 形态:一个双段开关(单聊 / 群聊) + 恒显在最右侧的加号按钮。
//   加号在两种模式下都在 —— 群聊模式语义是"创建群聊",单聊模式是"新建对话";
//   本组件不判断该做什么,只抛 add 事件,由父级按当前模式分发。
// 交互:
//   - 点击任一段 → 切换模式(段是真正的 <button>,走原生 click)
//   - 左右拖动(鼠标或触摸)→ 跟手移动指示块,松手按位移方向切换
//   - 键盘 → Tab 到段上回车/空格
//
// 【为什么点击不靠坐标比例判定】
// 早期版本用 setPointerCapture 把指针收归轨道,再在松手时按 clientX 落在
// 矩形的左右半边判断点了哪一段。移动端上这条路径不可靠:列表整体套在 CSS
// zoom 里,不同 WebView 对"zoom 下 getBoundingClientRect 是否含缩放"的处理
// 不一致,于是比例恒偏一侧 —— 表现为"点左右两边都去同一个模式"。
// 现在改为:
//   - 段本身可点,走原生 click(不依赖任何坐标换算)
//   - 拖动全程只用 window 上的 pointermove/pointerup 跟随,不调用
//     setPointerCapture —— 指针捕获会让浏览器不再向子按钮派发 click,
//     那样点击就又回到"必须自己算坐标"的老问题上了
// =============================================================================
import { computed, onBeforeUnmount, ref } from 'vue'
import { PERSON_GROUP_PATHS, PERSON_SOLO_PATHS } from '../../constants/icons'

export type ChatMode = 'single' | 'group'

const props = withDefaults(
  defineProps<{
    /** 当前模式 */
    mode: ChatMode
    /**
     * 操作带里由父级渲染的方形按钮个数(默认 3 = 删除 / 用量 / 设置)
     *
     * 单段宽度必须按"整条带恰好铺满主卡宽"反算,而用量面板按钮只在
     * 自定义 API 模式下出现 —— 个数会变。写死常数的话,少一个按钮时
     * 整条带就会比主卡短一截(右侧露白)。故由父级如实告诉这里。
     */
    hostActionCount?: number
  }>(),
  { hostActionCount: 3 },
)

const emit = defineEmits<{
  (e: 'update:mode', mode: ChatMode): void
  /**
   * 点击最右侧的加号
   *
   * 两种模式都显示:群聊模式下语义是"创建群聊",单聊模式下是"新建对话"。
   * 具体做什么由父级按当前模式分发,本组件不参与判断。
   */
  (e: 'add'): void
}>()

/** 拖动状态 */
const dragging = ref(false)
/** 拖动期间指示块的像素偏移(相对当前激活段) */
const dragDx = ref(0)

/** 指示块是否落在第二段(群聊)上 */
const isGroup = computed(() => props.mode === 'group')

/** 加号按钮的无障碍标签 / 悬浮提示:随模式变化 */
const addLabel = computed(() => (isGroup.value ? '创建群聊' : '新建对话'))

/** 主卡宽度(px):与 CharacterCardItem 的 .card__rect 一致,整条操作带与它等宽 */
const CARD_W = 458.28

/** 操作带方形按钮边长(px):与 list-action-btn 的默认值一致 */
const ACTION_BTN = 40

/** 操作带按钮间距(px):与 .mode-switch-host / 本组件 .mode-switch 的 gap 一致 */
const ACTION_GAP = 10

/**
 * 开关单段宽度(px)
 *
 * 整条操作带要和主卡等宽。带内共 (hostActionCount + 1) 个方形按钮
 * (加号 + 父级的每个操作按钮),且每个按钮前面都有一个 gap,故:
 *   458.28 − N×40(方形按钮) − N×10(间距) = 轨道宽,track 左右各有 1px 描边
 *   单段 = (轨道宽 − 2) / 2
 *
 * 例:N = 4(加号/删除/用量/设置)→ (458.28 − 160 − 40 − 2) / 2 = 128.14
 *     N = 3(加号/删除/设置)      → (458.28 − 120 − 30 − 2) / 2 = 153.14
 *
 * 这个值同时被拖动逻辑(indicatorX 的夹取、切换阈值)与样式(track/indicator/seg
 * 的宽度)使用。为避免两处各写一个数字日后走散,这里算出的结果通过内联 CSS 变量
 * --seg-w 传给样式,样式侧一律用 var(--seg-w),不再重复写死。
 *
 * 操作带增删按钮时,只需改父级下发的 hostActionCount,单段宽度自动跟着变
 * (少传会让整条带与主卡错开,CharacterCardList 里有对应说明)。
 */
const SEG_W = computed(() => {
  const n = props.hostActionCount + 1
  return (CARD_W - n * ACTION_BTN - n * ACTION_GAP - 2) / 2
})

/** 指示块位移:激活段基位 ± 拖动量(限制在单段宽度内) */
const indicatorX = computed(() => {
  const base = isGroup.value ? SEG_W.value : 0
  const d = Math.max(-SEG_W.value, Math.min(SEG_W.value, dragDx.value))
  return base + d
})

let startX = 0
/** 本次手势是否已越过阈值、被判定为拖动 */
let moved = false
/** 拖动刚结束时抑制一次合成 click,避免"拖完又按落点切一次" */
let suppressClick = false

/** 位移小于该值视为"点击"而非"拖动"(px,视觉坐标) */
const TAP_THRESHOLD = 8

/** 按下:开始跟踪手势(不改指针归属,点击仍由段自己收) */
function onDown(e: PointerEvent): void {
  dragging.value = true
  moved = false
  startX = e.clientX
  dragDx.value = 0
  window.addEventListener('pointermove', onWindowMove)
  window.addEventListener('pointerup', onWindowUp)
  window.addEventListener('pointercancel', onWindowCancel)
}

/** 移动:必须监听 window —— 手指可能滑出轨道,轨道自身的 pointermove 会断 */
function onWindowMove(e: PointerEvent): void {
  if (!dragging.value) return
  // 部分 WebView 在系统接管手势 / 取消指针时会上报 clientX = 0,
  // 那会被算成一次极大位移、误判为拖动 → 直接丢弃这次采样
  if (e.clientX === 0 && startX !== 0) return
  const dx = e.clientX - startX
  if (!moved && Math.abs(dx) > TAP_THRESHOLD) moved = true
  dragDx.value = dx
}

/** 统一的监听清理 */
function detachWindow(): void {
  window.removeEventListener('pointermove', onWindowMove)
  window.removeEventListener('pointerup', onWindowUp)
  window.removeEventListener('pointercancel', onWindowCancel)
}

/**
 * 手势被系统取消(如浏览器接管为滚动)
 *
 * 取消不等于"拖动结束":此时上报的坐标往往归零,拿它判定方向会切错甚至
 * 切不动。直接复位、不改模式。
 */
function onWindowCancel(): void {
  detachWindow()
  dragging.value = false
  moved = false
  dragDx.value = 0
}

/**
 * 松手
 *
 * 只有"确认拖动"的手势才在这里处理;点击不做任何事 —— 交给段上的原生 click,
 * 那条路径不涉及任何坐标换算,移动端与桌面端行为一致。
 */
function onWindowUp(): void {
  detachWindow()
  if (!dragging.value) return
  dragging.value = false

  if (!moved) {
    // 纯点击:不做判定,等原生 click
    dragDx.value = 0
    return
  }

  const dx = dragDx.value
  dragDx.value = 0
  // 合成 click 在本轮任务里就会派发,rAF 在其之后执行,足够抑制掉
  suppressClick = true
  requestAnimationFrame(() => {
    suppressClick = false
  })

  if (dx <= -SEG_W.value / 3 && isGroup.value) emit('update:mode', 'single')
  else if (dx >= SEG_W.value / 3 && !isGroup.value) emit('update:mode', 'group')
}

onBeforeUnmount(detachWindow)

/** 点某一段(原生 click) */
function select(mode: ChatMode): void {
  if (suppressClick) return
  if (mode !== props.mode) emit('update:mode', mode)
}
</script>

<template>
  <div class="mode-switch">
    <!-- 开关主体:只负责"拖动"手势;点击由内部两段自己处理。
         单段宽度由脚本算出后以 CSS 变量下发(见 SEG_W),样式侧统一用 var(--seg-w) -->
    <div
      class="mode-switch__track"
      :style="{ '--seg-w': `${SEG_W}px` }"
      @pointerdown="onDown"
    >
      <!-- 滑动指示块(强调黄) -->
      <span
        class="mode-switch__indicator"
        :style="{
          transform: `translateX(${indicatorX}px)`,
          transition: dragging && moved ? 'none' : 'transform .22s ease',
        }"
      />

      <!-- 单聊:一个小人 -->
      <button
        class="mode-switch__seg"
        :class="{ 'is-active': !isGroup }"
        type="button"
        aria-label="单聊"
        :aria-pressed="!isGroup"
        @click="select('single')"
      >
        <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="4"
             stroke-linecap="round" stroke-linejoin="round">
          <path v-for="(d, i) in PERSON_SOLO_PATHS" :key="i" :d="d" />
        </svg>
      </button>

      <!-- 群聊:两个小人 -->
      <button
        class="mode-switch__seg"
        :class="{ 'is-active': isGroup }"
        type="button"
        aria-label="群聊"
        :aria-pressed="isGroup"
        @click="select('group')"
      >
        <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="4"
             stroke-linecap="round" stroke-linejoin="round">
          <path v-for="(d, i) in PERSON_GROUP_PATHS" :key="i" :d="d" />
        </svg>
      </button>
    </div>

    <!-- 加号:两种模式都显示,具体动作由父级按当前模式分发 -->
    <button
      class="mode-switch__plus"
      type="button"
      :aria-label="addLabel"
      :title="addLabel"
      @click="emit('add')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round">
        <path d="M12 5.5v13M5.5 12h13" />
      </svg>
    </button>
  </div>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

$track-h: 40px;

.mode-switch {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;

  // 开关主体。单段宽度 --seg-w 由脚本算出后内联下发(见 SEG_W):
  // 整条操作带与主卡等宽,扣掉右侧四个方形按钮与它们的间距后,余下全给轨道;
  // 轨道左右各有 1px 描边,故总宽 = 两段 + 2px。
  &__track {
    position: relative;
    display: flex;
    width: calc(var(--seg-w) * 2 + 2px);
    height: $track-h;
    border-radius: 4.39px;
    background: $color-card-bg;
    border: 1px solid $color-subcard-line;
    overflow: hidden;
    cursor: pointer;
    // 拖动跟手:手势不交给外层滚动容器
    touch-action: none;
    user-select: none;
    outline: none;
  }

  // 滑动指示块
  &__indicator {
    position: absolute;
    left: 0;
    top: 0;
    width: var(--seg-w);
    height: 100%;
    background: $color-subcard-selected;
    border-radius: 4.39px;
    pointer-events: none;
  }

  // 单段:真正的按钮,点击走原生 click(不做任何坐标换算)
  &__seg {
    position: relative;
    z-index: 1;
    width: var(--seg-w);
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    background: transparent;
    color: $color-subcard-text;
    cursor: pointer;
    transition: color 0.2s ease;

    svg {
      width: 22px;
      height: 22px;
    }

    // 激活段:深色图标压在黄块上
    &.is-active { color: $color-subcard-text-selected; }

    // 键盘聚焦时才画框,鼠标/触摸不画
    &:focus-visible {
      outline: 1px solid $color-subcard-selected;
      outline-offset: -3px;
    }
  }

  // 加号按钮:恒显。外壳与右侧的删除/设置按钮共用同一个 mixin(见 list-action-btn)。
  //
  // 图标明暗必须与右侧按钮一致:它们是 img + opacity .55 → hover 1,
  // 而加号是 svg + currentColor,不显式对齐就会比它们亮一档。
  // 颜色也一并统一为纯白 —— 右侧图标本身是白色填充,若这里用 #e3e1e1,
  // 同样压在 55% 下仍能看出色差。
  &__plus {
    @include list-action-btn($track-h);
    color: $color-text-primary;

    svg {
      width: 20px;
      height: 20px;
      opacity: 0.55;
      transition: opacity 0.15s ease;
    }

    &:hover svg {
      opacity: 1;
    }
  }
}
</style>
