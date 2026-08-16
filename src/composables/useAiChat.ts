// =============================================================================
// AI 聊天编排 composable(useAiChat)
// -----------------------------------------------------------------------------
// 连接 store(chat) + settings + llm,编排完整的 AI 聊天流程:
//   1. 用户发送消息 → store.sendUserMessage
//   2. 构建 LLM 消息(系统提示词 + 角色提示词 + 历史消息)
//   3. 创建 AI 占位消息 → store.startAiResponse(loading 动画)
//   4. 流式调用 API,缓冲完整回复(loading 动画持续)
//   5. 回复完成 → 按 \n 分段,逐段顺序显示:
//      - 第一段填入当前 loading 气泡 → finishAiSegment
//      - 后续段:短暂假 loading → 新气泡显示该段 → finishAiSegment
//      - 最后一段:finishAiResponse(结束整体响应)
// =============================================================================

import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { streamChat, buildMessages } from '../utils/llm'
import { buildBackendRequest, fetchBackendReply } from '../utils/backend'

/** 聊天历史条目(与 chat store 的 contextHistory 形状一致) */
type ChatHistoryEntry = { side: 'other' | 'mine'; text: string; image?: string }

/** 后端模式输入:当前消息 + 发送前截取的历史(不含当前输入) */
interface BackendInput {
  message: string
  history: ChatHistoryEntry[]
}

/** 延迟工具(ms):分段显示模拟"对方正在输入"的节奏 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function useAiChat() {
  const chatStore = useChatStore()
  const settingsStore = useSettingsStore()

  /**
   * 触发 AI 流式回复(内部公共逻辑)
   *
   * 从当前对话读取角色信息 + 历史消息,构建请求。
   * - 后端模式(传入 backendInput):只传递原始数据(message/history/character),
   *   提示词与处理全部由后端 Python 脚本负责,一次性拿到 { reply } 后分段显示。
   * - 其他模式:沿用原有 system + 角色提示词 + OpenAI 格式流式调用。
   *
   * 流式缓冲完整回复后,按换行分段,逐段创建气泡顺序显示。
   * 每段之间有短暂假 loading 动画,模拟"逐条发送"的聊天节奏。
   */
  async function triggerAiResponse(backendInput?: BackendInput): Promise<void> {
    if (chatStore.activeSub === null) return
    const conv = chatStore.conversations[chatStore.activeSub]
    if (!conv) return
    const characterName = conv.name

    // 构建角色头像/名称
    const meta = chatStore.currentConversationMeta
    const speakerName = characterName
    const speakerAvatar = meta?.avatar ?? ''

    // 创建第一个 loading 气泡
    chatStore.startAiResponse(speakerName, speakerAvatar)

    // ---- 请求并缓冲完整回复(loading 动画持续,不实时显示文字) -------------
    let fullText = ''

    try {
      if (backendInput) {
        // 后端模式:前端只负责传递,不拼接任何提示词
        const request = buildBackendRequest(
          backendInput.message,
          characterName,
          backendInput.history,
        )
        fullText = await fetchBackendReply(
          settingsStore.apiConfig,
          request,
          chatStore.getAiSignal(),
        )
      } else {
        // 原有模式:系统提示词 + 角色提示词 + 历史消息,SSE 流式调用
        const systemPrompt = settingsStore.getFullSystemPrompt()
        const characterPrompt = settingsStore.getCharacterPrompt(characterName)
        const history = chatStore.getChatHistory()

        const messages = buildMessages(systemPrompt, characterPrompt, history)

        await streamChat({
          config: settingsStore.apiConfig,
          messages,
          signal: chatStore.getAiSignal(),
          onChunk: (chunk) => {
            fullText += chunk
          },
          onDone: (full) => {
            fullText = full
          },
        })
      }
    } catch (err) {
      // AbortError:用户主动中止,请求层返回空串而非抛错,此处仅兜底
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      // 其他错误:在当前 loading 气泡中显示错误信息
      const errMsg = err instanceof Error ? err.message : String(err)
      chatStore.appendAiChunk(`[错误: ${errMsg}]`)
      chatStore.finishAiResponse()
      return
    }

    // 用户在流式期间中止:不继续分段显示
    if (!chatStore.isAiResponding) return

    // ---- 分段:按换行拆分,过滤空行 ---------------------------------------
    // 部分模型/API 代理双重 JSON 编码,导致 JSON.parse 后仍残留字面量转义序列:
    //   \\n(双反斜杠+n)→ 若直接 /\\n/g 只消费第二组 \n,残留第一个 \ 显示为 "\"
    //   \\\" → 残留 \" 显示为反斜杠+引号
    // 处理顺序:先 \\\\ → \\(双反斜杠合并),再处理 \n / \" / \r
    const normalizedText = fullText
      .replace(/\r\n/g, '\n')   // Windows 换行统一
      .replace(/\\\\/g, '\\')   // 双反斜杠 → 单反斜杠(须先于 \n \" 处理)
      .replace(/\\n/g, '\n')    // 字面量 \n → 实际换行
      .replace(/\\r/g, '')      // 清除残留字面量 \r
      .replace(/\\"/g, '"')     // 字面量 \" → "

    const segments = normalizedText
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    if (segments.length === 0) {
      // 无内容:结束响应(空的 loading 气泡会被 abortAiResponse 逻辑清理)
      chatStore.finishAiResponse()
      return
    }

    // ---- 第一段:填入当前 loading 气泡 -----------------------------------
    chatStore.appendAiChunk(segments[0])

    if (segments.length === 1) {
      // 单段:直接结束
      chatStore.finishAiResponse()
      return
    }

    // 多段:完成第一段(保持 isAiResponding=true)
    chatStore.finishAiSegment()

    // ---- 后续段:逐条顺序显示 ---------------------------------------------
    for (let i = 1; i < segments.length; i++) {
      // 用户中止检查
      if (!chatStore.isAiResponding) break

      // 段间延迟(模拟"对方正在输入"的节奏)
      await delay(600 + Math.random() * 400)
      if (!chatStore.isAiResponding) break

      // 创建新 loading 气泡
      chatStore.startAiResponse(speakerName, speakerAvatar)

      // 假 loading 动画展示(模拟"对方正在输入"的节奏)
      await delay(900 + Math.random() * 600)
      if (!chatStore.isAiResponding) break

      // 填入本段文字
      chatStore.appendAiChunk(segments[i])

      // 最后一段:结束整体响应;中间段:保持响应状态
      if (i < segments.length - 1) {
        chatStore.finishAiSegment()
      } else {
        chatStore.finishAiResponse()
      }
    }

    // 如果循环中途 break(用户中止),确保状态清理
    if (chatStore.isAiResponding) {
      chatStore.finishAiResponse()
    }
  }

  /**
   * 发送文本消息并触发 AI 流式回复
   *
   * 完整流程:
   *   1. 检查 API 配置(未配置时抛出错误,由调用方引导用户配置)
   *   2. 后端模式:先截取历史(不含当前输入),再添加用户消息到对话
   *   3. 触发 AI 响应(后端模式拿到 reply 后 / 原有模式流式分段顺序显示)
   *
   * @param text 用户输入文本
   * @throws API 未配置时抛出错误
   */
  async function sendAndWaitForAi(text: string): Promise<void> {
    if (chatStore.activeSub === null) return

    // 检查 API 配置
    if (!settingsStore.isApiConfigured) {
      throw new Error('API 未配置：请先在设置中填写 Base URL、API Key 和模型名')
    }

    // 后端模式:先截取历史(此时尚未写入当前输入,天然不含它)
    const isBackend = settingsStore.apiConfig.apiMode === 'backend'
    const backendInput: BackendInput | undefined = isBackend
      ? { message: text, history: chatStore.getChatHistory() }
      : undefined

    // 1. 添加用户消息(含上下文历史同步)
    chatStore.sendUserMessage(text)

    // 2. 触发 AI 响应
    await triggerAiResponse(backendInput)
  }

  /**
   * 图片发送后触发 AI 流式回复
   *
   * 图片消息已由 store.sendImage 添加(含上下文历史同步),
   * 此方法仅负责触发 AI 响应流程(后端模式:message 传 "[图片]",
   * 历史弹出刚写入的图片条目;原有模式:分段顺序显示)。
   *
   * @throws API 未配置时抛出错误
   */
  async function respondAfterImage(): Promise<void> {
    if (chatStore.activeSub === null) return

    // 检查 API 配置
    if (!settingsStore.isApiConfigured) {
      throw new Error('API 未配置：请先在设置中填写 Base URL、API Key 和模型名')
    }

    // 后端模式:图片已由 sendImage 写入 contextHistory(最后一条),
    // 用 slice 弹出它(不修改 store 数据),历史中不含当前输入
    const isBackend = settingsStore.apiConfig.apiMode === 'backend'
    let backendInput: BackendInput | undefined
    if (isBackend) {
      const history = chatStore.getChatHistory()
      backendInput = {
        message: '[图片]',
        history: history.slice(0, -1),
      }
    }

    // 图片消息已由 sendImage 添加,直接触发 AI 响应
    await triggerAiResponse(backendInput)
  }

  /** 中止当前 AI 响应(中止流式请求 + 停止后续分段显示) */
  function abort() {
    chatStore.abortAiResponse()
  }

  return {
    sendAndWaitForAi,
    respondAfterImage,
    abort,
  }
}
