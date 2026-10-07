// =============================================================================
// 用量统计(useUsageStore)
// -----------------------------------------------------------------------------
// 汇总自定义 API 模式的 token 用量,供实时面板显示:
//   - 最近一次请求:输入 / 输出 / 缓存命中
//   - 累计(跨刷新保留):输入 / 输出 / 命中 / 调用次数
//   - 自校准比值:用真实上报值修正本地估算器
//   - 前缀指纹:检测"固定前缀被改动"导致的缓存失效
//
// 数据来源优先级:服务商上报的 usage > 本地估算(标记 estimated)。
// 持久化由 useChatPersistence 负责(独立 IndexedDB key,不影响卡片数据)。
// =============================================================================

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { nextCalibrationRatio } from '../utils/tokenEstimate'
import type { NormalizedUsage, UsageSource } from '../utils/usage'

/** 单次请求的用量记录 */
export interface RequestRecord {
  /** 记录时间戳(ms) */
  at: number
  /** 输入 token */
  inputTokens: number
  /** 输出 token */
  outputTokens: number
  /** 其中命中缓存的输入 token */
  cachedTokens: number
  /** true 表示本地估算(服务商未上报 usage) */
  estimated: boolean
  /** 缓存命中字段来源 */
  source: UsageSource
  /** 本轮是否因上下文压缩导致前缀重建 */
  compacted: boolean
  /**
   * 本次请求使用的 baseUrl
   *
   * 用于判断"这条记录能否代表当前端点":用户换端点后、还没发新请求时,
   * 面板不应该继续用旧端点的能力来回答"这个端点会不会上报缓存"。
   * 旧持久化数据可能没有该字段。
   */
  endpoint?: string
}

/** 累计用量 */
export interface UsageTotals {
  input: number
  output: number
  cached: number
  calls: number
  /**
   * 其中服务商明确上报了缓存字段的请求数 / 其输入 token 合计
   *
   * 命中率的正确分母只能取这一份:未上报的请求 cached 记 0,若混进分母
   * 会把命中率无端拉低,显示出一个"看起来像真的"的错误数字。
   */
  reportedCalls: number
  reportedInput: number
}

/** 记录一次请求的入参 */
export interface RecordPayload {
  /** 服务商上报的归一化用量;未上报为 null */
  usage: NormalizedUsage | null
  /** 本地估算的输入 token(未乘校准比值) */
  estimatedInput: number
  /** 本地估算的输出 token */
  estimatedOutput: number
  /** 本轮是否发生了上下文压缩 */
  compacted: boolean
  /** 本次请求使用的 baseUrl(用于判断记录是否仍代表当前端点) */
  endpoint: string
}

/** 最近请求记录的保留条数(面板趋势图用) */
const RECENT_MAX = 20

/** 持久化快照版本 */
export const USAGE_SNAPSHOT_VERSION = 1

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cached: 0, calls: 0, reportedCalls: 0, reportedInput: 0 }
}

export const useUsageStore = defineStore('usage', () => {
  // ---- 状态 ---------------------------------------------------------------
  /** 最近一次请求的用量(刷新后由持久化恢复,面板标注时间) */
  const lastRequest = ref<RequestRecord | null>(null)

  /** 累计用量(跨刷新保留) */
  const totals = ref<UsageTotals>(emptyTotals())

  /** 最近 N 次请求(时间顺序,最旧在前) */
  const recent = ref<RequestRecord[]>([])

  /** 输入框当前草稿(面板实时预估下一次请求体积) */
  const draftText = ref('')

  /** 自校准比值:实际输入 token ÷ 本地估算值 */
  const calibration = ref(1)

  /** 最近一次请求所用固定前缀的指纹(检测前缀变更导致的缓存失效) */
  const prefixHash = ref('')

  /** 固定前缀是否相对上一次请求发生了变化 */
  const prefixChanged = ref(false)

  /** 累计压缩次数 / 最近一次压缩时间 */
  const compactionCount = ref(0)
  const lastCompactionAt = ref(0)

  /** 固定前缀是否发生了变化(与上一次请求相比) */
  const wasCompacted = ref(false)

  /**
   * 自上次请求以来是否发生过压缩(尚未发出请求时也为 true)
   *
   * 手动压缩发生在两次请求之间:压缩后前缀已被重建,但此时还没有请求可以
   * 承载"本轮压缩"标记。用这个标志承接,直到下一次 record() 消费掉它,
   * 面板徽章才能在压缩完成的当下就给出正确提示。
   */
  const pendingCompaction = ref(false)

  // ---- 派生量 -------------------------------------------------------------
  /** 最近一次请求的缓存命中率(0-100;不可信时请看 lastHitRateKnown) */
  const lastHitRate = computed(() => {
    const r = lastRequest.value
    if (!r || r.inputTokens <= 0) return 0
    return (r.cachedTokens / r.inputTokens) * 100
  })

  /**
   * 最近一次请求的命中率是否可信
   *
   * 两种情况不可信,面板应显示 "—" 而不是 0%:
   *   - estimated:服务商没返回 usage,数字是本地估算的
   *   - source === 'unknown':返回了 usage 但没有缓存字段,无从得知命中情况
   * 后者显示 0% 会让人误以为"缓存没生效",而事实是"这个端点不告诉我们"。
   */
  const lastHitRateKnown = computed(() => {
    const r = lastRequest.value
    return !!r && !r.estimated && r.source !== 'unknown'
  })

  /** 累计缓存命中率(0-100) */
  const totalHitRate = computed(() => {
    const t = totals.value
    if (t.reportedInput <= 0) return 0
    return (t.cached / t.reportedInput) * 100
  })

  /** 累计命中率是否可信(至少有一次请求真的上报了缓存字段) */
  const totalHitRateKnown = computed(() => totals.value.reportedInput > 0)

  /** 是否从服务商拿到过缓存字段(否则说明该端点不上报缓存) */
  const hasCacheReporting = computed(() =>
    recent.value.some((r) => !r.estimated && r.source !== 'unknown'),
  )

  /** 缓存字段来源说明(面板展示"命中数从哪来") */
  const cacheSource = computed<UsageSource | null>(() => {
    for (let i = recent.value.length - 1; i >= 0; i--) {
      const r = recent.value[i]
      if (!r.estimated && r.source !== 'unknown') return r.source
    }
    return null
  })

  // ---- 动作 ---------------------------------------------------------------

  /**
   * 记录一次请求的用量
   *
   * 有服务商上报时以上报值为准,并用其校准估算器;
   * 未上报时回退估算值 × 校准比值,并标记 estimated。
   */
  function record(payload: RecordPayload): void {
    const { usage, estimatedInput, estimatedOutput, compacted, endpoint } = payload

    // 相对上一次请求,前缀是否被重建过:
    //  - 自动压缩:本轮发送前刚压过(compacted)
    //  - 手动压缩:发生在两次请求之间,由 pendingCompaction 承接
    // 任一为真都意味着本轮必然全量未命中,徽章与趋势条都要如实标出。
    const prefixRebuilt = compacted || pendingCompaction.value

    let entry: RequestRecord
    if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
      // 用真实输入值校准估算器(raw 估算值 vs 实际上报值)
      calibration.value = nextCalibrationRatio(calibration.value, estimatedInput, usage.inputTokens)
      entry = {
        at: Date.now(),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        estimated: false,
        source: usage.source,
        compacted: prefixRebuilt,
        endpoint,
      }
    } else {
      entry = {
        at: Date.now(),
        inputTokens: Math.ceil(estimatedInput * calibration.value),
        outputTokens: Math.max(0, Math.round(estimatedOutput)),
        cachedTokens: 0,
        estimated: true,
        source: 'unknown',
        compacted: prefixRebuilt,
        endpoint,
      }
    }

    lastRequest.value = entry
    // 只有"服务商确实上报了缓存字段"的请求才计入命中率分母
    const reported = !entry.estimated && entry.source !== 'unknown'
    totals.value = {
      input: totals.value.input + entry.inputTokens,
      output: totals.value.output + entry.outputTokens,
      cached: totals.value.cached + entry.cachedTokens,
      calls: totals.value.calls + 1,
      reportedCalls: totals.value.reportedCalls + (reported ? 1 : 0),
      reportedInput: totals.value.reportedInput + (reported ? entry.inputTokens : 0),
    }
    const next = recent.value.concat(entry)
    recent.value = next.length > RECENT_MAX ? next.slice(next.length - RECENT_MAX) : next
    wasCompacted.value = prefixRebuilt
    pendingCompaction.value = false
  }

  /** 更新输入框草稿(面板实时预估用) */
  function setDraft(text: string): void {
    draftText.value = text
  }

  /**
   * 登记本轮固定前缀指纹
   *
   * @returns true 表示前缀相对上一次发生了变化(缓存需要重建)
   */
  function notePrefix(hash: string): boolean {
    const changed = prefixHash.value !== '' && prefixHash.value !== hash
    prefixChanged.value = changed
    prefixHash.value = hash
    return changed
  }

  /** 登记一次上下文压缩 */
  function noteCompaction(): void {
    compactionCount.value += 1
    lastCompactionAt.value = Date.now()
    // 标记"前缀已被重建,但还没有请求消费这个事实"(手动压缩后立即需要)
    pendingCompaction.value = true
  }

  /** 清空全部统计(面板"重置"按钮) */
  function resetAll(): void {
    lastRequest.value = null
    totals.value = emptyTotals()
    recent.value = []
    calibration.value = 1
    prefixHash.value = ''
    prefixChanged.value = false
    compactionCount.value = 0
    lastCompactionAt.value = 0
    wasCompacted.value = false
    pendingCompaction.value = false
  }

  // ---- 持久化快照 ---------------------------------------------------------

  /** 导出可序列化快照(写入 IndexedDB 的 usage key) */
  function getSnapshot(): Record<string, unknown> {
    return {
      version: USAGE_SNAPSHOT_VERSION,
      lastRequest: lastRequest.value,
      totals: { ...totals.value },
      recent: recent.value.slice(-RECENT_MAX),
      calibration: calibration.value,
      prefixHash: prefixHash.value,
      compactionCount: compactionCount.value,
      lastCompactionAt: lastCompactionAt.value,
      // 压缩后未及发请求就刷新页面时,这个标记不该丢(前缀确实已被重建)
      pendingCompaction: pendingCompaction.value,
    }
  }

  /**
   * 从快照恢复(损坏/缺失时静默保持默认值)
   *
   * 逐字段校验类型,任何一项不合法就跳过该项 —— 统计值不值得为它冒数据风险。
   */
  function applySnapshot(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== 'object') return
    const s = snapshot as Record<string, unknown>
    if (s.version !== USAGE_SNAPSHOT_VERSION) return

    if (Array.isArray(s.recent)) {
      recent.value = s.recent.filter(isRequestRecord).slice(-RECENT_MAX)
    }
    if (isRequestRecord(s.lastRequest)) lastRequest.value = s.lastRequest

    const t = s.totals
    if (t && typeof t === 'object') {
      const tt = t as Record<string, unknown>
      const pick = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
      totals.value = {
        input: pick(tt.input),
        output: pick(tt.output),
        cached: pick(tt.cached),
        calls: pick(tt.calls),
        reportedCalls: pick(tt.reportedCalls),
        reportedInput: pick(tt.reportedInput),
      }
    }

    if (typeof s.calibration === 'number' && Number.isFinite(s.calibration)) {
      calibration.value = Math.min(3, Math.max(0.5, s.calibration))
    }
    if (typeof s.prefixHash === 'string') prefixHash.value = s.prefixHash
    if (typeof s.compactionCount === 'number' && s.compactionCount >= 0) {
      compactionCount.value = s.compactionCount
    }
    if (typeof s.lastCompactionAt === 'number' && s.lastCompactionAt >= 0) {
      lastCompactionAt.value = s.lastCompactionAt
    }
    if (typeof s.pendingCompaction === 'boolean') {
      pendingCompaction.value = s.pendingCompaction
    }
  }

  return {
    // state
    lastRequest,
    totals,
    recent,
    draftText,
    calibration,
    prefixHash,
    prefixChanged,
    compactionCount,
    lastCompactionAt,
    wasCompacted,
    pendingCompaction,
    // getters
    lastHitRate,
    lastHitRateKnown,
    totalHitRate,
    totalHitRateKnown,
    hasCacheReporting,
    cacheSource,
    // actions
    record,
    setDraft,
    notePrefix,
    noteCompaction,
    resetAll,
    getSnapshot,
    applySnapshot,
  }
})

/** 校验一条持久化记录的形状 */
function isRequestRecord(value: unknown): value is RequestRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  const isNum = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
  return (
    isNum(r.at) &&
    isNum(r.inputTokens) &&
    isNum(r.outputTokens) &&
    isNum(r.cachedTokens) &&
    typeof r.estimated === 'boolean' &&
    typeof r.source === 'string' &&
    typeof r.compacted === 'boolean' &&
    // endpoint 是后加的字段,旧数据没有,故为可选而非必需
    (r.endpoint === undefined || typeof r.endpoint === 'string')
  )
}
