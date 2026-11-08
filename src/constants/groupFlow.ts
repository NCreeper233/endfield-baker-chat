// groupFlow —— 「指定发言」分段胶囊与角色下拉菜单的尺寸
// 两个消费者共用同一套数字：ChatArea 用它预留滚动高度、GroupFlowControl 用它排版，
// 各写一份字面量就会改一处静默错位。移动端刻意收紧，桌面值与既有实现一致。

/** 尺寸单位均为 px */
export interface FlowMetrics {
  pillH: number
  pillGap: number
  pillBottomGap: number
  font: number
  segGoPadX: number
  segPickPadX: number
  /** 角色名最大宽度：超出省略，避免把整颗胶囊撑出视口 */
  segNameMaxW: number
  menuItemH: number
  menuMaxH: number
  menuGap: number
  menuFont: number
  menuPadX: number
}

const DESKTOP: FlowMetrics = {
  pillH: 46,
  pillGap: 12,
  pillBottomGap: 30,
  font: 22,
  segGoPadX: 26,
  segPickPadX: 22,
  segNameMaxW: 200,
  menuItemH: 40,
  menuMaxH: 240,
  menuGap: 8,
  menuFont: 20,
  menuPadX: 22,
}

/** 与 ChoicePanel 的移动端取值（15px 字 / 34px 高）对齐 */
const MOBILE: FlowMetrics = {
  pillH: 34,
  pillGap: 10,
  pillBottomGap: 24,
  font: 15,
  segGoPadX: 14,
  segPickPadX: 12,
  segNameMaxW: 110,
  menuItemH: 30,
  menuMaxH: 180,
  menuGap: 6,
  menuFont: 15,
  menuPadX: 14,
}

export function flowMetrics(isMobile: boolean): FlowMetrics {
  return isMobile ? MOBILE : DESKTOP
}
