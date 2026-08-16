<script setup lang="ts">
// =============================================================================
// DebugOverlay:移动端屏幕诊断浮层(临时调试用,修复完成后删除)
// -----------------------------------------------------------------------------
// 目的:移动端软键盘故障(聊天区内容消失/键盘闪退)在真机上的表现无法从
// 桌面复现,需要用户侧直接反馈关键状态。此浮层在 ≤768px 视口显示:
//   - 版本标识:确认用户加载的是最新构建(看不到浮层 = 旧缓存/旧部署)
//   - 实时快照:innerWidth/innerHeight、visualViewport.height/offsetTop、
//     .chat-scroll 的 getBoundingClientRect、.m-chat 是否存在
//   - 事件日志:focusin/focusout/resize/vv.resize/vv.scroll/visibilitychange,
//     每条带时间戳与当时的快照 —— 故障瞬间发生了什么一目了然
// 点击顶栏切换展开/收起。
// =============================================================================
import { onMounted, onBeforeUnmount, ref } from 'vue'

/** 诊断版本标识(每次修改后递增,用户以此确认加载的是最新构建) */
const DIAG_VERSION = 'DIAG-20260816-1'

const expanded = ref(true)
const logs = ref<{ t: string; ev: string; info: string }[]>([])
const now = ref('')
/** 仅移动端视口显示(≤768px) */
const showOverlay = ref(typeof window !== 'undefined' && window.innerWidth <= 768)
/** 复制按钮反馈态("已复制" 1.5s) */
const copied = ref(false)

/** 记录一条事件日志(最多 30 条,最新的在最上) */
function log(ev: string, info = '') {
  const d = new Date()
  const t =
    d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0')
  logs.value.unshift({ t, ev, info })
  if (logs.value.length > 30) logs.value.pop()
}

/** 当前状态快照(渲染时实时调用) */
function snap(): string {
  const vv = window.visualViewport
  const el = document.querySelector('.m-chat .chat-scroll')
  let rect = '-'
  if (el) {
    const r = el.getBoundingClientRect()
    rect = `L${Math.round(r.left)} T${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`
  }
  const chat = document.querySelector('.m-chat')
  return `iW${window.innerWidth} iH${window.innerHeight} vvH${vv ? Math.round(vv.height) : '-'} vvT${vv ? Math.round(vv.offsetTop) : '-'} scroll[${rect}] mchat:${chat ? 'Y' : 'N'}`
}

function describeTarget(e: Event): string {
  const t = e.target as HTMLElement | null
  if (!t) return '?'
  const cls = typeof t.className === 'string' ? t.className.slice(0, 40) : ''
  return `${t.tagName.toLowerCase()}${cls ? '.' + cls : ''}`
}

function onFocusIn(e: Event) {
  log('focusin', `${describeTarget(e)} | ${snap()}`)
}
function onFocusOut(e: Event) {
  log('focusout', `${describeTarget(e)} | ${snap()}`)
}
function onResize() {
  showOverlay.value = window.innerWidth <= 768
  log('resize', snap())
}
function onVvResize() {
  log('vv.resize', snap())
}
function onVvScroll() {
  log('vv.scroll', snap())
}
function onVis() {
  log('vis', `${document.visibilityState} | ${snap()}`)
}

/** 复制兜底:clipboard API 在非 https/localhost 上下文不可用时的 textarea 方案 */
function fallbackCopy(text: string) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } catch {
    /* 忽略:复制失败时用户仍可手动长按选择文本 */
  }
  document.body.removeChild(ta)
}

/** 一键复制:版本标识 + 当前时间 + 实时快照 + 全部事件日志(旧→新) */
function copyAll() {
  const lines: string[] = []
  lines.push(`版本: ${DIAG_VERSION}`)
  lines.push(`时间: ${new Date().toLocaleString()}`)
  lines.push(`快照: ${snap()}`)
  lines.push('--- 事件日志(旧→新) ---')
  for (let i = logs.value.length - 1; i >= 0; i--) {
    const l = logs.value[i]
    lines.push(`${l.t} ${l.ev} ${l.info}`)
  }
  const text = lines.join('\n')
  const done = () => {
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {
      fallbackCopy(text)
      done()
    })
  } else {
    fallbackCopy(text)
    done()
  }
}

onMounted(() => {
  now.value = new Date().toLocaleString()
  log('mount', snap())
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('focusout', onFocusOut, true)
  window.addEventListener('resize', onResize)
  window.visualViewport?.addEventListener('resize', onVvResize)
  window.visualViewport?.addEventListener('scroll', onVvScroll)
  document.addEventListener('visibilitychange', onVis)
})
onBeforeUnmount(() => {
  document.removeEventListener('focusin', onFocusIn, true)
  document.removeEventListener('focusout', onFocusOut, true)
  window.removeEventListener('resize', onResize)
  window.visualViewport?.removeEventListener('resize', onVvResize)
  window.visualViewport?.removeEventListener('scroll', onVvScroll)
  document.removeEventListener('visibilitychange', onVis)
})
</script>

<template>
  <div v-if="showOverlay" class="dbg">
    <div class="dbg__bar" @click="expanded = !expanded">
      <span>{{ DIAG_VERSION }} · {{ now }}</span>
      <button class="dbg__copy" type="button" @click.stop="copyAll">
        {{ copied ? '已复制✓' : '复制' }}
      </button>
      <span class="dbg__hint">{{ expanded ? '收起' : '展开' }}</span>
    </div>
    <div v-if="expanded" class="dbg__body">
      <div class="dbg__snap">{{ snap() }}</div>
      <ul class="dbg__logs">
        <li v-for="(l, i) in logs" :key="i" class="dbg__log">
          <span class="dbg__t">{{ l.t }}</span>
          <b class="dbg__ev">{{ l.ev }}</b>
          <span class="dbg__info">{{ l.info }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped lang="scss">
.dbg {
  position: fixed;
  right: 4px;
  bottom: 4px;
  z-index: 99999;
  max-width: 97vw;
  max-height: 48vh;
  display: flex;
  flex-direction: column;
  padding: 4px 6px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.78);
  color: #9f9;
  font-family: Consolas, Menlo, monospace;
  font-size: 10px;
  line-height: 1.45;
  user-select: text;
  pointer-events: auto;

  &__bar {
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    cursor: pointer;
    color: #ff8;
  }

  &__copy {
    padding: 1px 8px;
    border: 1px solid #666;
    border-radius: 8px;
    background: #222;
    color: #8cf;
    font-size: 10px;
    line-height: 1.4;
    cursor: pointer;

    &:active {
      background: #333;
    }
  }

  &__hint {
    margin-left: 6px;
    color: #888;
  }

  &__body {
    margin-top: 2px;
    overflow-y: auto;
  }

  &__snap {
    white-space: nowrap;
    color: #8cf;
  }

  &__logs {
    margin: 2px 0 0;
    padding: 0;
    list-style: none;
  }

  &__log {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__t {
    margin-right: 4px;
    color: #aaa;
  }

  &__ev {
    margin-right: 4px;
    color: #f88;
  }
}
</style>
