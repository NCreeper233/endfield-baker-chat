// colors —— 给 SVG 属性与 inline style 用的颜色令牌
// SCSS 变量在这些地方引用不到，故与 _variables.scss 互补。

export const APP_MASK_BG = 'rgba(0, 0, 0, 0.85)'

export const BUBBLE_FILL_MINE = '#f0eeee'
export const BUBBLE_FILL_OTHER = '#464444'
export const BUBBLE_TEXT_MINE = '#000'
export const BUBBLE_TEXT_OTHER = '#fff'

/**
 * 括号描写居中行：比正文弱一档，比话题提示行清楚。
 *
 * ⚠️ 必须同时以 inline 写进 DOM：html-to-image 克隆时会内联计算样式，
 * `-webkit-text-fill-color` 会带上根节点的黑色并继承，只靠 scoped CSS 导出图里这行会变黑。
 */
export const CENTER_ACTION_COLOR = 'rgba(255, 255, 255, 0.5)'

/** 与 BUBBLE_FILL_* 配套：深底浅点、浅底深点 */
export const LOADING_DOT_COLOR_OTHER = '#fff'
export const LOADING_DOT_COLOR_MINE = '#222'
