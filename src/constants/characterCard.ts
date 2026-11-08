// characterCard —— 干员卡片列表的布局常量与计算
// 数值来自设计稿测量，**严禁调整**：主卡高度固定，展开后第一张子卡偏移
// SUB_TOP_FROM_CARD，其后每张再加 SUB_H + SUB_GAP_BETWEEN。

export const CHARACTER_LIST_TOP = 122.57

/** 列表顶部留白：容器固定在 122.57，卡片整体在容器内下移 */
export const TOP_PAD = 10

const CARD_H = 92.99

/** 已含主卡高度与主卡到子卡的间距 */
const SUB_TOP_FROM_CARD = 100.86

const SUB_H = 68.95

const SUB_GAP_BETWEEN = 4.61

/** 主卡块间距，折叠与展开都适用 */
const SUB_GAP = 7.87

const BOTTOM_PAD = 80

export function blockHeight(collapsed: boolean, subCount: number): number {
  if (collapsed) return SUB_TOP_FROM_CARD
  const subArea = subCount * SUB_H + Math.max(0, subCount - 1) * SUB_GAP_BETWEEN
  return SUB_TOP_FROM_CARD + subArea + SUB_GAP
}

/** 与 blockHeight 的差别：不含块间距，用于算下一张主卡的 top */
export function tailHeight(collapsed: boolean, subCount: number): number {
  if (collapsed) return CARD_H
  const subArea = subCount * SUB_H + Math.max(0, subCount - 1) * SUB_GAP_BETWEEN
  return CARD_H + (SUB_TOP_FROM_CARD - CARD_H) + subArea
}

/** 每张主卡在列表内的 top 偏移（已含 TOP_PAD） */
export function computeUnitTops(collapsed: boolean[], subCounts: number[]): number[] {
  const tops: number[] = []
  let cursor = TOP_PAD
  for (let i = 0; i < collapsed.length; i++) {
    tops[i] = cursor
    cursor += blockHeight(collapsed[i], subCounts[i] ?? 1)
  }
  return tops
}

/** 传入 unitTops 可省一次 O(n) 遍历 */
export function computeCardPadTop(
  collapsed: boolean[],
  subCounts: number[],
  unitTops?: number[],
): number {
  const n = collapsed.length
  if (n === 0) return TOP_PAD + BOTTOM_PAD
  const tops = unitTops ?? computeUnitTops(collapsed, subCounts)
  return tops[n - 1] + tailHeight(collapsed[n - 1], subCounts[n - 1] ?? 1)
}

export function subTopInCard(subIndexInCard: number): number {
  if (subIndexInCard <= 0) return SUB_TOP_FROM_CARD
  return SUB_TOP_FROM_CARD + subIndexInCard * (SUB_H + SUB_GAP_BETWEEN)
}
