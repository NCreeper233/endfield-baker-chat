// identity —— 说话人身份解析（纯函数，不读 store、不碰 DOM）

import { DEFAULT_AVATAR_URL, findCharacter } from '../../constants/character'
import type { MessageSpeaker } from '../../types/chat'

/** 我方固定身份名，会作为署名发给模型 */
export const MINE_NAME = '管理员'

export function resolveAvatar(name: string): string {
  return findCharacter(name)?.avatar ?? DEFAULT_AVATAR_URL
}

/** mine 侧消息是否由「我扮演的角色」发出（而非管理员） */
export function isRolePlayMessage(msg: MessageSpeaker): boolean {
  return msg.side === 'mine' && !!msg.speakerName && msg.speakerName !== MINE_NAME
}

/**
 * 解析一条消息该显示谁的头像
 *
 * other 侧优先取角色表里的**实时**头像而非消息里存的快照 —— 换形象后历史消息
 * 要立刻跟着变；查不到才回退 speakerAvatar，再回退会话默认头像。
 *
 * @param convName 会话原始名，旧数据没记 speakerName 时用它查角色
 * @param altAvatarOf 取角色第二张形象，由调用方注入以保持本函数纯净
 */
export function resolveMessageAvatar(
  msg: MessageSpeaker,
  convName: string,
  otherUrl: string,
  mineUrl: string,
  altAvatarOf?: (name: string) => string | undefined,
): string {
  if (msg.side === 'mine') {
    const selfName = msg.speakerName
    if (selfName && selfName !== MINE_NAME) {
      const c = findCharacter(selfName)
      if (c?.avatar) return altAvatarOf?.(selfName) ?? c.avatar
      if (msg.speakerAvatar) return msg.speakerAvatar
    }
    return mineUrl
  }
  const name = msg.speakerName ?? convName
  if (name) {
    const c = findCharacter(name)
    if (c) return altAvatarOf?.(name) ?? c.avatar
  }
  if (msg.speakerAvatar) return msg.speakerAvatar
  return otherUrl
}
