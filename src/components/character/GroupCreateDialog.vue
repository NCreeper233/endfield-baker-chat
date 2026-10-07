<script setup lang="ts">
// =============================================================================
// 创建群聊弹窗(GroupCreateDialog) —— 第三版群聊
// -----------------------------------------------------------------------------
// 职责:从内置干员中勾选成员(至少 2 人,不设上限),并选择"我的身份",
//       确认后把成员名单 + 身份上抛。
//
// 只做 UI:真正的建卡由对接方在 create 事件里实现
//        (本项目由 stores/chat.ts 的 createGroupCard() 承担)。
//
// 形态选择:列表式(头像 + 名字 + 勾选)而非纯头像网格 ——
// 33 个角色里有大量同姓/近形名,中文名必须看得清。
//
// 规则:
//   - 至少 2 人成组;不设人数上限(可勾选全部角色)
//   - 我的身份默认「管理员」,可切为「旁观」或「扮演某个角色」
//   - 扮演某角色时该角色自动勾选且不可取消,直到切换身份
//   - 人数不足时创建按钮禁用,点击给出「至少选择两个角色」提示
// =============================================================================
import { computed, ref, watch } from 'vue'
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
  <Transition name="gc">
    <div v-if="props.open" class="gc" @click.self="emit('close')">
      <div class="gc__panel">
        <button class="gc__close" type="button" aria-label="关闭" @click="emit('close')">×</button>
        <h2 class="gc__title">创建群聊</h2>
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
        <div class="gc__role">
          <span class="gc__role-label">我的身份</span>
          <select
            class="gc__role-select"
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
        <div class="gc__mode">
          <span class="gc__mode-label">聊天形式</span>
          <div class="gc__modes">
            <button
              v-for="m in GROUP_SPEAK_MODES"
              :key="m.key"
              class="gc__mode-btn"
              :class="{ 'is-active': speakMode === m.key }"
              type="button"
              :aria-pressed="speakMode === m.key"
              @click="speakMode = m.key"
            >
              <span class="gc__mode-name">{{ m.label }}</span>
              <span class="gc__mode-desc">{{ m.desc }}</span>
            </button>
          </div>
          <p v-if="speakMode === 'assign'" class="gc__mode-tip">
            指定谁发言请到聊天区最后一条消息下方的「指定发言」里选择
          </p>
        </div>

        <!-- 群聊名预览:与创建后的命名规则同源,所见即所得 -->
        <p class="gc__preview">
          <template v-if="titlePreview">将创建：{{ titlePreview }}（我的身份：{{ myRoleLabel }}）</template>
          <template v-else>请至少选择 2 个角色</template>
        </p>

        <!-- 提示行 -->
        <p v-if="hint" class="gc__hint">{{ hint }}</p>

        <div class="gc__actions" @click="onDisabledCreate">
          <button
            class="gc__btn gc__btn--primary"
            type="button"
            :disabled="!canCreate"
            @click.stop="onCreate"
          >创建群聊</button>
          <button class="gc__btn" type="button" @click.stop="emit('close')">取消</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 遮罩 + 居中深色面板(与设置/数据管理/删除确认同一套外壳)
@include dialog-shell(gc, 520px, 6px);

// 聊天形式三选一:与「群聊设置」弹窗的发言模式同一份样式(含纯黄底选中态)
@include speak-mode-options('gc__modes', 'gc__mode-btn', 'gc__mode-name', 'gc__mode-desc');

.gc {
  &__stats {
    margin: 0 0 10px;
    font-family: $font-harmony;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.55);
  }

  // 角色列表:限高滚动,隐藏滚动条
  &__list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 44vh;
    overflow-y: auto;
    padding-right: 4px;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  &__item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 10px;
    border: none;
    background: transparent;
    color: $color-subcard-text;
    font-family: $font-harmony;
    font-size: 15px;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;

    &:hover {
      background: $color-hover-overlay;
    }

    &.is-selected {
      background: $color-subcard-selected;
      color: $color-subcard-text-selected;
    }
  }

  &__avatar {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    border-radius: 4px;
    border: 1px solid $color-avatar-border;
    overflow: hidden;
    background: $color-subcard-bg;
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

  // "扮演中"标记
  &__lock {
    flex-shrink: 0;
    font-size: 11px;
    opacity: 0.75;
  }

  &__check {
    flex-shrink: 0;
    width: 18px;
    font-size: 16px;
    font-weight: 600;
    text-align: center;
  }

  // ---- 我的身份 ----------------------------------------------------------
  &__role {
    margin: 12px 0 0;
    padding-top: 10px;
    border-top: 1px solid rgba(134, 134, 133, 0.35);
  }

  &__role-label {
    display: block;
    margin-bottom: 8px;
    font-family: $font-harmony;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.55);
  }

  &__role-select {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid $color-dialog-border;
    background: rgba(0, 0, 0, 0.3);
    color: $color-subcard-text;
    font-family: $font-harmony;
    font-size: 13px;
    cursor: pointer;
  }

  // ---- 聊天形式 ----------------------------------------------------------
  &__mode {
    margin: 12px 0 0;
    padding-top: 10px;
    border-top: 1px solid rgba(134, 134, 133, 0.35);
  }

  // 三个选项的样式与「群聊设置」弹窗的发言模式**完全同源**
  // (见 styles/_mixins 的 speak-mode-options):横排等距、选中纯黄底 + 黑字。
  &__mode-label {
    display: block;
    margin-bottom: 8px;
    font-family: $font-harmony;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.55);
  }

  &__mode-tip {
    margin: 8px 0 0;
    font-family: $font-harmony;
    font-size: 11px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.4);
  }

  &__preview {
    margin: 12px 0 0;
    font-family: $font-harmony;
    font-size: 13px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.55);
    // 长群名允许换行,不撑破面板
    word-break: break-all;
  }

  // 提示行(黄字,与强调色一致)
  &__hint {
    margin: 8px 0 0;
    font-family: $font-harmony;
    font-size: 13px;
    color: $color-subcard-selected;
  }

  &__actions {
    display: flex;
    gap: 12px;
    margin-top: 14px;
  }
}
</style>
