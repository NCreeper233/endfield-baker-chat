// =============================================================================
// 数据持久化(useChatPersistence)
// -----------------------------------------------------------------------------
//   - 介质:IndexedDB(库 endfield-baker,单 objectStore "data")
//   - 自动保存:deep watch(cards)→ 300ms 防抖 → 深拷贝写库;运行时态不持久化
//   - 列表排序记录(cardActivity)另存一个 key:卡片标识 → 最后活跃时刻,
//     与 cards 同一批读写,但互不依赖(它坏了只是退回内置顺序)
//   - 启动恢复:loadProject() 读取并校验,失败/超时静默回退初始数据
//   - 导出/导入:ZIP 压缩包(文本 JSON + 独立图片),见 utils/zipExport.ts
//   - 结构版本:PROJECT_VERSION = 1
// =============================================================================
import { watch } from 'vue'
import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { useUsageStore } from '../stores/usage'
import {
  isCards,
  sanitizeCards,
  PROJECT_VERSION,
  restoreCardsLoose,
} from '../utils/zipExport'
import { getNativeFileBridge, createNativeStore } from '../utils/nativeStorage'
import type { Card } from '../types/chat'
import { devWarn } from '../utils/logger'

const DB_NAME = 'endfield-baker'
const STORE_NAME = 'data'
const KEY_CARDS = 'cards'
const KEY_SETTINGS = 'settings'
const KEY_MY_GENDER = 'myGender'
const KEY_STRIP_VARIANT = 'stripVariant'
const KEY_VERSION = 'version'
/** 用量统计快照(与卡片数据独立,互不依赖:任一方损坏都不影响另一方) */
const KEY_USAGE = 'usage'
/**
 * 列表排序记录(主卡标识 → 最后一次来消息的时刻)
 *
 * 独立 key:它只是"列表怎么排"这一条展示偏好,坏了/丢了最多退回内置顺序,
 * 绝不该影响卡片数据本身。键是卡片身份(干员名 / 群成员集合),不是下标。
 */
const KEY_CARD_ACTIVITY = 'cardActivity'

/** 写库防抖窗口(ms) */
const SAVE_DEBOUNCE_MS = 300
/** 打开数据库超时(ms) */
const DB_TIMEOUT_MS = 8000

// ---- IndexedDB 封装(模块级单例连接) -----------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null

/**
 * 是否禁止自动写入(库内结构版本高于本应用版本时置真)。
 * 防止旧版本应用覆写新版本数据。
 */
let blockWrites = false

/** 已注册的防抖写库 flush 回调 */
const flushReady = new Set<() => void>()

/**
 * 立即冲刷所有挂起的防抖写库。
 * 页面隐退与导入/清空后调用,把防抖窗口内的编辑即刻落盘。
 */
export async function flushPendingWrites(): Promise<void> {
  // 【2026-10-04】可等待：Electron 关窗前必须等真实落盘，否则窗口销毁时在途写入一起消失。
  await Promise.all([...flushReady].map((f) => Promise.resolve(f())))
}

/** 是否已安装页面隐退监听(单例) */
let unloadFlushInstalled = false

function installUnloadFlush(): void {
  if (unloadFlushInstalled) return
  unloadFlushInstalled = true
  const onPageHide = () => flushPendingWrites()
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') flushPendingWrites()
  }
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onVisibilityChange)
}

function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDb().catch((err) => {
      dbPromise = null
      throw err
    })
  }
  return dbPromise
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME)
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('打开数据库超时'))
    }, DB_TIMEOUT_MS)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => {
      if (settled) {
        request.result.close()
        return
      }
      settled = true
      window.clearTimeout(timer)
      resolve(request.result)
    }
    request.onerror = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      reject(request.error ?? new Error('打开数据库失败'))
    }
    request.onblocked = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      reject(new Error('数据库被占用'))
    }
  })
}

function putRecord(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('写入失败'))
    tx.onabort = () => reject(tx.error ?? new Error('写入中止'))
  })
}

function getRecord(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('读取失败'))
  })
}

// ---- 统一存储后端(网页 IndexedDB / 打包 JSON 文件) -------------------------
// 打包环境(EXE/APK)下 IndexedDB 不可靠(WebView 可能清空),改走本地 JSON 文件:
// 优先探测原生文件桥,存在则用 JSON 文件,否则回退 IndexedDB。
let nativeStorePromise: Promise<ReturnType<typeof createNativeStore> | null> | null = null

function getNativeStore(): Promise<ReturnType<typeof createNativeStore> | null> {
  if (!nativeStorePromise) {
    nativeStorePromise = getNativeFileBridge().then((bridge) =>
      bridge ? createNativeStore(bridge) : null,
    )
  }
  return nativeStorePromise
}

/** 统一写入:打包环境写 JSON 文件,网页写 IndexedDB */
async function putRecordUnified(key: string, value: unknown): Promise<void> {
  const native = await getNativeStore()
  if (native) {
    await native.put(key, value)
    return
  }
  const db = await getDb()
  await putRecord(db, key, value)
}

/** 统一读取:打包环境读 JSON 文件,网页读 IndexedDB */
async function getRecordUnified(key: string): Promise<unknown> {
  const native = await getNativeStore()
  if (native) {
    return native.get(key)
  }
  const db = await getDb()
  return getRecord(db, key)
}

// ---- 持久化生命周期 ---------------------------------------------------------

/**
 * 注册自动保存并返回启动恢复函数。
 * 需在应用挂载前调用,保证恢复数据先于首帧渲染。
 */
export function useChatPersistence(
  store: ReturnType<typeof useChatStore>,
  settingsStore: ReturnType<typeof useSettingsStore>,
) {
  /** 载入时实际恢复出来的卡片数 */
  let loadedCardCount = 0
  /**
   * 载入状态（决定能否写库）
   * unknown = 还没载入完 / 载入过程抛错（**禁止写**，防空库覆盖）
   * ok      = 成功恢复出数据 · empty = 确实没有记录（首次使用）· invalid = 结构异常（只读保护）
   */
  let loadState: 'unknown' | 'ok' | 'empty' | 'invalid' = 'unknown'

  /**
   * 防抖写库器:schedule(延迟写) + flush(立即写)
   * 写入统一 doWrite:深拷贝后落库,并同步库内结构版本。
   */
  const debounceWrite = (key: string, get: () => unknown) => {
    let timer: number | undefined

    const doWrite = async (): Promise<void> => {
      try {
        const snapshot = get()
        // 数据层护栏:get() 返回 {__skipWrite:true} 时本次不写(见 scheduleCards)
        if (snapshot && typeof snapshot === 'object' &&
            (snapshot as { __skipWrite?: boolean }).__skipWrite) {
          return
        }
        await putRecordUnified(key, JSON.parse(JSON.stringify(snapshot)))
        if (KEY_VERSION !== key) await putRecordUnified(KEY_VERSION, PROJECT_VERSION)
      } catch (err) {
        devWarn(`[persist] 写入 ${key} 失败`, err)
      }
    }

    const schedule = () => {
      if (blockWrites) return
      window.clearTimeout(timer)
      timer = window.setTimeout(async () => {
        timer = undefined
        await doWrite()
      }, SAVE_DEBOUNCE_MS)
    }

    const flush = (): Promise<void> => {
      if (blockWrites) return Promise.resolve()
      if (timer !== undefined) {
        window.clearTimeout(timer)
        timer = undefined
      }
      return doWrite()
    }

    flushReady.add(flush)
    return { schedule, flush }
  }

  // v6: 设置快照(apiConfig/promptOverrides/think/forceSearch/summary/noticeDismissed)
  const scheduleSettings = debounceWrite(KEY_SETTINGS, () => settingsStore.getSettingsSnapshot())
  // 卡片写库:错误消息(请求失败占位气泡)只显示、绝不持久化——写库前剥离 isError 消息
  const scheduleCards = debounceWrite(KEY_CARDS, () => {
    const cards = store.cards
    // 【2026-10-04 护栏·重做】原判据 `cards.length === 0` 永远不成立
    // （cards 恒含内置角色），等于没护栏。真正的危险是"载入失败 → 只剩空内置卡"，
    // 所以改用载入状态：只有确实"恢复了数据"或"确实没有记录"时才允许写。
    if (loadState === 'unknown' || loadState === 'invalid') {
      devWarn(`[persist] 跳过写库:载入状态=${loadState}(未成功恢复/结构异常),拒绝覆盖`)
      return { __skipWrite: true }
    }
    return cards.map((c) => ({
      ...c,
      conversations: c.conversations.map((conv) => ({
        ...conv,
        messages: conv.messages.filter((m) => !m.isError),
      })),
    }))
  })
  const { schedule: cardSchedule, flush: cardFlush } = scheduleCards
  const scheduleMyGender = debounceWrite(KEY_MY_GENDER, () => store.myGender)
  const scheduleStripVariant = debounceWrite(KEY_STRIP_VARIANT, () => store.stripVariantIndex)
  const { schedule: myGenderSchedule, flush: myGenderFlush } = scheduleMyGender
  const { schedule: stripVariantSchedule, flush: stripVariantFlush } = scheduleStripVariant
  const { schedule: settingsSchedule, flush: settingsFlush } = scheduleSettings

  // v7: 用量统计(最近一次 / 累计 / 校准比值 / 前缀指纹),独立 key
  const usageStore = useUsageStore()
  const scheduleUsage = debounceWrite(KEY_USAGE, () => usageStore.getSnapshot())
  const { schedule: usageSchedule, flush: usageFlush } = scheduleUsage

  // 列表排序记录:每次盖章都会换一个新对象 → 依赖变化即落盘(300ms 防抖吸收连发)
  const scheduleCardActivity = debounceWrite(KEY_CARD_ACTIVITY, () => store.cardActiveAt)
  const { schedule: cardActivitySchedule, flush: cardActivityFlush } = scheduleCardActivity

  installUnloadFlush()

  const unwatchCards = watch(() => store.cards, cardSchedule, { deep: true })
  const unwatchMyGender = watch(() => store.myGender, myGenderSchedule)
  const unwatchStripVariant = watch(() => store.stripVariantIndex, stripVariantSchedule)
  const unwatchCardActivity = watch(() => store.cardActiveAt, cardActivitySchedule)
  // 深度监听 settings store 全部相关状态,变化即落盘
  const unwatchSettings = watch(
    () => settingsStore.getSettingsSnapshot(),
    settingsSchedule,
    { deep: true },
  )
  // 用量统计每次 record/getSnapshot 都会产出新对象 → 依赖变化即触发落盘
  const unwatchUsage = watch(() => usageStore.getSnapshot(), usageSchedule, { deep: true })

  function disposeWatchers() {
    unwatchCards()
    unwatchMyGender()
    unwatchStripVariant()
    unwatchCardActivity()
    unwatchSettings()
    unwatchUsage()
    flushReady.delete(cardFlush)
    flushReady.delete(myGenderFlush)
    flushReady.delete(stripVariantFlush)
    flushReady.delete(cardActivityFlush)
    flushReady.delete(settingsFlush)
    flushReady.delete(usageFlush)
  }

  /**
   * 从 IndexedDB 恢复数据。
   * 失败/超时静默回退初始数据,绝不抛出。
   */
  async function loadProject(): Promise<void> {
    try {
      // 【2026-10-04 数据安全】改成**串行**读取。
      // 以前 Promise.all 并发 7 个读取：原生端 loadCache 未命中缓存时每个都整文件读一次
      // → 30MB 库并发读 7 次 → 低端机 OOM → 异常被吞成 null → 被判成"没有数据"
      // → 随后整库被覆盖。串行只真读一次，其余命中缓存。
      const cardsRaw = await getRecordUnified(KEY_CARDS)
      const versionRaw = await getRecordUnified(KEY_VERSION)
      const myGenderRaw = await getRecordUnified(KEY_MY_GENDER)
      const stripVariantRaw = await getRecordUnified(KEY_STRIP_VARIANT)
      const settingsRaw = await getRecordUnified(KEY_SETTINGS)
      const usageRaw = await getRecordUnified(KEY_USAGE)
      const cardActivityRaw = await getRecordUnified(KEY_CARD_ACTIVITY)
      // v6: 恢复设置快照(api配置/提示词覆盖/开关等),缺失时跳过
      if (settingsRaw && typeof settingsRaw === 'object') {
        settingsStore.applySettingsSnapshot(settingsRaw as Record<string, unknown>)
      }
      const fromVersion = typeof versionRaw === 'number' ? versionRaw : 0
      if (fromVersion !== PROJECT_VERSION) {
        // 【2026-10-04 修复:以前这里直接 return,等于把用户数据判死刑】
        // 触发条件很常见:上一次保存"卡片写成功、版本键还没写"时 App 被系统杀掉,
        // 重启后版本键缺失 → 旧代码不恢复卡片 → 空列表被自动保存覆盖 → 聊天记录全丢。
        // 现在:版本不匹配**照样把能读出来的数据恢复出来**,只是版本更高(降级运行)时
        // 禁止写回,避免旧版本覆盖新版本数据。
        if (fromVersion > PROJECT_VERSION) {
          devWarn(`[persist] 库内结构版本 ${fromVersion} 高于本应用 ${PROJECT_VERSION}:` +
                  '已按只读方式载入数据(不写回)')
          blockWrites = true
        } else {
          devWarn(`[persist] 库内结构版本 ${fromVersion} 与本应用 ${PROJECT_VERSION} 不一致:` +
                  '已恢复数据并将在下次保存时补齐版本键(不再丢弃)')
        }
      }
      if (myGenderRaw === 'female' || myGenderRaw === 'male') {
        store.setMyGender(myGenderRaw)
      }
      if (typeof stripVariantRaw === 'number') {
        store.setStripVariant(stripVariantRaw)
      }
      // 【2026-10-04 数据安全】逐卡恢复：以前 isCards 是"全有或全无"，
      // 一条坏消息就会让整库不被恢复（随后被空库覆盖 = 数据全丢）。
      if (Array.isArray(cardsRaw) && cardsRaw.length > 0) {
        const { cards: restored, dropped } = restoreCardsLoose(cardsRaw)
        if (restored.length > 0) {
          store.replaceAllCards(restored)
          loadedCardCount = restored.length
          loadState = 'ok'
        }
        if (dropped > 0) {
          devWarn(`[persist] 恢复时跳过 ${dropped} 条无法解析的卡片数据（其余已恢复）`)
        }
      } else if (cardsRaw === undefined || cardsRaw === null) {
        loadState = 'empty'      // 确实没有记录（首次使用）
      } else {
        loadState = 'invalid'    // 有记录但结构完全不对 → 只读保护
        devWarn('[persist] 卡片数据结构异常，已进入只读保护（不会覆盖）')
      }
      // 列表排序记录必须**在卡片树装好之后**恢复:replaceAllCards 会清空它
      // (换数据集时旧的活跃记录没有意义),这里再把落盘的那份盖回去。
      store.applyCardActivity(cardActivityRaw)
      // 用量统计与卡片数据互不依赖:卡片结构版本不匹配时它也不该被丢弃
      usageStore.applySnapshot(usageRaw)
    } catch (err) {
      devWarn('[persist] 读取失败,使用初始数据', err)
    }
  }

  return { loadProject, disposeWatchers, flushNow: flushPendingWrites }
}
