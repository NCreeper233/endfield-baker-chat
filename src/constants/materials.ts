// materials —— 内置素材的集中导入
// 组件一律通过 MATERIALS 表引用，避免跨组件重复 import 与硬编码路径。

import bgApp from '../assets/materials/bg_app.webp'
import headerDeco from '../assets/materials/achievement_main_deco05.webp'

import cardTexture from '../assets/materials/deco_sns_hudentry_bg.webp'
import cardFaint from '../assets/materials/deco_sns_tweet_decorate_02.webp'
import subFaint from '../assets/materials/deco_sns_tweet_decorate_03.webp'
import decoWing from '../assets/materials/deco_sns_tweet_decorate_42.svg'
import subArrow from '../assets/materials/deco_source_arrow.webp'
import underline from '../assets/materials/deco_sns_tweet_decorate.webp'
import cornerDeco from '../assets/materials/deco_sns_list_decorate.webp'
import chatBadge from '../assets/materials/icon_sns_chat_01.svg'

import avatarBase from '../assets/materials/icon_virtualmouse_bg.webp'

import headSvg from '../assets/materials/head.svg'
import headLeftSvg from '../assets/materials/head_left.svg'
import headRightSvg from '../assets/materials/head_right.svg'
import chatBottomDeco from '../assets/materials/chat_bottom_deco.webp'
import chatEndDeco from '../assets/materials/chat_end_deco.webp'
import choiceTopDeco from '../assets/materials/choice_top_deco.webp'
import chatEmptyPlaceholder from '../assets/materials/chat_empty_placeholder.webp'
import chatCornerDeco45 from '../assets/materials/deco_sns_tweet_decorate_45.webp'

import editBtnPotential from '../assets/materials/potential_picture.svg'
import editBtnEmoticon from '../assets/materials/icon_sns_chat_emoticon.svg'
import iconEventsOverview from '../assets/materials/icon_events_overview.svg'
import editBtnChat from '../assets/materials/icon_sns_chat_04.svg'

import iconUsageStats from '../assets/materials/icon_usage_stats.svg'
import prefBracketColorOn from '../assets/materials/pref_bracket_color_on.webp'
import prefBracketColorOff from '../assets/materials/pref_bracket_color_off.webp'
import prefBracketCenterOff from '../assets/materials/pref_bracket_center_off.webp'

import decoPanelContour from '../assets/materials/deco_panel_contour.webp'
import decoPanelLogoBg from '../assets/materials/deco_panel_logo_bg.webp'
import panelTabTexture from '../assets/materials/panel_tab_texture.webp'
import panelBtnTexture from '../assets/materials/panel_btn_texture.webp'
import panelBtnDeco from '../assets/materials/panel_btn_deco.webp'

import prefChibi from '../assets/materials/pref_chibi.webp'

// 关于页：头图（佩丽卡插画，圆角矩形背景用）
import aboutHero from '../assets/materials/about_hero.webp'

/** 命名约定 `<区域><用途>` 驼峰；通过 MATERIALS.xxx 访问，避免硬编码路径 */
export const MATERIALS = {
  // 应用背景 / 顶部标题装饰
  bgApp,
  headerDeco,
  // 主卡
  cardTexture,
  cardFaint,
  underline,
  cornerDeco,
  // 主卡徽章 / 子卡图标
  chatBadge,
  // 子卡
  subFaint,
  decoWing,
  subArrow,
  // 头像底图。外圈圆环已改为自绘（ChatAvatar.vue），不再走素材表
  avatarBase,
  // 聊天区：顶部头图桌面端用 head.svg，移动端用 head_left + CSS center + head_right
  headSvg,
  headLeftSvg,
  headRightSvg,
  chatBottomDeco,
  chatEndDeco,
  choiceTopDeco,
  chatEmptyPlaceholder,
  // 右上角装饰，左右镜像
  chatCornerDeco45,
  // 底部面板圆形按钮图标（从左到右）
  editBtnPotential,
  editBtnEmoticon,
  iconEventsOverview,
  editBtnChat,
  iconUsageStats,
  // 首次使用偏好弹窗：三张示意图与三个选项一一对应
  prefBracketColorOn,
  prefBracketColorOff,
  prefBracketCenterOff,
  prefChibi,
  // 面板设计系统（设置 / 版本弹窗共用）
  decoPanelContour,
  decoPanelLogoBg,
  panelTabTexture,
  panelBtnTexture,
  panelBtnDeco,
  // 关于页：头图（圆角矩形背景）
  aboutHero,
} as const
