// announcements —— 公告页的历史条目（左侧日期列表 + 右侧正文）
// 往数组最前面插一项即为新增；pinned 条目永远排在最前。
// content 为纯文本：空行分段、「· 」开头渲染成列表项、「【…】」独占一行渲染成小标题。

export interface AnnouncementEntry {
  id: string
  title: string
  /** 版本徽标；留空则不画 */
  version: string
  /** YYYY-MM-DD，页面只取「日 / 月」两段画日期块 */
  date: string
  content: string
  pinned?: boolean
}

/** 顺序 = 展示顺序 */
export const ANNOUNCEMENTS: AnnouncementEntry[] = [
  {
    id: 'welcome',
    title: '欢迎来到 Baker AI',
    version: '',
    date: '2026-10-18',
    pinned: true,
    content: `感谢你使用 Baker AI —— 基于《明日方舟：终末地》世界观的 AI 角色聊天应用。

· 与干员自由对话，体验真实角色性格与世界观
· 支持思考模式、强制搜索、沉浸式对话模式等实验性功能
· 对话历史本地存储，支持导出 / 导入完整数据（含 API 配置与自定义提示词）

祝你与干员们相处愉快！

【QQ 公告群】
群内会发布应用相关公告与通知，还没加入的请尽快加入。
QQ 公告群号：1056020027

【QQ 交流群】
反馈问题、聊天都可以来这里（不发布公告，群很活跃，欢迎进群）。
QQ 交流群号：926147159

【重要警告】
如果你现在是直接在 QQ 内点开本网站链接，请立即退出，改用浏览器（推荐 Edge / Chrome）访问本网站！
否则将会出现无法导出数据的问题，因此个人行为出现的数据丢失问题概不负责！

【免责声明】
继续使用本应用，即代表你已阅读并同意全部条款；完整内容可在「设置 → 免责声明」中查看。`,
  },
]
