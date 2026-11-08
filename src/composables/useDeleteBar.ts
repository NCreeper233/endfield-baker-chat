// useDeleteBar —— 删除模式底部条的实测高度（模块级单例）
// 底部条是 fixed 浮层，会盖住最后一张卡；高度随断点变（手机两行、桌面一行），
// 写死数字迟早与样式分叉，所以由组件量出来写这里，列表据此在尾部留空。

import { ref } from 'vue'

/** 屏幕口径 px；未显示时为 0 */
const deleteBarH = ref(0)

/** 负值与 NaN 归零；值没变就不写 */
export function setDeleteBarH(value: number): void {
  const next = Number.isFinite(value) && value > 0 ? Math.round(value) : 0
  if (next !== deleteBarH.value) deleteBarH.value = next
}

export { deleteBarH }
