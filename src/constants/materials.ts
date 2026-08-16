// =============================================================================
// 素材集中导入
// -----------------------------------------------------------------------------
// 所有素材在此处一次性导入,组件统一通过 MATERIALS 表引用,避免跨组件重复 import。
// 后续扩展:用户上传自定义头像/表情时,可在此表基础上叠加 custom 字段。
// =============================================================================

import bgApp from '../assets/materials/bg_app.webp'
import headerDeco from '../assets/materials/achievement_main_deco05.webp'
import editPopDecoTl from '../assets/materials/deco_sns_tweet_decorate_31.webp'
import editPopDecoBr from '../assets/materials/deco_sns_tweet_decorate_32.webp'

import cardTexture from '../assets/materials/deco_sns_hudentry_bg.webp'
import cardFaint from '../assets/materials/deco_sns_tweet_decorate_02.webp'
import subFaint from '../assets/materials/deco_sns_tweet_decorate_03.webp'
import decoBadge from '../assets/materials/deco_sns_tweet_decorate_06.webp'
import decoWing from '../assets/materials/deco_sns_tweet_decorate_42.webp'
import subArrow from '../assets/materials/deco_source_arrow.webp'
import underline from '../assets/materials/deco_sns_tweet_decorate.webp'
import cornerDeco from '../assets/materials/deco_sns_list_decorate.webp'
import chatBadge from '../assets/materials/icon_sns_chat_01.webp'
import circleBorder from '../assets/materials/line_common_circle_food.webp'
import cardArrow from '../assets/materials/deco_common_arrow_p2.webp'

import avatarFrame from '../assets/materials/bg_snscharentry_head_Line.webp'
import avatarBase from '../assets/materials/icon_virtualmouse_bg.webp'

import chatStripV1 from '../assets/materials/chat_strip_v1.webp'
import chatStripV2 from '../assets/materials/chat_strip_v2.webp'
import chatStripV3 from '../assets/materials/chat_strip_v3.webp'
// 移动端头图分段素材(ffmpeg 已由 png 转 webp:l = 左纹理段,r = 右图案段,c = 中间纯色条,均 66px 高)
import chatStripV1L from '../assets/materials/chat_strip_v1_l.webp'
import chatStripV1R from '../assets/materials/chat_strip_v1_r.webp'
import chatStripV2L from '../assets/materials/chat_strip_v2_l.webp'
import chatStripV2R from '../assets/materials/chat_strip_v2_r.webp'
import chatStripV3L from '../assets/materials/chat_strip_v3_l.webp'
import chatStripV3R from '../assets/materials/chat_strip_v3_r.webp'
import chatStripC from '../assets/materials/chat_strip_c.webp'
import chatBottomDeco from '../assets/materials/chat_bottom_deco.webp'
import chatEndDeco from '../assets/materials/chat_end_deco.webp'
import choiceTopDeco from '../assets/materials/choice_top_deco.webp'
import chatEmptyPlaceholder from '../assets/materials/chat_empty_placeholder.webp'
import chatCornerDeco45 from '../assets/materials/deco_sns_tweet_decorate_45.webp'

// 底部输入面板圆形按钮图标(从左到右)
import editBtnPotential from '../assets/materials/potential_picture.webp'
import editBtnEmoticon from '../assets/materials/icon_sns_chat_emoticon.webp'
import editBtnChat from '../assets/materials/icon_sns_chat_04.webp'
import editBtnChat09 from '../assets/materials/icon_sns_chat_09.webp'
import editBtnCharacter from '../assets/materials/btn_character.webp'
import editBtnDeleteIndeed from '../assets/materials/icon_tips_delete_indeed.webp'
import editBtnUpgrade from '../assets/materials/icon_suffix_upgrade.webp'

// 右侧工具栏按钮图标
import editBtnExport from '../assets/materials/icon_contingency_contract_apply_share.webp'
import editBtnShare from '../assets/materials/icon_friend_share.webp'
import loginBtnSetting from '../assets/materials/login_btn_setting.webp'

/**
 * 内置素材 URL 表。
 *
 * 命名约定:`<区域><用途>` 驼峰,如 `cardTexture`(卡片纹理)、`chatStripV1`(聊天条)。
 * 通过 `MATERIALS.cardTexture` 访问,避免硬编码字符串路径。
 */
export const MATERIALS = {
  // 应用背景
  bgApp,
  // 顶部标题装饰
  headerDeco,
  // 弹窗面板背景装饰:左上角 / 右下角
  editPopDecoTl,
  editPopDecoBr,
  // 主卡素材
  cardTexture,
  cardFaint,
  underline,
  cornerDeco,
  circleBorder,
  cardArrow,
  // 主卡徽章 / 子卡图标
  chatBadge,
  // 子卡素材
  subFaint,
  decoBadge,
  decoWing,
  subArrow,
  // 聊天区头像框/底
  avatarFrame,
  avatarBase,
  // 聊天区装饰
  // 顶部聊天条(三图点击循环切换,默认 v1)
  chatStripV1,
  chatStripV2,
  chatStripV3,
  // 移动端头图分段素材(l/r/c)
  chatStripV1L,
  chatStripV1R,
  chatStripV2L,
  chatStripV2R,
  chatStripV3L,
  chatStripV3R,
  chatStripC,
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
  editBtnChat,
  // 聊天(新建对话)按钮图标
  editBtnChat09,
  // 角色名称显示开关按钮(btn_character.png)
  editBtnCharacter,
  // 删除对话按钮图标
  editBtnDeleteIndeed,
  // 自定义页面背景(上传图片)按钮图标
  editBtnUpgrade,
  // 右侧工具栏按钮图标
  editBtnExport,
  editBtnShare,
  // 设置按钮图标
  loginBtnSetting,
} as const
