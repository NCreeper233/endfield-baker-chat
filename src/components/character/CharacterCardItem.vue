<script setup lang="ts">
// =============================================================================
// 单张主卡(可折叠,内含任意数量子卡 ≥1)
// -----------------------------------------------------------------------------
// 职责:
// 1. 渲染主卡视觉(rect/texture/faint/name/underline/corner/avatar/badge/btn)
// 2. 折叠按钮:点击切换 store.collapsed[index]
// 3. 折叠联动:箭头旋转 + 子卡 v-if 隐藏(配合 <transition name="collapse">)
// 4. hover 状态:局部 ref 管理(主卡 + 每张子卡)
//
// 子卡渲染:v-for 遍历该主卡下的所有子卡(由 store.cardSubRanges 提供全局索引),
// 用 subTopInCard(k) 计算第 k 张子卡的 top 偏移。
// =============================================================================
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../../stores/chat'
import { useSettingsStore } from '../../stores/settings'
import { MATERIALS } from '../../constants/materials'
import { isOriginalScaleAvatar } from '../../constants/character'
import { subTopInCard } from '../../constants/characterCard'
import SubCard from './SubCard.vue'

const props = defineProps<{
  /** 主卡索引 */
  index: number
  /** 该主卡的 top 偏移(由 CharacterCardList 计算) */
  top: number
}>()

const chatStore = useChatStore()
const settingsStore = useSettingsStore()
const { cardSubRanges } = storeToRefs(chatStore)

/** 该卡片是否折叠 */
const collapsed = computed(() => chatStore.collapsed[props.index])

/** 该主卡是否被选中(点击父卡或选中子对话;选中视觉 = 白色遮罩常显) */
const isCardSelected = computed(() => chatStore.activeCardIndex === props.index)

/** 该主卡下的全局子卡索引区间 [start, start+count) */
const range = computed(() => cardSubRanges.value[props.index] ?? { start: 0, count: 0 })

/** 该主卡下所有子卡的全局索引列表(用于 v-for) */
const subIndices = computed(() => {
  const { start, count } = range.value
  const list: number[] = []
  for (let k = 0; k < count; k++) list.push(start + k)
  return list
})

/** 该主卡对应的干员数据(name + avatar) */
const character = computed(() => chatStore.cardCharacters[props.index])

/**
 * 是否正在显示第二张头像(带 avatarAlt 的角色才有意义,目前只有「管理员」)
 *
 * 状态在**设置 store** 里(随设置快照落盘),不在组件内 ——
 * 这样刷新后仍是你选的那张,而且聊天区里对方的头像读的是同一份状态,两处一致。
 */
const showAltAvatar = computed(() => settingsStore.isAvatarAltOn(character.value.name))

/** 这张卡的头像能否切换(有第二张形象) */
const canSwitchAvatar = computed(() => !!character.value.avatarAlt)

/** 当前该显示的头像 */
const avatarUrl = computed(() =>
  showAltAvatar.value && character.value.avatarAlt ? character.value.avatarAlt : character.value.avatar,
)

/**
 * 点击头像
 *
 * 能切换的角色:换一张图,并**阻止冒泡** —— 否则这一下会顺带把卡片折叠/选中。
 * 不能切换的角色:什么都不做,让事件照常冒泡(整卡行为与改动前完全一致)。
 */
function onAvatarClick(e: MouseEvent): void {
  if (!canSwitchAvatar.value) return
  e.stopPropagation()
  settingsStore.toggleAvatarAlt(character.value.name)
}

/**
 * 该主卡是否已经有对话记录(任意一段子对话里有消息)
 *
 * 有记录 = 已经聊过 → 头像右上角不再挂那个晃动的消息浮标;
 * 一次都没聊过的新卡才保留浮标,用作"点这里开始聊"的提示。
 */
const hasChatRecord = computed(() =>
  (chatStore.cards[props.index]?.conversations ?? []).some(c => c.messages.length > 0),
)

/** 局部 hover 状态:null=未 hover / 'card'=主卡 / 数字=对应子卡在主卡内的下标 */
const hover = ref<null | 'card' | number>(null)

/** 组件根元素 ref(用于 leave 时判断 relatedTarget 是否仍在卡内) */
const rootEl = ref<HTMLElement | null>(null)

function enterCard() {
  hover.value = 'card'
}

/**
 * 点击主卡:切换折叠 + 选中该主卡(白色遮罩常显)。
 * 选中主卡后即使未进入子对话,也可在选中父卡下新建对话(createChildConversation)。
 */
function onCardClick() {
  chatStore.toggleCollapse(props.index)
  chatStore.selectCard(props.index)
}

function enterSub(k: number) {
  hover.value = k
}

/**
 * 鼠标离开主卡/子卡时清除 hover
 *
 * 鼠标从主卡移到子卡时先触发主卡 pointerleave(hover=null,主卡 hover 样式丢失)
 * 再触发子卡 pointerenter(hover=k),中间一帧 hover=null 会导致视觉闪烁。
 * 因此检查 relatedTarget 是否仍在 .card-unit 内,若仍在内则不清除 hover
 * (子卡的 pointerenter 会紧接着覆盖)。
 */
function leave(event: PointerEvent) {
  const related = event.relatedTarget as Node | null
  if (related && rootEl.value?.contains(related)) return
  hover.value = null
}
</script>

<template>
  <div ref="rootEl" class="card-unit" :style="{ top: top + 'px' }">
    <!-- 主卡(点击卡片任意位置:切换折叠 + 选中该主卡;按钮为纯视觉) -->
    <div
      class="card"
      :class="{
        'is-collapsed': collapsed,
        'is-hover': hover === 'card',
        'is-selected': isCardSelected,
      }"
      @pointerenter="enterCard"
      @pointerleave="leave($event)"
      @click="onCardClick"
    >
      <div class="card__rect" />
      <img class="card__texture" :src="MATERIALS.cardTexture" alt="" />
      <img class="card__faint" :src="MATERIALS.cardFaint" alt="" />
      <p class="card__name">{{ character.name }}</p>
      <img class="card__underline" :src="MATERIALS.underline" alt="" />
      <img class="card__corner" :src="MATERIALS.cornerDeco" alt="" />
      <div
        class="card__avatar"
        :class="{ 'is-switchable': canSwitchAvatar }"
        :title="canSwitchAvatar ? '点击切换形象' : undefined"
        @click="onAvatarClick"
      >
        <!-- 裁剪夹层:overflow:hidden 限制 img scale 后的可见范围,
             外层 &__avatar 保持 overflow:visible 让 chat-indicator 能超出边框显示 -->
        <div class="card__avatar-clip">
          <img
            class="card__avatar-img"
            :class="{ 'is-original-scale': isOriginalScaleAvatar(character.name) }"
            :src="avatarUrl"
            alt=""
          />
        </div>
        <!-- 消息浮标:只有还没聊过的卡才挂(有对话记录的干员不显示) -->
        <img
          v-if="!hasChatRecord"
          class="card__chat-indicator"
          :src="MATERIALS.chatBadge"
          alt=""
        />
      </div>
      <!-- 折叠按钮:纯视觉(点击已由整卡接管,此处穿透到 .card)。
           圆环与人字箭头均为自绘 —— 原 line_common_circle_food.webp /
           deco_common_arrow_p2.webp 已弃用,尺寸按原素材像素反推(见样式)。 -->
      <button class="card__btn" type="button" tabindex="-1" aria-hidden="true">
        <!-- 空心圆环:viewBox 与原素材画布同为 260×260,
             外径 256(四周留 2px)、描边 16 → 中线半径 = 128 − 16/2 = 120 -->
        <svg class="card__btn-circle" viewBox="0 0 260 260" aria-hidden="true">
          <circle cx="130" cy="130" r="120" fill="none" stroke="#fff" stroke-width="16" />
        </svg>
        <!-- 人字形 chevron:viewBox 与原素材画布同为 24×19,
             故显示尺寸(18×14.25)与位置无需任何改动。
             张角 = 2×atan(半宽 9.2 / 进深 11.0) ≈ 80°(原素材约 65°,已按要求开大) -->
        <svg class="card__btn-arrow" viewBox="0 0 24 19" aria-hidden="true">
          <polyline
            points="2.8 3.9 12 14.9 21.2 3.9"
            fill="none"
            stroke="#f0f0f0"
            stroke-width="3.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>

    <!-- 子卡(任意数量,v-for 渲染) -->
    <transition name="collapse">
      <div v-if="!collapsed" class="card__subs">
        <SubCard
          v-for="(subIdx, k) in subIndices"
          :key="subIdx"
          :sub-index="subIdx"
          :is-second="k >= 1"
          :top="subTopInCard(k)"
          :is-hover="hover === k"
          @pointerenter="enterSub(k)"
          @pointerleave="leave($event)"
        />
      </div>
    </transition>
  </div>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// ---- 卡片单元:折叠时整块上下位移的载体 --------------------------------------
.card-unit {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  transition: top 0.3s ease;
}

// ---- 主卡 ----------------------------------------------------------------
.card {
  // 机体(矩形底/纹理/淡纹/名字/下划线/转角装饰/hover 白层/选中白层)、
  // 头像框、右上角消息浮标 —— 三块与群聊卡(GroupCardItem)共用同一组 mixin,
  // 保证两种卡在这些部位逐像素一致,且今后不会单边漂移。
  @include main-card-chrome;
  @include card-avatar-frame;
  @include card-chat-indicator;

  // 主卡的 hover 态除 :hover 外还有一个 class 形式 is-hover(由 hover===card 设置):
  // 鼠标从主卡移向子卡时 :hover 会短暂丢失,靠它兜住,避免头像描边闪一下。
  &.is-hover &__avatar {
    border-color: $color-avatar-border-hover;
  }

  // 「管理员」那张卡(带 avatarAlt)的头像可以点击切换男女形象:
  // 给个手型,并在悬停时把描边提亮一档,暗示"这里能点"
  // (列表整体是点击驱动的,这里不额外开 tabindex,与其它卡片保持一致)
  &__avatar.is-switchable {
    cursor: pointer;

    &:hover {
      border-color: $color-avatar-border-hover;
    }
  }

  &__btn {
    position: absolute;
    // 415.92 → 411.92:整体左移 4px(原位置离卡片右缘 11.16px,略靠外)
    left: 411.92px;
    top: 52.31px;
    width: 31.2px;
    height: 31.2px;
    padding: 0;
    border: none;
    background: transparent;
    // 纯视觉:点击穿透到 .card(整卡可点)
    pointer-events: none;

    &-circle,
    &-arrow {
      position: absolute;
      opacity: 0.4;
    }

    &-circle {
      // 原 line_common_circle_food.webp:260×260 画布里的**空心圆环**,
      // 外径 256(四周各留 2px)、描边 16px、纯白。
      // 按显示尺寸换算(31.2 / 260 = 0.12):外径 256×0.12 = 30.72,
      // 四周各留 (31.2 − 30.72) / 2 = 0.24。
      //
      // 刻意用 svg 而非 CSS `border` + `border-radius`:实测 border 宽度会被
      // Chrome 吸附到整数 device px —— 本画布 zoom≈0.745 时 1.92px 被压成 1px,
      // 圆环比原图细约 30%。svg 是整体平滑缩放,描边宽度等比保留。
      left: 0.24px;
      top: 0.24px;
      width: calc(100% - 0.48px);
      height: calc(100% - 0.48px);
    }

    &-arrow {
      left: 6.6px;
      top: 8.475px;
      width: 18px;
      height: 14.25px;
      transform: rotate(180deg);
      transition: transform 0.3s ease;
    }
  }

  // 折叠态:箭头回到 0deg
  &.is-collapsed .card__btn-arrow {
    transform: rotate(0deg);
  }

  // 子卡容器(仅作为 v-for 的承载,本身无尺寸/定位)
  &__subs {
    position: absolute;
    left: 0;
    top: 0;
    width: 0;
    height: 0;
  }
}
</style>
