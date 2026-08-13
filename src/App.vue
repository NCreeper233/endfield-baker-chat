<script setup lang="ts">
// =============================================================================
// 应用根组件
// -----------------------------------------------------------------------------
// 组装:背景层 + 等比缩放画布(顶部标题 + 干员卡片列表 + 聊天区 + 顶部工具栏)。
// 删除确认弹窗为独立组件(DeleteConfirmDialog),打开状态与删除动作在此持有。
// 调试模式:URL 包含 #debug 时,useDebugMode 会在左下角渲染气泡尺寸信息。
// =============================================================================
import { ref, onMounted, onBeforeUnmount } from 'vue'
import AppBackground from './components/layout/AppBackground.vue'
import DesignCanvas from './components/layout/DesignCanvas.vue'
import HeaderTop from './components/header/HeaderTop.vue'
import CharacterCardList from './components/character/CharacterCardList.vue'
import ChatArea from './components/chat/ChatArea.vue'
import DeleteConfirmDialog from './components/layout/DeleteConfirmDialog.vue'
import DataManagerDialog from './components/layout/DataManagerDialog.vue'
import ChatExportDialog from './components/layout/ChatExportDialog.vue'
import SettingsDialog from './components/layout/SettingsDialog.vue'
import { useChatStore } from './stores/chat'
import { MATERIALS } from './constants/materials'
import { useDebugMode } from './composables/useDebugMode'
import { useCustomBackground } from './composables/useCustomBackground'

const chatStore = useChatStore()

// 调试浮层(非调试模式下为空操作)
useDebugMode()

// 自定义页面背景(带 localStorage 持久化:刷新保留、不随 .baker 导出、
// 不受清空对话影响;上传成功赋值后自动落库)
const { customBg } = useCustomBackground()

/**
 * 右上角工具栏是否可见(E 键切换)
 *
 * 仅会话内生效,不持久化,刷新页面即恢复可见。
 */
const showToolbar = ref(true)

/** 是否应忽略该键盘事件(输入框 / textarea / contenteditable 内按 E 不切换) */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

/** E 键切换工具栏显隐 */
function onToolbarToggleKeydown(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== 'e') return
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (isEditableTarget(event.target)) return
  showToolbar.value = !showToolbar.value
}

onMounted(() => document.addEventListener('keydown', onToolbarToggleKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onToolbarToggleKeydown))

/** 删除确认弹窗是否展开(删除按钮 toggle) */
const confirmOpen = ref(false)

/** 数据管理弹窗是否展开(清除数据按钮 toggle) */
const dataManagerOpen = ref(false)

/** 导出聊天截图弹窗是否展开(分享按钮 toggle) */
const shareOpen = ref(false)

/** 设置弹窗是否展开(API 配置 + 提示词编辑) */
const settingsOpen = ref(false)

/** "请先选中会话"提示弹窗(新建对话时未选中任何对话触发) */
const needSelectOpen = ref(false)

/** 背景上传按钮对应的隐藏 file input */
const bgInput = ref<HTMLInputElement | null>(null)

/** 上传图片作为自定义页面背景(读为 data URL 交给 AppBackground 渲染) */
function onBgUpload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    customBg.value = typeof reader.result === 'string' ? reader.result : null
  }
  // FileReader 可能因文件损坏 / 权限问题失败,失败时打印警告,input 一并清空可重试。
  reader.onerror = () => {
    console.warn('[App] 背景图片读取失败,可能是损坏或不受支持的格式')
  }
  reader.readAsDataURL(file)
  ;(event.target as HTMLInputElement).value = ''
}

/**
 * 聊天按钮(chat09)行为:
 * - 已选中子对话 → 在选中父级卡片下追加子会话(无论是否展开)
 * - 未选中任何对话 → 弹出"请先选中会话"提示
 */
function onChatNew() {
  if (chatStore.activeSub === null) {
    needSelectOpen.value = true
    return
  }
  chatStore.createChildConversation()
}
</script>

<template>
  <AppBackground :custom-url="customBg" />
  <DesignCanvas>
    <HeaderTop />
    <CharacterCardList />
    <ChatArea @open-settings="settingsOpen = true" />
  </DesignCanvas>
  <!-- 右上角工具栏(E 键整体隐藏/显示,刷新恢复可见) -->
  <div v-show="showToolbar">
  <!-- 新建对话按钮:右上角起始位;选中子对话时在选中父级卡片下追加子会话(无论是否展开);
       未选中任何对话时弹出"请先选中会话"提示 -->
  <button
    class="edit-toggle edit-toggle--chat09"
    type="button"
    @click="onChatNew"
  >
    <img :src="MATERIALS.editBtnChat09" alt="聊天" />
  </button>
  <!-- 角色名称开关按钮(已注释停用):位于 chat09(建会话)与背景(自定义背景)之间;
       点击切换"每条带头像的气泡上方是否显示小号灰字角色名"(localStorage 持久化)。
       角色名称显示功能整体停用,按钮一并注释保留,便于日后恢复。 -->
  <!-- <button
    class="edit-toggle edit-toggle--character"
    :class="{ 'edit-toggle--active': chatStore.showCharacterNames }"
    type="button"
    :aria-pressed="chatStore.showCharacterNames"
    @click="chatStore.toggleShowCharacterNames()"
  >
    <img :src="MATERIALS.editBtnCharacter" alt="角色名" />
  </button> -->
  <!-- 背景自定义按钮:位于 chat09 按钮右侧(建会话与删除界面之间),始终可见;
       点击弹出本地图片选择,上传图片作为自定义页面背景(原游戏背景被覆盖) -->
  <button
    class="edit-toggle edit-toggle--bg"
    type="button"
    @click="bgInput?.click()"
  >
    <img :src="MATERIALS.editBtnUpgrade" alt="自定义背景" />
  </button>
  <!-- 隐藏的文件选择框(由上面按钮触发) -->
  <input
    ref="bgInput"
    type="file"
    accept="image/*"
    class="bg-file-input"
    @change="onBgUpload"
  />
  <!-- 删除对话按钮:与 chat09 按钮同列(正下方),始终可见;点击弹出确认弹窗 -->
  <button
    class="edit-toggle edit-toggle--delete"
    type="button"
    @click="confirmOpen = !confirmOpen"
  >
    <img :src="MATERIALS.editBtnDeleteIndeed" alt="删除对话" />
  </button>

  <!-- 右侧操作按钮:横向等距排列,始终可见。
       导出 → 打开数据管理弹窗(统计/导出/导入/清空/重置;原独立"清除数据"按钮
       已并入此按钮) -->
  <button class="edit-toggle edit-toggle--export" type="button" @click="dataManagerOpen = true">
    <img :src="MATERIALS.editBtnExport" alt="导出" />
  </button>
  <button class="edit-toggle edit-toggle--share" type="button" @click="shareOpen = true">
    <img :src="MATERIALS.editBtnShare" alt="分享" />
  </button>
  <!-- 设置按钮:位于按钮列最左侧(share 左侧),login_btn_setting 图标;
       点击打开 API 配置 + 提示词编辑 + 免责声明 + 关于 弹窗 -->
  <button
    class="edit-toggle edit-toggle--settings"
    type="button"
    @click="settingsOpen = true"
  >
    <img :src="MATERIALS.loginBtnSetting" alt="设置" />
  </button>
  </div>

  <!-- 删除对话确认弹窗:fixed 视口定位,1920 原始尺寸不缩放 -->
  <DeleteConfirmDialog :open="confirmOpen" @close="confirmOpen = false" />
  <!-- 数据管理弹窗:清除数据按钮触发 -->
  <DataManagerDialog :open="dataManagerOpen" @close="dataManagerOpen = false" />
  <!-- 导出聊天截图弹窗:分享按钮触发(右侧工具栏显示) -->
  <ChatExportDialog
    :open="shareOpen"
    :conversation-title="chatStore.counterpartName"
    :custom-bg-url="customBg"
    @close="shareOpen = false"
  />
  <!-- "请先选中会话"提示弹窗:新建对话时未选中任何对话触发 -->
  <Transition name="ns">
    <div v-if="needSelectOpen" class="ns" @click.self="needSelectOpen = false">
      <div class="ns__panel">
        <p class="ns__text">请先选中会话</p>
        <button class="ns__btn" type="button" @click="needSelectOpen = false">确定</button>
      </div>
    </div>
  </Transition>
  <!-- 设置弹窗:API 配置 + 系统提示词 + 角色提示词编辑 -->
  <SettingsDialog :open="settingsOpen" @close="settingsOpen = false" />
</template>

<style scoped lang="scss">
@use './styles/variables' as *;
@use './styles/mixins' as *;

// "请先选中会话"提示弹窗:复用 dialog-shell 基础面板 + 过渡
@include dialog-shell(ns, 280px, 0);

.ns {
  &__text {
    text-align: center;
    color: $color-text-primary;
    font-size: 16px;
  }

  &__btn {
    display: block;
    margin: 0 auto;
  }
}

.edit-toggle {
  position: fixed;
  right: 60px;
  // 整列按钮改到页面顶端,横向等距排布(不再纵向叠在右侧)
  top: 44px;
  z-index: 100;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  width: auto;
  height: auto;

  // 新建对话按钮:位于按钮列最右端
  &--chat09 {
    right: 60px;
  }

  // 背景自定义按钮:位于 chat09 按钮左侧(同排横向等距,75px)
  &--bg {
    right: 135px;
  }

  // 删除对话按钮:位于背景按钮左侧(同排横向等距)
  &--delete {
    right: 210px;
  }

  // 右侧操作按钮(导出/分享):横向等距排列(每个按钮间距 75px;原清除数据按钮已并入导出按钮)
  &--export {
    right: 285px;
  }

  &--share {
    right: 360px;
  }

  // 设置按钮:位于按钮列最左侧(share 左侧,同排横向等距)
  &--settings {
    right: 435px;
  }

  img {
    display: block;
    width: 25px;
    height: auto;
    opacity: 0.5;
  }

  // 唯一特效:hover 时图标染为 #999898 灰色
  &:hover img {
    filter: $icon-hover-gray-filter;
  }
}

// 背景上传用的隐藏 file input(由工具栏"自定义背景"按钮触发弹出)
.bg-file-input {
  position: fixed;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}

// ---- 移动端适配 -----------------------------------------------------------
// 桌面端 6 个工具栏按钮横向铺开占 ~460px(间距 75px、图标 25px),窄屏会溢出左侧。
// 移动端整体收紧:图标缩到 20px、间距收到 38px、起点贴近右边缘 12px,
// 让全部按钮在 ≥320px 视口下完整可见。仅调整 right / 尺寸,不改结构与桌面端布局。
@media (max-width: 600px) {
  .edit-toggle {
    right: 12px;
    top: 12px;

    img {
      width: 20px;
    }

    &--chat09 {
      right: 12px;
    }

    &--bg {
      right: 50px;
    }

    &--delete {
      right: 88px;
    }

    &--export {
      right: 126px;
    }

    &--share {
      right: 164px;
    }

    &--settings {
      right: 202px;
    }
  }
}
</style>
