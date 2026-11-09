<script setup lang="ts">
// MessageActionMenu —— 消息长按 / 右键操作菜单（桌面右键、移动端长按）
// 一级「重新生成 / 导出选中消息 / 删除」，删除进入二级：删除此轮（用户消息 + AI 回复）或仅删此条。
//
// 外观与定位全部来自 ActionMenu / ActionMenuRow，与主卡、子卡、群卡共用同一套菜单。
import { computed, ref, watch } from 'vue'
import ActionMenu from '../common/ActionMenu.vue'
import ActionMenuRow from '../common/ActionMenuRow.vue'
import { ACTION_TRASH_PATHS } from '../../constants/icons'

const props = defineProps<{
  /** 是否显示 */
  open: boolean
  /** 菜单锚点(屏幕坐标) */
  x: number
  y: number
  /** 是否可"重新生成"(仅 AI 回复/错误消息为 true) */
  canRegenerate?: boolean
  /** 消息的对话内序号（0 起）。给了就在头部显示 No.xxx，不给则整块省略 */
  messageId?: number
  /** 消息归属，用于头部右侧的「对方 / 我」 */
  side?: 'other' | 'mine'
}>()

const emit = defineEmits<{
  close: []
  regenerate: []
  /** 进入"选中消息"模式(选中的消息导出为图片) */
  'pick-messages': []
  'delete-round': []
  'delete-message': []
}>()

/** 菜单层级:0=一级(重新生成/导出/删除) / 1=二级(删除方式) */
const level = ref(0)

// 消息专用图标（48×48 线框、stroke 4；颜色交给 currentColor）
/** 重新生成:带缺口的圆弧(两端各一截短线),循环/重来语义 */
const ICON_REGEN: string[] = [
  'M42 8V24',
  'M6 24L6 40',
  'M42 24C42 14.0589 33.9411 6 24 6C18.9145 6 14.3216 8.10896 11.0481 11.5' +
    'M6 24C6 33.9411 14.0589 42 24 42C28.8556 42 33.2622 40.0774 36.5 36.9519',
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

/** 头部编号:真实序号(0 起的对话内序号 → 1 起补零) */
const serial = computed(() =>
  props.messageId === undefined ? '' : String(props.messageId + 1).padStart(3, '0'),
)

/** 头部右侧标签 */
const sideLabel = computed(() => (props.side === 'mine' ? '我' : '对方'))

/**
 * 一级菜单的行号
 *
 * 「重新生成」只在 AI 回复上出现；不能重生成时它整行不渲染，
 * 后面两项必须顺延成 01 / 02，不能留空号。
 */
function rowSerial(index: number): string {
  const base = props.canRegenerate ? 1 : 0
  return String(index + base).padStart(2, '0')
}

// 关闭时把层级退回一级，下次打开不会停在删除确认上
watch(
  () => props.open,
  (open) => {
    if (!open) level.value = 0
  },
)

/**
 * 选中某一项：先发对应事件，再关菜单
 *
 * 用 switch 逐个发而不是把事件名当变量传 —— emit 是按事件名重载的，
 * 联合类型参数过不了类型检查。
 */
function pick(label: 'regenerate' | 'pick-messages' | 'delete-round' | 'delete-message'): void {
  switch (label) {
    case 'regenerate':
      emit('regenerate')
      break
    case 'pick-messages':
      emit('pick-messages')
      break
    case 'delete-round':
      emit('delete-round')
      break
    case 'delete-message':
      emit('delete-message')
      break
  }
  emit('close')
}
</script>

<template>
  <ActionMenu
    :open="open"
    :x="x"
    :y="y"
    :eyebrow="level === 0 ? '// MESSAGE' : '// DELETE'"
    :serial="level === 0 ? serial : ''"
    :meta="level === 0 ? sideLabel : '删除方式'"
    @close="emit('close')"
  >
    <template v-if="level === 0">
      <ActionMenuRow
        v-if="canRegenerate"
        :idx="rowSerial(0)"
        :icon="ICON_REGEN"
        label="重新生成"
        @select="pick('regenerate')"
      />
      <ActionMenuRow
        :idx="rowSerial(1)"
        :icon="ICON_PICK"
        label="导出选中消息"
        @select="pick('pick-messages')"
      />
      <ActionMenuRow
        :idx="rowSerial(2)"
        :icon="ACTION_TRASH_PATHS"
        label="删除"
        tone="danger"
        caret
        @select="level = 1"
      />
    </template>

    <template v-else>
      <ActionMenuRow idx="01" label="删除此轮对话" tone="danger" @select="pick('delete-round')" />
      <ActionMenuRow idx="02" label="删除此条对话" tone="danger" @select="pick('delete-message')" />
    </template>
  </ActionMenu>
</template>
