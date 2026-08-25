// =============================================================================
// Python 后端调用层(backend.ts)
// -----------------------------------------------------------------------------
// 后端模式(apiMode === 'backend')的专属 API 层:
//   - 每个角色一个固定后端地址(见 CHARACTER_BACKEND_URLS),前端不拼接任何
//     提示词,只负责传递原始数据:
//     当前输入(message) + 最近 10 轮问答历史(history) + 角色中文名(character)
//   - 后端运行 Python 脚本处理后返回 { reply: "完整回复" }(一次性 JSON)
//   - 前端收到 reply 后交由 useAiChat 复用现有"按 \n 分段 + 假打字"展示节奏
//
// 契约说明见 docs/backend-contract.md
// =============================================================================

import type { ApiConfig } from '../stores/settings'

/** 后端请求的历史条目(OpenAI 风格 role/content) */
export interface BackendHistoryEntry {
  role: 'user' | 'assistant'
  content: string
  /** v3: 图片 dataURL（识图用；无图片时缺省） */
  image?: string
}

/** 后端请求体(与 docs/backend-contract.md 保持一致) */
export interface BackendRequest {
  /** 当前用户输入(不重复出现在 history 中) */
  message: string
  /** 最近 25 轮问答历史(最多 50 条,从旧到新,图片以 "[图片]" 占位) */
  history: BackendHistoryEntry[]
  /** 角色中文名(后端自行映射英文 ID) */
  character: string
  /** v2: 固定世界观 system 提示词(默认 API 模式也随请求传递,兼容字段) */
  system_prompt?: string
  /** v5: 全局世界观/规则(后端拆分为独立 system 消息,优先使用) */
  global_prompt?: string
  /** v5: 角色专属提示词(后端拆分为独立 system 消息,优先使用) */
  character_prompt?: string
  /** v3: 思考模式开关 */
  think?: boolean
  /** v4: 实验性功能-强制每条搜索(开启时后端强制触发搜索;关闭时 false 或缺省) */
  force_search?: boolean
  /** v7: 实验性功能-沉浸式对话模式(true 或缺省=保留括号描写;false=后端追加禁止括号规则) */
  immersive_mode?: boolean
}

/** 后端响应体 */
export interface BackendReply {
  /** 角色完整回复 */
  reply: string
  /** 可选:角色当前心情表情 token(如 sns_emoji_001),缺失时前端不展示 */
  mood?: string
}

/** fetchBackendReply 的解析结果 */
export interface BackendReplyResult {
  /** 角色完整回复文本 */
  reply: string
  /** 可选:心情表情 token(后端未返回时为 undefined) */
  mood?: string
}

/**
 * 角色 → 固定后端地址(键名以 character.ts 的应用内角色名为准)
 *
 * 每个角色一个独立后端(子域名),最终地址 = https://<子域名>/chat。
 * 地址内置在代码里、不在 UI 显示,仅用于后端模式内部路由。
 * 未收录的角色(自定义/无后端)请求时会报"未找到固定后端地址"。
 */
export const CHARACTER_BACKEND_URLS: Record<string, string> = {
  佩丽卡: 'https://perlica.peilika.beer/chat',
  陈千语: 'https://chenqianyu.peilika.beer/chat',
  弧光: 'https://huguang.peilika.beer/chat',
  弭弗: 'https://mifei.peilika.beer/chat',
  昼雪: 'https://zhouxue.peilika.beer/chat',
  梨诺: 'https://linuo.peilika.beer/chat',
  汤汤: 'https://tangtang.peilika.beer/chat',
  洁尔佩塔: 'https://jieerpeita.peilika.beer/chat',
  洛茜: 'https://luoxi.peilika.beer/chat',
  狼卫: 'https://langwei.peilika.beer/chat',
  秋栗: 'https://qiuli.peilika.beer/chat',
  艾尔黛拉: 'https://aierdaila.peilika.beer/chat',
  艾维文娜: 'https://aiweiwena.peilika.beer/chat',
  莱万汀: 'https://laiwanting.peilika.beer/chat',
  萤石: 'https://yingshi.peilika.beer/chat',
  赛希: 'https://saixi.peilika.beer/chat',
  阿列什: 'https://alieshi.peilika.beer/chat',
  骏卫: 'https://junwei.peilika.beer/chat',
  黎风: 'https://lifeng.peilika.beer/chat',
  大潘: 'https://dapan.peilika.beer/chat',
  安塔尔: 'https://antaer.peilika.beer/chat',
  埃特拉: 'https://aitela.peilika.beer/chat',
  卡契尔: 'https://kaqier.peilika.beer/chat',
  别礼: 'https://bieli.peilika.beer/chat',
  余烬: 'https://yujin.peilika.beer/chat',
  伊冯: 'https://yifeng.peilika.beer/chat',
  诀: 'https://jue.peilika.beer/chat',
  卡缪: 'https://kamiu.peilika.beer/chat',
  庄方宜: 'https://zhuangfangyi.peilika.beer/chat',
}

/**
 * 解析角色对应的后端地址
 *
 * 优先查固定映射表;未收录角色回退 fallback(历史配置的 backendUrl),
 * 再没有则返回空串(由调用方给出明确报错)。
 */
export function resolveBackendUrl(character: string, fallback = ''): string {
  return CHARACTER_BACKEND_URLS[character] ?? fallback
}

/** 最近保留的问答轮数(1 轮 = 1 条用户 + 1 条 AI 回复) */
export const BACKEND_HISTORY_ROUNDS = 25

/** 最近保留的历史条数(25 轮 × 2) */
export const BACKEND_HISTORY_LIMIT = BACKEND_HISTORY_ROUNDS * 2

/**
 * 组装后端请求体
 *
 * 将前端历史({side, text, image?})映射为后端格式:
 *   - mine → user / other → assistant
 *   - 图片消息:content 用 "[图片]" 占位,不传 base64 dataURL(避免请求膨胀)
 *   - 仅截取最近 25 轮(50 条),从旧到新;不足则全部发送
 *   - 当前输入单独放 message,不在 history 中
 *     (调用方负责传入"发送前"截取的历史,不含当前输入)
 *
 * @param message   当前用户输入
 * @param character 角色中文名(对话名,后端自行映射)
 * @param history   截取前的完整历史(不含当前输入)
 */
export function buildBackendRequest(
  message: string,
  character: string,
  history: Array<{ side: 'other' | 'mine'; text: string; image?: string }>,
  options?: {
    systemPrompt?: string
    globalPrompt?: string
    characterPrompt?: string
    think?: boolean
    forceSearch?: boolean
    immersiveMode?: boolean
  },
): BackendRequest {
  const entries: BackendHistoryEntry[] = history
    .slice(-BACKEND_HISTORY_LIMIT)
    .map((h) => ({
      role: h.side === 'mine' ? 'user' : 'assistant',
      content: h.image ? '[图片]' : h.text,
      image: h.image || undefined,
    }))
  return {
    message,
    history: entries,
    character,
    system_prompt: options?.systemPrompt || undefined,
    global_prompt: options?.globalPrompt || undefined,
    character_prompt: options?.characterPrompt || undefined,
    think: options?.think ?? false,
    force_search: options?.forceSearch ?? false,
    immersive_mode: options?.immersiveMode ?? true,
  }
}

/**
 * 请求后端并返回完整回复文本
 *
 * POST JSON 到该角色固定的后端地址(CHARACTER_BACKEND_URLS 解析,
 * 未收录角色回退 config.backendUrl),解析一次性响应 { reply }。
 * 与 streamChat 保持一致的语义:
 *   - 用户中止(AbortError):返回空串,不算错误
 *   - 非 2xx / 响应体非 JSON / 缺少 reply:抛出错误(由调用方显示)
 *
 * @param config  API 配置(需 apiMode === 'backend')
 * @param request 后端请求体(character 决定目标地址)
 * @param signal  AbortController(外部传入以便中止)
 * @returns reply 文本与可选 mood(token 形式,如 sns_emoji_001;后端未返回时为 undefined)
 */
export async function fetchBackendReply(
  config: ApiConfig,
  request: BackendRequest,
  signal?: AbortSignal,
): Promise<BackendReplyResult> {
  const url = resolveBackendUrl(request.character, config.backendUrl)
  if (!url) {
    throw new Error(`后端地址未配置：未找到角色「${request.character}」的固定后端地址`)
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { reply: '' }
    }
    throw new Error(`后端请求失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText)
    throw new Error(`后端请求失败 (${response.status}): ${errText}`)
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error('后端响应不是有效的 JSON')
  }

  const payload = data as BackendReply | null
  const reply = payload?.reply
  if (typeof reply !== 'string') {
    throw new Error('后端响应缺少 reply 字段')
  }
  const mood = typeof payload?.mood === 'string' ? payload.mood : undefined
  return { reply, mood }
}

/**
 * 测试后端连接(设置弹窗"连接测试"按钮)
 *
 * 按真实契约向指定角色的固定后端地址发送一条最小请求
 * (空历史 + 空角色),2xx 即视为连接成功;
 * 若后端对字段有强校验,错误信息会原样透出便于排查。
 *
 * @param config    API 配置
 * @param character 要测试的角色名(解析其固定地址;为空则回退 config.backendUrl)
 */
export async function testBackendConnection(
  config: ApiConfig,
  character = '',
): Promise<{ ok: boolean; message: string }> {
  const url = resolveBackendUrl(character, config.backendUrl)
  if (!url) {
    return {
      ok: false,
      message: character
        ? `未找到角色「${character}」的后端地址`
        : '未找到可测试的后端地址（请选中一个对话后再测试）',
    }
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '连接测试',
        history: [],
        character: '',
      } satisfies BackendRequest),
    })
    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText)
      return { ok: false, message: `连接失败 (${response.status}): ${errText}` }
    }
    return { ok: true, message: '连接成功' }
  } catch (err) {
    return { ok: false, message: `连接失败: ${err instanceof Error ? err.message : String(err)}` }
  }
}
