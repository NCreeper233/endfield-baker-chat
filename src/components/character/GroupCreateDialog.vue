<script setup lang="ts">
// GroupCreateDialog —— 创建群聊：勾选成员（≥2 人，不设上限）+ 选择我的身份
// 只做 UI，建卡由对接方在 create 事件里完成。用列表式而非头像网格：中文名必须看得清。
// 扮演某角色时该角色自动勾选且不可取消；人数不足时禁用创建。
import { computed, ref, watch } from 'vue'
import VersionDialogShell from '../layout/VersionDialogShell.vue'
import { CHARACTERS } from '../../constants/character'
import { groupTitle, groupSelfName, GROUP_SPEAK_MODES } from '../../stores/chat'
import type { GroupSpeakMode } from '../../types/chat'

const props = defineProps<{
  /** 是否展开 */
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  /** 确认创建:成员名单(≥2) + 我的身份('admin' | 'observer' | 角色名) + 聊天形式 */
  (e: 'create', members: string[], myRole: string, speakMode: GroupSpeakMode): void
}>()

/** 已勾选的角色名(按勾选先后顺序,决定群聊名里的顿号顺序) */
const selected = ref<string[]>([])

/**
 * 我的身份
 *
 *   'admin'    → 管理员(默认;我以管理员身份参与)
 *   'observer' → 旁观(只看,不参与)
 *   其他字符串 → 扮演该角色
 */
const myRole = ref<string>('admin')

/** 聊天形式:轮流 / 智能 / 指定(默认智能模式) */
const speakMode = ref<GroupSpeakMode>('smart')

/** 提示行文案(人数不足 / 扮演冲突) */
const hint = ref('')

/** 每次打开都重置选择与身份,避免上次的残留 */
watch(
  () => props.open,
  (open) => {
    if (open) {
      selected.value = []
      myRole.value = 'admin'
      speakMode.value = 'smart'
      hint.value = ''
    }
  },
)

/** 成员数是否足够建群(≥2) */
const canCreate = computed(() => selected.value.length >= 2)

/** 群聊名预览(与创建后的实际命名同源) */
const titlePreview = computed(() =>
  canCreate.value ? groupTitle(selected.value, groupSelfName(myRole.value)) : '',
)

/** 我的身份的展示文案 */
const myRoleLabel = computed(() => {
  if (myRole.value === 'admin') return '管理员'
  if (myRole.value === 'observer') return '旁观'
  return `扮演 ${myRole.value}`
})

function isSelected(name: string): boolean {
  return selected.value.indexOf(name) !== -1
}

/** 该角色是否因"我扮演"而被锁定(不可取消勾选) */
function isLockedByRole(name: string): boolean {
  if (myRole.value === 'admin' || myRole.value === 'observer') return false
  return myRole.value === name
}

/**
 * 切换身份
 *
 * 扮演某角色时该角色自动勾选;切回管理员/旁观的只是解除锁定(勾选保留,可自行取消)。
 */
function onRoleChange(next: string): void {
  hint.value = ''
  if (!next || next === 'admin' || next === 'observer') {
    myRole.value = !next ? 'admin' : next
    return
  }
  myRole.value = next
  if (selected.value.indexOf(next) === -1) selected.value.push(next)
}

/** 勾选 / 取消勾选(不设上限;扮演中的角色不可取消) */
function toggle(name: string): void {
  hint.value = ''
  const i = selected.value.indexOf(name)
  if (i !== -1) {
    if (isLockedByRole(name)) {
      hint.value = `正在扮演「${name}」，如需取消请先切换身份`
      return
    }
    selected.value.splice(i, 1)
    return
  }
  selected.value.push(name)
}

/** 点击禁用状态的创建按钮:给出人数不足提示 */
function onDisabledCreate(): void {
  if (canCreate.value) return
  hint.value = '至少选择两个角色'
}

/** 确认创建 */
function onCreate(): void {
  if (!canCreate.value) {
    onDisabledCreate()
    return
  }
  emit('create', [...selected.value], myRole.value, speakMode.value)
  emit('close')
}
</script>

<template>
  <VersionDialogShell
    :open="props.open"
    title="创建群聊"
    kind="alert"
    @close="emit('close')"
  >
    <p class="gc__stats">已选 {{ selected.length }} 人（至少 2 人成组）</p>

    <!-- 角色列表:可勾选全部角色,不设人数上限 -->
    <div class="gc__list">
      <button
        v-for="c in CHARACTERS"
        :key="c.name"
        class="gc__item"
        :class="{ 'is-selected': isSelected(c.name) }"
        type="button"
        :aria-pressed="isSelected(c.name)"
        @click="toggle(c.name)"
      >
        <span class="gc__avatar">
          <img class="gc__avatar-img" :src="c.avatar" alt="" />
        </span>
        <span class="gc__name">{{ c.name }}</span>
        <span class="gc__lock" aria-hidden="true">{{ isLockedByRole(c.name) ? '扮演中' : '' }}</span>
        <span class="gc__check" aria-hidden="true">{{ isSelected(c.name) ? '✓' : '' }}</span>
      </button>
    </div>

    <!-- 我的身份:默认管理员;下拉里可选旁观或扮演某个角色 -->
    <div class="gc__field">
      <span class="gc__field-label">我的身份</span>
      <select
        class="gc__select"
        :value="myRole"
        @change="onRoleChange(($event.target as HTMLSelectElement).value)"
      >
        <option value="admin">管理员（我）</option>
        <option value="observer">旁观（不参与对话）</option>
        <option disabled>──────────</option>
        <option v-for="c in CHARACTERS" :key="c.name" :value="c.name">扮演 {{ c.name }}</option>
      </select>
    </div>

    <!-- 聊天形式:轮流 / 智能 / 指定(与群聊设置里同一组,随时可改) -->
    <div class="gc__field">
      <span class="gc__field-label">聊天形式</span>
      <div class="gc__modes">
        <button
          v-for="m in GROUP_SPEAK_MODES"
          :key="m.key"
          class="gc__mode"
          :class="{ 'is-active': speakMode === m.key }"
          type="button"
          :aria-pressed="speakMode === m.key"
          @click="speakMode = m.key"
        >
          <span class="gc__mode-name">{{ m.label }}</span>
          <span class="gc__mode-desc">{{ m.desc }}</span>
        </button>
      </div>
      <p v-if="speakMode === 'assign'" class="gc__tip">
        指定谁发言请到聊天区最后一条消息下方的「指定发言」里选择
      </p>
    </div>

    <!-- 群聊名预览:与创建后的命名规则同源,所见即所得 -->
    <p class="gc__preview">
      <template v-if="titlePreview">将创建：{{ titlePreview }}（我的身份：{{ myRoleLabel }}）</template>
      <template v-else>请至少选择 2 个角色</template>
    </p>

    <p v-if="hint" class="gc__hint">{{ hint }}</p>

    <template #actions>
      <button class="pn-btn pn-btn--light" type="button" @click="emit('close')">
        <span class="pn-btn__label">取消</span>
      </button>
      <button class="pn-btn" type="button" :disabled="!canCreate" @click="onCreate">
        <span class="pn-btn__tex" aria-hidden="true"></span>
        <span class="pn-btn__deco" aria-hidden="true"></span>
        <span class="pn-btn__label">创建群聊</span>
      </button>
    </template>
  </VersionDialogShell>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

// 外观与公告 / 提醒 / 更新一致（VersionDialogShell），正文是白底，
// 故这里的文字与控件统一按浅色底配色。

.gc {
  &__stats {
    margin: 0 0 10px;
    color: #6b7280;
    font-family: $font-harmony;
    font-size: 13px;
  }

  // 角色列表:限高滚动,隐藏滚动条
  &__list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 38vh;
    overflow-y: auto;
    padding-right: 4px;
    scrollbar-width: thin;

    &::-webkit-scrollbar {
      width: 6px;
    }

    &::-webkit-scrollbar-thumb {
      border-radius: 3px;
      background: rgba(0, 0, 0, 0.2);
    }
  }

  // 角色行:白底卡片 + 细边,选中换成黄底
  &__item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border: 1px solid rgba(17, 24, 39, 0.12);
    border-radius: 4px;
    background: #f7f7f7;
    color: #1f2937;
    font-family: $font-harmony;
    font-size: 14px;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.15s ease, border-color 0.15s ease;

    &:hover {
      border-color: rgba(17, 24, 39, 0.28);
      background: #efefef;
    }

    &.is-selected {
      border-color: #d8cf00;
      background: #fcf33f;
      color: #241d00;

      .gc__lock {
        opacity: 0.7;
      }
    }
  }

  &__avatar {
    flex-shrink: 0;
    width: 34px;
    height: 34px;
    overflow: hidden;
    border-radius: 3px;
    border: 1px solid rgba(17, 24, 39, 0.16);
    background: #e6e6e6;
  }

  &__avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    // 与主卡头像同口径:角色立绘为竖幅,取上端方形区域
    object-position: 45% 15%;
  }

  &__name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__lock {
    flex-shrink: 0;
    color: #8a6d00;
    font-size: 11px;
    opacity: 0.85;
  }

  &__check {
    flex-shrink: 0;
    width: 18px;
    color: #1f2937;
    font-size: 15px;
    font-weight: 700;
    text-align: center;
  }

  // ---- 表单区 ------------------------------------------------------------
  &__field {
    margin: 14px 0 0;
    padding-top: 12px;
    border-top: 1px solid rgba(17, 24, 39, 0.1);
  }

  &__field-label {
    display: block;
    margin-bottom: 8px;
    color: #4b5563;
    font-size: 13px;
  }

  // 下拉:浅灰底 + 细边,与白底正文协调
  &__select {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid rgba(17, 24, 39, 0.18);
    border-radius: 4px;
    background: #f2f2f2;
    color: #1f2937;
    font-family: inherit;
    font-size: 13.5px;
    cursor: pointer;

    &:focus {
      outline: none;
      border-color: #d8cf00;
      box-shadow: 0 0 0 2px rgba(252, 243, 63, 0.5);
    }
  }

  // ---- 聊天形式 ----------------------------------------------------------
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

  &__tip {
    margin: 8px 0 0;
    color: #6b7280;
    font-size: 11px;
    line-height: 1.5;
  }

  &__preview {
    margin: 14px 0 0;
    color: #4b5563;
    font-size: 13px;
    line-height: 1.5;
    // 长群名允许换行,不撑破面板
    word-break: break-all;
  }

  // 提示行(黄色强调)
  &__hint {
    margin: 8px 0 0;
    color: #8a6d00;
    font-size: 13px;
  }
}

@media (max-width: 768px) {
  .gc {
    &__list {
      max-height: 34vh;
    }

    &__modes {
      flex-direction: column;
    }
  }
}
</style>