// contact —— QQ 群入口与项目链接（关于页）
// 只在这一处维护，避免多处各写一份、改了一处漏另一处。

// 群二维码：源图 qrcode_1 / qrcode_2.jpg 经 ffmpeg 裁到卡片边界、压成 webp
import qrNotice from '../assets/materials/qr_notice.webp'
import qrChat from '../assets/materials/qr_chat.webp'

export interface QqGroup {
  label: string
  code: string
  url: string
  /** 群二维码（已裁掉原图四周的大片黑边） */
  qr: string
}

/** 顺序即展示顺序 */
export const QQ_GROUPS: readonly QqGroup[] = [
  {
    label: 'BAKER AI 公告群',
    code: '1056020027',
    url: 'https://qun.qq.com/universal-share/share?ac=1&authKey=DPFveNVF1Z52nYKN7Y5hkQpiyePOyZO1tM%2B5HC3RMwbdBIfllYsZnHlF2JiSOuob&busi_data=eyJncm91cENvZGUiOiIxMDU2MDIwMDI3IiwidG9rZW4iOiJiVWRLVFpsUjZvNWN3NUdoajZJS290aWg5M1lleEJuemc2dnBWUUlsNmhSZFZYN3JySE9xRy9XUUh0dXY1cmpEIiwidWluIjoiMTc2MjQ1NTE3In0%3D&data=kxqHAM5MIP1o9MYhyyAWOUWFZtR-xuKw_s0zbIlz-qz0Jh1KUYK6kpQVwWE5AiG4S4yrUU_hloIJ8m9b4eihTw&svctype=4&tempid=h5_group_info',
    qr: qrNotice,
  },
  {
    label: 'BAKER AI 交流群',
    code: '926147159',
    url: 'https://qun.qq.com/universal-share/share?ac=1&authKey=VuPGuN9ZJgrnDk1yAYhNa1ttQMgjzWtLq3Dy4zFLeySkCrgZw9XGMAdEkyqwqLuG&busi_data=eyJncm91cENvZGUiOiI5MjYxNDcxNTkiLCJ0b2tlbiI6IjdOY1c3K1B2NnRmR2QrYTJKSklqUVZnNHRxNnBlUytLVlErYm1WdWU1bW5JQjlnQyszam1LLzFuVGlzVjMxNjIiLCJ1aW4iOiIxNzYyNDU1MTcifQ%3D%3D&data=ImB81MsUWZyM0CGFfQegtwvYV4fSFCwpojz2Bjv4-r5Ha_O8_Q8nsfO8vqvWYdVFl_WwpAFVHkfVv4PtQrmSXg&svctype=4&tempid=h5_group_info',
    qr: qrChat,
  },
]

/** 源码仓库：单独一块，不和其它链接混在一起 */
export const GITHUB_URL = 'https://github.com/NCreeper233/endfield-baker-chat'
