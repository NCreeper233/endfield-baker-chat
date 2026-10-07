<script setup lang="ts">
// =============================================================================
// 群聊列表项(GroupCardItem) —— 第三版群聊
// -----------------------------------------------------------------------------
// 与 CharacterCardItem 的主卡**同尺寸同风格**:机体(矩形底/纹理/淡纹/名字/
// 下划线/转角装饰)、头像框、右上角消息浮标三块直接 include 同一组 mixin
// (_mixins.scss 的 main-card-chrome / card-avatar-frame / card-chat-indicator),
// 因此:
//   - 悬停 = 同一个 hover-overlay(12% 白层),不再换底色
//   - 选中 = 同一套 `is-selected` 白层常显,不再画黄色内描边
//   - 头像框 76×76 @8.5/8.5、圆角 6、1px 描边,与单人完全一致
//   - 消息浮标同一张素材、同一条动画;且都只在"还没有对话记录"时才显示
//
// 头像内部改为**九宫格**(见下方 grid 计算):N 个成员各占一个正方形格子,
// 格子边长随 N 变化、尽量填满头像框,不足整格的空位留空;整片网格贴顶。
// 每格只保留圆角(6px,与最外层头像框同值),不画描边、不铺底板;
// 格与格之间留 GRID_GAP(与描边同宽)的空隙。
//
// 群聊没有子卡设计,故**不设折叠箭头**;群聊设置「⋯」放在右下角
// (即单人主卡折叠箭头所在的位置)。
// =============================================================================
import { computed, inject } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../../stores/chat'
import { groupTitle } from '../../stores/chat'
import {
  findCharacter,
  DEFAULT_AVATAR_URL,
  isOriginalScaleAvatar,
} from '../../constants/character'
import { MATERIALS } from '../../constants/materials'
import type { Card } from '../../types/chat'

const props = defineProps<{
  /** 该群聊在 cards 中的真实下标 */
  cardIndex: number
  /** 列表内的 top 偏移(px) */
  top: number
  /** 该主卡数据 */
  card: Card
}>()

const emit = defineEmits<{
  /** 点击右下角「⋯」→ 打开群聊设置弹窗 */
  (e: 'settings', cardIndex: number): void
}>()

const chatStore = useChatStore()
const { activeCardIndex } = storeToRefs(chatStore)

/**
 * 移动端单击即进入聊天视图(由 App provide;桌面端为空操作 —— 内部会判断 isMobile)
 *
 * 与 SubCard 同一套机制:单聊靠双击"子卡"进入,而群聊卡没有子卡,
 * 所以群聊卡自身同时负责"选中"与"进入"。
 */
const enterMobileChat = inject<(() => void) | null>('enterMobileChat', null)

/** 头像框描边宽度(px):与 card-avatar-frame 里的 `1px solid` 保持一致 */
const AVATAR_BORDER = 1

/** 头像框**内容盒**边长(px):76 外框 − 左右各一份描边 */
const AVATAR_INNER = 76 - 2 * AVATAR_BORDER

/**
 * 格子之间的空隙(px)
 *
 * 取与头像框描边同宽 —— 于是格与格之间的缝隙、以及圆角让出的缺口,
 * 读起来与最外层描边是同一种细线。
 *
 * 空隙会占用内容盒,格边长必须相应扣减(见 grid),否则整片网格会撑破头像框。
 */
const GRID_GAP = AVATAR_BORDER

/** 九宫格上限:超过 9 人只取前九个 */
const GRID_MAX = 9

/** 成员名列表 */
const members = computed(() => props.card.members ?? [])

/** 进入九宫格的成员(超出 9 人截断;入群顺序即显示顺序) */
const gridMembers = computed(() => members.value.slice(0, GRID_MAX))

/** 群聊名(优先用子对话里保存的名字,便于将来支持自定义) */
const title = computed(
  () => props.card.conversations[0]?.name || groupTitle(members.value),
)

/** 是否选中(删除模式下不画常规选中白层,那时的"选中"由左缘黄条表达) */
const isActive = computed(() => !chatStore.deleteMode && activeCardIndex.value === props.cardIndex)

/**
 * 该群聊是否已经有对话记录(任意一段子对话里有消息)
 *
 * 与单人主卡同一规则:聊过的群不再挂头像右上角的消息浮标。
 */
const hasChatRecord = computed(() => props.card.conversations.some(c => c.messages.length > 0))

/** 该群聊是否已在删除模式里被勾选 */
const isDeleteSelected = computed(() => chatStore.deleteMode && isDeleteSelectedRaw.value)

/** 该群聊对应的子对话(全局下标;一张群聊卡恒有一段对话) */
const groupSub = computed(() => chatStore.cardSubRanges[props.cardIndex]?.start ?? -1)

/** 原始勾选判据(未叠 deleteMode 判断,供 isDeleteSelected 复用) */
const isDeleteSelectedRaw = computed(() => groupSub.value >= 0 && chatStore.isDeleteSelected(groupSub.value))

/** 成员头像 URL(按角色名查内置干员表;未收录角色回退默认头像) */
function avatarOf(name: string): string {
  return findCharacter(name)?.avatar ?? DEFAULT_AVATAR_URL
}

/**
 * 九宫格分格
 *
 * 规则:
 *   - 每格都是**正方形**,边长随人数变化(不是固定格子数)
 *   - 列数 = ceil(sqrt(N)),行数 = ceil(N / 列数) —— N 个格子的最方排法
 *   - 格边长同时受两轴约束,取较小者:(内容盒 − 该轴空隙总宽) / 该轴格数
 *     这样既保证是正方形,又保证两轴都放得下。列数恒 ≥ 行数,故通常由列这一轴决定
 *   - 该轴空隙总宽 = (该轴格数 − 1) × GRID_GAP
 *   - 不足整格的空位留空(3 人 = 2×2 占 3 格)
 *
 * 例(N=1..9 的 列×行 / 格边长 / 网格总尺寸):
 *   1→1×1/74/74×74、2→2×1/36.5/74×36.5、3→2×2/36.5/74×74、4→2×2/36.5/74×74、
 *   5→3×2/24/74×49、6→3×2/24/74×49、7→3×3/24/74×74、8→3×3/24/74×74、9→3×3/24/74×74。
 */
const grid = computed(() => {
  const n = gridMembers.value.length
  if (n === 0) {
    return { cols: 1, rows: 1, cell: AVATAR_INNER, w: AVATAR_INNER, h: AVATAR_INNER }
  }
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const cell = Math.min(
    (AVATAR_INNER - (cols - 1) * GRID_GAP) / cols,
    (AVATAR_INNER - (rows - 1) * GRID_GAP) / rows,
  )
  return {
    cols,
    rows,
    cell,
    w: cols * cell + (cols - 1) * GRID_GAP,
    h: rows * cell + (rows - 1) * GRID_GAP,
  }
})

/**
 * 网格轨道 / 空隙 / 容器尺寸(内联)
 *
 * 用显式 px 轨道而不是 1fr:格子边长必须随 N 变(见上),1fr 会永远把
 * 网格拉满、格子大小反而固定。
 *
 * 同时显式给出容器宽高(= 轨道总尺寸 + 空隙总宽):容器定宽后
 * `margin: 0 auto` 才能横向居中;高度贴合内容,使网格作为首个子元素贴顶,
 * 行数不足时下方留空。
 */
const gridStyle = computed(() => {
  const { cols, rows, cell, w, h } = grid.value
  return {
    gridTemplateColumns: `repeat(${cols}, ${cell}px)`,
    gridTemplateRows: `repeat(${rows}, ${cell}px)`,
    gap: `${GRID_GAP}px`,
    width: `${w}px`,
    height: `${h}px`,
  }
})

/**
 * 点击选中该群聊
 *
 * 关键:不能只调 selectCard —— 那只设 activeCardIndex,右侧聊天区不会切换。
 * 必须同时选中该群聊下的子对话(selectCardConversation),右侧才真正切过去。
 */
function onSelect(): void {
  chatStore.selectCardConversation(props.cardIndex)
}

/**
 * 点按:移动端**单击即进入该群聊**(并同时选中它)
 *
 * 原先的"单击选中、双击进入"已取消(与单聊子卡同一套改动):
 * 双击慢且容易点空,单击的意图已经足够明确。
 * 桌面端 enterMobileChat 是空操作,单击只选中。
 * 删除模式下点击改为勾选 / 取消勾选(不切群聊、也不进聊天视图)。
 */
function onTap(): void {
  if (chatStore.deleteMode) {
    if (groupSub.value >= 0) chatStore.toggleDeleteSelect(groupSub.value)
    return
  }
  onSelect()
  enterMobileChat?.()
}

/**
 * 点击「⋯」打开群聊设置
 *
 * 只发事件、不改选中态:先让父级弹窗拿到本卡下标即可,
 * 是否顺带切到该群聊由父级(App)决定。
 */
function onMore(): void {
  emit('settings', props.cardIndex)
}
</script>

<template>
  <div class="group-unit" :class="{ 'is-active': isActive }" :style="{ top: top + 'px' }">
    <!-- 主卡:机体/头像框/浮标与单人主卡同源(mixin) -->
    <div
      class="card"
      :class="{ 'is-selected': isActive }"
      @click="onTap"
    >
      <div class="card__rect" />
      <!-- 删除模式:被勾选的群聊在左缘挂一条悬浮黄条(与单聊子卡同一套标记) -->
      <span v-if="isDeleteSelected" class="card__del-bar" />
      <img class="card__texture" :src="MATERIALS.cardTexture" alt="" />
      <img class="card__faint" :src="MATERIALS.cardFaint" alt="" />
      <p class="card__name">{{ title }}</p>
      <img class="card__underline" :src="MATERIALS.underline" alt="" />
      <img class="card__corner" :src="MATERIALS.cornerDeco" alt="" />

      <div class="card__avatar">
        <div class="card__avatar-clip">
          <!-- 九宫格:每格一个成员头像,格子边长随人数变化、整片贴顶;每格只保留圆角 -->
          <div class="card__avatar-grid" :style="gridStyle">
            <span v-for="m in gridMembers" :key="m" class="card__avatar-cell">
              <img
                class="card__avatar-img"
                :class="{ 'is-original-scale': isOriginalScaleAvatar(m) }"
                :src="avatarOf(m)"
                :alt="m"
              />
            </span>
          </div>
        </div>
        <!-- 消息浮标:只有还没聊过的群才挂(与单人主卡同一张素材、同一条动画) -->
        <img v-if="!hasChatRecord" class="card__chat-indicator" :src="MATERIALS.chatBadge" alt="" />
      </div>

      <!-- 右下角「⋯」:进入群聊设置。位置对齐单人主卡折叠箭头的槽位。
           放在 .card 内部(div 可含 button),靠 @click.stop 阻止冒泡选中。 -->
      <button
        class="card__more"
        type="button"
        aria-label="群聊设置"
        title="群聊设置"
        @click.stop="onMore"
      >
        <svg class="card__more-icon" viewBox="0 0 18 4" aria-hidden="true">
          <circle cx="2" cy="2" r="1.9" />
          <circle cx="9" cy="2" r="1.9" />
          <circle cx="16" cy="2" r="1.9" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// ---- 卡片单元:与 CharacterCardItem 的 .card-unit 同构(仅承载 top 位移) ------
.group-unit {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  transition: top 0.3s ease;

  // 选中项连同它的「⋯」压在其他卡片之上
  &.is-active {
    z-index: 6;
  }
}

// ---- 主卡(机体 / 头像框 / 消息浮标三块与单人主卡共用 mixin) ------------------
.card {
  @include main-card-chrome;
  @include card-avatar-frame;
  @include card-chat-indicator;

  // 删除模式的勾选标记:左缘一条悬浮黄条(与单聊子卡同一套标记、同一段动画)
  &__del-bar {
    position: absolute;
    left: -5px;
    top: 0;
    width: 5px;
    height: 92.99px; // = 主卡机体高度(见 main-card-chrome 的 __rect)
    border-radius: 2px;
    background: $color-subcard-selected;
    box-shadow: 0 0 12px rgba(255, 239, 0, 0.45);
    pointer-events: none;
    animation: group-del-bar-in 0.18s ease-out;
  }

  @keyframes group-del-bar-in {
    from {
      opacity: 0;
      transform: scaleY(0.35);
    }
    to {
      opacity: 1;
      transform: scaleY(1);
    }
  }

  // ---- 九宫格 ------------------------------------------------------------
  &__avatar-grid {
    display: grid;
    // 尺寸由内联样式给出(= 轨道总尺寸)。块级元素 + 定宽 + auto 外边距 → 横向居中;
    // 作为 clip 的首个子元素天然贴顶,不居中(头像要贴住边框上沿)。
    margin: 0 auto;
  }

  &__avatar-cell {
    display: block;
    overflow: hidden;
    // 只保留圆角(与最外层头像框同为 6px):不画描边、不铺底板,
    // 圆角让出的缺口直接透出卡片底色,靠圆角本身把每格区分开。
    border-radius: 6px;

    // 每格复用 &-img 的裁剪配方(见 card-avatar-frame):同样是 cover +
    // object-position 45% 15% + scale 收紧,只是容器从整个头像框变成一格。
    .card__avatar-img {
      display: block;
    }
  }

  // ---- 右下角群聊设置「⋯」------------------------------------------------
  // 槽位对齐单人主卡的折叠箭头(left 415.92 / top 52.31 / 31.2×31.2)——
  // 群聊没有子卡,不设箭头,这个位置让给群聊设置。
  // 命中区略放大到 32×32 并保持同中心:移动端整体 zoom≈0.74,
  // 换算到屏幕仍有 ~24px,再小就容易点空。
  &__more {
    position: absolute;
    left: 415.52px;
    top: 51.91px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: rgba(255, 255, 255, 0.55);
    cursor: pointer;
    // 全部常显:此前默认 opacity:0 + pointer-events:none,只有鼠标进入列表
    // 或该卡被选中时才出现,触屏上几乎是"看不见也点不到"。
    // 反馈只走颜色(悬停/按下变亮),不铺矩形底色块。
    transition: color 0.15s ease;

    &-icon {
      display: block;
      width: 16px;
      height: 4px;
      fill: currentColor;
    }

    &:hover,
    &:active {
      color: $color-text-primary;
    }

    // 键盘可达性:聚焦时给一圈描边
    &:focus-visible {
      outline: 1px solid $color-subcard-selected;
    }
  }
}
</style>
