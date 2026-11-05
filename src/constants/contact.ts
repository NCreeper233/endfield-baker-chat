// =============================================================================
// 联系方式 / 相关链接(公告页的「关于」页签使用)
// -----------------------------------------------------------------------------
// 群号与会跳到加群页的分享链接只在这一处维护:公告页的「关于」以及后续其它
// 需要联系方式的地方都从这里取,避免各写一份、日后改了一个忘了另一个。
// =============================================================================

/** 一个 QQ 群入口 */
export interface QqGroup {
  /** 群名 */
  label: string
  /** 群号(点击会复制到剪贴板) */
  code: string
  /** 加群页链接 */
  url: string
}

/** QQ 群入口(顺序即展示顺序) */
export const QQ_GROUPS: readonly QqGroup[] = [
  {
    label: 'BAKER AI 公告群',
    code: '1056020027',
    url: 'https://qun.qq.com/universal-share/share?ac=1&authKey=DPFveNVF1Z52nYKN7Y5hkQpiyePOyZO1tM%2B5HC3RMwbdBIfllYsZnHlF2JiSOuob&busi_data=eyJncm91cENvZGUiOiIxMDU2MDIwMDI3IiwidG9rZW4iOiJiVWRLVFpsUjZvNWN3NUdoajZJS290aWg5M1lleEJuemc2dnBWUUlsNmhSZFZYN3JySE9xRy9XUUh0dXY1cmpEIiwidWluIjoiMTc2MjQ1NTE3In0%3D&data=kxqHAM5MIP1o9MYhyyAWOUWFZtR-xuKw_s0zbIlz-qz0Jh1KUYK6kpQVwWE5AiG4S4yrUU_hloIJ8m9b4eihTw&svctype=4&tempid=h5_group_info',
  },
  {
    label: 'BAKER AI 交流群',
    code: '926147159',
    url: 'https://qun.qq.com/universal-share/share?ac=1&authKey=VuPGuN9ZJgrnDk1yAYhNa1ttQMgjzWtLq3Dy4zFLeySkCrgZw9XGMAdEkyqwqLuG&busi_data=eyJncm91cENvZGUiOiI5MjYxNDcxNTkiLCJ0b2tlbiI6IjdOY1c3K1B2NnRmR2QrYTJKSklqUVZnNHRxNnBlUytLVlErYm1WdWU1bW5JQjlnQyszam1LLzFuVGlzVjMxNjIiLCJ1aW4iOiIxNzYyNDU1MTcifQ%3D%3D&data=ImB81MsUWZyM0CGFfQegtwvYV4fSFCwpojz2Bjv4-r5Ha_O8_Q8nsfO8vqvWYdVFl_WwpAFVHkfVv4PtQrmSXg&svctype=4&tempid=h5_group_info',
  },
]

/** 相关链接(关于页) */
export const PROJECT_LINKS: readonly { label: string; url: string }[] = [
  { label: 'GitHub', url: 'https://github.com/NCreeper233/endfield-baker-chat' },
  { label: '哔哩哔哩', url: 'https://space.bilibili.com/1143315127' },
]
