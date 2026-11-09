// qqGroup —— 关于页「加入QQ群」的跳转
//
// 网页里那张群二维码下面跟的是 qun.qq.com 的 H5 分享页。在手机浏览器里点它会
// 再弹一次「打开QQ」，在应用的 WebView 里点则**只会把 H5 套在应用自己身上**，
// 用户还得手动点一下「打开QQ」—— 真机反馈「点了没跳转」。
//
// 所以安卓端走本地插件 QqGroup：直接用 mqqapi 协议唤起 QQ 的群名片，
// 没装 QQ 才退回 H5；浏览器 / EXE 保持原行为（开新页，Windows 交给默认浏览器）。

import { registerPlugin } from '@capacitor/core'
import { isAndroid } from './platform'

interface QqGroupPluginLike {
  open?: (opts: { uin: string; url?: string }) => Promise<{ ok?: boolean; via?: string }>
}

/** 与 MainActivity 里注册的 @CapacitorPlugin(name = "QqGroup") 对应 */
const QqGroup = registerPlugin<QqGroupPluginLike>('QqGroup')

/** 跳转超时：真机上 startActivity 是同步的，这里只是兜住"插件没应答"的极端情况 */
const OPEN_TIMEOUT_MS = 6_000

/** 浏览器 / Electron：开新页（Electron 的 setWindowOpenHandler 会交给系统浏览器） */
function openInBrowser(url: string): void {
  try {
    window.open(url, '_blank', 'noopener')
  } catch {
    window.location.href = url
  }
}

/**
 * 打开 QQ 群。
 *
 * @returns 是否已经交给原生/浏览器处理（没有 UI 反馈需求，调用方可以忽略）
 */
export async function openQqGroup(group: { code: string; url: string }): Promise<boolean> {
  if (isAndroid()) {
    try {
      const res = await Promise.race([
        QqGroup.open ? QqGroup.open({ uin: group.code, url: group.url }) : Promise.resolve(null),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), OPEN_TIMEOUT_MS)),
      ])
      if (res && res.ok) return true
      // 原生没成功（超时 / 两种都打不开）→ 退回浏览器开新页，别让点击变成没反应
      openInBrowser(group.url)
      return false
    } catch {
      openInBrowser(group.url)
      return false
    }
  }

  openInBrowser(group.url)
  return true
}
