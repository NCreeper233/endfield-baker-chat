<script setup lang="ts">
// =============================================================================
// AI 聊天输入框(ChatInput)
// -----------------------------------------------------------------------------
// 复用底部面板的视觉风格(PanelShell + 胶囊输入框 + 圆形按钮),
// 连接 AI 聊天流程(useAiChat):
//   - contenteditable 输入框(回车发送,Ctrl/Shift+Enter 换行)
//   - 图片按钮:上传图片并直接发送(等比缩放到 CHAT_IMAGE 上限)
//   - 表情按钮:弹出表情网格,点击在光标处插入表情
//   - 发送按钮(AI 响应中变为停止按钮)
//   - API 未配置时上抛 open-settings 事件
// =============================================================================
import { ref, computed, inject, onMounted, onBeforeUnmount, toValue } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../../stores/chat'
import { useAiChat } from '../../composables/useAiChat'
import { useSettingsStore } from '../../stores/settings'
import { MATERIALS } from '../../constants/materials'
import {
  chatGeometryKey,
  globalChatGeometry,
  DESKTOP_GEOM,
  type ChatGeometry,
} from '../../constants/chatGeometry'
import { CHAT_IMAGE } from '../../constants/design'
import { EMOJIS, emojiImgHtml, htmlToEmojiText } from '../../constants/emoji'
import type { Emoji } from '../../constants/emoji'
import PanelTopMask from './PanelTopMask.vue'
import PanelShell from './PanelShell.vue'

const chatStore = useChatStore()
const { isAiResponding } = storeToRefs(chatStore)
const { sendAndWaitForAi, respondAfterImage, abort } = useAiChat()
const settingsStore = useSettingsStore()

const emit = defineEmits<{
  (e: 'open-settings'): void
}>()

/** 注入几何(面板位置/尺寸;默认全局,导出模式由 ChatExportStage 覆盖)。
 * 注意:inject 必须在 setup 期间立即调用(见 ChatArea 同款注释)。 */
const injectedGeom = inject(chatGeometryKey, globalChatGeometry) ?? DESKTOP_GEOM
const geom = computed<ChatGeometry>(() => toValue(injectedGeom))

/** 是否移动端输入(几何层 stripSegmented 仅移动端为 true):移动端用原生 textarea
 * 替代 contenteditable——夸克等魔改内核浏览器对 contenteditable 的焦点支持差,
 * 会导致键盘弹出后闪退;textarea 为原生控件,焦点稳定。 */
const isMobileInput = computed(() => geom.value.stripSegmented)

/** 面板高度(px,几何层:桌面 80 / 移动端 56) */
const PANEL_H = computed(() => geom.value.panelHeight)

/** 面板顶 = 几何层面板顶(桌面 = detail 底边 - 面板高 - 3px) */
const panelTop = computed(() => geom.value.panelTop)

/** contenteditable 输入框 DOM ref(桌面端) */
const inputEl = ref<HTMLDivElement | null>(null)

/** textarea 输入框 DOM ref(移动端) */
const mobileInputEl = ref<HTMLTextAreaElement | null>(null)

/** 移动端输入文本(v-model) */
const mobileText = ref('')

/** 隐藏的图片文件选择框(上传图片按钮触发) */
const fileInput = ref<HTMLInputElement | null>(null)

/** 是否正在等待 AI 响应 */
const isResponding = computed(() => isAiResponding.value)

/** 表情弹窗是否展开 */
const showEmojiPop = ref(false)

// ---- 表情弹窗网格(桌面 16 列 60px 格;窄屏 8 列 40px 格) --------------------
/** 是否窄屏弹窗(移动端聊天区面板宽 ≤ 600px) */
const isNarrowPop = computed(() => geom.value.panelWidth <= 600)

/** 每行表情数 */
const POP_COLS = computed(() => (isNarrowPop.value ? 8 : 16))
/** 单格边长(px) */
const POP_CELL = computed(() => (isNarrowPop.value ? 40 : 60))
/** 格间距(px) */
const POP_GAP = computed(() => (isNarrowPop.value ? 12 : 16))
/** 弹窗上下内边距(px) */
const POP_PAD = 24
/** 行数(38 个表情) */
const POP_ROWS = computed(() => Math.ceil(EMOJIS.length / POP_COLS.value))

/**
 * 表情弹窗高度(px):上下边距 + 行×格高 + 行距(不出现滚动条)
 */
const POP_H_EMOTICON = computed(
  () => POP_PAD * 2 + POP_ROWS.value * POP_CELL.value + (POP_ROWS.value - 1) * POP_GAP.value,
)

/** 表情弹窗样式:紧贴面板顶边向上延伸,与面板同宽 */
const emojiPopStyle = computed(() => ({
  left: '0px',
  top: `-${POP_H_EMOTICON.value}px`,
  width: `${geom.value.panelWidth}px`,
  height: `${POP_H_EMOTICON.value}px`,
}))

/** 表情网格样式(列数/格宽/间距随宽度变化,inline 覆盖 scoped CSS 默认值) */
const emojiGridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${POP_COLS.value}, ${POP_CELL.value}px)`,
  columnGap: `${POP_GAP.value}px`,
  rowGap: `${POP_GAP.value}px`,
}))

/** 序列化输入框内容为纯文本(表情 <img> → [sns_emoji_xxx] token;桌面 contenteditable) */
function serializeInput(): string {
  if (!inputEl.value) return ''
  return htmlToEmojiText(inputEl.value.innerHTML)
}

/** 清空输入框(桌面清 innerHTML / 移动端清 v-model) */
function clearInput() {
  if (isMobileInput.value) {
    mobileText.value = ''
  } else if (inputEl.value) {
    inputEl.value.innerHTML = ''
  }
}

/** 发送消息 */
async function onSend() {
  const text = isMobileInput.value ? mobileText.value.trim() : serializeInput().trim()
  if (!text || isResponding.value) return

  // 检查 API 配置
  if (!settingsStore.isApiConfigured) {
    emit('open-settings')
    return
  }

  clearInput()

  try {
    await sendAndWaitForAi(text)
  } catch {
    // 错误已在 useAiChat 中处理
  }
}

/** 中止 AI 响应 */
function onAbort() {
  abort()
}

/**
 * 选择图片后:读取为 dataURL,按自然尺寸等比计算显示尺寸(不超过 CHAT_IMAGE 上限,
 * 小图不放大),作为图片消息发送并触发 AI 回复。
 *
 * AI 响应中或 API 未配置时不发送图片。读取完成后重置 input.value,
 * 允许连续选择同一文件。
 */
function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  // AI 响应中不发送
  if (isResponding.value) {
    input.value = ''
    return
  }

  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = reader.result
    if (typeof dataUrl !== 'string') return
    const img = new Image()
    img.onload = async () => {
      const nw = img.naturalWidth || CHAT_IMAGE.w
      const nh = img.naturalHeight || CHAT_IMAGE.h
      if (nw <= CHAT_IMAGE.w && nh <= CHAT_IMAGE.h) {
        chatStore.sendImage(dataUrl, nw, nh)
      } else {
        const scale = Math.min(CHAT_IMAGE.w / nw, CHAT_IMAGE.h / nh)
        chatStore.sendImage(dataUrl, Math.round(nw * scale), Math.round(nh * scale))
      }
      input.value = ''

      // 检查 API 配置,触发 AI 回复
      if (!settingsStore.isApiConfigured) {
        emit('open-settings')
        return
      }
      try {
        await respondAfterImage()
      } catch {
        // 错误已在 useAiChat 中处理
      }
    }
    img.onerror = () => {
      console.warn('[ChatInput] 图片解码失败,可能是损坏或不受支持的格式')
      input.value = ''
    }
    img.src = dataUrl
  }
  reader.readAsDataURL(file)
}

/** 触发文件选择(图片按钮点击) */
function openFilePicker() {
  fileInput.value?.click()
}

/**
 * 点击表情:聚焦输入框并在光标处插入表情(紧跟在文字后面)
 *
 * 表情输出内联 em 尺寸(高度 1em、宽度按原图宽高比),随输入框字号
 * 自动缩放且保持真实比例。
 *
 * 桌面(contenteditable):用 Range API 插入表情
 *   - 有选区且在输入框内:删除选区内容 → 插入表情片段 → 光标移到表情后
 *   - 无选区或选区不在输入框内:追加到输入框末尾
 * 移动端(textarea):在光标处插入表情 token(表情在发送时显示为图片)
 */
function insertEmoji(emoji: Emoji) {
  if (isMobileInput.value) {
    const el = mobileInputEl.value
    if (!el) return
    el.focus()
    const token = emoji.token
    const start = el.selectionStart ?? mobileText.value.length
    const end = el.selectionEnd ?? start
    mobileText.value =
      mobileText.value.slice(0, start) + token + mobileText.value.slice(end)
    // 光标移到插入内容之后
    requestAnimationFrame(() => {
      const pos = start + token.length
      el.setSelectionRange(pos, pos)
    })
    return
  }

  const el = inputEl.value
  if (!el) return
  el.focus()
  const imgHtml = emojiImgHtml(emoji.token, emoji.src)
  const sel = window.getSelection()
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0)
    range.deleteContents()
    const tmp = document.createElement('div')
    tmp.innerHTML = imgHtml
    const frag = document.createDocumentFragment()
    while (tmp.firstChild) frag.appendChild(tmp.firstChild)
    range.insertNode(frag)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  } else {
    el.insertAdjacentHTML('beforeend', imgHtml)
  }
}

/** 切换表情弹窗展开/收起 */
function toggleEmojiPop() {
  showEmojiPop.value = !showEmojiPop.value
}

/**
 * 点击面板外部关闭表情弹窗
 *
 * 规则:表情弹窗展开时,点击除弹窗与表情触发按钮以外的任意位置即收起。
 * 用 pointerdown(先于 click 触发):点到外面任意元素时,弹窗先收起,
 * 按钮自身的 click 动作照常执行。
 */
function onDocPointerDown(event: PointerEvent) {
  const target = event.target as Node
  if (!(target instanceof Element)) return
  if (
    target.closest('.chat-input__pop') ||
    target.closest('.is-emoji-trigger')
  ) {
    return
  }
  if (showEmojiPop.value) {
    showEmojiPop.value = false
  }
}

onMounted(() => document.addEventListener('pointerdown', onDocPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown))

/**
 * 键盘事件:
 * - Enter(无修饰键):发送
 * - Ctrl/Cmd/Shift + Enter:插入换行(移动端 textarea 原生支持 Shift+Enter)
 */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter') return
  event.preventDefault()
  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    if (isMobileInput.value) {
      // textarea:原生插入换行
      const el = mobileInputEl.value
      if (!el) return
      const start = el.selectionStart ?? mobileText.value.length
      const end = el.selectionEnd ?? start
      mobileText.value =
        mobileText.value.slice(0, start) + '\n' + mobileText.value.slice(end)
      requestAnimationFrame(() => {
        const pos = start + 1
        el.setSelectionRange(pos, pos)
      })
    } else {
      document.execCommand('insertText', false, '\n')
    }
  } else {
    onSend()
  }
}

/** 粘贴:仅插入纯文本(移动端 textarea 原生纯文本粘贴,无需处理) */
function onPaste(event: ClipboardEvent) {
  if (isMobileInput.value) return
  event.preventDefault()
  const text = event.clipboardData?.getData('text/plain') ?? ''
  document.execCommand('insertText', false, text)
}
</script>

<template>
  <PanelTopMask :top="panelTop" />
  <PanelShell :height="PANEL_H" :top="panelTop" class="chat-input">    <!-- 隐藏的图片文件选择框 -->
    <input
      ref="fileInput"
      class="chat-input__file"
      type="file"
      accept="image/*"
      @change="onFileChange"
    />

    <!-- 胶囊输入框:移动端原生 textarea(夸克等对 contenteditable 焦点支持差) /
         桌面端 contenteditable(支持表情富文本) -->
    <textarea
      v-if="isMobileInput"
      ref="mobileInputEl"
      v-model="mobileText"
      class="chat-input__field chat-input__field--mobile"
      rows="1"
      aria-label="发消息输入框"
      placeholder="发消息"
      :disabled="isResponding"
      @keydown="onKeydown"
    ></textarea>
    <div
      v-else
      ref="inputEl"
      class="chat-input__field"
      :contenteditable="!isResponding"
      role="textbox"
      aria-label="发消息输入框"
      data-placeholder="发消息"
      @keydown="onKeydown"
      @paste="onPaste"
    ></div>

    <!-- 按钮组 -->
    <div class="chat-input__btns">
      <!-- 图片按钮:上传图片并发送 -->
      <button
        class="chat-input__btn"
        type="button"
        aria-label="上传图片"
        :disabled="isResponding"
        @click="openFilePicker"
      >
        <img class="chat-input__btn__icon" :src="MATERIALS.editBtnPotential" alt="" />
      </button>
      <!-- 表情按钮:弹出表情选择网格 -->
      <button
        class="chat-input__btn is-emoji-trigger"
        type="button"
        aria-label="表情"
        :disabled="isResponding"
        @click="toggleEmojiPop"
      >
        <img class="chat-input__btn__icon" :src="MATERIALS.editBtnEmoticon" alt="" />
      </button>
      <!-- AI 响应中:显示停止按钮 -->
      <button
        v-if="isResponding"
        class="chat-input__btn chat-input__btn--stop"
        type="button"
        aria-label="停止"
        @click="onAbort"
      >
        <span class="chat-input__stop-icon"></span>
      </button>
      <!-- 正常状态:显示发送按钮 -->
      <button
        v-else
        class="chat-input__btn"
        type="button"
        aria-label="发送"
        @click="onSend"
      >
        <img class="chat-input__btn__icon" :src="MATERIALS.editBtnChat" alt="" />
      </button>
    </div>

    <!-- 表情弹窗:紧贴面板顶边从下到上展开,与面板同宽 -->
    <Transition name="chat-input-pop">
      <div v-if="showEmojiPop" class="chat-input__pop" :style="emojiPopStyle">
        <!-- 背景装饰:左上角 + 右下角 -->
        <img class="chat-input__pop-bg chat-input__pop-bg--tl" :src="MATERIALS.editPopDecoTl" alt="" />
        <img class="chat-input__pop-bg chat-input__pop-bg--br" :src="MATERIALS.editPopDecoBr" alt="" />
        <!-- 表情选择网格:点击在输入框光标处插入(列数/格宽由 emojiGridStyle 响应式注入) -->
        <div class="chat-input__emoji-grid" :style="emojiGridStyle">
          <button
            v-for="e in EMOJIS"
            :key="e.token"
            class="chat-input__emoji-cell"
            type="button"
            @click="insertEmoji(e)"
          >
            <img class="chat-input__emoji-img" :src="e.src" alt="" />
          </button>
        </div>
      </div>
    </Transition>
  </PanelShell>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

.chat-input {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 24px;
  box-sizing: border-box;
  pointer-events: none;

  // 移动端窄屏:左右 padding 与按钮间距收窄
  @media (max-width: 768px) {
    padding: 0 12px;
    gap: 10px;
  }

  // 隐藏的图片选择框
  &__file {
    display: none;
  }

  // 胶囊输入框样式
  &__field {
    flex: 1;
    min-width: 0;
    height: 45px;
    line-height: 1.4;
    white-space: pre-wrap;
    overflow-x: hidden;
    overflow-y: auto;
    border: none;
    border-radius: 999px;
    background: $color-btn-bg;
    color: #2a2a2a;
    font-family: $font-bubble;
    font-size: 20.88px;
    padding: 8px 24px;
    box-sizing: border-box;
    outline: none;
    user-select: text;
    word-break: break-word;
    scrollbar-width: none;
    pointer-events: auto;

    &:empty::before {
      content: attr(data-placeholder);
      color: rgba(42, 42, 42, 0.5);
      pointer-events: none;
      user-select: none;
    }

    &[contenteditable="false"] {
      opacity: 0.5;
      pointer-events: none;
    }

    // 移动端 textarea 形态:textarea 无 :empty 伪类,用原生 placeholder;
    // 去掉默认外观/缩放,垂直居中微调,支持多行滚动
    &--mobile {
      display: block;
      resize: none;
      overflow-y: auto;
      padding-top: 11px;
      padding-bottom: 9px;
      appearance: none;
      -webkit-appearance: none;

      &::placeholder {
        color: rgba(42, 42, 42, 0.5);
      }

      &:disabled {
        opacity: 0.5;
        pointer-events: none;
      }
    }
  }

  // 按钮组
  &__btns {
    display: flex;
    align-items: center;
    gap: 16px;
    pointer-events: none;
  }

  // 圆形按钮:45px 圆形
  &__btn {
    width: 45px;
    height: 45px;
    border: none;
    border-radius: 50%;
    background: $color-btn-bg;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
    position: relative;
    pointer-events: auto;

    &::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 50%;
      background: $color-hover-overlay-gray;
      opacity: 0;
      transition: opacity 0.15s ease;
    }

    &:hover::after {
      opacity: 1;
    }

    &:disabled {
      opacity: 0.5;
      pointer-events: none;
      cursor: default;
    }

    // 图标:等比铺满按钮(留 8px 边距)
    &__icon {
      position: absolute;
      inset: 8px;
      width: calc(100% - 16px);
      height: calc(100% - 16px);
      object-fit: contain;
      filter: brightness(0.267);
      pointer-events: none;
      user-select: none;
    }

    // 停止按钮:深色圆形 + 白色方形停止图标
    &--stop {
      background: #c44;

      &::after {
        background: rgba(0, 0, 0, 0.15);
      }
    }
  }

  // 停止图标:白色小方形
  &__stop-icon {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 14px;
    height: 14px;
    background: #fff;
    border-radius: 2px;
  }

  // 表情弹窗:紧贴面板顶边向上延伸,与面板同宽(圆角矩形,底部直角贴合面板)
  &__pop {
    position: absolute;
    background: #dedcdc;
    border-radius: 16px 16px 0 0;
    z-index: 11;
    overflow: hidden;

    // 背景装饰图:原始尺寸原样贴角,不拉伸不铺满
    &-bg {
      position: absolute;
      pointer-events: none;
      user-select: none;

      &--tl {
        left: 0;
        top: 0;
      }

      &--br {
        right: 0;
        bottom: 0;
      }
    }
  }

  // 表情选择网格:每行 16 个 60px 格,超出面板高度时可滚动
  &__emoji-grid {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 24px;
    box-sizing: border-box;
    display: grid;
    grid-template-columns: repeat(16, 60px);
    justify-content: center;
    column-gap: 12px;
    row-gap: 16px;
    align-content: start;
    scrollbar-width: thin;
    scrollbar-color: $color-scrollbar-chat transparent;
    pointer-events: auto;
  }

  // 单个表情:60px 方格,原图等比铺满;点击在输入框光标处插入
  &__emoji-cell {
    width: 60px;
    height: 60px;
    border: none;
    border-radius: 8px;
    padding: 0;
    cursor: pointer;
    background: transparent;
    position: relative;

    &::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 8px;
      background: $color-hover-overlay;
      opacity: 0;
      transition: opacity 0.15s ease;
    }

    &:hover::after {
      opacity: 1;
    }
  }

  &__emoji-img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }

  // 表情弹窗过渡:从下到上展开 / 从上到下收起
  .chat-input-pop-enter-active,
  .chat-input-pop-leave-active {
    transition: transform 0.3s ease-out, opacity 0.3s ease-out;
    transform-origin: bottom center;
  }

  .chat-input-pop-enter-from,
  .chat-input-pop-leave-to {
    transform: scaleY(0);
    opacity: 0;
  }
}
</style>
