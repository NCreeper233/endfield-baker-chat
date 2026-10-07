// =============================================================================
// useInputHeight:底部输入框的"内容增高量"
// -----------------------------------------------------------------------------
// 输入框要随文本长度长高(让输进去的字都看得见),而它的高度又决定底部面板的
// 高度 —— 面板一高,聊天区可视高度必须同步变矮,否则末尾几条消息会被面板盖住。
//
// 这条链路横跨组件与几何层,故把"增高量"抽成模块级单例:
//   写:ChatInput 量出内容高度后写入(设计口径 px)
//   读:constants/chatGeometry 把它加进面板高、并从滚动区高度里扣掉
// (与 useMobile / useCanvasZoom 的模块级单例做法一致。)
// =============================================================================

import { ref } from 'vue'

/** 输入框内容增高量(px,设计口径;0 = 单行,不增高) */
const extraInputH = ref(0)

/**
 * 写入增高量
 *
 * 负值 / NaN 一律归零;值没变就不写,避免每一帧都触发几何层重算。
 */
export function setExtraInputH(value: number): void {
  const next = Number.isFinite(value) && value > 0 ? Math.round(value) : 0
  if (next !== extraInputH.value) extraInputH.value = next
}

export { extraInputH }
