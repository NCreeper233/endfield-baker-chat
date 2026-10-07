// =============================================================================
// 素材集中导入
// -----------------------------------------------------------------------------
// 所有素材在此处一次性导入,组件统一通过 MATERIALS 表引用,避免跨组件重复 import。
// 后续扩展:用户上传自定义头像/表情时,可在此表基础上叠加 custom 字段。
// =============================================================================

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

// 底部输入面板圆形按钮图标(从左到右)
import editBtnPotential from '../assets/materials/potential_picture.svg'
import editBtnEmoticon from '../assets/materials/icon_sns_chat_emoticon.svg'
// 推荐选项面板开关(底部面板:表情与发送之间)
import iconEventsOverview from '../assets/materials/icon_events_overview.svg'
import editBtnChat from '../assets/materials/icon_sns_chat_04.svg'
import editBtnDeleteIndeed from '../assets/materials/icon_tips_delete_indeed.svg'

// 设置按钮图标
import loginBtnSetting from '../assets/materials/login_btn_setting.svg'

// Token 用量 / 缓存命中面板按钮图标(角色列表上方操作带,仅自定义 API 模式显示)
import iconUsageStats from '../assets/materials/icon_usage_stats.svg'

// 首次使用偏好弹窗的三张示意图(动作/神态描写的三种样式)
//   源图:聊天截图 PNG → ffmpeg 转 webp(720 宽,q85),原图留档 temps/style_pref_src/
import prefBracketColorOn from '../assets/materials/pref_bracket_color_on.webp'
import prefBracketColorOff from '../assets/materials/pref_bracket_color_off.webp'
import prefBracketCenterOff from '../assets/materials/pref_bracket_center_off.webp'

/**
 * 内置素材 URL 表。
 *
 * 命名约定:`<区域><用途>` 驼峰,如 `cardTexture`(卡片纹理)、`headSvg`(头图)。
 * 通过 `MATERIALS.cardTexture` 访问,避免硬编码字符串路径。
 */
export const MATERIALS = {
  // 应用背景
  bgApp,
  // 顶部标题装饰
  headerDeco,
  // 主卡素材
  cardTexture,
  cardFaint,
  underline,
  cornerDeco,
  // (折叠按钮的圆环与人字箭头已改为自绘,见 CharacterCardItem,不再走素材表)
  // 主卡徽章 / 子卡图标
  chatBadge,
  // 子卡素材
  subFaint,
  // 子卡右上的虚线装饰(矢量;原 42.webp 已弃用)
  decoWing,
  subArrow,
  // 聊天区头像底图
  // (头像外圈圆环已改为自绘,见 ChatAvatar.vue,不再走素材表)
  avatarBase,
  // 聊天区装饰
  // 顶部头图: 桌面端 head.svg, 移动端 head_left + CSS center + head_right
  headSvg,
  headLeftSvg,
  headRightSvg,
  chatBottomDeco,
  chatEndDeco,
  // 面板顶部装饰
  choiceTopDeco,
  // 起始页(未选中对话)占位图
  chatEmptyPlaceholder,
  // 聊天区右上角装饰(左右镜像)
  chatCornerDeco45,
  // 底部输入面板圆形按钮图标(从左到右)
  editBtnPotential,
  editBtnEmoticon,
  // 推荐选项面板开关按钮图标
  iconEventsOverview,
  editBtnChat,
  // 删除对话按钮图标(角色列表上方操作带)
  editBtnDeleteIndeed,
  // 设置按钮图标
  loginBtnSetting,
  // Token 用量 / 缓存命中面板入口按钮图标(同上操作带)
  iconUsageStats,
  // 首次使用偏好弹窗的三张示意图(一一对应三个选项)
  prefBracketColorOn,
  prefBracketColorOff,
  prefBracketCenterOff,
} as const
