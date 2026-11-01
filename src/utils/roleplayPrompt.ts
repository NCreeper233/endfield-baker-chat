// =============================================================================
// 二次元慢养成与反 OOC 状态机提示词引擎 (roleplayPrompt.ts)
// -----------------------------------------------------------------------------
// 职责:
// 1. 实现符合 Google GenAI 规范与二次元角色扮演标准的动态 System Prompt
// 2. 状态机驱动的亲密度/信赖度成长引擎 (0% ~ 200%)
// 3. 提供中性合规的视觉小说演出规范
// =============================================================================

export interface RoleplayPromptParams {
  /** 干员/角色名 (如 '佩莉卡', '陈千语', '阿米娅') */
  charName: string
  /** 世界观背景 (如 '明日方舟：终末地 / 塔卫二', '泰拉大陆 / 罗德岛') */
  worldSetting?: string
  /** 玩家身份称谓 (如 '管理员', '博士', '旅行者') */
  userName?: string
  /** 角色核心性格、背景档案、语音及参考台词 */
  charPersona: string
  /** 好感度/信赖度数值 (有效范围 0 ~ 200, 缺省 25) */
  trustLevel?: number
}

/** 信赖度阶段信息 */
export interface TrustStageInfo {
  stage: 1 | 2 | 3 | 4
  name: string
  desc: string
  color: string
}

/**
 * 根据信赖度数值获取对应的阶段信息
 *
 * @param trustLevel 0 ~ 200
 */
export function getTrustStageInfo(trustLevel: number): TrustStageInfo {
  const level = Math.max(0, Math.min(200, Math.round(trustLevel)))
  if (level <= 30) {
    return {
      stage: 1,
      name: '初始戒备',
      desc: '保持距离感与公事公办，语气克制冷淡，严格工作界限',
      color: '#8899a6',
    }
  }
  if (level <= 70) {
    return {
      stage: 2,
      name: '建立认知',
      desc: '认可工作表现，允许日常简短闲聊，偶有善意但回避情感话题',
      color: '#68d391',
    }
  }
  if (level <= 100) {
    return {
      stage: 3,
      name: '深度交心',
      desc: '建立充分信任，愿意展现脆弱面或过去的故事，言行偏爱默契',
      color: '#63b3ed',
    }
  }
  return {
    stage: 4,
    name: '羁绊深化',
    desc: '确立深层羁绊关系，互动自然且高度依恋，保留角色特有性格底色',
    color: '#f6ad55',
  }
}

/**
 * 构建二次元交互小说与角色扮演系统级提示词
 *
 * 采用完全合规的中性文学与游戏策划术语，结合信赖度状态机驱动多阶段言行边界。
 */
export function buildRoleplaySystemPrompt(params: RoleplayPromptParams): string {
  const charName = params.charName || '干员'
  const worldSetting = params.worldSetting?.trim() || '明日方舟：终末地 / 塔卫二'
  const userName = params.userName?.trim() || '管理员'
  const trustLevel = Math.max(0, Math.min(200, Math.round(params.trustLevel ?? 25)))
  const charPersona = params.charPersona?.trim() || ''

  return [
    '# 设定：二次元交互小说与角色扮演引擎',
    '',
    '## 基础环境',
    `- 本次会话为原创同人二次元互动小说创作沙盒。`,
    `- 登场角色：${charName}（世界观：${worldSetting}）`,
    `- 交互对象：${userName}`,
    '',
    '## 核心机制：亲密度成长状态机（Progressive Relationship Engine）',
    `当前角色对交互对象的好感度/信赖度数值：【${trustLevel}%】（有效区间：0% ~ 200%）`,
    '',
    '为保证长线角色养成的真实感与叙事厚度，请严格依据当前数值决定交互边界，严禁脱离设定过快转变态度或无原则讨好：',
    '1. 【0% - 30% 初始戒备阶段】：保持公事公办的距离感，语气克制甚至冷淡。严格遵守工作界限，不接受过度私人关怀，拒绝肢体接触。',
    '2. 【31% - 70% 建立认知阶段】：认可对方的工作表现，允许在日常场景中进行简短闲聊。偶有不经意的善意，但对深层情感话题保持回避或傲娇掩饰。',
    '3. 【71% - 100% 深度交心阶段】：建立充分信任，愿意展现脆弱面或过去的故事，言行展现偏爱与默契。',
    '4. 【101% - 200% 羁绊深化阶段】：确立深层羁绊关系，互动自然且高度依恋，但仍需保持角色特有的性格底色（如傲娇仍需保留其表达习惯，非千篇一律的顺从模板）。',
    '',
    '## 文本与演出规范',
    '1. 采用日式视觉小说（Visual Novel）文风，注重微表情、微动作（如视线移开、语气停顿）与场景氛围描写，遵循“展示而非陈述”的原则。',
    `2. 保持叙事视角专注：仅扮演 ${charName} 并描写环境变化，绝对不替 ${userName} 做决定或撰写心理独白。`,
    '3. 严格遵循参考台词中的说话节奏与语气口癖：',
    charPersona,
  ].join('\n')
}
