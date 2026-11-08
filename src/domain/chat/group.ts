// group —— 群聊名推导、成员判定、主卡展示身份（纯函数）

import { DEFAULT_AVATAR_URL, findCharacter } from '../../constants/character'
import type { Card, GroupSpeakMode } from '../../types/chat'
import { MINE_NAME, resolveAvatar } from './identity'

export const GROUP_MIN_MEMBERS = 2

/** 成员数下限。人数上限已取消 */
export const GROUP_SETTINGS_MIN = 2

/** 群名最多展开几个成员名，超出折叠为「等 N 人」 */
export const GROUP_TITLE_HEAD = 3

export const GROUP_SPEAK_MODES: {
  key: GroupSpeakMode
  label: string
  desc: string
}[] = [
  { key: 'round', label: '轮流模式', desc: '我发言后，成员按顺序依次回复' },
  { key: 'smart', label: '智能模式', desc: '由系统判断下一个发言的成员' },
  { key: 'assign', label: '指定模式', desc: '我指定成员，被点名者单独回复' },
]

export function isGroupCard(card: Card | null | undefined): boolean {
  return (card?.members ?? []).length >= GROUP_MIN_MEMBERS
}

/** 群名里「我」的显示名：旁观与管理员都算管理员，扮演角色则用角色名 */
export function groupSelfName(myRole?: string): string {
  if (!myRole || myRole === 'admin' || myRole === 'observer') return MINE_NAME
  return myRole
}

/** ['A','B','C'] → A、B和C */
function joinWithAnd(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join('、')}和${names[names.length - 1]}`
}

/**
 * 群聊默认名称
 *
 * 只展开前 3 个成员名，其余折叠成人数：「我」不单独作为后缀出现，
 * 否则 3 人组会列出 4 个名字，比 4 人组还长。
 */
export function groupTitle(members: string[], selfName: string = MINE_NAME): string {
  if (members.length === 0) return `${selfName}的群聊`

  const total = members.length
  if (total <= GROUP_TITLE_HEAD) return `${joinWithAnd(members)}的群聊`

  return `${joinWithAnd(members.slice(0, GROUP_TITLE_HEAD))}等${total}人的群聊`
}

/**
 * 主卡的展示身份（名称 + 头像 + 是否群聊）
 *
 * 群聊卡的 avatar 只是占位，真实头像由 GroupCardItem 用成员头像拼九宫格自绘。
 */
export function resolveCardIdentity(card: Card): {
  name: string
  avatar: string
  isGroup: boolean
  avatarAlt?: string
} {
  if (isGroupCard(card)) {
    return {
      name: groupTitle(card.members ?? [], groupSelfName(card.myRole)),
      avatar: DEFAULT_AVATAR_URL,
      isGroup: true,
    }
  }
  const name = card.conversations[0]?.name ?? ''
  return {
    name,
    avatar: resolveAvatar(name),
    isGroup: false,
    avatarAlt: findCharacter(name)?.avatarAlt,
  }
}
