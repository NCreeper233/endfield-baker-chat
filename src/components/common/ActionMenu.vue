<script setup lang="ts">
// ActionMenu —— 行动菜单外壳（消息 / 主卡 / 子卡 / 群卡共用）
//
// 只负责「怎么出现、长什么样」：直角面板、宽体大写眉标、右侧真实字段、
// 贴边回收、点外关闭、Esc 关闭、机械动效。菜单里有什么由调用方用插槽决定，
// 每一行用 ActionMenuRow。
//
// 尺寸会随内容变（消息菜单还有二级），所以用 ResizeObserver 在尺寸变化时
// 重新按锚点收回视口 —— 比每个调用方自己 nextTick 量一次更不容易漏。
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 是否显示 */
    open: boolean
    /** 锚点(屏幕坐标) */
    x: number
    y: number
    /** 眉标，如 `// MESSAGE` */
    eyebrow: string
    /** 右侧序号（不含 No. 前缀） */
    serial?: string
    /** 竖线后的说明，如「对方」「删除方式」 */
    meta?: string
    /** 面板最小宽度(px)，0 = 用样式里的默认值 */
    minWidth?: number
  }>(),
  { serial: '', meta: '', minWidth: 0 },
)

const emit = defineEmits<{ close: [] }>()

/** 面板 DOM（用来量实际尺寸，不靠写死的宽高估算） */
const menuEl = ref<HTMLElement | null>(null)
/** 校正后的位置；null = 还没量过，先按锚点渲染 */
const pos = ref<{ left: number; top: number } | null>(null)

/** 打开时刻：刚打开的 200ms 内忽略外部点击，避免「打开它的那一次点击」顺手把它关掉 */
let openedAt = 0
const OPEN_GUARD_MS = 200

/** 防溢出留白(px) */
const VIEWPORT_PAD = 8

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

const menuStyle = () => ({
  left: `${pos.value ? pos.value.left : props.x}px`,
  top: `${pos.value ? pos.value.top : props.y}px`,
  ...(props.minWidth ? { minWidth: `${props.minWidth}px` } : null),
})

/** 尺寸监听：二级菜单切换、文案换行都会改变面板大小 */
let ro: ResizeObserver | null = null

function observeSize(): void {
  const el = menuEl.value
  if (!el || typeof ResizeObserver === 'undefined') return
  ro?.disconnect()
  ro = new ResizeObserver(() => place())
  ro.observe(el)
}

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      pos.value = null
      ro?.disconnect()
      ro = null
      return
    }
    await nextTick()
    openedAt = Date.now()
    place()
    observeSize()
  },
  { immediate: true },
)

/** 点击外部关闭 */
function onDocClick(e: MouseEvent) {
  // 刚打开的这一拍不判定外部点击：打开它的那次点击（长按后的补发 click、
  // 或子卡向上冒泡的 click）不能顺手把菜单关掉
  if (Date.now() - openedAt < OPEN_GUARD_MS) return
  const el = menuEl.value
  if (el && !el.contains(e.target as Node)) emit('close')
}

/** Esc 关闭 */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      document.addEventListener('click', onDocClick, true)
      document.addEventListener('keydown', onKey)
    } else {
      document.removeEventListener('click', onDocClick, true)
      document.removeEventListener('keydown', onKey)
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  document.removeEventListener('click', onDocClick, true)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="am">
      <div
        v-if="open"
        ref="menuEl"
        class="am"
        role="menu"
        :style="menuStyle()"
        @click.stop
      >
        <div class="am__head">
          <span class="am__eyebrow">{{ eyebrow }}</span>
          <span v-if="serial || meta" class="am__field">
            <span v-if="serial" class="am__no">No.{{ serial }}</span>
            <span v-if="serial && meta" class="am__bar" aria-hidden="true" />
            <span v-if="meta" class="am__meta">{{ meta }}</span>
          </span>
        </div>
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

// 直角、无投影、无圆角：靠 1px 细线和底色分层。
// 底色比聊天区再沉一档，压在气泡上也不会糊成一片。
.am {
  position: fixed;
  z-index: 100000;
  min-width: 190px;
  padding: 0;
  background: #1b1b1b;
  border: 1px solid #4c4c4c;
  border-radius: 0;
  box-shadow: none;
  color: rgba(255, 255, 255, 0.9);
  font-family: $font-harmony;
  font-size: 13px;
  user-select: none;
}

// 宽体大写英文眉标 + 真实字段（No.012 │ 对方）
.am__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 26px;
  padding: 0 10px;
  background: #232323;
  border-bottom: 1px solid rgba(255, 255, 255, 0.14);
}

.am__eyebrow {
  font-size: 10px;
  line-height: 1;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.52);
  white-space: nowrap;
}

.am__field {
  display: flex;
  align-items: center;
  flex: 0 1 auto;
  min-width: 0;
  margin-left: 14px;
  font-size: 10px;
  line-height: 1;
  letter-spacing: 0.06em;
  color: rgba(255, 255, 255, 0.46);
  white-space: nowrap;
}

// 说明字段可能很长（子卡菜单传的是对话预览），限宽省略，
// 否则会把整个面板撑开、把眉标挤没。
.am__meta {
  max-width: 116px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.am__no {
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.78);
}

// 竖线分隔字段（分隔用 │，不用中间点）
.am__bar {
  width: 1px;
  height: 9px;
  margin: 0 6px;
  background: rgba(255, 255, 255, 0.26);
}

@media (max-width: 768px) {
  .am {
    min-width: 204px;
    font-size: 14px;
  }

  .am__head {
    height: 30px;
    padding: 0 12px;
  }
}

// 出现用 snap，退出用 mech；位移 4px，不缩放、不弹跳。
.am-enter-active {
  transition:
    opacity 0.14s cubic-bezier(0.16, 1, 0.3, 1),
    transform 0.14s cubic-bezier(0.16, 1, 0.3, 1);
}

.am-leave-active {
  transition:
    opacity 0.09s cubic-bezier(0.7, 0, 0.2, 1),
    transform 0.09s cubic-bezier(0.7, 0, 0.2, 1);
}

.am-enter-from,
.am-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (prefers-reduced-motion: reduce) {
  .am-enter-active,
  .am-leave-active {
    transition: none;
  }

  .am-enter-from,
  .am-leave-to {
    transform: none;
  }
}
</style>
