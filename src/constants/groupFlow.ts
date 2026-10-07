// =============================================================================
// 群聊流程控制条几何(GroupFlowControl)
// -----------------------------------------------------------------------------
// 「指定发言」分段胶囊 / 角色下拉菜单的尺寸。
//
// 为什么单独成文件:同一套数字有**两个**消费者,且分属不同文件 ——
//   - ChatArea:用它预留滚动高度(flowExtraH),少留会被裁掉、多留会空一块
//   - GroupFlowControl:用它排版
// 此前两处各写一份字面量,靠注释"须与 xxx 一致"维系,改一处就会静默错位。
// 现收敛于此,按端取值。
//
// 移动端刻意整体收紧:桌面尺寸(46px 高 / 22px 字)在 375px 视口上又高又胖。
// 桌面数值与 v2 既有实现一致,未改动。
//
// 【已删除】单颗「开启 / 暂停 / 恢复对话」胶囊的左右内边距(pillPadX):
// 那颗按钮已改为底部输入面板里的圆形按钮,聊天区不再渲染它。
// =============================================================================

export interface FlowMetrics {
  /** 单颗胶囊高度(px) */
  pillH: number
  /** 多颗胶囊之间的间距(px) */
  pillGap: number
  /** 胶囊与末尾装饰之间的额外留白(px) */
  pillBottomGap: number
  /** 胶囊文字字号(px) */
  font: number
  /** 分段左半(「指定发言」)的左右内边距(px) */
  segGoPadX: number
  /** 分段右半(角色名 + 箭头)的左右内边距(px) */
  segPickPadX: number
  /** 分段右半里角色名的最大宽度(px):超出省略,避免把整颗胶囊撑出视口 */
  segNameMaxW: number
  /** 下拉菜单项高度(px) */
  menuItemH: number
  /** 下拉菜单最大高度(px) */
  menuMaxH: number
  /** 下拉菜单与胶囊的间距(px) */
  menuGap: number
  /** 下拉菜单项字号(px) */
  menuFont: number
  /** 下拉菜单项的左右内边距(px) */
  menuPadX: number
}

/** 桌面端(与既有数值一致,勿随意改动) */
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

/** 移动端:整体收紧,字号与 ChoicePanel 的移动端取值(15px / 34px 高)对齐 */
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

/**
 * 取当前端的控件尺寸
 *
 * @param isMobile 与 ChatInput / ChoicePanel 同判据:几何层 stripSegmented
 */
export function flowMetrics(isMobile: boolean): FlowMetrics {
  return isMobile ? MOBILE : DESKTOP
}
