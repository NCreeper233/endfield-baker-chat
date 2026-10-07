// =============================================================================
// 上下文预算与压缩规划(contextBudget)
// -----------------------------------------------------------------------------
// 纯函数层:只做算术,不碰 store / DOM,便于单独推演与回归。
//
// 设计依据(DeepSeek 官方 Context Caching 文档):
//   缓存前缀是"完整单元",后续请求必须完整匹配某个前缀单元才能命中。
//   因此每轮从头部裁掉一两条(滑动窗口)会让第 3 条消息起全部错位,
//   缓存只剩固定的两条 system 生效。
//
// 本模块的策略是"批次化压缩":
//   - 未超预算时:一条都不丢(req(N) 成为 req(N+1) 的严格前缀 → 整段命中)
//   - 超预算时:一次丢到目标占用(默认 50%),使下次压缩隔很多轮
//   摊销代价 ≈ 1 次全量未命中 ÷ N 轮,而非每轮一次。
// =============================================================================

import { estimateEntries, estimateEntry, estimateText } from './tokenEstimate'
import type { EstimableEntry } from './tokenEstimate'

/** 输入预算的安全余量(token):吸收估算误差与服务商额外的框架开销 */
export const SAFETY_MARGIN = 512

/** 压缩目标占用比例:一次压缩裁到预算的该比例,换取更长的免压缩间隔 */
export const COMPACT_TARGET_RATIO = 0.5

/** 冻结摘要条目的体积预留(token):压缩后头部会新增一条摘要,需提前扣掉 */
export const SUMMARY_TOKEN_ALLOWANCE = 400

/** 无论如何都保留的最近条目数(2 ≈ 最近一轮问答) */
export const MIN_KEEP_ENTRIES = 2

/** 输入预算下限:避免用户把窗口设得过小时算出无意义的负预算 */
const MIN_INPUT_BUDGET = 1024

/**
 * 触发上下文压缩的默认占比(%):占上下文窗口的比例
 *
 * 达到窗口的这个比例就压缩,而不是等塞满 —— 留出的余量用来吸收估算误差、
 * 本轮长回复,以及服务商的框架开销,免得临门一脚被服务端拒绝
 * (那会触发 hard-trim,比提前压缩糟得多)。
 */
export const DEFAULT_COMPACT_TRIGGER_PERCENT = 80

/** 触发占比允许的区间(%):低于 10 压缩过于频繁,高于 100 越界 */
export const MIN_COMPACT_TRIGGER_PERCENT = 10
export const MAX_COMPACT_TRIGGER_PERCENT = 100

/**
 * 上下文窗口未设置时,引擎按这个值估算
 *
 * 设置里该字段默认是**空的**(0),由自动获取或用户手填。但压缩判据与占用率
 * 必须有分母才算得出来,故保留一个兜底值 —— 取 65536,与旧版默认一致,
 * 使"还没填窗口"的用户升级后行为不发生突变。
 */
export const FALLBACK_CONTEXT_WINDOW = 65536

/**
 * 取实际参与计算的上下文窗口
 *
 * 把"0 / NaN = 未设置 → 用兜底值"这条规则收敛到一处:
 * computeInputBudget 与 computeBreakdown 必须同一口径,
 * 否则面板显示的占用率会和压缩判据对不上。
 *
 * @param contextWindow 用户配置的窗口(0 表示未设置)
 */
export function effectiveContextWindow(contextWindow: number): number {
  return Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : FALLBACK_CONTEXT_WINDOW
}

/** 把触发占比夹到合法区间(非法值回落到默认 80) */
export function clampTriggerPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return DEFAULT_COMPACT_TRIGGER_PERCENT
  return Math.min(
    MAX_COMPACT_TRIGGER_PERCENT,
    Math.max(MIN_COMPACT_TRIGGER_PERCENT, Math.round(percent)),
  )
}

/**
 * 计算可用于输入(prompt)的 token 预算 —— 也就是**触发压缩的阈值**
 *
 * 取两者中较小的一方:
 *   1. 用户设定的占比 × 窗口(默认 80%)
 *   2. 硬上限:窗口 − 生成预留 − 安全余量
 * 第 2 条是安全底线 —— 输入 + 生成预留若超过窗口本身,请求会被服务端直接拒绝。
 * 所以占比设成 100% 并不会真的"压满",只会退化成旧版口径。
 *
 * @param contextWindow  用户配置的上下文窗口大小(0 = 未设置,走兜底值)
 * @param maxTokens      单次生成上限(即 max_tokens / max_completion_tokens)
 * @param triggerPercent 触发占比(%,默认 80)
 */
export function computeInputBudget(
  contextWindow: number,
  maxTokens: number,
  triggerPercent: number = DEFAULT_COMPACT_TRIGGER_PERCENT,
): number {
  const window = effectiveContextWindow(contextWindow)
  const reserve = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0
  const hardCeiling = window - reserve - SAFETY_MARGIN
  const threshold = Math.floor((window * clampTriggerPercent(triggerPercent)) / 100)
  return Math.max(MIN_INPUT_BUDGET, Math.min(threshold, hardCeiling))
}

/** 预算判定结果 */
export type BudgetVerdict =
  /** 未超预算:原样发送(cache 最优路径) */
  | 'ok'
  /** 需要压缩:丢若干条并在头部插入冻结摘要 */
  | 'compact'
  /** 丢到只剩最近若干条仍超预算:只能硬裁,面板需标红 */
  | 'hard-trim'

/** 压缩规划结果 */
export interface BudgetPlan {
  verdict: BudgetVerdict
  /** 需要从历史头部丢弃的条目数 */
  dropCount: number
  /** 当前预计总输入 token */
  estimatedBefore: number
  /** 按本方案处理后,预计总输入 token */
  estimatedAfter: number
  /** 输入预算 */
  budget: number
}

/**
 * 规划一次请求的上下文裁剪方案
 *
 * @param entries            完整历史条目(最旧在前,最新在后)
 * @param fixedTokens        固定前缀(两条 system 消息)的估算 token
 * @param currentInputTokens 本轮新增输入的估算 token(非后端模式为 0,因为已含在 entries 内)
 * @param budget             输入预算(computeInputBudget 的结果)
 * @param ratio              自校准比值
 */
export function planCompaction(
  entries: EstimableEntry[],
  fixedTokens: number,
  currentInputTokens: number,
  budget: number,
  ratio = 1,
): BudgetPlan {
  const entriesTokens = estimateEntries(entries, ratio)
  const estimatedBefore = fixedTokens + entriesTokens + currentInputTokens

  if (estimatedBefore <= budget) {
    return {
      verdict: 'ok',
      dropCount: 0,
      estimatedBefore,
      estimatedAfter: estimatedBefore,
      budget,
    }
  }

  // 目标:压缩后总占用 ≈ 预算 × COMPACT_TARGET_RATIO
  const target = budget * COMPACT_TARGET_RATIO
  // 摘要条目会新增体积,且固定前缀与本轮输入不可丢,先扣掉
  const available = target - fixedTokens - currentInputTokens - SUMMARY_TOKEN_ALLOWANCE

  // 从最旧的一条开始丢,直到剩余体积落进 available(或触及保留下限)
  const maxDrop = Math.max(0, entries.length - MIN_KEEP_ENTRIES)
  let dropCount = 0
  let remaining = entriesTokens
  while (dropCount < maxDrop && remaining > available) {
    remaining -= Math.ceil(estimateEntry(entries[dropCount]) * ratio)
    dropCount++
  }

  // 触发压缩后的最终体积,还要把摘要条目的预留算回去
  const estimatedAfter = fixedTokens + Math.max(0, remaining) + currentInputTokens + SUMMARY_TOKEN_ALLOWANCE

  return {
    verdict: estimatedAfter > budget ? 'hard-trim' : 'compact',
    dropCount,
    estimatedBefore,
    estimatedAfter,
    budget,
  }
}

/** 手动压缩的最少可丢条目数:低于此值认为"没什么可压的",面板会禁用按钮 */
export const MANUAL_COMPACT_MIN_DROPPABLE = 2

/** 手动压缩结果 */
export interface ManualPlan {
  /** 需要从历史头部丢弃的条目数 */
  dropCount: number
  /** 压缩前历史总 token */
  totalTokens: number
  /** 压缩后保留的历史 token */
  keepTokens: number
}

/**
 * 规划一次"手动压缩"(面板按钮触发)
 *
 * 与自动压缩的区别:自动压缩以"是否超预算"为前提,不超就一条不丢;
 * 手动压缩是用户的显式意图,因此**无条件至少裁掉一半历史**,使下一次请求
 * 立刻变轻。若裁掉一半后仍超预算目标,则继续多裁,保证压缩是有意义的。
 *
 * @param entries      完整历史条目(最旧在前)
 * @param fixedTokens  固定前缀 token
 * @param budget       输入预算
 * @param ratio        自校准比值
 */
export function planManualCompaction(
  entries: EstimableEntry[],
  fixedTokens: number,
  budget: number,
  ratio = 1,
): ManualPlan {
  const perEntry: number[] = []
  let totalTokens = 0
  for (const entry of entries) {
    const t = Math.ceil(estimateEntry(entry) * ratio)
    perEntry.push(t)
    totalTokens += t
  }

  // 可丢上限:必须保留最近 MIN_KEEP_ENTRIES 条
  const maxDrop = Math.max(0, entries.length - MIN_KEEP_ENTRIES)

  // 目标:至多保留"当前历史的一半"
  const halfTarget = Math.floor(totalTokens * 0.5)
  // 同时不得超出预算目标(超大历史时可能要比一半裁得更多)
  const budgetTarget = Math.max(
    0,
    budget * COMPACT_TARGET_RATIO - fixedTokens - SUMMARY_TOKEN_ALLOWANCE,
  )
  const keepTarget = Math.min(halfTarget, budgetTarget)

  let dropCount = 0
  let keepTokens = totalTokens
  while (dropCount < maxDrop && keepTokens > keepTarget) {
    keepTokens -= perEntry[dropCount]
    dropCount++
  }

  return { dropCount, totalTokens, keepTokens: Math.max(0, keepTokens) }
}

/** 上下文占用的构成明细(供面板堆叠条使用) */export interface ContextBreakdown {
  /** 固定前缀(固定系统提示词 + 世界观 + 角色提示词 + 风格规则) */
  fixed: number
  /** 冻结摘要条目(压缩产生) */
  summary: number
  /** 其余历史条目 */
  history: number
  /** 待发送的输入框草稿 */
  draft: number
  /** 合计 */
  total: number
  /** 输入预算(即触发压缩的阈值) */
  budget: number
  /** 触发压缩的占比(%,相对上下文窗口) */
  triggerPercent: number
  /** 上下文窗口 */
  contextWindow: number
  /** 合计占上下文窗口的百分比(0-100) */
  percent: number
}

/**
 * 汇总当前对话的上下文占用构成
 *
 * @param entries        完整历史条目
 * @param fixedText      固定前缀原文(多条用 \n 连接)
 * @param draftText      输入框当前草稿
 * @param contextWindow  上下文窗口
 * @param maxTokens      生成预留
 * @param ratio          自校准比值
 * @param triggerPercent 触发压缩的占比(%,默认 80)
 */
export function computeBreakdown(
  entries: EstimableEntry[],
  fixedText: string,
  draftText: string,
  contextWindow: number,
  maxTokens: number,
  ratio = 1,
  triggerPercent: number = DEFAULT_COMPACT_TRIGGER_PERCENT,
): ContextBreakdown {
  const percent = clampTriggerPercent(triggerPercent)
  const budget = computeInputBudget(contextWindow, maxTokens, percent)
  const fixed = Math.ceil(estimateText(fixedText) * ratio)
  const draft = Math.ceil(estimateText(draftText) * ratio)

  // 头部冻结摘要条目:压缩产物,单独统计(便于用户看懂"这条是压缩出来的")
  let summary = 0
  let history = 0
  for (let i = 0; i < entries.length; i++) {
    const isSummary = i === 0 && isSummaryEntry(entries[i])
    const tokens = Math.ceil(estimateEntry(entries[i]) * ratio)
    if (isSummary) summary += tokens
    else history += tokens
  }

  const total = fixed + summary + history + draft
  const window = effectiveContextWindow(contextWindow)
  const usedPercent = Math.min(100, (total / window) * 100)

  return {
    fixed,
    summary,
    history,
    draft,
    total,
    budget,
    triggerPercent: percent,
    contextWindow: window,
    percent: usedPercent,
  }
}

/** 冻结摘要条目的识别前缀(stores/chat 写入时使用同一常量) */
export const SUMMARY_ENTRY_PREFIX = '【对话总结】'

/** 判断某条历史条目是否为压缩产生的冻结摘要 */
export function isSummaryEntry(entry: EstimableEntry): boolean {
  return entry.text.indexOf(SUMMARY_ENTRY_PREFIX) === 0
}
