<script setup lang="ts">
// =============================================================================
// 群聊设置弹窗(GroupSettingsDialog) —— 第三版群聊
// -----------------------------------------------------------------------------
// 入口:桌面端鼠标悬停群聊列表 → 每条右上角出现「⋯」;移动端选中该群聊后出现。
//       点击「⋯」打开本弹窗。
//
// 包含五块内容(对应需求):
//   1. 群聊名称   —— 显示 + 可编辑,保存进本地 JSON
//   2. 群聊成员   —— 头像 + 名字,可增删;正在扮演的角色不可移除;限 2~5 人
//   3. 发言模式   —— 轮流 / 智能 / 指定,点击立即生效并落盘
//   4. 我的身份   —— 只读展示
//   5. 删除群聊   —— 二次确认后删除卡片、清理本地数据、切走当前会话
//
// 纯前端:所有改动都写入 chatStore 的 cards,由 useChatPersistence 的 watch
//         自动序列化到本地 JSON(web 端 IndexedDB / 打包端原生文件)。
// =============================================================================
import { computed, ref, watch } from 'vue'
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
  <Transition name="gs">
    <div v-if="props.open" class="gs" @click.self="onClose">
      <div class="gs__panel">
        <button class="gs__close" type="button" aria-label="关闭" @click="onClose">×</button>
        <h2 class="gs__title">群聊设置</h2>

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
            <p class="gs__hint-text">留空则自动按成员生成</p>
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
                <span class="gs__mode-label">{{ m.label }}</span>
                <span class="gs__mode-desc">{{ m.desc }}</span>
              </button>
            </div>

            <!-- 指定模式下"指定谁发言"的入口不在这里:
                 它和旁观模式的「开启/暂停对话」统一放在聊天区最后一条消息
                 下方的小方框里(见 components/chat/GroupFlowControl.vue),
                 跟随消息滚动、点一下就改。 -->
            <p v-if="speakMode === 'assign'" class="gs__hint-text">
              指定谁发言请到聊天区最后一条消息下方的「指定发言」里选择
            </p>
          </section>

          <!-- ═══ 4. 我的身份(只读) ═══ -->
          <section class="gs__field">
            <span class="gs__label">我的身份</span>
            <p class="gs__readonly">{{ info.myRoleLabel }}</p>
          </section>

          <!-- 操作提示 -->
          <p v-if="hint" class="gs__hint">{{ hint }}</p>

          <!-- ═══ 5. 删除群聊 ═══
               已移除:删除入口收敛到角色列表上方操作带的那个删除按钮
               (DeleteConfirmDialog 在群聊模式下会显示「删除群聊」),
               这里不再放第二个入口。 -->

          <div class="gs__actions">
            <button class="gs__btn gs__btn--primary" type="button" @click="onClose">完成</button>
          </div>
        </template>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 遮罩 + 居中深色面板(与创建群聊/设置/数据管理同一套外壳)
@include dialog-shell(gs, 560px, 6px);

// 发言模式按钮组:与「创建群聊」弹窗同一份样式(含选中态),只是类名不同
@include speak-mode-options('gs__modes', 'gs__mode', 'gs__mode-label', 'gs__mode-desc');

.gs {
  &__empty {
    margin: 12px 0 0;
    font-family: $font-harmony;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.55);
  }

  // 面板限高滚动:五块内容在窄屏 / 移动端也能完整查看
  &__panel {
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  // ---- 通用字段 ----------------------------------------------------------
  &__field {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid rgba(134, 134, 133, 0.35);

    &--danger {
      margin-top: 18px;
    }
  }

  &__label {
    display: block;
    margin-bottom: 8px;
    font-family: $font-harmony;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.55);
  }

  &__hint-text {
    margin: 6px 0 0;
    font-family: $font-harmony;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.35);
  }

  &__hint {
    margin: 12px 0 0;
    font-family: $font-harmony;
    font-size: 13px;
    color: $color-subcard-selected;
  }

  // ---- 1. 群聊名称 -------------------------------------------------------
  &__input {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid $color-dialog-border;
    border-radius: 0;
    background: rgba(0, 0, 0, 0.3);
    color: $color-subcard-text;
    font-family: $font-harmony;
    font-size: 14px;
    box-sizing: border-box;

    &::placeholder {
      color: rgba(255, 255, 255, 0.3);
    }

    &:focus {
      outline: none;
      border-color: $color-subcard-selected;
    }
  }

  // ---- 2. 群聊成员 -------------------------------------------------------
  &__members {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  &__member {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 8px 4px 4px;
    background: rgba(255, 255, 255, 0.04);
  }

  &__member-avatar {
    flex-shrink: 0;
    width: 34px;
    height: 34px;
    border: 1px solid $color-avatar-border;
    border-radius: 50%;
    overflow: hidden;
    background: $color-subcard-bg;

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
    font-family: $font-harmony;
    font-size: 14px;
    color: $color-subcard-text;
  }

  // "扮演中"标记(该成员不可移除)
  &__member-lock {
    flex-shrink: 0;
    font-family: $font-harmony;
    font-size: 11px;
    color: $color-subcard-selected;
    opacity: 0.85;
  }

  &__member-del {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: rgba(255, 255, 255, 0.45);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;

    &:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.12);
      color: $color-text-primary;
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
    margin-top: 4px;
    padding: 6px 8px;
    border: 1px dashed rgba(134, 134, 133, 0.55);
    background: transparent;
    color: rgba(255, 255, 255, 0.55);
    font-family: $font-harmony;
    font-size: 14px;
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease;

    &:hover,
    &.is-open {
      border-color: $color-subcard-selected;
      color: $color-subcard-selected;
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
    border: 1px solid rgba(134, 134, 133, 0.35);
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  &__picker-empty {
    margin: 0;
    padding: 10px 12px;
    font-family: $font-harmony;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.4);
  }

  &__picker-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 5px 10px;
    border: none;
    background: transparent;
    color: $color-subcard-text;
    font-family: $font-harmony;
    font-size: 14px;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s ease;

    &:hover {
      background: $color-hover-overlay;
    }
  }

  &__picker-avatar {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    overflow: hidden;
    background: $color-subcard-bg;

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
    color: rgba(255, 255, 255, 0.45);
  }

  // ---- 3. 发言模式 -------------------------------------------------------
  // 按钮组样式与「创建群聊」弹窗共用(见 styles/_mixins 的 speak-mode-options)
  // 传的是本组件的类名,所以两边外观必然一致,不会各改各的。

  // ---- 4. 我的身份(只读) ------------------------------------------------
  &__readonly {
    margin: 0;
    font-family: $font-harmony;
    font-size: 14px;
    color: $color-subcard-text;
  }

  // ---- 5. 删除群聊 -------------------------------------------------------
  // 样式随删除入口一并移除(见模板注释):删除改由操作带的删除按钮承担。

  // ---- 底部动作 ----------------------------------------------------------
  &__actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 18px;
  }

  &__btn {
    padding: 8px 22px;
    border: 1px solid $color-dialog-border;
    background: transparent;
    color: $color-subcard-text;
    font-family: $font-harmony;
    font-size: 14px;
    cursor: pointer;
    transition: background 0.15s ease;

    &:hover {
      background: $color-hover-overlay;
    }

    &--primary {
      border-color: $color-subcard-selected;
      background: $color-subcard-selected;
      color: $color-subcard-text-selected;

      &:hover {
        filter: brightness(0.92);
        background: $color-subcard-selected;
      }
    }

    &--danger {
      border-color: #d75a5a;
      background: #d75a5a;
      color: #fff;

      &:hover {
        filter: brightness(0.92);
        background: #d75a5a;
      }
    }
  }
}
</style>
