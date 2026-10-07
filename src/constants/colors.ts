// =============================================================================
// Inline 颜色常量(TS 单一来源)
// -----------------------------------------------------------------------------
// 这些颜色用于 SVG 属性 / inline style,SCSS 变量无法直接引用。
// 集中定义避免硬编码重复,与 _variables.scss 的 SCSS 令牌互补。
//
// 后续扩展:用户自定义气泡皮肤时,可在此表基础上叠加 custom 配色。
// =============================================================================

/** App 背景遮罩色(原 inline maskStyle) */
export const APP_MASK_BG = 'rgba(0, 0, 0, 0.85)'

/** 我方气泡填充色(右侧浅灰) */
export const BUBBLE_FILL_MINE = '#f0eeee'

/** 对方气泡填充色(左侧深灰) */
export const BUBBLE_FILL_OTHER = '#464444'

/** 我方气泡文字色 */
export const BUBBLE_TEXT_MINE = '#000'

/** 对方气泡文字色 */
export const BUBBLE_TEXT_OTHER = '#fff'

/**
 * 括号描写居中行(设置项「括号描写居中」)的文本色
 *
 * 半透明白:居中行是"旁白 / 动作描写"性质,比气泡正文(#fff)弱一档,
 * 但仍比群聊话题提示行(rgba(255,255,255,.38))清楚。
 *
 * ⚠️ 必须同时以 inline 形式写进 DOM(不能只靠 scoped CSS):
 * html-to-image 克隆节点时会把计算样式整份内联,其中 `-webkit-text-fill-color`
 * 会带上根节点的黑色并**继承**到子节点、优先级高于 color,导致导出图里的
 * 居中文字变黑(深色背景上几乎不可见)。与 ChatBubble 的文字同理。
 */
export const CENTER_ACTION_COLOR = 'rgba(255, 255, 255, 0.5)'

/**
 * 加载动画方形点颜色
 *
 * other 侧气泡深底,用浅色点;mine 侧气泡浅底,用深色点。
 * 与 BUBBLE_FILL_* 配套,保证加载气泡与普通气泡视觉一致。
 */
export const LOADING_DOT_COLOR_OTHER = '#fff'
export const LOADING_DOT_COLOR_MINE = '#222'
