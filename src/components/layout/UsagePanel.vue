<script setup lang="ts">
// =============================================================================
// 实时用量面板(UsagePanel)
// -----------------------------------------------------------------------------
// 非模态浮层:不拦截背景交互,可在聊天过程中一直开着看数字变化。
//
// 显示四组信息:
//   1. 最近一次请求:输入 / 输出 / 缓存命中 / 命中率
//   2. 上下文占用:已用 ÷ 窗口 + 构成堆叠条(固定前缀 / 冻结摘要 / 历史 / 草稿)
//   3. 累计用量:跨刷新保留(由 useChatPersistence 写入独立 IndexedDB key)
//   4. 缓存状态:前缀是否稳定 / 本轮是否压缩 / 该端点是否上报缓存字段
//
// "实时"来源:输入框草稿(usageStore.draftText)+ 历史变化 + 响应完成,
// 三者任一变化都会让下一次请求的预估体积立即重算。
//
// 面板可通过标题栏拖动到任意位置,位置持久化(localStorage)。
// =============================================================================
import { computed, nextTick, ref, watch } from 'vue'
import { useChatStore } from '../../stores/chat'
import { useSettingsStore } from '../../stores/settings'
import { useUsageStore } from '../../stores/usage'
import { useContextCompaction } from '../../composables/useContextCompaction'
import { useDraggable } from '../../composables/useDraggable'
import {
  computeBreakdown,
  planManualCompaction,
  MANUAL_COMPACT_MIN_DROPPABLE,
} from '../../utils/contextBudget'
import { estimateText } from '../../utils/tokenEstimate'
import { describeDataStatus, formatPercent, formatTokenCount } from '../../utils/usage'
import type { UsageSource } from '../../utils/usage'

/** 面板位置持久化的 localStorage key(沿用 endfield-baker- 前缀族) */
const PANEL_POS_KEY = 'endfield-baker-usage-panel-pos'

const props = defineProps<{
  /** 是否显示 */
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const chatStore = useChatStore()
const settingsStore = useSettingsStore()
const usageStore = useUsageStore()
const { compact } = useContextCompaction()

/** 面板拖动(标题栏为把手,位置持久化) */
const {
  panelEl,
  handleEl,
  dragging,
  panelStyle,
  clampNow,
  onPointerDown,
  onPointerMove,
  onPointerUp,
} = useDraggable(PANEL_POS_KEY)

/** 当前对话的角色名(未选中对话时为空串) */
const characterName = computed(() =>
  chatStore.activeSub !== null ? chatStore.conversations[chatStore.activeSub]?.name ?? '' : '',
)

/** 是否为自定义 API 模式(只有该模式走预算压缩) */
const isCustom = computed(() => settingsStore.apiConfig.apiMode === 'custom')

/** 当前对话的上下文历史(响应式:历史变化会重算占用) */
const history = computed(() => (chatStore.activeSub !== null ? chatStore.getChatHistory() : []))

/** 两条 system 消息的固定前缀原文(与真实请求完全同源) */
const fixedText = computed(() => {
  if (!characterName.value) return ''
  return `${settingsStore.getSystemMessage()}\n\n${settingsStore.getCharacterMessage(characterName.value)}`
})

/** 上下文占用构成(随草稿 / 历史 / 校准比值实时变化) */
const breakdown = computed(() =>
  computeBreakdown(
    history.value,
    fixedText.value,
    usageStore.draftText,
    settingsStore.apiConfig.contextWindow,
    settingsStore.apiConfig.maxTokens,
    usageStore.calibration,
    settingsStore.apiConfig.compactTriggerPercent,
  ),
)

/** 占用进度条配色档位:<60% 绿 / <85% 黄 / ≥85% 红 */
const barLevel = computed(() => {
  const p = breakdown.value.percent
  if (p >= 85) return 'danger'
  if (p >= 60) return 'warn'
  return 'ok'
})

/** 堆叠条各段宽度百分比(相对上下文窗口) */
function segWidth(tokens: number): string {
  const win = breakdown.value.contextWindow
  if (win <= 0) return '0%'
  return `${Math.min(100, (tokens / win) * 100)}%`
}

/** 最近一次请求的缓存命中率 */
const lastHitRate = computed(() => usageStore.lastHitRate)

/** 累计命中率 */
const totalHitRate = computed(() => usageStore.totalHitRate)

/**
 * 最近一次请求的展示值
 *
 * 关键:命中数与命中率在"服务商没上报"时显示 —,而不是 0。
 * 0% 会被读成"缓存一次都没命中",而事实是"这个端点不告诉我们",
 * 两者对使用者的决策含义完全相反。
 */
const lastView = computed(() => {
  const r = usageStore.lastRequest
  if (!r) return null
  const known = usageStore.lastHitRateKnown
  return {
    input: formatTokenCount(r.inputTokens),
    output: formatTokenCount(r.outputTokens),
    cached: known ? formatTokenCount(r.cachedTokens) : '—',
    rate: known ? formatPercent(lastHitRate.value) : '—',
    estimated: r.estimated,
    cacheUnknown: !known,
  }
})

/** 累计展示值(同样区分"未知"与"0") */
const totalView = computed(() => {
  const t = usageStore.totals
  const known = usageStore.totalHitRateKnown
  return {
    input: formatTokenCount(t.input),
    output: formatTokenCount(t.output),
    cached: known ? formatTokenCount(t.cached) : '—',
    rate: known ? formatPercent(totalHitRate.value) : '—',
    unreported: Math.max(0, t.calls - t.reportedCalls),
  }
})

/**
 * 面板数据可信度状态
 *
 * 判断逻辑抽在 utils/usage.describeDataStatus(纯函数,可单独验证),
 * 这里只负责把当前 store 状态喂进去。
 */
const dataStatus = computed(() =>
  describeDataStatus(usageStore.lastRequest, settingsStore.apiConfig.baseUrl),
)

/** 缓存状态徽章 */
const cacheBadge = computed<{ text: string; level: string }>(() => {
  // 端点是否上报缓存字段由上方"数据可信度"行负责,此处只谈前缀稳定性
  if (usageStore.prefixChanged) {
    return { text: '固定前缀已变更 → 缓存需重建', level: 'warn' }
  }
  // pendingCompaction:刚压缩完、还没发请求,前缀同样已被重建
  if (usageStore.wasCompacted || usageStore.pendingCompaction) {
    return { text: '前缀已重建 → 下一次请求全量缓存未命中', level: 'warn' }
  }
  return { text: '前缀稳定', level: 'ok' }
})

/** 最近一次请求的相对时间描述 */
const lastTimeLabel = computed(() => {
  const r = usageStore.lastRequest
  if (!r) return ''
  const diff = Date.now() - r.at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
})

/** 最近 N 次请求的命中率(趋势柱,最旧在左) */
const trend = computed(() =>
  usageStore.recent.map((r) => ({
    rate: r.inputTokens > 0 ? (r.cachedTokens / r.inputTokens) * 100 : 0,
    estimated: r.estimated,
    compacted: r.compacted,
  })),
)

/** 重置全部统计(不影响对话内容) */
function onReset() {
  usageStore.resetAll()
}

// ---- 手动压缩 ---------------------------------------------------------------
/** 是否正在压缩(会调用总结 API,可能耗时数秒) */
const compacting = ref(false)
/** 压缩结果提示 */
const compactResult = ref('')
/** 结果语气:成功 / 失败 */
const compactResultLevel = ref<'ok' | 'warn'>('ok')

/**
 * 手动压缩预案
 *
 * 提前算好"点下去会丢多少条",让按钮本身就是可预期的 ——
 * 不给数字的破坏性按钮最容易误点。
 */
const manualPlan = computed(() =>
  planManualCompaction(
    history.value,
    estimateText(fixedText.value),
    breakdown.value.budget,
    usageStore.calibration,
  ),
)

/** 是否允许手动压缩 */
const canCompact = computed(
  () =>
    isCustom.value &&
    !compacting.value &&
    manualPlan.value.dropCount >= MANUAL_COMPACT_MIN_DROPPABLE,
)

/** 不可压缩的原因(空串表示可压缩) */
const compactBlockedReason = computed(() => {
  if (!isCustom.value) return '仅自定义 API 模式支持（其他模式的提示词由服务端管理）'
  if (manualPlan.value.dropCount < MANUAL_COMPACT_MIN_DROPPABLE) return '历史太短，没有可压缩的内容'
  return ''
})

/** 按钮文案 */
const compactButtonText = computed(() => {
  if (compacting.value) return '压缩中…'
  if (!isCustom.value) return '压缩上下文'
  return `压缩上下文（丢弃 ${manualPlan.value.dropCount} 条）`
})

/** 关闭面板或切对话时清掉上次结果,避免旧提示误导 */
watch(
  () => [props.open, chatStore.activeSub],
  () => {
    compactResult.value = ''
  },
)

/**
 * 面板每次显示时按当前视口夹一次位置
 *
 * 必须重新夹:持久化的坐标可能是窗口较大时留下的,窗口缩小后面板会落在
 * 屏幕外 —— 表现就是"点了按钮但面板不出现"。
 */
watch(
  () => props.open,
  async (open) => {
    if (!open) return
    await nextTick()
    clampNow()
  },
)

/** 执行手动压缩 */
async function onCompact() {
  if (!canCompact.value) return
  compacting.value = true
  compactResult.value = ''
  compactResultLevel.value = 'ok'
  try {
    const outcome = await compact(fixedText.value, 'manual')
    if (!outcome) {
      compactResult.value = '没有可压缩的内容'
      compactResultLevel.value = 'warn'
      return
    }
    compactResult.value = `已丢弃 ${outcome.dropped} 条早期对话，并生成冻结摘要`
  } catch (err) {
    // 手动压缩失败时不会改动任何历史(见 useContextCompaction),如实告知即可
    compactResult.value = `压缩失败：${err instanceof Error ? err.message : String(err)}`
    compactResultLevel.value = 'warn'
  } finally {
    compacting.value = false
  }
}
</script>

<template>
  <Transition name="up">
    <div
      v-if="props.open"
      ref="panelEl"
      class="up"
      :class="{ 'up--dragging': dragging }"
      :style="panelStyle"
      role="dialog"
      aria-label="Token 用量"
    >
      <!-- 标题栏兼拖拽把手:按住可把面板拖到任意位置(位置会记住) -->
      <div
        ref="handleEl"
        class="up__head"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <span class="up__title">TOKEN 用量</span>
        <span v-if="!isCustom" class="up__mode">当前为 {{ settingsStore.apiConfig.apiMode }} 模式</span>
        <button class="up__close" type="button" aria-label="关闭" @click="emit('close')">×</button>
      </div>

      <!-- 数据可信度:判断上面数字能不能信的前提,故放在最显眼处 -->
      <div class="up__status" :class="`up__status--${dataStatus.level}`">
        <span class="up__status-dot" />
        <span class="up__status-text">
          <span class="up__status-label">{{ dataStatus.label }}</span>
          <span class="up__status-detail">{{ dataStatus.detail }}</span>
        </span>
      </div>

      <!-- 缓存状态 -->
      <div class="up__badge" :class="`up__badge--${cacheBadge.level}`">{{ cacheBadge.text }}</div>

      <!-- 最近一次请求 -->
      <div class="up__section">
        <div class="up__label">
          最近一次请求
          <span v-if="lastTimeLabel" class="up__time">{{ lastTimeLabel }}</span>
        </div>
        <div class="up__grid">
          <div class="up__cell">
            <span class="up__cell-k">输入</span>
            <span class="up__cell-v">{{ lastView?.input ?? '—' }}</span>
          </div>
          <div class="up__cell">
            <span class="up__cell-k">输出</span>
            <span class="up__cell-v">{{ lastView?.output ?? '—' }}</span>
          </div>
          <div class="up__cell">
            <span class="up__cell-k">缓存命中</span>
            <span class="up__cell-v up__cell-v--hit">{{ lastView?.cached ?? '—' }}</span>
          </div>
          <div class="up__cell">
            <span class="up__cell-k">命中率</span>
            <span class="up__cell-v">{{ lastView?.rate ?? '—' }}</span>
          </div>
        </div>
        <p v-if="lastView?.estimated" class="up__hint up__hint--warn">
          服务商未返回 usage,以上为<strong>本地估算值</strong>,不是实测
        </p>
        <p v-else-if="lastView?.cacheUnknown" class="up__hint up__hint--warn">
          该端点返回了 usage 但不含缓存字段,<strong>命中情况未知</strong>(不是 0%)
        </p>
      </div>

      <!-- 上下文占用 -->
      <div class="up__section">
        <div class="up__label">上下文占用（估算）</div>
        <div class="up__usage">
          <span class="up__usage-num">{{ formatTokenCount(breakdown.total) }}</span>
          <span class="up__usage-sep">/</span>
          <span class="up__usage-win">{{ formatTokenCount(breakdown.contextWindow) }}</span>
          <span class="up__usage-pct" :class="`up__usage-pct--${barLevel}`">
            {{ formatPercent(breakdown.percent) }}
          </span>
        </div>
        <div class="up__bar">
          <div class="up__bar-fixed" :style="{ width: segWidth(breakdown.fixed) }" />
          <div class="up__bar-summary" :style="{ width: segWidth(breakdown.summary) }" />
          <div class="up__bar-history" :style="{ width: segWidth(breakdown.history) }" />
          <div class="up__bar-draft" :style="{ width: segWidth(breakdown.draft) }" />
        </div>
        <div class="up__legend">
          <span><i class="up__dot up__dot--fixed" />固定前缀 {{ formatTokenCount(breakdown.fixed) }}</span>
          <span v-if="breakdown.summary > 0">
            <i class="up__dot up__dot--summary" />冻结摘要 {{ formatTokenCount(breakdown.summary) }}
          </span>
          <span><i class="up__dot up__dot--history" />历史 {{ formatTokenCount(breakdown.history) }}</span>
          <span v-if="breakdown.draft > 0">
            <i class="up__dot up__dot--draft" />草稿 {{ formatTokenCount(breakdown.draft) }}
          </span>
        </div>
        <p class="up__hint">
          触发阈值 {{ formatTokenCount(breakdown.budget) }}（窗口的
          {{ breakdown.triggerPercent }}%，已扣生成预留
          {{ formatTokenCount(settingsStore.apiConfig.maxTokens) }} 与安全余量）
        </p>
        <p v-if="breakdown.total > breakdown.budget" class="up__hint up__hint--warn">
          已超出触发阈值,下次发送将触发压缩
        </p>

        <!-- 手动压缩:用户显式触发,至少裁掉一半历史 -->
        <div class="up__compact">
          <button
            class="up__btn"
            type="button"
            :disabled="!canCompact"
            @click="onCompact"
          >{{ compactButtonText }}</button>
          <p v-if="compactBlockedReason" class="up__hint">{{ compactBlockedReason }}</p>
          <p v-else-if="compactResult" class="up__hint" :class="`up__hint--${compactResultLevel}`">
            {{ compactResult }}
          </p>
          <p v-else class="up__hint">
            早期对话会被总结成一条冻结摘要（调用总结 API），剧情记忆保留在摘要里；
            屏幕上已显示的消息不受影响。
          </p>
        </div>
      </div>

      <!-- 累计 -->
      <div class="up__section">
        <div class="up__label">累计(跨刷新保留)</div>
        <div class="up__grid">
          <div class="up__cell">
            <span class="up__cell-k">输入</span>
            <span class="up__cell-v">{{ totalView.input }}</span>
          </div>
          <div class="up__cell">
            <span class="up__cell-k">输出</span>
            <span class="up__cell-v">{{ totalView.output }}</span>
          </div>
          <div class="up__cell">
            <span class="up__cell-k">缓存命中</span>
            <span class="up__cell-v up__cell-v--hit">{{ totalView.cached }}</span>
          </div>
          <div class="up__cell">
            <span class="up__cell-k">命中率</span>
            <span class="up__cell-v">{{ totalView.rate }}</span>
          </div>
        </div>
        <p class="up__hint">
          共 {{ formatTokenCount(usageStore.totals.calls) }} 次请求<template v-if="totalView.unreported > 0">（其中
          {{ formatTokenCount(totalView.unreported) }} 次未上报缓存,不计入命中率）</template>
          · 压缩 {{ usageStore.compactionCount }} 次 · 校准比 {{ usageStore.calibration.toFixed(2) }}
        </p>
      </div>

      <!-- 趋势 -->
      <div v-if="trend.length > 1" class="up__section">
        <div class="up__label">最近 {{ trend.length }} 次命中率</div>
        <div class="up__trend">
          <span
            v-for="(t, i) in trend"
            :key="i"
            class="up__trend-bar"
            :class="{ 'up__trend-bar--est': t.estimated, 'up__trend-bar--compacted': t.compacted }"
            :style="{ height: `${Math.max(3, t.rate)}%` }"
            :title="`${formatPercent(t.rate)}${t.estimated ? '(估算)' : ''}${t.compacted ? ' · 本轮压缩' : ''}`"
          />
        </div>
      </div>

      <div class="up__foot">
        <button class="up__reset" type="button" @click="onReset">重置统计</button>
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;

// 非模态浮层:深色直角面板 + 网格纹理,与设置弹窗同一视觉语言(无遮罩)
.up {
  position: fixed;
  top: 84px;
  right: 60px;
  z-index: 150;
  width: 320px;
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 110px);
  overflow-y: auto;
  padding: 14px 16px 12px;
  background-color: $color-dialog-bg;
  background-image:
    linear-gradient(to right, rgba(134, 134, 133, 0.12) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(134, 134, 133, 0.12) 1px, transparent 1px);
  background-size: 24px 24px;
  border: 1px solid $color-dialog-border;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  font-family: $font-harmony;
  color: $color-text-primary;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }

  // 拖动中:整块面板禁选文字 + 抓手光标,避免拖过内容时选中一片文本
  &--dragging {
    user-select: none;

    .up__head {
      cursor: grabbing;
    }
  }

  &__head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 10px;
    // 吸顶:内容超长滚动时标题栏不会滚走,拖拽把手始终抓得到
    position: sticky;
    top: 0;
    z-index: 2;
    // 用面板底色盖住从下方滚过的内容(网格纹理在此条带上中断,可接受)
    background: $color-dialog-bg;
    // 拖拽把手:鼠标显示抓手,触屏用 touch-action 阻止滚动手势抢走拖动
    cursor: grab;
    touch-action: none;
    user-select: none;
  }

  &__title {
    font-size: 14px;
    font-weight: 500;
    letter-spacing: 0.5px;
  }

  &__mode {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.45);
  }

  &__close {
    margin-left: auto;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    background: transparent;
    color: $color-subcard-text;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;

    &:hover {
      color: #fff;
    }
  }

  // 数据可信度状态行:左侧色条 + 圆点 + 标签同色,扫一眼就知道数字能不能信
  &__status {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 10px;
    padding: 7px 9px;
    border-left: 3px solid rgba(255, 255, 255, 0.3);
    background: rgba(255, 255, 255, 0.04);

    &--measured {
      border-left-color: #8fe38f;

      .up__status-dot {
        background: #8fe38f;
      }

      .up__status-label {
        color: #8fe38f;
      }
    }

    &--partial {
      border-left-color: #ffd45e;

      .up__status-dot {
        background: #ffd45e;
      }

      .up__status-label {
        color: #ffd45e;
      }
    }

    &--estimated {
      border-left-color: #ffab5e;

      .up__status-dot {
        background: #ffab5e;
      }

      .up__status-label {
        color: #ffab5e;
      }
    }

    &--stale,
    &--none {
      .up__status-label {
        color: rgba(255, 255, 255, 0.6);
      }
    }
  }

  &__status-dot {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    margin-top: 5px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.4);
  }

  &__status-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  &__status-label {
    font-size: 12px;
    font-weight: 500;
  }

  &__status-detail {
    font-size: 10px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.5);
  }

  &__badge {
    display: inline-block;
    margin-bottom: 12px;
    padding: 3px 8px;
    font-size: 11px;
    border: 1px solid;

    &--ok {
      color: #8fe38f;
      border-color: rgba(143, 227, 143, 0.45);
    }

    &--warn {
      color: #ffd45e;
      border-color: rgba(255, 212, 94, 0.45);
    }

    &--muted {
      color: rgba(255, 255, 255, 0.45);
      border-color: rgba(255, 255, 255, 0.18);
    }
  }

  &__section {
    margin-bottom: 14px;
  }

  &__label {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin-bottom: 6px;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.55);
  }

  &__time {
    color: rgba(255, 255, 255, 0.35);
  }

  &__grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 10px;
  }

  &__cell {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 6px;
  }

  &__cell-k {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.5);
  }

  &__cell-v {
    font-size: 13px;
    font-variant-numeric: tabular-nums;

    &--hit {
      color: #8fe38f;
    }
  }

  &__usage {
    display: flex;
    align-items: baseline;
    gap: 4px;
    margin-bottom: 6px;
    font-variant-numeric: tabular-nums;
  }

  &__usage-num {
    font-size: 16px;
  }

  &__usage-sep,
  &__usage-win {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
  }

  &__usage-pct {
    margin-left: auto;
    font-size: 12px;

    &--ok {
      color: #8fe38f;
    }

    &--warn {
      color: #ffd45e;
    }

    &--danger {
      color: #ff8080;
    }
  }

  // 构成堆叠条
  &__bar {
    display: flex;
    height: 6px;
    margin-bottom: 6px;
    background: rgba(255, 255, 255, 0.08);
    overflow: hidden;
  }

  &__bar-fixed {
    background: #7aa7d8;
  }

  &__bar-summary {
    background: #b58ad8;
  }

  &__bar-history {
    background: #8fe38f;
  }

  &__bar-draft {
    background: #ffd45e;
  }

  &__legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    margin-bottom: 6px;
    font-size: 10px;
    color: rgba(255, 255, 255, 0.55);
  }

  &__dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 4px;

    &--fixed {
      background: #7aa7d8;
    }

    &--summary {
      background: #b58ad8;
    }

    &--history {
      background: #8fe38f;
    }

    &--draft {
      background: #ffd45e;
    }
  }

  &__hint {
    margin: 4px 0 0;
    font-size: 10px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.4);

    &--warn {
      color: #ffd45e;
    }

    &--ok {
      color: #8fe38f;
    }
  }

  // 手动压缩区:与上方统计拉开距离,避免误点
  &__compact {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  &__btn {
    display: block;
    width: 100%;
    padding: 5px 8px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    background: transparent;
    color: $color-subcard-text;
    font-family: $font-harmony;
    font-size: 11px;
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease;

    &:hover:not(:disabled) {
      border-color: #ffd45e;
      color: #ffd45e;
    }

    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
  }

  &__trend {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 34px;
    padding: 0 1px;
    background: rgba(255, 255, 255, 0.05);
  }

  &__trend-bar {
    flex: 1;
    min-width: 2px;
    background: #8fe38f;

    &--est {
      background: rgba(255, 255, 255, 0.3);
    }

    &--compacted {
      background: #ffd45e;
    }
  }

  &__foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  &__reset {
    flex-shrink: 0;
    padding: 3px 8px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    background: transparent;
    color: $color-subcard-text;
    font-family: $font-harmony;
    font-size: 10px;
    cursor: pointer;

    &:hover {
      border-color: #fff;
      color: #fff;
    }
  }
}

.up-enter-active,
.up-leave-active {
  transition: opacity 0.15s ease-out;
}

.up-enter-from,
.up-leave-to {
  opacity: 0;
}
</style>
