// backendStream —— 后端 SSE 的逐字流式回合
// 一个节奏器边读 SSE 边把已定稿的段播出去，流结束后用 done 帧全文补完；收到任何
// delta 之前失败则回退非流式。不能把 delta 原样直出：上游一两秒内就推完全部增量，
// 直出在视觉上等于一次性全出，反而丢了逐拍手感。

import type { AiResponseCtx, useChatStore } from '../../stores/chat'
import type { ApiConfig } from '../../stores/settings'
import {
  BackendStreamUnavailableError,
  fetchBackendReply,
  fetchBackendReplyStream,
} from '../../utils/backend'
import type { BackendRequest } from '../../utils/backend'
import { splitAiSegments, splitAiSegmentsStreaming } from '../../utils/aiText'
import { delay } from '../../utils/delay'

type ChatStore = ReturnType<typeof useChatStore>

/** 后端 usage 的最小形状(避免引入 backend.ts 的类型耦合) */
interface BackendUsageLike {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

/**
 * 从后端返回的 usage 里取"本轮**输出** token"
 *
 * 为什么只累计输出 token:对话历史里逐轮累积增长的就是模型生成的部分;
 * 输入 token 每轮都会把整段历史重新算一遍,累加它无法反映历史长度。
 */
export function pickOutputTokens(usage?: BackendUsageLike): number {
  if (!usage || typeof usage !== 'object') return 0
  const c = Number(usage.completion_tokens)
  return Number.isFinite(c) && c > 0 ? c : 0
}

/**
 * 一次后端流式回合的结果
 *
 * - `finalized`:这一回合已经把回复播完并收尾(或已报错占位),调用方**直接返回**,
 *   不要再走常规分段播放,也不要再做用量记账 —— 与搬移前的 `return` 语义一致。
 * - `direct`:字符一个都没实时播出去(SSE 不可用 → 已回退非流式一次),
 *   调用方按既有流程继续(用量记账 + 分段播放)。
 */
export type BackendStreamOutcome =
  | { kind: 'finalized' }
  | { kind: 'direct'; fullText: string; mood?: string; outputTokens: number }

/** 运行时依赖(显式传入,避免模块内部再去 new 一个 store) */
export interface BackendStreamDeps {
  chat: ChatStore
  /** 分拍写入(useReplyReveal 的实现) */
  appendStaged: (text: string, ctx: AiResponseCtx) => Promise<void>
  /**
   * 空回复时静默收尾（抹掉加载气泡，不弹提示）
   *
   * 由调用方提供 —— 它要负责 `abortAiResponse` 那套清理。
   */
  onEmptyTurn: () => void
}

/** 回合参数 */
export interface BackendStreamParams {
  apiConfig: ApiConfig
  request: BackendRequest
  signal?: AbortSignal
  ctx: AiResponseCtx
  /** 设置项「智能消息分条」 */
  smartSplit: boolean
  /**
   * 设置项「done 帧兜底」（默认 true）
   *
   * true：done 帧的 reply 是空白、但逐帧已经收到过内容 → 用逐帧文本收尾
   * （否则短回复会被覆盖成空串，整轮白说）。
   */
  keepDeltasOnEmptyDone?: boolean
}

/**
 * 跑一次后端 SSE 回合
 *
 * @returns 见 BackendStreamOutcome
 * @throws 非"流式不可用"的错误原样抛出(交给调用方写错误气泡)
 */
export async function runBackendStream(
  deps: BackendStreamDeps,
  params: BackendStreamParams,
): Promise<BackendStreamOutcome> {
  const { chat, appendStaged, onEmptyTurn } = deps
  const { apiConfig, request, signal, ctx, smartSplit, keepDeltasOnEmptyDone } = params

  /** 已完成(实时播完并收尾) */
  const finalized: BackendStreamOutcome = { kind: 'finalized' }

  let revealBuf = ''
  let streamDone = false
  let pacerStop = false
  let playedCount = 0
  /** 本回合是否真的通过 SSE 逐字实时落过字 */
  let streamedLive = false
  let fullText = ''
  let pendingMood: string | undefined
  let backendOutputTokens = 0

  /** 播出一段(节奏与关闭 SSE 时的分段播放完全一致) */
  const playSegment = async (text: string, isLast: boolean): Promise<void> => {
    if (!text) return
    if (playedCount === 0) {
      // 首段:填入当前的 loading 气泡(mood 此刻多半还没到,收尾时补写)
      chat.setPendingAiMood(pendingMood, ctx)
      await appendStaged(text, ctx)
    } else {
      // 后续段:先停顿,再亮"头像 + 加载气泡",再落字
      await delay(600 + Math.random() * 400)
      if (!chat.isCtxActive(ctx)) return
      chat.beginAiSegment(ctx)
      await delay(900 + Math.random() * 600)
      if (!chat.isCtxActive(ctx)) return
      await appendStaged(text, ctx)
    }
    playedCount++
    if (!chat.isCtxActive(ctx)) return
    if (isLast) chat.finishAiResponse(ctx)
    else chat.finishAiSegment(ctx)
  }

  // 节奏器:与读流并行,边收边播"已定稿"的段
  const pacer = (async () => {
    while (!pacerStop) {
      if (!chat.isCtxActive(ctx)) return
      if (revealBuf.length === 0) {
        if (streamDone) return
        await delay(30)
        continue
      }
      // 只播已定稿的段(未闭合括号内部、以及可能继续增长的末段都不播),
      // consumed 是"这几个段在缓冲里占了多少字符",据此切缓冲 ——
      // 不用 indexOf 猜位置(文本里有重复片段时会切错地方)。
      const { segments, consumed } = splitAiSegmentsStreaming(revealBuf, smartSplit)
      if (consumed > 0) revealBuf = revealBuf.slice(consumed)
      if (segments.length > 0) {
        for (const seg of segments) {
          if (!chat.isCtxActive(ctx)) return
          await playSegment(seg, false)
        }
        continue
      }
      if (streamDone) return
      await delay(30)
    }
  })()

  try {
    const result = await fetchBackendReplyStream(apiConfig, request, {
      signal,
      keepDeltasWhenDoneEmpty: keepDeltasOnEmptyDone !== false,
      onDelta: (text) => {
        revealBuf += text
      },
    })
    fullText = result.reply
    // 可选 mood 字段(token 形式,如 sns_emoji_001);缺失时为 undefined
    pendingMood = result.mood
    backendOutputTokens = pickOutputTokens(result.usage)
    streamedLive = true
  } catch (err) {
    // 收到任何 delta 之前就失败(旧后端没有 /chat/stream、网络、非 2xx、
    // 响应不是 event-stream):回退到原来的非流式请求一次,用户无感。
    // 此时缓冲仍为空(揭示器一个字都没写过),回退后**照常走下面的分段
    // 播放**,与开关关闭时完全一致。
    if (!(err instanceof BackendStreamUnavailableError)) {
      pacerStop = true
      // 已收到的半截内容照常落进气泡(改造前 delta 是直出的,不能因为
      // 改成"节奏化播出"就把用户已经等到的字丢掉),再抛错交给错误气泡
      if (revealBuf) {
        chat.appendAiChunk(revealBuf, ctx)
        revealBuf = ''
      }
      throw err
    }
    const fallback = await fetchBackendReply(apiConfig, request, signal)
    fullText = fallback.reply
    pendingMood = fallback.mood
    backendOutputTokens = pickOutputTokens(fallback.usage)
  } finally {
    streamDone = true
  }
  await pacer

  // done 帧全文为空、但已经实时播过内容(后端异常):以已落下的字为准。
  // 各段在播放时已经各自 finishAiSegment 入了历史,这里只收尾。
  if (streamedLive && !fullText.trim() && playedCount > 0) {
    if (chat.isCtxActive(ctx)) chat.finishAiResponse(ctx)
    return finalized
  }

  // 一段都没播、全文还是空:空回复，静默收尾（抹掉加载气泡，不弹任何提示）
  if (streamedLive && !fullText.trim()) {
    onEmptyTurn()
    return finalized
  }

  if (streamedLive) {
    // ---- 收尾:按权威全文补完剩余段 ----------------------------------
    // 已经播过 playedCount 段 —— 它们的文本逐字等于权威分段的前缀:
    // splitAiSegmentsStreaming 只消费"已经定稿"的分组(未闭合括号内部、
    // 以及可能被后续增量改写的末段都不消费)。剩下的段一律取自 done 帧
    // 的权威全文,首段气泡补上 mood。
    const finalSegs = splitAiSegments(fullText, smartSplit)
    const rest = finalSegs.slice(playedCount)
    chat.setFirstAiMood(pendingMood, ctx)
    for (let i = 0; i < rest.length; i++) {
      if (!chat.isCtxActive(ctx)) return finalized
      await playSegment(rest[i], i === rest.length - 1)
    }
    if (chat.isCtxActive(ctx)) chat.finishAiResponse(ctx)
    return finalized
  }

  // 回退路径:气泡里没有流式内容 → 交回调用方走常规分段播放
  return { kind: 'direct', fullText, mood: pendingMood, outputTokens: backendOutputTokens }
}
