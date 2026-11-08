// useReplyReveal —— 一条消息内部的逐拍显示
// 按括号区间边界把文本分拍写入同一条消息：每拍只追加原文切片，拼起来恒等于
// 原文，所以 contextHistory 里仍是带括号的完整文本，喂给模型的内容一字未改。
// 单聊与群聊共用，避免两边节奏走散。

import { useChatStore, type AiResponseCtx } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { bracketPartRanges } from '../utils/aiText'

/** 拍间静默。比段间停顿短一档：同一段回复内间隔太长会读成两个人说话 */
const REVEAL_GAP_MIN = 420
const REVEAL_GAP_JITTER = 240

/** 台词拍落字前先亮加载气泡；居中拍不亮（居中文本无归属，静默出现） */
const REVEAL_TYPING_MIN = 700
const REVEAL_TYPING_JITTER = 360

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function useReplyReveal() {
  const chatStore = useChatStore()
  const settingsStore = useSettingsStore()

  /**
   * 分拍写入一段回复
   *
   * 关闭括号居中、或该段没有括号时一次写完，零额外延迟。本轮响应失效时立即收手，
   * 已写入的字符保留。
   */
  async function appendStaged(text: string, ctx: AiResponseCtx): Promise<void> {
    const ranges = settingsStore.bracketCenter ? bracketPartRanges(text) : []
    // 无括号（单区间）或开关关闭：一次写完
    if (ranges.length <= 1) {
      chatStore.appendAiChunk(text, ctx)
      return
    }
    let written = 0
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i]
      if (written > 0) {
        // 上一拍有 0.3s 淡入，别紧接着糊上下一个元素
        await delay(REVEAL_GAP_MIN + Math.random() * REVEAL_GAP_JITTER)
        if (!chatStore.isCtxActive(ctx)) return
        // 下一拍是台词气泡：先亮「头像 + 加载气泡」再落字
        if (!range.centered) {
          chatStore.beginAiSegment(ctx)
          await delay(REVEAL_TYPING_MIN + Math.random() * REVEAL_TYPING_JITTER)
          if (!chatStore.isCtxActive(ctx)) return
        }
      }
      // 按原文切片追加：written 到 range.end 之间的字符一个不少
      chatStore.appendAiChunk(text.slice(written, range.end), ctx)
      // 文字已落：收起刚亮的加载气泡（首拍由 appendAiChunk 建消息时收起）
      if (!range.centered) chatStore.endAiSegmentLoading(ctx)
      written = range.end
    }
  }

  return { appendStaged }
}
