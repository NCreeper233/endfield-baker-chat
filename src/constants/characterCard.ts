// =============================================================================
// 干员卡片列表布局常量
// -----------------------------------------------------------------------------
// 支持任意主卡数量、每张主卡任意子卡数量(≥1)。
//
// 布局规则:
//   - 主卡高度固定 CARD_H
//   - 展开时,主卡下方依次排布 n 张子卡:
//     · 第 1 张子卡相对主卡顶部的偏移 = SUB_TOP_FROM_CARD(已含主卡高度 + 主卡到子卡的间距)
//     · 第 2 张及以后:每张相对上一张 = SUB_H + SUB_GAP_BETWEEN
//   - 折叠时:子卡区域隐藏,主卡块高度仅含 SUB_TOP_FROM_CARD(保留主卡到下一张主卡的间距)
//
// 所有数值来自原 SVG 设计稿测量,严禁调整。
// =============================================================================

/** 干员卡片列表容器顶部 y(对应 .character-card 的 top) */
export const CHARACTER_LIST_TOP = 122.57

/** 列表顶部留白(第一张卡片前的占位高度)。容器固定在 122.57,卡片整体在容器内下移 */
export const TOP_PAD = 10

/** 主卡高度 */
const CARD_H = 92.99

/** 第一张子卡相对主卡顶部的偏移(已含主卡高度 + 主卡到第一张子卡的间距) */
const SUB_TOP_FROM_CARD = 100.86

/** 子卡高度(统一) */
const SUB_H = 68.95

/** 第一张子卡与第二张子卡之间的间距(以及后续子卡之间的间距) */
const SUB_GAP_BETWEEN = 4.61

/** 主卡块之间的间距(折叠/展开均适用,展开时附加在最后一张子卡之后) */
const SUB_GAP = 7.87

/** 列表尾部留白高度 */
const BOTTOM_PAD = 80

/**
 * 计算指定主卡(给定子卡数量)的"块高度"(主卡 + 折叠/展开状态下的子卡区域)
 *
 * @param collapsed 该主卡是否折叠
 * @param subCount  该主卡下的子卡数量(≥1)
 * @returns         块占位高度
 */
export function blockHeight(collapsed: boolean, subCount: number): number {
  if (collapsed) return SUB_TOP_FROM_CARD
  // 展开:主卡 + 第一张子卡偏移已含主卡高度,故块高度 = SUB_TOP_FROM_CARD + n*SUB_H + (n-1)*SUB_GAP_BETWEEN + SUB_GAP
  const subArea = subCount * SUB_H + Math.max(0, subCount - 1) * SUB_GAP_BETWEEN
  return SUB_TOP_FROM_CARD + subArea + SUB_GAP
}

/**
 * 计算指定主卡的"尾部高度"(主卡 + 展开状态下的子卡占位,不含块间距)
 *
 * 用于计算下一张主卡的 top 偏移。
 *
 * @param collapsed 该主卡是否折叠
 * @param subCount  该主卡下的子卡数量
 */
export function tailHeight(collapsed: boolean, subCount: number): number {
  if (collapsed) return CARD_H
  const subArea = subCount * SUB_H + Math.max(0, subCount - 1) * SUB_GAP_BETWEEN
  return CARD_H + (SUB_TOP_FROM_CARD - CARD_H) + subArea
}

/**
 * 计算所有主卡的顶部 y 坐标
 *
 * @param collapsed 每张主卡的折叠状态
 * @param subCounts 每张主卡的子卡数量
 * @returns         每张主卡在列表内的 top 偏移(已含 TOP_PAD)
 */
export function computeUnitTops(collapsed: boolean[], subCounts: number[]): number[] {
  const tops: number[] = []
  let cursor = TOP_PAD
  for (let i = 0; i < collapsed.length; i++) {
    tops[i] = cursor
    cursor += blockHeight(collapsed[i], subCounts[i] ?? 1)
  }
  return tops
}

/**
 * 计算列表尾部留白的 top 坐标
 *
 * 接受可选的预计算 tops 数组:调用方已算好 unitTops 时直接复用,
 * 避免内部再调用 computeUnitTops 重新计算、与 CharacterCardList 的
 * unitTops computed 重复 O(n) 遍历。
 *
 * @param collapsed 每张主卡的折叠状态
 * @param subCounts 每张主卡的子卡数量
 * @param unitTops  可选:已算好的每张主卡 top 偏移(由 computeUnitTops 产出),
 *                  省略时内部计算
 */
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

/**
 * 计算主卡内某张子卡相对主卡顶部的 top 偏移
 *
 * 第 1 张:SUB_TOP_FROM_CARD
 * 第 k 张(k≥2):SUB_TOP_FROM_CARD + (k-1) * (SUB_H + SUB_GAP_BETWEEN)
 *
 * @param subIndexInCard 子卡在主卡内的下标(0-based)
 */
export function subTopInCard(subIndexInCard: number): number {
  if (subIndexInCard <= 0) return SUB_TOP_FROM_CARD
  return SUB_TOP_FROM_CARD + subIndexInCard * (SUB_H + SUB_GAP_BETWEEN)
}
