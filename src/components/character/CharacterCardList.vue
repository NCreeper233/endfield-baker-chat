<script setup lang="ts">
// =============================================================================
// 左侧列表容器(第三版:单聊 / 群聊双模式)
// -----------------------------------------------------------------------------
// 职责:
// 1. 顶部渲染操作带:左组(新建 / 删除) + 中间搜索框 + 右组(公告 / 用量 / 设置),
//    不随列表滚动;单聊 / 群聊的切换已搬到页面顶栏(AppHeader)的页签上
// 2. 单聊模式:渲染非群聊主卡(沿用原 CharacterCardItem)
// 3. 群聊模式:渲染群聊主卡(GroupCardItem:成员头像叠层 + 群名 + 末条预览)
// 4. 按当前模式的可见卡片重新计算 top 偏移(两种模式各自连续排布)
// 5. 动态排序:最近来过消息的主卡排最上面(见 orderedIndexes,只改展示顺序)
// 6. 搜索:按卡名/群成员名实时过滤(纯本地,不发请求)
//
// 位置计算复用 constants/characterCard 的 computeUnitTops / computeCardPadTop:
// 传入"当前模式下的折叠状态 + 子卡数",即可得到该模式下各卡片的 top。
// =============================================================================
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore, GROUP_MIN_MEMBERS } from '../../stores/chat'
import { useSettingsStore } from '../../stores/settings'
import {
  computeUnitTops,
  computeCardPadTop,
} from '../../constants/characterCard'
import CharacterCardItem from './CharacterCardItem.vue'
import GroupCardItem from './GroupCardItem.vue'
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
  /** 点击操作带的公告按钮:请求打开公告页 */
  (e: 'open-announce'): void
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

/** 加号的无障碍标签:随模式变化(群聊 = 创建群聊,单聊 = 新建对话) */
const addLabel = computed(() => (chatMode.value === 'group' ? '创建群聊' : '新建对话'))

/** 搜索框内容(本地筛选,不发请求、不落盘) */
const searchQuery = ref('')

/** 归一化后的搜索词 */
const searchKeyword = computed(() => searchQuery.value.trim().toLowerCase())

/** 是否群聊主卡(成员 ≥2) */
function isGroupCard(c: Card): boolean {
  return (c.members ?? []).length >= GROUP_MIN_MEMBERS
}

/**
 * 当前模式下可见卡片的真实下标
 *
 * 单聊模式排除群聊主卡,群聊模式只保留群聊主卡;之后再按搜索词过滤。
 * 匹配规则:卡名包含关键词即命中;群聊额外匹配成员名(方便按角色找群)。
 */
const visibleIndexes = computed(() => {
  const base = cards.value
    .map((c, i) => i)
    .filter((i) => (chatMode.value === 'group' ? isGroupCard(cards.value[i]) : !isGroupCard(cards.value[i])))

  const kw = searchKeyword.value
  if (!kw) return base

  return base.filter((i) => {
    const card = cards.value[i]
    const name = (card.conversations[0]?.name ?? '').toLowerCase()
    if (name.includes(kw)) return true
    return (card.members ?? []).some((m) => m.toLowerCase().includes(kw))
  })
})

/** 搜索无命中(用于空状态提示) */
const searchEmpty = computed(() => !!searchKeyword.value && visibleIndexes.value.length === 0)

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
/** 群聊列表为空时的提示(搜索无命中的情况单独提示,不显示这句) */
const groupListEmpty = computed(
  () => chatMode.value === 'group' && visibleIndexes.value.length === 0 && !searchKeyword.value,
)
</script>

<template>
  <!-- 顶部操作带:左组(新建 / 删除) + 中间搜索框 + 右组(公告 / 用量 / 设置)
       位于角色列表上方、不随列表滚动 -->
  <div class="mode-switch-host">
    <!-- 左组 -->
    <div class="mode-switch-host__side">
      <button
        class="mode-switch-host__action"
        type="button"
        :aria-label="addLabel"
        :title="addLabel"
        @click="emit('add')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" aria-hidden="true">
          <path d="M12 5.5v13M5.5 12h13" />
        </svg>
      </button>
      <button
        class="mode-switch-host__action"
        type="button"
        aria-label="删除对话"
        title="删除对话"
        @click="emit('open-delete')"
      >
        <img :src="MATERIALS.editBtnDeleteIndeed" alt="" />
      </button>
    </div>

    <!-- 中间:角色 / 群聊搜索(实时筛选,不发请求) -->
    <div class="mode-switch-host__search">
      <input
        v-model="searchQuery"
        class="mode-switch-host__input"
        type="text"
        :placeholder="chatMode === 'group' ? '搜索群聊 / 成员' : '搜索干员名'"
        aria-label="搜索"
        spellcheck="false"
        autocomplete="off"
      />
      <button
        v-if="searchQuery"
        class="mode-switch-host__clear"
        type="button"
        aria-label="清空搜索"
        title="清空"
        @click="searchQuery = ''"
      >×</button>
    </div>

    <!-- 右组 -->
    <div class="mode-switch-host__side">
      <button
        class="mode-switch-host__action"
        type="button"
        aria-label="公告"
        title="公告"
        @click="emit('open-announce')"
      >
        <!-- 公告:铃铛外框 + 底部小锤,与相邻的图片图标同为纯白、同透明度 -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 9a6 6 0 1 1 12 0c0 4 1.2 5.4 2 6H4c.8-.6 2-2 2-6Z" />
          <path d="M10 19a2 2 0 0 0 4 0" />
        </svg>
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
      <span class="group-empty__sub">点左上角「＋」创建</span>
    </p>

    <!-- 搜索无命中的空状态 -->
    <p v-else-if="searchEmpty" class="group-empty">
      没有匹配的{{ chatMode === 'group' ? '群聊' : '干员' }}<br />
      <span class="group-empty__sub">换个关键词试试</span>
    </p>

    <div class="card-pad" :style="{ top: cardPadTop + 'px', height: props.bottomPad + 'px' }" />
  </section>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 顶部操作带宿主:绝对定位于画布坐标,高度 40px,位于列表上方。
// 排布:左组(新建 / 删除) — 中间搜索框(吃掉剩余宽) — 右组(公告 / 用量 / 设置)。
//
// 几何:左边缘与主卡对齐(同为 47.42px),宽度与主卡等宽(同为 458.28px)。
.mode-switch-host {
  position: absolute;
  left: 47.42px;
  // 顶栏(AppHeader,高 80)接管了标题与模式页签后,这条操作带整体下移一点点:
  // 76 让按钮视觉上紧贴顶栏下沿,底边 116 距首卡(≈132.57)仍有余量
  top: 76px;
  width: 458.28px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  z-index: 2;
  // 宿主是一整块实体盒子(只有按钮 / 输入框本身占宽)。不关掉命中测试,
  // 它会像一块透明玻璃一样吃掉整条上的点击。
  pointer-events: none;

  > * {
    pointer-events: auto;
  }

  // ---- 左右两组按钮 ------------------------------------------------------
  &__side {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: none;
  }

  // ---- 中间搜索框 --------------------------------------------------------
  &__search {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    height: 40px;
    display: flex;
    align-items: center;
  }

  &__input {
    width: 100%;
    height: 100%;
    padding: 0 26px 0 12px;
    border: 1px solid $color-subcard-line;
    border-radius: 4.39px;
    background: $color-card-bg;
    color: $color-text-primary;
    font-family: $font-harmony;
    font-size: 12px;
    line-height: 1;
    outline: none;
    transition: border-color 0.15s ease, background 0.15s ease;

    &::placeholder {
      color: rgba(255, 255, 255, 0.35);
    }

    &:hover {
      border-color: $color-avatar-border;
    }

    // 聚焦态用灰色描边(与面板其它输入框一致),不再用选中黄
    &:focus {
      border-color: $color-dialog-border;
      background: #3a3b39;
    }
  }

  // 一键清空(有内容时才出现)
  &__clear {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.16);
    color: rgba(255, 255, 255, 0.75);
    font-family: $font-harmony;
    font-size: 11px;
    line-height: 16px;
    text-align: center;
    cursor: pointer;

    &:hover {
      background: rgba(255, 255, 255, 0.28);
      color: #fff;
    }
  }

  // 操作按钮(新建 / 删除 / 公告 / 用量 / 设置):外壳与加号共用同一个 mixin
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

    // 自绘图标(公告铃铛):与图片图标同样的 20px / 55% 白,视觉上不分彼此
    svg {
      display: block;
      width: 20px;
      height: 20px;
      opacity: 0.55;
      transition: opacity 0.15s ease;
    }

    &:hover img,
    &:hover svg {
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
