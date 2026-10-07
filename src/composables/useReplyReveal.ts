// =============================================================================
// AI 回复逐拍显示(useReplyReveal)
// -----------------------------------------------------------------------------
// 为什么需要:
//   开启「括号描写居中」后,一段回复里的括号描写与台词是两个视觉条目
//   (居中条 + 气泡)。若两者同时出现,居中条的入场动画、以及它与台词之间
//   该有的间隔,全都看不出来 —— 用户看到的是"糊在一起"。
//
// 做法:按**括号区间边界**把一段文本分拍写入同一条消息:
//   - 每拍只追加"这一拍应有的字符",msg.text 逐步累积;切片取自原文,
//     拼起来**恒等于整段原文** → contextHistory 写进去的仍是带括号的完整文本,
//     模型看到的历史与分拍前一字不差(绝不因为显示节奏而改动喂给模型的内容)
//   - 拍与拍之间留间隔,居中条先入场、台词随后跟上
//   - **台词拍落字前先亮一次"头像 + 加载气泡"**(居中拍不亮):居中条后面那句
//     台词与普通新消息一样先"正在输入"再出现,而不是凭空冒出文字
//   - 后一拍的气泡行是"新出现的行",自然从加载气泡尺寸过渡入场(见 useChatRows
//     的 frozenPrevRects),无需额外动画
//
// 与「分段显示」的分工:
//   - 分段(utils/aiText.splitAiSegments)= 一次回复切成几条**消息**,落库单位
//   - 分拍(本文件)= 一条消息内几个**部件**的显示节奏,不改变消息边界
//
// 单聊(useAiChat)与群聊(useGroupChat)共用本实现,避免两处节奏走散。
// =============================================================================

import { useChatStore, type AiResponseCtx } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { bracketPartRanges } from '../utils/aiText'

/**
 * 拍与拍之间的静默间隔(ms)
 *
 * 比"段与段"的停顿(600~1000ms 空档 + 900~1500ms 假 loading)明显短一档:
 * 同一段回复内的部件属于同一次发言,间隔太长会读成两个人说话。
 */
const REVEAL_GAP_MIN = 420
const REVEAL_GAP_JITTER = 240

/**
 * 台词拍落字**之前**先亮加载气泡的时长(ms)
 *
 * 居中条后面的那句台词不是凭空冒出来的:与普通新消息一样,先"正在输入"
 * (头像 + 加载气泡),再落字。居中拍不亮 —— 居中文本无归属,与 maker 的
 * "居中提示文本静默出现"一致。
 */
const REVEAL_TYPING_MIN = 700
const REVEAL_TYPING_JITTER = 360

/** 延迟工具(ms) */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function useReplyReveal() {
  const chatStore = useChatStore()
  const settingsStore = useSettingsStore()

  /**
   * 分拍写入一段回复文本
   *
   * 关闭「括号描写居中」、或该段没有括号描写时整段一次写入 ——
   * 与分拍功能加入之前的行为完全一致(零额外延迟)。
   *
   * 中途本轮响应失效(用户停止 / 同会话又发起新请求)时立即收手,
   * 已写入的字符保留(与分段显示的既有语义一致)。
   *
   * @param text 该段回复的完整文本(调用方已 normalize)
   * @param ctx  目标响应上下文
   */
  async function appendStaged(text: string, ctx: AiResponseCtx): Promise<void> {
    const ranges = settingsStore.bracketCenter ? bracketPartRanges(text) : []
    // 无括号(单区间)或开关关闭:一次写完
    if (ranges.length <= 1) {
      chatStore.appendAiChunk(text, ctx)
      return
    }
    let written = 0
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i]
      if (written > 0) {
        // 拍间呼吸:上一拍刚入场(居中条有 0.3s 淡入),别紧接着糊上下一个元素
        await delay(REVEAL_GAP_MIN + Math.random() * REVEAL_GAP_JITTER)
        if (!chatStore.isCtxActive(ctx)) return
        // 下一拍是**台词气泡**:先亮出"头像 + 加载气泡"再落字
        // (居中拍整段跳过 —— 它无归属,静默出现)
        if (!range.centered) {
          chatStore.beginAiSegment(ctx)
          await delay(REVEAL_TYPING_MIN + Math.random() * REVEAL_TYPING_JITTER)
          if (!chatStore.isCtxActive(ctx)) return
        }
      }
      // 按原文切片追加:written 到 range.end 之间的字符一个不少
      chatStore.appendAiChunk(text.slice(written, range.end), ctx)
      // 文字已落:收起刚亮的加载气泡(首拍的 loading 由 appendAiChunk 建消息时收起)
      if (!range.centered) chatStore.endAiSegmentLoading(ctx)
      written = range.end
    }
  }

  return { appendStaged }
}
