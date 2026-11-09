<script setup lang="ts">
// ActionMenuRow —— 行动菜单里的一行
//
// 记录行范式：编号 / 图标 / 中文动作，行与行之间一条 1px 细线；
// 悬停或按下时强调色从左擦入（删除行是红色），字反色。
// 圆角、投影、渐变一律不用。
withDefaults(
  defineProps<{
    /** 行号（真实顺序，如 01）。留空则不显示 */
    idx?: string
    /** 文案 */
    label: string
    /** 图标路径（48×48 viewBox 的 d 列表）。留空则不显示 */
    icon?: string[]
    /** danger = 删除类操作（唯一允许用红的地方） */
    tone?: 'default' | 'danger'
    /** 有下级菜单：右端箭头 */
    caret?: boolean
  }>(),
  { idx: '', icon: () => [], tone: 'default', caret: false },
)

defineEmits<{ select: [] }>()
</script>

<template>
  <button
    class="am-row"
    :class="{ 'am-row--danger': tone === 'danger' }"
    type="button"
    role="menuitem"
    @click="$emit('select')"
  >
    <span v-if="idx" class="am-row__idx" aria-hidden="true">{{ idx }}</span>
    <svg v-if="icon.length" class="am-row__icon" viewBox="0 0 48 48" aria-hidden="true">
      <path v-for="(d, i) in icon" :key="i" :d="d" />
    </svg>
    <span class="am-row__label">{{ label }}</span>
    <svg v-if="caret" class="am-row__caret" viewBox="0 0 12 20" aria-hidden="true">
      <path d="M3 3 L9 10 L3 17" />
    </svg>
  </button>
</template>

<style scoped lang="scss">
.am-row {
  position: relative;
  isolation: isolate;
  display: flex;
  align-items: center;
  width: 100%;
  height: 36px;
  margin: 0;
  padding: 0 10px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  overflow: hidden;
  -webkit-tap-highlight-color: transparent;
  transition: color 0.14s cubic-bezier(0.7, 0, 0.2, 1);

  + .am-row {
    border-top: 1px solid rgba(255, 255, 255, 0.09);
  }

  // 擦入层：从左铺满，mech 曲线（硬、不回弹）
  &::before {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: -1;
    background: #ffef00;
    transform: scaleX(0);
    transform-origin: left center;
    transition: transform 0.16s cubic-bezier(0.7, 0, 0.2, 1);
  }

  &:hover::before,
  &:active::before {
    transform: scaleX(1);
  }

  &:hover,
  &:active {
    color: #161616;

    .am-row__idx { color: rgba(0, 0, 0, 0.5); }
    .am-row__caret { opacity: 0.85; }
  }

  &:focus-visible {
    outline: 1px solid #ffef00;
    outline-offset: -2px;
  }

  // 删除是唯一允许用红的地方：红做填充，字反白
  &--danger::before {
    background: #c8403f;
  }

  &--danger:hover,
  &--danger:active {
    color: #fff;

    .am-row__idx { color: rgba(255, 255, 255, 0.62); }
  }
}

// 行号：等宽数字，压到背景层；擦入后自动转深
.am-row__idx {
  flex: none;
  width: 18px;
  margin-right: 8px;
  font-size: 10px;
  line-height: 1;
  letter-spacing: 0.08em;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.34);
  transition: color 0.14s cubic-bezier(0.7, 0, 0.2, 1);
}

// 图标 15px、描边 4（与 48 的 viewBox 同比例，缩放后仍是 4/48 的细线）
.am-row__icon {
  flex: none;
  width: 15px;
  height: 15px;
  margin-right: 9px;
  fill: none;
  stroke: currentColor;
  stroke-width: 4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.am-row__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.am-row__caret {
  flex: none;
  width: 7px;
  height: 12px;
  margin-left: 10px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.45;
  transition: opacity 0.14s cubic-bezier(0.7, 0, 0.2, 1);
}

// 触屏：行高 46（≥44 的点击区），字号 +1
@media (max-width: 768px) {
  .am-row {
    height: 46px;
    padding: 0 12px;
  }

  .am-row__idx {
    width: 20px;
    margin-right: 10px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .am-row::before,
  .am-row,
  .am-row__idx,
  .am-row__caret {
    transition: none;
  }
}
</style>
