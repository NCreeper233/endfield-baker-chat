// initialCards —— 启动时的默认卡片集合
// ⚠ 必须经 createInitialCards() 取**新数组**，绝不直接持有 INITIAL_CARDS：
// store 增删是原地 push / splice，别名会污染常量，「清空对话」后脏数据又会被还回来。

import type { Card } from '../types/chat'
import { CHARACTERS } from './character'

const INITIAL_CARDS: Card[] = CHARACTERS.map((c) => ({
  conversations: [
    {
      name: c.name,
      messages: [],
    },
  ],
}))

export function createInitialCards(): Card[] {
  return INITIAL_CARDS.map((card) => deepClone(card))
}

/**
 * structuredClone 在鸿蒙 ArkWeb / 老安卓 WebView 上可能不存在，直接调用会让启动
 * seed 抛错白屏；卡片是纯 JSON，JSON 往返兼容性最好。
 */
function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch {
      // 落入 JSON 分支
    }
  }
  return JSON.parse(JSON.stringify(value)) as T
}
