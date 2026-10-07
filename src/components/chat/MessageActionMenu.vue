<script setup lang="ts">
// =============================================================================
// MessageActionMenu.vue —— 消息长按/右键操作菜单
// -----------------------------------------------------------------------------
// 一级菜单:"重新生成"(仅 AI 回复,可选) / "删除";点击删除进入二级选择:
//   - 删除此轮对话:删除该轮用户消息 + AI 回复,不影响其他轮次
//   - 删除此条对话:仅删除长按的那一条,同轮其他内容保留
// 适配桌面(右键)与移动端(长按),Teleport 到 body 按屏幕坐标定位。
//
// 样式走"网页右键菜单"的通用做法:窄面板 + 中性深灰底 + 逐行悬停浅色高亮 +
// 行首小图标;破坏性操作(两种删除)悬停转红。不再用原先的游戏风黄描边。
// =============================================================================
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  /** 是否显示 */
  open: boolean
  /** 菜单锚点(屏幕坐标) */
  x: number
  y: number
  /** 是否可"重新生成"(仅 AI 回复/错误消息为 true) */
  canRegenerate?: boolean
}>()

const emit = defineEmits<{
  close: []
  regenerate: []
  /** 进入"选中消息"模式(选中的消息导出为图片) */
  'pick-messages': []
  'delete-round': []
  'delete-message': []
}>()

/** 菜单层级:0=一级(重新生成/删除) / 1=二级(删除方式) */
const level = ref(0)

// ---- 图标(设计稿 48×48 线框,stroke 4;颜色交给 CSS 的 currentColor) ----------
/** 重新生成:带缺口的圆弧(两端各一截短线),循环/重来语义 */
const ICON_REGEN: string[] = [
  'M42 8V24',
  'M6 24L6 40',
  'M42 24C42 14.0589 33.9411 6 24 6C18.9145 6 14.3216 8.10896 11.0481 11.5' +
    'M6 24C6 33.9411 14.0589 42 24 42C28.8556 42 33.2622 40.0774 36.5 36.9519',
]

/** 删除:垃圾桶(桶身 + 两条竖线 + 桶盖 + 提手) */
const ICON_DELETE: string[] = [
  'M9 10V44H39V10H9Z',
  'M20 20V33',
  'M28 20V33',
  'M4 10H44',
  'M16 10L19.289 4H28.7771L32 10H16Z',
]

/** 导出选中消息:三条横线 + 行首三个方块(逐条勾选语义) */
const ICON_PICK: string[] = [
  'M20 10H44',
  'M20 24H44',
  'M20 38H44',
  'M4 6H12V14H4Z',
  'M4 20H12V28H4Z',
  'M4 34H12V42H4Z',
]

// ---- 定位 -------------------------------------------------------------------
/** 菜单 DOM(用来量实际尺寸,而不是靠写死的宽高估算) */
const menuEl = ref<HTMLElement | null>(null)

/** 校正后的位置;null = 还没量过,先按锚点渲染 */
const pos = ref<{ left: number; top: number } | null>(null)

/** 防溢出留白(px) */
const VIEWPORT_PAD = 8

/**
 * 按实际尺寸把菜单收回视口内
 *
 * 每级菜单的行数不同、文案长短也不同,所以尺寸必须量(写死的宽高迟早对不上)。
 * 量完立刻写 pos —— 与首次渲染在同一个 tick 内完成,浏览器不会画出中间位置。
 */
function place(): void {
  const el = menuEl.value
  if (!el) return
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = el.offsetWidth
  const h = el.offsetHeight
  let left = props.x
  let top = props.y
  if (left + w > vw - VIEWPORT_PAD) left = vw - w - VIEWPORT_PAD
  if (left < VIEWPORT_PAD) left = VIEWPORT_PAD
  if (top + h > vh - VIEWPORT_PAD) top = vh - h - VIEWPORT_PAD
  if (top < VIEWPORT_PAD) top = VIEWPORT_PAD
  pos.value = { left, top }
}

/** 菜单样式:量过用校正值,没量过先用锚点 */
const menuStyle = () => ({
  left: `${pos.value ? pos.value.left : props.x}px`,
  top: `${pos.value ? pos.value.top : props.y}px`,
})

// 打开、以及在一二级之间切换,尺寸都会变 → 重新定位
watch(
  [() => props.open, level],
  async ([open]) => {
    if (!open) {
      pos.value = null
      level.value = 0
      return
    }
    await nextTick()
    place()
  },
  { immediate: true },
)

/** 点击外部关闭 */
function onDocClick(e: MouseEvent) {
  const el = menuEl.value
  if (el && !el.contains(e.target as Node)) {
    emit('close')
  }
}

/** Esc 关闭 */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  document.addEventListener('click', onDocClick, true)
  document.addEventListener('keydown', onKey)
})

onUnmounted(() => {
  document.removeEventListener('click', onDocClick, true)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menuEl"
      class="message-action-menu"
      :style="menuStyle()"
      @click.stop
    >
      <!-- 一级:重新生成(AI 回复/错误消息) / 删除 -->
      <template v-if="level === 0">
        <button
          v-if="canRegenerate"
          class="menu-item"
          type="button"
          @click="emit('regenerate'); emit('close')"
        >
          <svg class="menu-item__icon" viewBox="0 0 48 48" aria-hidden="true">
            <path v-for="(d, i) in ICON_REGEN" :key="i" :d="d" />
          </svg>
          <span>重新生成</span>
        </button>

        <button
          class="menu-item"
          type="button"
          @click="emit('pick-messages'); emit('close')"
        >
          <svg class="menu-item__icon" viewBox="0 0 48 48" aria-hidden="true">
            <path v-for="(d, i) in ICON_PICK" :key="i" :d="d" />
          </svg>
          <span>导出选中消息</span>
        </button>

        <button
          class="menu-item"
          type="button"
          @click="level = 1"
        >
          <svg class="menu-item__icon" viewBox="0 0 48 48" aria-hidden="true">
            <path v-for="(d, i) in ICON_DELETE" :key="i" :d="d" />
          </svg>
          <span>删除</span>
          <!-- 有下级菜单:右端小箭头 -->
          <svg class="menu-item__caret" viewBox="0 0 12 20" aria-hidden="true">
            <path d="M3 3 L9 10 L3 17" />
          </svg>
        </button>
      </template>

      <!-- 二级:删除方式(分隔线 + 小标题,与通用右键菜单的子菜单同一形态) -->
      <template v-else>
        <div class="menu-sep" />
        <div class="menu-title">删除方式</div>
        <button
          class="menu-item menu-item--danger"
          type="button"
          @click="emit('delete-round'); emit('close')"
        >
          <span>删除此轮对话</span>
        </button>
        <button
          class="menu-item menu-item--danger"
          type="button"
          @click="emit('delete-message'); emit('close')"
        >
          <span>删除此条对话</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

// 通用网页右键菜单:窄面板、中性深灰、圆角、轻描边 + 投影;
// 行内图标走 currentColor,悬停只做浅色高亮(破坏性操作转红)。
.message-action-menu {
  position: fixed;
  z-index: 100000;
  min-width: 168px;
  padding: 4px;
  background: #26262a;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 8px;
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.45),
    0 2px 6px rgba(0, 0, 0, 0.3);
  font-family: $font-harmony;
  user-select: none;
}

// 图标统一 16px、描边随文字颜色;两条 SVG 共用同一套描边参数。
//
// 淡化**必须**用元素 opacity,不能写成 color: rgba(255,255,255,.62):
// 颜色带 alpha 时每一条描边各自半透明,图标里线条重叠处(垃圾桶尤其明显 ——
// 桶盖横线、提手、桶身顶边都在 y=10 上)会叠成更深的一笔。
// opacity 先把整个图标按不透明合成、再整体淡出,重叠处颜色完全一致。
.menu-item__icon {
  flex: none;
  width: 16px;
  height: 16px;
  color: #fff;
  opacity: 0.62;
  fill: none;
  stroke: currentColor;
  stroke-width: 4;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: opacity 0.1s ease;
}

.menu-item__caret {
  flex: none;
  width: 7px;
  height: 12px;
  margin-left: auto;
  color: #fff;
  opacity: 0.35;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: opacity 0.1s ease;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: none;
  border-radius: 5px;
  background: none;
  color: rgba(255, 255, 255, 0.88);
  font-family: $font-harmony;
  font-size: 13px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.1s ease, color 0.1s ease;

  &:hover {
    background: rgba(255, 255, 255, 0.09);
    color: #fff;

    .menu-item__icon { opacity: 1; }
    .menu-item__caret { opacity: 0.7; }
  }

  // 破坏性操作:悬停转红(通用做法,避免误点)
  &--danger:hover {
    background: rgba(255, 92, 92, 0.16);
    color: #ff9d9d;
  }
}

.menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: rgba(255, 255, 255, 0.08);
}

.menu-title {
  padding: 6px 10px 4px;
  color: rgba(255, 255, 255, 0.42);
  font-family: $font-harmony;
  font-size: 11px;
}
</style>
