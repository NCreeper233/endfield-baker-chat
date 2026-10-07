// =============================================================================
// useDeleteBar:删除模式底部条的实测高度
// -----------------------------------------------------------------------------
// 底部条是 fixed 浮层,会盖住列表最后一张卡。要让内容不被盖住,就得在列表尾部
// 留出等高的空档 —— 而空档该留多少取决于这条究竟多高(手机上是两行、桌面一行),
// 写死数字迟早会和样式分叉。
//
// 故由 DeleteModeBar 自己量高度写进来,列表侧(经 App 换算成画布设计口径)读它。
// (与 useInputHeight 同一套做法:跨组件的量值用模块级单例传递。)
// =============================================================================

import { ref } from 'vue'

/** 底部条高度(px,屏幕口径;未显示时为 0) */
const deleteBarH = ref(0)

/** 写入底部条高度(负值 / NaN 归零) */
export function setDeleteBarH(value: number): void {
  const next = Number.isFinite(value) && value > 0 ? Math.round(value) : 0
  if (next !== deleteBarH.value) deleteBarH.value = next
}

export { deleteBarH }
