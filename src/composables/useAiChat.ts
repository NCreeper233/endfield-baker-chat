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
import { buildBackendRequest, fetchBackendReply, BACKEND_HISTORY_LIMIT } from '../utils/backend'
import { EMPHASIS_RULE } from '../constants/prompts'
import { requestSummary } from '../utils/summary'

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

/**
 * 智能总结处理:当历史超过 50 条时,将超出部分总结并插入 history 最前面
 *
 * 返回处理后待发送的 history(包含摘要 + 最近 50 条原始消息)。
 * 失败时降级:返回最近 50 条原始消息(不插入摘要),并在控制台记录错误。
 * 纯 emoji / 纯图片消息不触发本逻辑(由调用方在发送前判断跳过)。
 */
async function applySmartSummary(
  history: ChatHistoryEntry[],
  settingsStore: ReturnType<typeof useSettingsStore>,
): Promise<ChatHistoryEntry[]> {
  const cfg = settingsStore.summaryConfig
  if (!cfg.enabled) return history.slice(-BACKEND_HISTORY_LIMIT)

  // 总条数 > 50 才需要总结
  if (history.length <= BACKEND_HISTORY_LIMIT) {
    return history
  }

  const excessCount = history.length - BACKEND_HISTORY_LIMIT
  const excess = history.slice(0, excessCount) // 前 N 条(超出部分)
  const recent = history.slice(excessCount) // 最近 50 条

  try {
    const api = settingsStore.getSummaryApi()
    const summary = await requestSummary(
      api.baseUrl,
      api.apiKey,
      api.model,
      excess,
    )
    // 摘要以 user 角色插入最前(避免后端无法处理多条 system)
    const summaryEntry: ChatHistoryEntry = {
      side: 'mine',
      text: `【对话总结】\n${summary}`,
    }
    return [summaryEntry, ...recent]
  } catch (err) {
    // 总结失败:降级为最近 50 条原始消息,不阻断聊天
    console.warn('[summary] 智能总结失败,降级为最近 50 条:', err)
    return recent
  }
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
    // 后端模式可选返回的心情表情 token(如 sns_emoji_001),缺失为 undefined
    let pendingMood: string | undefined

    try {
      if (backendInput) {
        // 后端模式:v5 拆分 global_prompt / character_prompt 两条 system 消息
        const request = buildBackendRequest(
          backendInput.message,
          characterName,
          backendInput.history,
          {
            // v5: global_prompt = 全局世界观/规则(FIXED_SYSTEM_PROMPT + 用户世界观)
            globalPrompt: (() => {
              const fixed = settingsStore.getFullSystemPrompt()
              const world = settingsStore.worldView.trim()
              return world ? `${fixed}\n\n【世界观背景】\n${world}` : fixed
            })(),
            // v5: character_prompt = 角色专属提示词 + 回复风格规则
            characterPrompt: (() => {
              const role = settingsStore.getCharacterPrompt(characterName)
              return role ? `${role}\n\n${EMPHASIS_RULE}` : EMPHASIS_RULE
            })(),
            // 兼容字段:合并后的完整 system 提示词(后端优先使用拆分字段)
            systemPrompt: (() => {
              const fixed = settingsStore.getFullSystemPrompt()
              const role = settingsStore.getCharacterPrompt(characterName)
              const roleWithRule = role
                ? `${role}\n\n${EMPHASIS_RULE}`
                : EMPHASIS_RULE
              return fixed ? `${fixed}\n\n【角色设定】\n${roleWithRule}` : roleWithRule
            })(),
            think: settingsStore.thinkEnabled,
            // v4: 实验性功能-强制每条搜索
            forceSearch: settingsStore.forceSearch,
            // v7: 实验性功能-沉浸式对话模式(false 时后端在角色提示词后追加禁止括号描写规则)
            immersiveMode: settingsStore.immersiveMode,
          },
        )
        const backendResult = await fetchBackendReply(
          settingsStore.apiConfig,
          request,
          chatStore.getAiSignal(),
        )
        fullText = backendResult.reply
        // 可选 mood 字段(token 形式,如 sns_emoji_001);缺失时为 undefined
        pendingMood = backendResult.mood
      } else {
        // 原有模式:系统提示词 + 全局世界观 + 角色提示词 + 历史消息,SSE 流式调用
        const systemPrompt = settingsStore.getFullSystemPrompt()
        const characterPrompt = settingsStore.getCharacterPrompt(characterName)
        // 角色提示词末尾追加强制回复风格规则(描述:台词 ≈ 2:1)
        const characterPromptWithRule = characterPrompt
          ? `${characterPrompt}\n\n${EMPHASIS_RULE}`
          : EMPHASIS_RULE
        const history = chatStore.getChatHistory()

        // v2:注入全局世界观背景（自定义 API 模式专用）
        const worldView = settingsStore.worldView.trim()
        const systemWithWorld = worldView
          ? `${systemPrompt}\n\n【世界观背景】\n${worldView}`
          : systemPrompt

        const messages = buildMessages(systemWithWorld, characterPromptWithRule, history)

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

    const rawSegments = normalizedText
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    // ---- 合并"纯括号段" ---------------------------------------------------
    // 模型偶发格式不稳定:把括号描写单独另起一行(如 "(动作)\n\n台词")。
    // 若照原样分段,会出现只有括号描写的独立消息,写入 contextHistory 后,
    // 下一轮模型会模仿历史中"只有括号的 assistant 回复",导致整段回复
    // 退化成只有括号描写没有台词。这里将纯括号段并入相邻段(优先并入下一段),
    // 保证显示与历史中都不会出现"只有括号"的独立消息。
    // 纯括号段:整段去掉首尾括号后无其他字符,如 "(微微颔首)"。
    const segments: string[] = []
    const pendingBrackets: string[] = []
    for (const seg of rawSegments) {
      if (/^\([^)]*\)$/.test(seg)) {
        pendingBrackets.push(seg)
        continue
      }
      // 正常段:把之前暂存的纯括号段拼到其开头(并入下一段)
      const prefix = pendingBrackets.splice(0, pendingBrackets.length).join('')
      segments.push(prefix + seg)
    }
    // 末尾仍有纯括号段(整段回复全是括号):并入上一段末尾,无上一段则保留
    if (pendingBrackets.length > 0) {
      const tail = pendingBrackets.join('')
      if (segments.length > 0) segments[segments.length - 1] += `\n${tail}`
      else segments.push(tail)
    }

    if (segments.length === 0) {
      // 无内容:结束响应(空的 loading 气泡会被 abortAiResponse 逻辑清理)
      chatStore.finishAiResponse()
      return
    }

    // ---- 第一段:填入当前 loading 气泡 -----------------------------------
    // 后端模式的心情表情(token)随首段消息一并写入(缺失时 appendAiChunk 拿到 undefined)
    chatStore.setPendingAiMood(pendingMood)
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
   *   2. 后端模式:先截取历史(不含当前输入),应用智能总结(超 50 条时),再添加用户消息
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
    let backendInput: BackendInput | undefined
    if (isBackend) {
      const rawHistory = chatStore.getChatHistory()
      // 智能总结:超 50 条时总结前 N 条并插入摘要(失败降级为最近 50 条)
      const history = await applySmartSummary(rawHistory, settingsStore)
      backendInput = { message: text, history }
    }

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

    // 后端模式:图片已由 sendImage 写入 contextHistory(最后一条,含 image dataURL)。
    // v3: 保留该条目在 history 中,让后端能拿到图片数据做 vision 识别(不再 slice 弹出)。
    const isBackend = settingsStore.apiConfig.apiMode === 'backend'
    let backendInput: BackendInput | undefined
    if (isBackend) {
      const history = chatStore.getChatHistory()
      // 图片消息也应用 50 条截断(智能总结跳过,保持纯图片流程不变)
      const trimmed = history.slice(-BACKEND_HISTORY_LIMIT)
      backendInput = {
        message: '[图片]',
        history: trimmed,
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
