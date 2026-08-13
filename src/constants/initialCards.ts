// =============================================================================
// 初始卡片集合(应用启动时的默认状态)
// -----------------------------------------------------------------------------
// 默认为所有内置角色(管理员除外)各创建一张主卡 + 一张子卡,
// 用户打开应用即可看到全部角色列表,点击即聊。
//
// ⚠ 别名纪律:store 的 cards 与 DataManagerDialog"清空对话"一律消费
// createInitialCards() 的**新数组**,绝不直接持用 INITIAL_CARDS 引用——
// store 增删是原地 push / splice,若与模块常量别名,建卡/删卡会污染常量,
// 后续"清空对话"会把脏常量当"空工程"还回来。工厂深拷贝保证每份独立。
// =============================================================================

import type { Card } from '../types/chat'
import { CHARACTERS } from './character'

/**
 * 初始卡片集合:每个角色一张主卡 + 一张默认子卡(空消息列表)
 *
 * 仅作为来源数据,禁止在 store 中原地持有。
 */
const INITIAL_CARDS: Card[] = CHARACTERS.map((c) => ({
  conversations: [
    {
      name: c.name,
      messages: [],
    },
  ],
}))

/**
 * 生成一份全新的初始卡片副本(深拷贝)
 *
 * store 启动 seed 与"清空对话"重置都应调用本工厂而非直接引用 INITIAL_CARDS:
 * 返回的数组不与常量共享引用,后续 store 原地增删元素不会污染常量。
 */
export function createInitialCards(): Card[] {
  return INITIAL_CARDS.map((card) => structuredClone(card))
}
