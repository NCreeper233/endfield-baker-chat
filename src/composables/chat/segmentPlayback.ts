// segmentPlayback —— 「一次回复切成 N 条气泡逐条出现」的唯一实现
// 分段 = 一条回复 → 几条消息（落库单位）；分拍 = 一条消息内几个部件（useReplyReveal）。
// 每拍之后都检查 isCtxActive：用户点停止或同会话又发起新请求时立刻收手。

import type { AiResponseCtx, useChatStore } from '../../stores/chat'
import { delay } from '../../utils/delay'

type ChatStore = ReturnType<typeof useChatStore>

/** 段与段之间的停顿区间(ms) */
const GAP_MIN = 600
const GAP_JITTER = 400
/** 段间"对方正在输入"的假 loading 时长区间(ms) */
const TYPING_MIN = 900
const TYPING_JITTER = 600

export interface SegmentPlaybackDeps {
  chat: ChatStore
  /** 分拍写入(useReplyReveal.appendStaged) */
  appendStaged: (text: string, ctx: AiResponseCtx) => Promise<void>
}

/**
 * 首段填入当前 loading 气泡（顺带消费 mood），后续段停顿 → 亮头像与加载气泡 → 落字。
 * 中途本轮失效（用户停止 / 同会话新请求）立即停手，已写入的字符保留。
 */
export async function playSegments(
  deps: SegmentPlaybackDeps,
  ctx: AiResponseCtx,
  segments: string[],
  pendingMood?: string,
): Promise<void> {
  const { chat, appendStaged } = deps

  if (segments.length === 0) {
    // 无内容:结束响应(空的 loading 气泡会被 abortAiResponse 逻辑清理)
    chat.finishAiResponse(ctx)
    return
  }

  // ---- 第一段:填入当前 loading 气泡 -----------------------------------
  // 心情表情(token)随首段消息一并写入(缺失时 appendAiChunk 拿到 undefined)
  chat.setPendingAiMood(pendingMood, ctx)
  // 分拍写入:开启「括号描写居中」时,居中条与台词之间留出间隔(见 useReplyReveal)
  await appendStaged(segments[0], ctx)
  if (!chat.isCtxActive(ctx)) return

  if (segments.length === 1) {
    // 单段:直接结束
    chat.finishAiResponse(ctx)
    return
  }

  // 多段:完成第一段(整体响应保持进行中)
  chat.finishAiSegment(ctx)

  // ---- 后续段:逐条顺序显示 ---------------------------------------------
  for (let i = 1; i < segments.length; i++) {
    // 本轮已失效检查(用户点停止,或同一会话又发起了新请求)
    if (!chat.isCtxActive(ctx)) break

    // 段间延迟(模拟"对方正在输入"的节奏)
    await delay(GAP_MIN + Math.random() * GAP_JITTER)
    if (!chat.isCtxActive(ctx)) break

    // 复用同一上下文重新开启 loading 气泡
    // (不可改用 beginAiResponse:那会生成新上下文并让本轮被判为陈旧)
    chat.beginAiSegment(ctx)

    // 假 loading 动画展示(模拟"对方正在输入"的节奏)
    await delay(TYPING_MIN + Math.random() * TYPING_JITTER)
    if (!chat.isCtxActive(ctx)) break

    // 填入本段文字(同样按部件分拍)
    await appendStaged(segments[i], ctx)
    if (!chat.isCtxActive(ctx)) break

    // 最后一段:结束整体响应;中间段:保持响应状态
    if (i < segments.length - 1) {
      chat.finishAiSegment(ctx)
    } else {
      chat.finishAiResponse(ctx)
    }
  }

  // 如果循环中途 break(用户中止),确保状态清理
  if (chat.isCtxActive(ctx)) {
    chat.finishAiResponse(ctx)
  }
}
