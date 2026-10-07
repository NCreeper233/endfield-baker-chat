// =============================================================================
// 上下文压缩(useContextCompaction)
// -----------------------------------------------------------------------------
// 压缩逻辑的唯一实现处,供两条路径共用:
//   - 自动:useAiChat 在超预算时调用(mode='auto')
//   - 手动:用量面板的"压缩上下文"按钮调用(mode='manual')
//
// 为什么必须收敛到一处:压缩既要写 contextHistory(唯一写入口是
// chatStore.applyCompaction),又要记用量统计、又要冻结摘要 —— 两处实现
// 一旦分叉,缓存前缀稳定性就没人保证了。
//
// 两条铁律(依据 DeepSeek Context Caching:缓存前缀必须被完整匹配):
//   1. 未超预算时一条都不丢 → req(N) 成为 req(N+1) 的严格前缀
//   2. 必须压缩时一次裁够(批次化),而不是每轮丢一两条
//   3. 摘要一旦写入即冻结,下次压缩前不再重算(每轮重算会让前缀每轮都变)
// =============================================================================

import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { useUsageStore } from '../stores/usage'
import {
  computeInputBudget,
  planCompaction,
  planManualCompaction,
  SUMMARY_ENTRY_PREFIX,
  SUMMARY_TOKEN_ALLOWANCE,
} from '../utils/contextBudget'
import { estimateText } from '../utils/tokenEstimate'
import { requestSummary } from '../utils/summary'
import { devWarn } from '../utils/logger'

/** 压缩模式 */
export type CompactMode =
  /** 仅在超出输入预算时执行;不超则原样返回 null(保缓存最优路径) */
  | 'auto'
  /** 用户显式触发:无条件至少裁掉一半历史 */
  | 'manual'

/** 一次压缩的结果 */
export interface CompactionOutcome {
  /** 实际丢弃的条目数 */
  dropped: number
  /** 是否生成了冻结摘要(关闭自动压缩或总结 API 失败时为 false) */
  summarized: boolean
  /** 压缩前后预计输入 token(仅历史 + 固定前缀部分) */
  estimatedBefore: number
  estimatedAfter: number
}

export function useContextCompaction() {
  const chatStore = useChatStore()
  const settingsStore = useSettingsStore()
  const usageStore = useUsageStore()

  /**
   * 执行一次上下文压缩
   *
   * @param fixedPrefixText 两条 system 消息的原文(估算固定前缀体积)
   * @param mode            'auto' 超预算才压 / 'manual' 用户显式触发
   * @returns 压缩结果;未发生压缩(未超预算、历史为空、无可丢条目)时返回 null
   */
  async function compact(
    fixedPrefixText: string,
    mode: CompactMode,
  ): Promise<CompactionOutcome | null> {
    const sub = chatStore.activeSub
    if (sub === null) return null

    const entries = chatStore.getChatHistory()
    if (entries.length === 0) return null

    const cfg = settingsStore.apiConfig
    // 触发阈值 = 用户设定的占比 × 窗口(默认 80%),上限由 computeInputBudget 兜底
    const budget = computeInputBudget(cfg.contextWindow, cfg.maxTokens, cfg.compactTriggerPercent)
    const fixedTokens = estimateText(fixedPrefixText)

    let dropCount: number
    let estimatedBefore: number
    let estimatedAfter: number

    if (mode === 'auto') {
      const plan = planCompaction(entries, fixedTokens, 0, budget, usageStore.calibration)
      if (plan.verdict === 'ok' || plan.dropCount <= 0) return null
      dropCount = plan.dropCount
      estimatedBefore = plan.estimatedBefore
      estimatedAfter = plan.estimatedAfter
    } else {
      const plan = planManualCompaction(entries, fixedTokens, budget, usageStore.calibration)
      if (plan.dropCount <= 0) return null
      dropCount = plan.dropCount
      estimatedBefore = fixedTokens + plan.totalTokens
      // 摘要条目会新增体积,估算时算回去
      estimatedAfter = fixedTokens + plan.keepTokens + SUMMARY_TOKEN_ALLOWANCE
    }

    // ---- 生成冻结摘要 -------------------------------------------------------
    // 两条路径的策略刻意不同:
    //
    //   自动:总结失败只能降级为纯丢弃 —— 否则超预算的请求必然被服务端拒绝,
    //         聊不下去比丢点早期细节更糟。降级会打日志。
    //
    //   手动:用户显式点了"压缩上下文",要的就是"保住剧情、只压体积"。
    //         此时若总结失败还继续丢历史,等于把用户的记忆悄悄删了。
    //         所以手动路径**失败即中止**,一条都不动,并把错误抛给面板展示。
    //         手动路径也不受 autoCompact 开关约束(那是自动路径的开关)。
    let summaryText: string | undefined
    if (mode === 'manual') {
      let summary: string
      try {
        const dropped = entries.slice(0, dropCount)
        const api = await settingsStore.getSummaryApi()
        summary = await requestSummary(api.baseUrl, api.apiKey, api.model, dropped)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`摘要生成失败,未做任何改动：${msg}`)
      }
      summaryText = `${SUMMARY_ENTRY_PREFIX}\n${summary}`
    } else if (cfg.autoCompact) {
      try {
        const dropped = entries.slice(0, dropCount)
        const api = await settingsStore.getSummaryApi()
        const summary = await requestSummary(api.baseUrl, api.apiKey, api.model, dropped)
        summaryText = `${SUMMARY_ENTRY_PREFIX}\n${summary}`
      } catch (err) {
        devWarn('[compact] 摘要生成失败,降级为直接丢弃早期对话:', err)
      }
    }

    const dropped = chatStore.applyCompaction(sub, dropCount, summaryText)
    if (dropped <= 0) return null

    usageStore.noteCompaction()
    return {
      dropped,
      summarized: summaryText !== undefined,
      estimatedBefore,
      estimatedAfter,
    }
  }

  return { compact }
}
