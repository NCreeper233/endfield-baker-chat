<script setup lang="ts">
// GroupSettingsDialog —— 群聊设置：改名、成员增删（2~5 人）、发言模式、身份、删除群聊
// 正在扮演的角色不可移除；改动都写进 chatStore.cards，由持久化层自动落盘。
import { computed, ref, watch } from 'vue'
import VersionDialogShell from '../layout/VersionDialogShell.vue'
import { CHARACTERS, findCharacter, DEFAULT_AVATAR_URL } from '../../constants/character'
import {
  useChatStore,
  GROUP_SETTINGS_MIN,
  GROUP_SPEAK_MODES,
} from '../../stores/chat'
import type { GroupSpeakMode } from '../../types/chat'

const props = defineProps<{
  /** 是否展开 */
  open: boolean
  /** 要设置的群聊在 cards 中的真实下标;无选中时为 null */
  cardIndex: number | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const chatStore = useChatStore()

/** 群名输入框的草稿(失焦 / 回车才写回 store,避免每敲一个字就落盘) */
const nameDraft = ref('')
/** 是否展开「添加成员」的角色挑选列表 */
const pickerOpen = ref(false)
/** 操作提示(人数越界 / 成员被锁定等) */
const hint = ref('')

/** 当前群聊的设置快照(每次打开或改动后重新读取) */
const info = ref<ReturnType<typeof chatStore.getGroupSettings>>(null)

/** 重新从 store 读一份快照 */
function refresh(): void {
  info.value = props.cardIndex === null ? null : chatStore.getGroupSettings(props.cardIndex)
  nameDraft.value = info.value?.name ?? ''
}

/** 每次打开都重读,并复位所有临时 UI 状态 */
watch(
  () => [props.open, props.cardIndex] as const,
  ([open]) => {
    if (!open) return
    pickerOpen.value = false
    hint.value = ''
    refresh()
  },
  { immediate: true },
)

const members = computed(() => info.value?.members ?? [])
const memberCount = computed(() => members.value.length)

/** 成员头像(未收录角色回退默认头像) */
function avatarOf(name: string): string {
  return findCharacter(name)?.avatar ?? DEFAULT_AVATAR_URL
}

/** 正在扮演的角色(不可移除);非扮演身份时为 null */
const lockedMember = computed(() => info.value?.lockedMember ?? null)

/** 还能不能减人(下限 2 人) */
const canRemove = computed(() => memberCount.value > GROUP_SETTINGS_MIN)

/** 候选角色(内置干员里还没进群的) */
const candidates = computed(() =>
  CHARACTERS.filter((c) => members.value.indexOf(c.name) === -1),
)

/** 成员的展示信息:名字 + 是否锁定 */
function isLocked(name: string): boolean {
  return lockedMember.value === name
}

// ═══ 1. 群聊名称 ═══════════════════════════════════════════════════════════

/** 把草稿写回 store(空串会退回按成员推导的默认名) */
function commitName(): void {
  if (props.cardIndex === null) return
  if (!chatStore.updateGroupName(props.cardIndex, nameDraft.value)) return
  refresh()
}

// ═══ 2. 群聊成员 ═══════════════════════════════════════════════════════════

/** 移除成员 */
function removeMember(name: string): void {
  hint.value = ''
  if (isLocked(name)) {
    hint.value = `正在扮演「${name}」，无法从群聊中移除`
    return
  }
  if (!canRemove.value) {
    hint.value = `群聊至少保留 ${GROUP_SETTINGS_MIN} 名成员`
    return
  }
  const next = members.value.filter((m) => m !== name)
  if (chatStore.updateGroupMembers(props.cardIndex!, next)) refresh()
}

/** 添加成员(不设上限) */
function addMember(name: string): void {
  hint.value = ''
  if (chatStore.updateGroupMembers(props.cardIndex!, [...members.value, name])) {
    refresh()
  }
}

/** 点「＋ 添加成员」 */
function togglePicker(): void {
  hint.value = ''
  pickerOpen.value = !pickerOpen.value
}

// ═══ 3. 发言模式 ═══════════════════════════════════════════════════════════

const speakMode = computed<GroupSpeakMode>(() => info.value?.speakMode ?? 'smart')

/** 切换发言模式:立即生效并落盘 */
function setSpeakMode(mode: GroupSpeakMode): void {
  hint.value = ''
  if (props.cardIndex === null) return
  if (!chatStore.updateGroupSpeakMode(props.cardIndex, mode)) return
  refresh()
}

// ═══ 5. 删除群聊 ═══════════════════════════════════════════════════════════
// 已从此弹窗移除:删除入口收敛到操作带的删除按钮(DeleteConfirmDialog 群聊模式)。

/** 关闭弹窗(先把群名草稿落盘,避免输入完直接点关闭丢失) */
function onClose(): void {
  commitName()
  emit('close')
}
</script>

<template>
  <VersionDialogShell
    :open="props.open"
    title="群聊设置"
    kind="alert"
    @close="onClose"
  >
    <!-- 群聊不存在(被删除 / 下标失效)时的兜底 -->
    <p v-if="!info" class="gs__empty">该群聊已不存在</p>

    <template v-else>
      <!-- ═══ 1. 群聊名称 ═══ -->
      <section class="gs__field">
        <label class="gs__label" for="gs-name">群聊名称</label>
        <input
          id="gs-name"
          v-model="nameDraft"
          class="gs__input"
          type="text"
          maxlength="40"
          placeholder="输入群聊名称"
          @blur="commitName"
          @keydown.enter.prevent="commitName"
        />
        <p class="gs__tip">留空则自动按成员生成</p>
      </section>

      <!-- ═══ 2. 群聊成员 ═══ -->
      <section class="gs__field">
        <span class="gs__label">群聊成员</span>

        <!-- 成员列表:头像 + 名字,右侧「×」移除 -->
        <div class="gs__members">
          <div v-for="m in members" :key="m" class="gs__member">
            <span class="gs__member-avatar">
              <img :src="avatarOf(m)" :alt="m" />
            </span>
            <span class="gs__member-name">{{ m }}</span>
            <span v-if="isLocked(m)" class="gs__member-lock">扮演中</span>
            <button
              v-else
              class="gs__member-del"
              type="button"
              :disabled="!canRemove"
              :aria-label="`移除 ${m}`"
              @click="removeMember(m)"
            >×</button>
          </div>

          <!-- 添加成员入口 -->
          <button
            class="gs__add"
            type="button"
            :class="{ 'is-open': pickerOpen }"
            @click="togglePicker"
          >
            <span class="gs__add-icon" aria-hidden="true">＋</span>
            <span>添加成员</span>
          </button>
        </div>

        <!-- 角色挑选列表 -->
        <div v-if="pickerOpen" class="gs__picker">
          <p v-if="candidates.length === 0" class="gs__picker-empty">所有角色都已在群聊中</p>
          <button
            v-for="c in candidates"
            :key="c.name"
            class="gs__picker-item"
            type="button"
            @click="addMember(c.name)"
          >
            <span class="gs__picker-avatar">
              <img :src="c.avatar" alt="" />
            </span>
            <span class="gs__picker-name">{{ c.name }}</span>
            <span class="gs__picker-plus" aria-hidden="true">＋</span>
          </button>
        </div>
      </section>

      <!-- ═══ 3. 发言模式 ═══ -->
      <section class="gs__field">
        <span class="gs__label">发言模式</span>
        <div class="gs__modes">
          <button
            v-for="m in GROUP_SPEAK_MODES"
            :key="m.key"
            class="gs__mode"
            :class="{ 'is-active': speakMode === m.key }"
            type="button"
            :aria-pressed="speakMode === m.key"
            @click="setSpeakMode(m.key)"
          >
            <span class="gs__mode-name">{{ m.label }}</span>
            <span class="gs__mode-desc">{{ m.desc }}</span>
          </button>
        </div>

        <p v-if="speakMode === 'assign'" class="gs__tip">
          指定谁发言请到聊天区最后一条消息下方的「指定发言」里选择
        </p>
      </section>

      <!-- ═══ 4. 我的身份(只读) ═══ -->
      <section class="gs__field">
        <span class="gs__label">我的身份</span>
        <p class="gs__readonly">{{ info.myRoleLabel }}</p>
      </section>

      <p v-if="hint" class="gs__hint">{{ hint }}</p>
    </template>

    <template #actions>
      <button class="pn-btn" type="button" @click="onClose">
        <span class="pn-btn__tex" aria-hidden="true"></span>
        <span class="pn-btn__deco" aria-hidden="true"></span>
        <span class="pn-btn__label">完成</span>
      </button>
    </template>
  </VersionDialogShell>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

// 与创建群聊 / 公告 / 提醒 / 更新共用 VersionDialogShell，正文白底，
// 文字与控件统一按浅色底配色。

.gs {
  &__empty {
    margin: 4px 0 0;
    color: #6b7280;
    font-family: $font-harmony;
    font-size: 14px;
  }

  // ---- 通用字段 ----------------------------------------------------------
  &__field {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid rgba(17, 24, 39, 0.1);

    &:first-child {
      margin-top: 0;
      padding-top: 0;
      border-top: 0;
    }
  }

  &__label {
    display: block;
    margin-bottom: 8px;
    color: #4b5563;
    font-family: $font-harmony;
    font-size: 13px;
  }

  &__tip {
    margin: 6px 0 0;
    color: #9ca3af;
    font-family: $font-harmony;
    font-size: 12px;
    line-height: 1.5;
  }

  &__hint {
    margin: 12px 0 0;
    color: #8a6d00;
    font-family: $font-harmony;
    font-size: 13px;
  }

  // ---- 1. 群聊名称 -------------------------------------------------------
  &__input {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid rgba(17, 24, 39, 0.18);
    border-radius: 4px;
    background: #f2f2f2;
    color: #1f2937;
    font-family: $font-harmony;
    font-size: 14px;
    box-sizing: border-box;

    &::placeholder {
      color: #9ca3af;
    }

    &:focus {
      outline: none;
      border-color: #d8cf00;
      box-shadow: 0 0 0 2px rgba(252, 243, 63, 0.5);
    }
  }

  // ---- 2. 群聊成员 -------------------------------------------------------
  &__members {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  &__member {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border: 1px solid rgba(17, 24, 39, 0.12);
    border-radius: 4px;
    background: #f7f7f7;
  }

  &__member-avatar {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    overflow: hidden;
    border: 1px solid rgba(17, 24, 39, 0.16);
    border-radius: 50%;
    background: #e6e6e6;

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      // 与主卡头像同口径:竖幅立绘取上端方形区域
      object-position: 45% 15%;
    }
  }

  &__member-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #1f2937;
    font-family: $font-harmony;
    font-size: 14px;
  }

  // "扮演中"标记(该成员不可移除)
  &__member-lock {
    flex-shrink: 0;
    color: #8a6d00;
    font-family: $font-harmony;
    font-size: 11px;
    opacity: 0.9;
  }

  &__member-del {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: #6b7280;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;

    &:hover:not(:disabled) {
      background: rgba(17, 24, 39, 0.08);
      color: #111827;
    }

    &:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }
  }

  // 「＋ 添加成员」行
  &__add {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border: 1px dashed rgba(17, 24, 39, 0.28);
    border-radius: 4px;
    background: transparent;
    color: #4b5563;
    font-family: $font-harmony;
    font-size: 14px;
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease, background-color 0.15s ease;

    &:hover,
    &.is-open {
      border-color: #d8cf00;
      background: rgba(252, 243, 63, 0.18);
      color: #6b5800;
    }
  }

  &__add-icon {
    font-size: 15px;
    line-height: 1;
  }

  // 角色挑选列表
  &__picker {
    margin-top: 6px;
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid rgba(17, 24, 39, 0.14);
    border-radius: 4px;
    background: #fff;
    scrollbar-width: thin;
  }

  &__picker-empty {
    margin: 0;
    padding: 10px 12px;
    color: #9ca3af;
    font-family: $font-harmony;
    font-size: 13px;
  }

  &__picker-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 6px 10px;
    border: none;
    background: transparent;
    color: #1f2937;
    font-family: $font-harmony;
    font-size: 14px;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s ease;

    &:hover {
      background: rgba(252, 243, 63, 0.22);
    }
  }

  &__picker-avatar {
    flex-shrink: 0;
    width: 26px;
    height: 26px;
    overflow: hidden;
    border-radius: 50%;
    background: #e6e6e6;

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: 45% 15%;
    }
  }

  &__picker-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__picker-plus {
    flex-shrink: 0;
    color: #9ca3af;
  }

  // ---- 3. 发言模式 -------------------------------------------------------
  &__modes {
    display: flex;
    align-items: stretch;
    gap: 6px;
  }

  &__mode {
    flex: 1 1 0;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid rgba(17, 24, 39, 0.14);
    border-radius: 4px;
    background: #f7f7f7;
    color: #374151;
    font-family: inherit;
    text-align: center;
    cursor: pointer;
    transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;

    &:hover {
      border-color: rgba(17, 24, 39, 0.3);
      background: #efefef;
    }

    &.is-active {
      border-color: #d8cf00;
      background: #fcf33f;
      color: #241d00;
    }
  }

  &__mode-name {
    display: block;
    font-size: 13px;
    font-weight: 600;
  }

  &__mode-desc {
    display: block;
    margin-top: 2px;
    font-size: 11px;
    line-height: 1.35;
    opacity: 0.75;
  }

  // ---- 4. 我的身份(只读) ------------------------------------------------
  &__readonly {
    margin: 0;
    color: #1f2937;
    font-family: $font-harmony;
    font-size: 14px;
  }
}

@media (max-width: 768px) {
  .gs {
    &__modes {
      flex-direction: column;
    }
  }
}
</style>