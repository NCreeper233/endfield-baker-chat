// contextBudget —— 上下文预算与压缩规划（纯函数，只做算术）
// 缓存前缀必须完整匹配才能命中，故不做滑动窗口（裁一两条会让后面全部错位），
// 而是批次化压缩：未超预算一条不丢，超预算一次丢到目标占用。

import { estimateEntries, estimateEntry, estimateText } from './tokenEstimate'
import type { EstimableEntry } from './tokenEstimate'

/** 输入预算的安全余量：吸收估算误差与服务商的框架开销 */
export const SAFETY_MARGIN = 512

/** 一次压缩裁到预算的该比例，换取更长的免压缩间隔 */
export const COMPACT_TARGET_RATIO = 0.5

/** 压缩后头部会新增一条摘要，需提前扣掉 */
export const SUMMARY_TOKEN_ALLOWANCE = 400

/** 无论如何都保留的最近条目数（2 ≈ 最近一轮问答） */
export const MIN_KEEP_ENTRIES = 2

/** 避免用户把窗口设得过小时算出负预算 */
const MIN_INPUT_BUDGET = 1024

/**
 * 达到窗口的该比例就压缩，而不是等塞满：余量用来吸收估算误差、本轮长回复
 * 与服务商框架开销，免得临门一脚被拒（那会触发 hard-trim，比提前压缩糟得多）。
 */
export const DEFAULT_COMPACT_TRIGGER_PERCENT = 80

/** 低于 10 压缩过于频繁，高于 100 越界 */
export const MIN_COMPACT_TRIGGER_PERCENT = 10
export const MAX_COMPACT_TRIGGER_PERCENT = 100

/** 窗口未设置时的兜底值：取 65536 与旧版一致，升级后行为不发生突变 */
export const FALLBACK_CONTEXT_WINDOW = 65536

/**
 * 「0 / NaN = 未设置 → 用兜底值」只在这里实现：computeInputBudget 与
 * computeBreakdown 必须同一口径，否则面板占用率会和压缩判据对不上。
 */
export function effectiveContextWindow(contextWindow: number): number {
  return Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : FALLBACK_CONTEXT_WINDOW
}

/** 夹到合法区间，非法值回落到 80 */
export function clampTriggerPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return DEFAULT_COMPACT_TRIGGER_PERCENT
  return Math.min(
    MAX_COMPACT_TRIGGER_PERCENT,
    Math.max(MIN_COMPACT_TRIGGER_PERCENT, Math.round(percent)),
  )
}

/**
 * 取「占比 × 窗口」与「窗口 − 生成预留 − 安全余量」中较小者，后者的安全底线：
 * 输入 + 预留超过窗口本身会被服务端直接拒绝，所以占比设 100% 也不会真的压满。
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

export type BudgetVerdict =
  /** 未超预算，原样发送 */
  | 'ok'
  /** 丢若干条并在头部插入冻结摘要 */
  | 'compact'
  /** 丢到只剩最近若干条仍超预算，只能硬裁，面板需标红 */
  | 'hard-trim'

export interface BudgetPlan {
  verdict: BudgetVerdict
  /** 需从历史头部丢弃的条目数 */
  dropCount: number
  estimatedBefore: number
  estimatedAfter: number
  budget: number
}

/**
 * entries 最旧在前。currentInputTokens 在后端模式下为 0（已含在 entries 内）。
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

  // 目标：压缩后总占用 ≈ 预算 × COMPACT_TARGET_RATIO
  const target = budget * COMPACT_TARGET_RATIO
  // 摘要条目会新增体积，固定前缀与本轮输入不可丢
  const available = target - fixedTokens - currentInputTokens - SUMMARY_TOKEN_ALLOWANCE

  const maxDrop = Math.max(0, entries.length - MIN_KEEP_ENTRIES)
  let dropCount = 0
  let remaining = entriesTokens
  while (dropCount < maxDrop && remaining > available) {
    remaining -= Math.ceil(estimateEntry(entries[dropCount]) * ratio)
    dropCount++
  }

  const estimatedAfter = fixedTokens + Math.max(0, remaining) + currentInputTokens + SUMMARY_TOKEN_ALLOWANCE

  return {
    verdict: estimatedAfter > budget ? 'hard-trim' : 'compact',
    dropCount,
    estimatedBefore,
    estimatedAfter,
    budget,
  }
}

/** 低于此值认为「没什么可压的」，面板会禁用按钮 */
export const MANUAL_COMPACT_MIN_DROPPABLE = 2

export interface ManualPlan {
  /** 需从历史头部丢弃的条目数 */
  dropCount: number
  totalTokens: number
  keepTokens: number
}

/**
 * 手动压缩是用户的显式意图，故无条件至少裁掉一半历史；若仍超预算目标则继续多裁。
 * （自动压缩以「是否超预算」为前提，不超就一条不丢。）
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

  const maxDrop = Math.max(0, entries.length - MIN_KEEP_ENTRIES)

  // 至多保留当前历史的一半
  const halfTarget = Math.floor(totalTokens * 0.5)
  // 同时不得超出预算目标（超大历史时可能要比一半裁得更多）
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

/** 供面板堆叠条使用 */
export interface ContextBreakdown {
  /** 固定系统提示词 + 世界观 + 角色提示词 + 风格规则 */
  fixed: number
  /** 压缩产生的冻结摘要条目 */
  summary: number
  history: number
  /** 待发送的输入框草稿 */
  draft: number
  total: number
  /** 即触发压缩的阈值 */
  budget: number
  triggerPercent: number
  contextWindow: number
  /** 合计占窗口的百分比（0-100） */
  percent: number
}

/** fixedText 多条时用 \n 连接 */
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

  // 头部冻结摘要单独统计，便于用户看懂「这条是压缩出来的」
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

/** stores/chat 写入摘要时使用同一常量 */
export const SUMMARY_ENTRY_PREFIX = '【对话总结】'

export function isSummaryEntry(entry: EstimableEntry): boolean {
  return entry.text.indexOf(SUMMARY_ENTRY_PREFIX) === 0
}
