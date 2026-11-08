// chatPosition —— 绝对定位盒的 style 构造

import type { CSSProperties } from 'vue'

/** 兼容 Vue 模板 :style 的类型约束 */
export type BoxStyle = CSSProperties

/** 参数顺序是 x / y / w / h */
export function pos(x: number, y: number, w: number, h: number): BoxStyle {
  return {
    left: `${x}px`,
    top: `${y}px`,
    width: `${w}px`,
    height: `${h}px`,
  }
}
