// =============================================================================
// 弹窗编排 composable(usePopups)
// -----------------------------------------------------------------------------
// 启动时拉取服务端 JSON,解析出三类弹窗数据,并驱动它们的显示:
//
//   公告(notice) → 每次打开弹出,直到玩家点"不再提醒";公告内容变化会重置该标记
//   提醒(alert)  → 只显示"未被确认过"的提醒;可能有多条,在同窗内左右滑动查看;
//                  玩家点"确定"时把当前所有未确认提醒一次性全部确认
//                  (避免新玩家因积累了大量提醒而需要连点多次)
//                  可用 enableAlert: false 整体关闭(不弹、也不占队列)
//   更新(update) → 服务端版本号大于当前版本时提示;玩家可"忽略此版本"
//                  (忽略后该版本不再提示,但更高版本仍会提示)
//                  仅在客户端(Windows / 安卓)弹出,网页端不弹
//
// 三类弹窗共用一个队列,按「公告 → 提醒 → 更新」顺序依次显示,
// 同一时刻只出现一个,关掉一个自动出下一个 —— 因此不会互相遮挡或冲突。
// =============================================================================
import { ref, computed } from 'vue'

import { useSettingsStore } from '../stores/settings'
import {
  POPUP_DATA_URL,
  APP_VERSION,
  ALERT_CONFIRMED_KEY,
  UPDATE_IGNORED_VERSION_KEY,
  NOTICE_CONTENT_HASH_KEY,
  detectPlatform,
  compareVersion,
  readStringArray,
  writeStringArray,
  readString,
  writeString,
  normalizeAlerts,
  type AlertItem,
  type DownloadLinks,
  type RuntimePlatform,
} from '../constants/popups'

/** 当前可显示的弹窗类型 */
export type PopupKind = 'notice' | 'alert' | 'update'

/** usePopups 的可选行为开关 */
export interface UsePopupsOptions {
  /**
   * 是否启用公告弹窗
   *
   * 公告弹窗沿用项目原有逻辑,按需求**仅在正式版加入**;
   * 测试版传 false,让队列跳过它(不占用队列,也不影响提示/更新弹窗)。
   */
  enableNotice?: boolean
  /**
   * 是否启用提醒弹窗
   *
   * 关闭后提醒**不进入队列**(activePopup 直接跳过它):既不弹出来,
   * 也不会占住队首把后面的更新弹窗堵死。数据照常解析、已确认记录也不动,
   * 随时把这一项去掉即可恢复。
   */
  enableAlert?: boolean
  /**
   * 是否忽略平台限制、总是允许弹更新弹窗
   *
   * 正式版不传:网页端永远是最新版,因此网页端不弹更新;
   * 测试版传 true:便于在浏览器里验证完整的更新流程。
   */
  forceUpdate?: boolean
}

export function usePopups(options: UsePopupsOptions = {}) {
  const settingsStore = useSettingsStore()

  /** 是否启用公告弹窗(默认启用) */
  const enableNotice = options.enableNotice !== false
  /** 是否启用提醒弹窗(默认启用) */
  const enableAlert = options.enableAlert !== false
  /** 是否强制允许更新弹窗(测试用,默认关闭) */
  const forceUpdate = options.forceUpdate === true

  // ---- 公告 ----------------------------------------------------------------
  /** 公告标题(服务端 JSON 的 title;缺省用内置标题) */
  const noticeTitle = ref('')
  /** 公告正文 */
  const noticeContent = ref('')
  /** 公告弹窗是否显示 */
  const noticeOpen = ref(false)

  // ---- 提醒 ----------------------------------------------------------------
  /** 待显示的提醒(已过滤掉玩家确认过的;可能为空 = 不弹) */
  const alerts = ref<AlertItem[]>([])

  // ---- 更新 ----------------------------------------------------------------
  /** 服务端最新版本号 */
  const latestVersion = ref('')
  /** 下载地址 */
  const downloads = ref<DownloadLinks>({})
  /** 更新弹窗是否显示 */
  const updateOpen = ref(false)

  /**
   * 运行平台
   *
   * 正式版:网页端不弹更新弹窗(网页永远是最新版);
   * 测试版强制模式下,网页端按「电脑版」处理,便于验证整个更新流程。
   */
  const detectedPlatform = detectPlatform()
  const platform: RuntimePlatform =
    forceUpdate && detectedPlatform === 'web' ? 'windows' : detectedPlatform

  /** 是否为客户端(非网页端) */
  const isNativeClient = platform !== 'web'

  /** 更新弹窗是否允许弹出:客户端恒可;网页端仅在测试模式下允许 */
  const updateAllowed = forceUpdate || platform !== 'web'

  /**
   * 弹窗队列:公告 → 提醒 → 更新
   *
   * 返回当前应当显示的弹窗类型;三者同时满足条件时按上述优先级排队,
   * 关闭队首后 activePopup 自动变为下一个,实现"依次显示"。
   */
  const activePopup = computed<PopupKind | null>(() => {
    // 公告弹窗仅在启用时进入队列(测试版按需求不加载公告)
    if (enableNotice && noticeOpen.value) return 'notice'
    // 提醒同理:关掉后直接跳过,不给它占住队首的机会
    if (enableAlert && alerts.value.length > 0) return 'alert'
    if (updateOpen.value) return 'update'
    return null
  })

  /** 公告内容哈希(仅公告正文变化时才重置"不再提醒") */
  function hashNoticeText(text: string): string {
    let h = 5381
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
    }
    return h.toString(36)
  }

  /**
   * 启动时拉取弹窗数据,并决定三类弹窗各自的显示状态
   *
   * 拉取失败(离线等)时:公告回退内置常量且不重置任何标记,
   * 提醒与更新一律不弹(避免误报)。
   */
  async function loadPopupData(): Promise<void> {
    let data: Record<string, unknown> | null = null

    try {
      const res = await fetch(POPUP_DATA_URL, { cache: 'no-store' })
      if (res.ok) {
        const text = (await res.text()).trim()
        if (text) {
          try {
            const parsed = JSON.parse(text)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              data = parsed as Record<string, unknown>
            }
          } catch {
            // 非 JSON:整段文本作为公告正文(兼容旧的纯文本公告形态)
            data = { content: text }
          }
        }
      }
    } catch {
      // 网络失败:保持 data 为 null,下面走回退分支
    }

    // ---- 公告 --------------------------------------------------------------
    const rawContent = typeof data?.content === 'string' ? data.content.trim() : ''
    const rawTitle = typeof data?.title === 'string' ? data.title.trim() : ''
    if (rawContent) {
      noticeContent.value = rawContent
      noticeTitle.value = rawTitle
      // 仅当公告正文本身变化时重置"不再提醒"(新增提醒/版本号不影响公告状态)
      const hash = hashNoticeText(rawContent)
      const lastHash = readString(NOTICE_CONTENT_HASH_KEY)
      if (lastHash !== hash) {
        settingsStore.noticeDismissed = false
        writeString(NOTICE_CONTENT_HASH_KEY, hash)
      }
    }
    // 未选择"不再提醒"时每次启动都弹(沿用原有行为)
    noticeOpen.value = !settingsStore.noticeDismissed

    // ---- 提醒 --------------------------------------------------------------
    // 只保留玩家尚未确认过的条目;一条都没有则本类弹窗不显示
    const allAlerts = normalizeAlerts(data?.alerts)
    const confirmedIds = readStringArray(ALERT_CONFIRMED_KEY)
    alerts.value = allAlerts.filter((item) => !confirmedIds.includes(item.id))

    // ---- 更新 --------------------------------------------------------------
    const version = typeof data?.version === 'string' ? data.version.trim() : ''
    latestVersion.value = version
    downloads.value =
      data?.downloads && typeof data.downloads === 'object'
        ? (data.downloads as DownloadLinks)
        : {}

    if (updateAllowed && version && compareVersion(version, APP_VERSION) > 0) {
      // 已忽略过该版本则不再提示;出现更高的新版本时仍会提示
      const ignored = readString(UPDATE_IGNORED_VERSION_KEY)
      updateOpen.value = !ignored || compareVersion(version, ignored) > 0
    } else {
      updateOpen.value = false
    }
  }

  // ---- 公告:交互 ----------------------------------------------------------

  /** 确认:仅关闭本次,下次启动仍会弹出 */
  function onNoticeConfirm(): void {
    noticeOpen.value = false
  }

  /** 不再提醒:持久化标记,此后不再弹出(公告内容变化时自动重置) */
  function onNoticeDismiss(): void {
    settingsStore.noticeDismissed = true
    noticeOpen.value = false
  }

  // ---- 提醒:交互 ----------------------------------------------------------

  /**
   * 确认提醒:把当前所有未确认提醒一次性标记为已确认
   *
   * 这样即便服务端同时下发多条提醒,玩家也只需点一次确定,
   * 不会因为提醒堆积而被要求连续点很多次。
   */
  function confirmAlerts(): void {
    if (alerts.value.length === 0) return
    const confirmed = readStringArray(ALERT_CONFIRMED_KEY)
    const merged = [...confirmed]
    for (const item of alerts.value) {
      if (!merged.includes(item.id)) merged.push(item.id)
    }
    writeStringArray(ALERT_CONFIRMED_KEY, merged)
    alerts.value = []
  }

  // ---- 更新:交互 ----------------------------------------------------------

  /** 忽略此版本:记录版本号,该版本不再提示(更高版本仍会提示) */
  function ignoreUpdate(): void {
    if (latestVersion.value) {
      writeString(UPDATE_IGNORED_VERSION_KEY, latestVersion.value)
    }
    updateOpen.value = false
  }

  /** 前往下载:返回当前平台对应的下载地址(网页端为空串) */
  function downloadUrl(): string {
    if (platform === 'android') return downloads.value.android ?? ''
    if (platform === 'windows') return downloads.value.windows ?? ''
    return ''
  }

  return {
    // 状态
    noticeTitle,
    noticeContent,
    noticeOpen,
    alerts,
    latestVersion,
    downloads,
    updateOpen,
    platform,
    isNativeClient,
    updateAllowed,
    activePopup,
    // 行为
    loadPopupData,
    onNoticeConfirm,
    onNoticeDismiss,
    confirmAlerts,
    ignoreUpdate,
    downloadUrl,
  }
}
