<script setup lang="ts">
// ChatModeTabs —— 聊天区正上方的「单聊 / 群聊」页签
// 复用设置弹窗的 .pn-tabs 样式（斜纹背板 + 选中黄块），不另起一套。
import { PERSON_GROUP_PATHS, PERSON_SOLO_PATHS } from '../../constants/icons'
import { MATERIALS } from '../../constants/materials'

/** 会话模式(与侧边栏开关一致;移动端仍用那边的开关) */
export type ChatMode = 'single' | 'group'

const props = defineProps<{
  /** 当前模式 */
  mode: ChatMode
}>()

const emit = defineEmits<{
  (e: 'update:mode', mode: ChatMode): void
}>()

/** 点页签:重复点当前项不发事件 */
function select(mode: ChatMode): void {
  if (mode !== props.mode) emit('update:mode', mode)
}
</script>

<template>
  <div class="chat-tabs">
    <!-- 宽度交给内容(max-content):.pn-tabs 的背板是 inset:0,拉满会变成一条
         贯穿整个聊天区的斜纹长条,与设置弹窗那种"一块牌"的观感不符 -->
    <div class="pn-tabs" :style="{ width: 'max-content' }">
      <div class="pn-tabs__backdrop" aria-hidden="true" />

      <button
        class="pn-tab"
        :class="{ 'is-active': mode === 'single' }"
        type="button"
        title="单聊"
        aria-label="单聊"
        :aria-pressed="mode === 'single'"
        @click="select('single')"
      >
        <span
          class="pn-tab__block"
          aria-hidden="true"
          :style="mode === 'single' ? { backgroundImage: `url(${MATERIALS.panelTabTexture})` } : undefined"
        />
        <span class="pn-tab__icon">
          <svg
            viewBox="0 0 48 48"
            fill="none"
            stroke="currentColor"
            stroke-width="4"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path v-for="(d, i) in PERSON_SOLO_PATHS" :key="i" :d="d" />
          </svg>
        </span>
      </button>

      <button
        class="pn-tab"
        :class="{ 'is-active': mode === 'group' }"
        type="button"
        title="群聊"
        aria-label="群聊"
        :aria-pressed="mode === 'group'"
        @click="select('group')"
      >
        <span
          class="pn-tab__block"
          aria-hidden="true"
          :style="mode === 'group' ? { backgroundImage: `url(${MATERIALS.panelTabTexture})` } : undefined"
        />
        <span class="pn-tab__icon">
          <svg
            viewBox="0 0 48 48"
            fill="none"
            stroke="currentColor"
            stroke-width="4"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path v-for="(d, i) in PERSON_GROUP_PATHS" :key="i" :d="d" />
          </svg>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
// 容器只管"放在哪、居中";外观全部来自 .pn-tabs(全局类)
.chat-tabs {
  display: flex;
  justify-content: center;
  // 整条横带不拦截鼠标,只有页签自己可点
  pointer-events: none;

  .pn-tabs {
    pointer-events: auto;
  }
}
</style>
