<script setup lang="ts">
// =============================================================================
// 左侧列表容器(第三版:单聊 / 群聊双模式)
// -----------------------------------------------------------------------------
// 职责:
// 1. 顶部渲染模式切换控件(不随列表滚动),群聊模式下右侧带加号
// 2. 单聊模式:渲染非群聊主卡(沿用原 CharacterCardItem)
// 3. 群聊模式:渲染群聊主卡(GroupCardItem:成员头像叠层 + 群名 + 末条预览)
// 4. 按当前模式的可见卡片重新计算 top 偏移(两种模式各自连续排布)
// 5. 动态排序:最近来过消息的主卡排最上面(见 orderedIndexes,只改展示顺序)
//
// 位置计算复用 constants/characterCard 的 computeUnitTops / computeCardPadTop:
// 传入"当前模式下的折叠状态 + 子卡数",即可得到该模式下各卡片的 top。
// =============================================================================
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore, GROUP_MIN_MEMBERS } from '../../stores/chat'
import { useSettingsStore } from '../../stores/settings'
import {
  computeUnitTops,
  computeCardPadTop,
} from '../../constants/characterCard'
import CharacterCardItem from './CharacterCardItem.vue'
import GroupCardItem from './GroupCardItem.vue'
import ChatModeSwitch from './ChatModeSwitch.vue'
import { MATERIALS } from '../../constants/materials'
import type { Card } from '../../types/chat'

const props = withDefaults(defineProps<{
  /**
   * 列表尾部留白高度(px,画布设计口径)
   *
   * 删除模式下底部会浮出一条操作条(删除 / 历史 / 上下文),它盖住列表最后
   * 一张卡 —— 由 App 把该条高度按当前画布缩放换算成设计口径传进来,尾部留白
   * 加到这么高,内容就能滚到条上方。默认 80 即样式里原本的留白。
   */
  bottomPad?: number
}>(), { bottomPad: 80 })

const emit = defineEmits<{
  /**
   * 点击操作带的加号
   *
   * 群聊模式下语义是"创建群聊",单聊模式下是"新建对话"。
   * 本组件不判断该做什么,统一上抛,由 App 按当前模式分发。
   */
  (e: 'add'): void
  /** 点击群聊卡「⋯」:请求打开群聊设置弹窗 */
  (e: 'group-settings', cardIndex: number): void
  /** 点击操作带的设置按钮:请求打开设置弹窗 */
  (e: 'open-settings'): void
  /** 点击操作带的删除按钮:请求打开删除确认弹窗 */
  (e: 'open-delete'): void
  /** 点击操作带的用量按钮:请求开关 Token 用量 / 缓存命中面板 */
  (e: 'open-usage'): void
}>()

const chatStore = useChatStore()
const settingsStore = useSettingsStore()
const { collapsed, cards, chatMode } = storeToRefs(chatStore)

/**
 * 是否显示用量面板入口
 *
 * 只对自定义 API 模式有意义:后端模式的提示词与上下文都由服务端管理,
 * 本地既算不出预算也拿不到服务商的 usage 字段。
 */
const showUsageButton = computed(() => settingsStore.apiConfig.apiMode === 'custom')

/** 操作带上由本组件渲染的方形按钮个数(删除 / 用量 / 设置),供开关反算单段宽度 */
const hostActionCount = computed(() => (showUsageButton.value ? 3 : 2))

/** 是否群聊主卡(成员 ≥2) */
function isGroupCard(c: Card): boolean {
  return (c.members ?? []).length >= GROUP_MIN_MEMBERS
}

/**
 * 当前模式下可见卡片的真实下标
 *
 * 单聊模式排除群聊主卡,群聊模式只保留群聊主卡。
 */
const visibleIndexes = computed(() =>
  cards.value
    .map((c, i) => i)
    .filter((i) => (chatMode.value === 'group' ? isGroupCard(cards.value[i]) : !isGroupCard(cards.value[i]))),
)

/**
 * 列表的展示顺序:最近来过消息的主卡排最上面
 *
 * 排的是**卡片在 store 里的下标**,不是 cards 数组本身 —— 展示顺序与数据顺序
 * 分离:cards / activeCardIndex / cardSubRanges / 删除勾选全都按原始下标工作,
 * 这里换个次序不会影响任何一处。
 *
 * 时间章按"卡片身份"取(chatStore.cardActiveKey,见 store 里的说明),所以
 * 增删卡片、导入数据都不会串号,刷新后顺序也照旧。
 * 从没来过消息的卡时间章为 0,靠 Array#sort 的稳定性保持它们原有的先后
 * (新卡永远按"内置干员表"的顺序排在有消息的卡之后)。
 */
const orderedIndexes = computed(() =>
  [...visibleIndexes.value].sort(
    (a, b) => activityOf(b) - activityOf(a),
  ),
)

/** 某张主卡的最后活跃时刻(没记录 = 0) */
function activityOf(cardIndex: number): number {
  const card = cards.value[cardIndex]
  if (!card) return 0
  return chatStore.cardActiveAt[chatStore.cardActiveKey(card)] ?? 0
}

/** 可见卡片对应的折叠状态 / 子卡数(与 orderedIndexes 同序) */
const visibleCollapsed = computed(() => orderedIndexes.value.map((i) => collapsed.value[i] ?? true))
const visibleSubCounts = computed(() =>
  orderedIndexes.value.map((i) => cards.value[i]?.conversations.length ?? 1),
)

/** 可见卡片的 top 偏移(已含 TOP_PAD) */
const unitTops = computed(() =>
  computeUnitTops(visibleCollapsed.value, visibleSubCounts.value),
)

/** 列表尾部留白的 top 坐标 */
const cardPadTop = computed(() =>
  computeCardPadTop(visibleCollapsed.value, visibleSubCounts.value, unitTops.value),
)
/** 群聊列表为空时的提示 */
const groupListEmpty = computed(() => chatMode.value === 'group' && visibleIndexes.value.length === 0)

/** 切换模式 */
function onModeChange(mode: 'single' | 'group'): void {
  chatStore.setChatMode(mode)
}
</script>

<template>
  <!-- 顶部操作带:模式切换控件 + 若干操作按钮,位于角色列表上方、不随列表滚动 -->
  <div class="mode-switch-host">
    <ChatModeSwitch
      :mode="chatMode"
      :host-action-count="hostActionCount"
      @update:mode="onModeChange"
      @add="emit('add')"
    />

    <!-- 删除 / 用量 / 设置:原先在右上角工具栏,现统一移到这条带上,排在加号右侧。
         外壳与加号共用 list-action-btn,保证各按钮同尺寸同质感。
         (分享按钮已移除 —— 导出并入消息右键菜单「导出选中消息」底部条的「导出全部消息」)

         宽度约束:这条带必须与主卡等宽(458.28px),而单段宽度是按
         "按钮个数"反算的 —— 增减按钮时务必同步 hostActionCount,
         否则带子会比主卡短一截(见 ChatModeSwitch 的 SEG_W 说明)。 -->
    <button
      class="mode-switch-host__action"
      type="button"
      aria-label="删除对话"
      title="删除对话"
      @click="emit('open-delete')"
    >
      <img :src="MATERIALS.editBtnDeleteIndeed" alt="" />
    </button>
    <button
      v-if="showUsageButton"
      class="mode-switch-host__action"
      type="button"
      aria-label="Token 用量与缓存命中"
      title="Token 用量与缓存命中"
      @click="emit('open-usage')"
    >
      <img :src="MATERIALS.iconUsageStats" alt="" />
    </button>
    <button
      class="mode-switch-host__action"
      type="button"
      aria-label="设置"
      title="设置"
      @click="emit('open-settings')"
    >
      <img :src="MATERIALS.loginBtnSetting" alt="" />
    </button>
  </div>

  <!-- 列表滚动容器 -->
  <section class="character-card">
    <div class="card-pad card-pad--top" />

    <!-- 单聊列表(顺序 = orderedIndexes:最近来过消息的排最前) -->
    <template v-if="chatMode === 'single'">
      <CharacterCardItem
        v-for="(top, k) in unitTops"
        :key="orderedIndexes[k]"
        :index="orderedIndexes[k]"
        :top="top"
      />
    </template>

    <!-- 群聊列表 -->
    <template v-else>
      <GroupCardItem
        v-for="(top, k) in unitTops"
        :key="orderedIndexes[k]"
        :card-index="orderedIndexes[k]"
        :top="top"
        :card="cards[orderedIndexes[k]]"
        @settings="(i: number) => emit('group-settings', i)"
      />
    </template>

    <!-- 群聊空状态 -->
    <p v-if="groupListEmpty" class="group-empty">
      还没有群聊<br />
      <span class="group-empty__sub">点右上角「＋」创建</span>
    </p>

    <div class="card-pad" :style="{ top: cardPadTop + 'px', height: props.bottomPad + 'px' }" />
  </section>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 顶部操作带宿主:绝对定位于画布坐标,高度 40px,位于列表上方。
// 内含「模式切换 + 加号」(ChatModeSwitch)与「删除 / 用量 / 设置」操作按钮。
//
// 几何:左边缘与主卡对齐(同为 47.42px),宽度与主卡等宽(同为 458.28px)。
// 带宽由内容精确铺满,不是写死后留白:
//   开关轨道 + N 个方形按钮 ×40 + N 个间距 ×10 = 458.28,N = 加号 + 本组按钮数。
// 用量按钮仅在自定义 API 模式出现 → N 会变,故本组按钮个数以 hostActionCount
// 下发给 ChatModeSwitch,由它反算单段宽度 SEG_W。
.mode-switch-host {
  position: absolute;
  left: 47.42px;
  top: 62px;
  width: 458.28px;
  height: 40px;
  display: flex;
  align-items: center;
  // 内容与带宽相等:用 flex-start 让"数字算错"表现为右侧露白(一眼可见),
  // 而不是被居中悄悄掩盖成两边各差一点
  justify-content: flex-start;
  // 与 ChatModeSwitch 内部 track/加号之间的间距一致,整条带等距
  gap: 10px;
  z-index: 2;
  // 宿主是一整块 526×40 的实体盒子(只有按钮本身占宽)。不关掉命中测试,
  // 它会像一块透明玻璃一样吃掉整条上的点击。按钮各自再打开命中测试。
  pointer-events: none;

  > * {
    pointer-events: auto;
  }

  // 操作按钮(设置 / 分享 / 删除):外壳与加号共用同一个 mixin,保证同质感
  &__action {
    @include list-action-btn;

    img {
      display: block;
      width: 20px;
      height: 20px;
      object-fit: contain;
      opacity: 0.55;
      transition: opacity 0.15s ease;
    }

    &:hover img {
      opacity: 1;
    }
  }
}

.character-card {
  position: absolute;
  left: 0;
  top: 122.57px;
  // 必须高于 .mode-switch-host(z-index: 2):两者虽不重叠,但层级关系一旦反了,
  // 处在列表顶部的那张卡片就会点不动(第二个及以后不受影响)。
  z-index: 3;
  width: 526px;
  height: 897.27px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: $color-scrollbar-character transparent;
  // 顶部 5px 渐隐 + 底部 40-80px 渐隐 + 右侧 14px 渐隐
  @include scroll-mask(0, 5px, calc(100% - 80px), calc(100% - 40px), 14px);
}

.card-pad {
  position: absolute;
  left: 0;
  width: 1px;
  height: 80px;
  pointer-events: none;

  &--top {
    top: 0;
    height: 10px;
  }
}

// 群聊空状态(居中于列表可视区)
.group-empty {
  position: absolute;
  left: 0;
  right: 0;
  top: 160px;
  margin: 0;
  text-align: center;
  font-family: $font-harmony;
  font-size: 15px;
  line-height: 1.8;
  color: rgba(255, 255, 255, 0.4);

  &__sub {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.28);
  }
}
</style>
