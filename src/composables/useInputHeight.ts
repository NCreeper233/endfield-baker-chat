// useInputHeight —— 输入框的内容增高量（模块级单例）
// 写：ChatInput 量出内容高度后写入；读：chatGeometry 据此抬面板高、压滚动区高。
// 不这样同步，输入框一长高就会盖住末尾几条消息。

import { ref } from 'vue'

/** 设计口径 px；0 = 单行 */
const extraInputH = ref(0)

/** 负值与 NaN 归零；值没变就不写，避免每帧触发几何层重算 */
export function setExtraInputH(value: number): void {
  const next = Number.isFinite(value) && value > 0 ? Math.round(value) : 0
  if (next !== extraInputH.value) extraInputH.value = next
}

export { extraInputH }
