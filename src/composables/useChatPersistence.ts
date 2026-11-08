// useChatPersistence —— 数据持久化（IndexedDB，库 endfield-baker / 单 store "data"）
// 自动保存是 deep watch(cards) → 300ms 防抖 → 深拷贝写库；运行时态不持久化。
// 启动恢复失败或超时静默回退初始数据；打包端改走 nativeStorage 的文件仓库。
import { watch } from 'vue'
import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { useUsageStore } from '../stores/usage'
import {
  PROJECT_VERSION,
  restoreCardsLoose,
} from '../utils/zipExport'
import { getNativeFileBridge, createNativeStore } from '../utils/nativeStorage'
import { toPlain } from '../utils/plainCopy'
import { CardStorage, planCardWrite, type CardKV } from '../utils/cardStorage'
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
/**
 * 子对话（主卡内的子卡）活跃记录
 *
 * 与 KEY_CARD_ACTIVITY 同理，但键是「卡片身份 + 卡内下标」——子对话没有稳定 id。
 * 独立 key：它只决定卡内渲染顺序，坏了最多顺序回退，绝不碰卡片数据本身。
 */
const KEY_SUB_ACTIVITY = 'subActivity'

/** 写库防抖窗口(ms) */
const SAVE_DEBOUNCE_MS = 300
/** 打开数据库超时(ms) */
const DB_TIMEOUT_MS = 8000

// IndexedDB 封装（模块级单例连接）

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
  // 可等待：Electron 关窗前必须等真实落盘，否则窗口销毁时在途写入一起消失
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

/** 单事务写多个键：要么全成、要么全无（分片迁移靠这个保证原子） */
function putManyRecords(db: IDBDatabase, entries: Array<[string, unknown]>): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const [key, value] of entries) store.put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('写入失败'))
    tx.onabort = () => reject(tx.error ?? new Error('写入中止'))
  })
}

/** 删除若干键（清理被删卡片留下的孤儿分片） */
function deleteRecords(db: IDBDatabase, keys: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const key of keys) store.delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('删除失败'))
    tx.onabort = () => reject(tx.error ?? new Error('删除中止'))
  })
}

function getRecord(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('读取失败'))
  })
}

// 统一存储后端（网页 IndexedDB / 打包 JSON 文件）
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

// 持久化生命周期

/**
 * 注册自动保存并返回启动恢复函数。
 * 需在应用挂载前调用,保证恢复数据先于首帧渲染。
 */
export function useChatPersistence(
  store: ReturnType<typeof useChatStore>,
  settingsStore: ReturnType<typeof useSettingsStore>,
) {
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
        await putRecordUnified(key, toPlain(snapshot))
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

  // ---- 卡片数据：网页端分片写，打包端整库写 -------------------------------
  // 网页端每次只写"变了的卡"（见 utils/cardStorage）；打包端是一个 JSON 文件，
  // 拆键只会让它每写一个键就整文件序列化一次，反而更慢，所以维持原样。
  /** 打包端才用整库快照 */
  let isNativeStore = false
  /** 分片存储状态机（slot 分配 / 脏标记 / 迁移） */
  const cardStorage = new CardStorage()
  /** 网页端的存储后端适配 */
  const webKv: CardKV = {
    get: (key) => getRecordUnified(key),
    putMany: async (entries) => putManyRecords(await getDb(), entries),
    del: async (keys) => deleteRecords(await getDb(), keys),
  }

  /** 单张卡 → 可结构化克隆的普通值（错误气泡只显示、绝不落库） */
  function cardValue(card: object): unknown {
    const c = card as {
      conversations?: Array<{ messages?: Array<{ isError?: boolean }> }>
    }
    const plain = toPlain(card) as typeof c
    return {
      ...plain,
      conversations: (plain.conversations ?? []).map((conv) => ({
        ...conv,
        messages: (conv.messages ?? []).filter((m) => !m.isError),
      })),
    }
  }

  /** 打包端用的整库快照 */
  function cardsSnapshot(): unknown {
    return store.cards.map((c) => cardValue(c))
  }

  /** 卡片身份：写进索引，载入时用来校验「位置 → slot」的映射 */
  function cardKeyOf(card: object): string {
    return store.cardActiveKey(card as Card)
  }

  /** 配额类错误（分片写完不成时用它决定能不能丢掉旧快照再试） */
  function isQuotaError(err: unknown): boolean {
    const name = err instanceof DOMException
      ? err.name
      : (err as { name?: string } | null)?.name
    return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
  }

  /** 真正写卡片数据 */
  async function writeCards(): Promise<void> {
    // 迁移前一律先把旧格式整库写一遍（见 planCardWrite 的注释）；
    // 迁移成功后 format 变 2，这条路自动关闭。
    const plan = planCardWrite({
      loadState,
      isNative: isNativeStore,
      format: cardStorage.format,
      blocked: blockWrites,
    })
    if (plan.mode === 'skip') {
      if (!blockWrites) {
        devWarn(`[persist] 跳过写库:载入状态=${loadState}(未成功恢复/结构异常),拒绝覆盖`)
      }
      return
    }
    try {
      if (plan.mode === 'legacy' || plan.mode === 'legacy+split') {
        await putRecordUnified(KEY_CARDS, cardsSnapshot())
      }
      if (plan.mode === 'legacy+split' || plan.mode === 'split') {
        trackCards()
        const migrated = cardStorage.format === 2
        try {
          await cardStorage.save(webKv, store.cards, cardValue, cardKeyOf)
        } catch (err) {
          // 已经迁移过还写不进去，多半是配额：旧快照还占着一份空间。
          // 此时分片里是完整的最新数据，旧快照只是回退用的，删掉它换空间不丢东西。
          // 迁移中的失败绝不能走这条：那一瞬间旧 `cards` 才是唯一完整副本。
          if (!migrated || !isQuotaError(err)) throw err
          devWarn('[persist] 分片写库超出配额，删除旧快照后重试', err)
          await webKv.del([KEY_CARDS])
          await cardStorage.save(webKv, store.cards, cardValue, cardKeyOf)
        }
      }
      await putRecordUnified(KEY_VERSION, PROJECT_VERSION)
    } catch (err) {
      devWarn('[persist] 写卡片失败', err)
    }
  }

  /** 卡片写库的防抖器（与 debounceWrite 同节奏，但写入内容不同） */
  let cardsTimer: number | undefined
  const cardSchedule = (): void => {
    if (blockWrites) return
    window.clearTimeout(cardsTimer)
    cardsTimer = window.setTimeout(() => {
      cardsTimer = undefined
      void writeCards()
    }, SAVE_DEBOUNCE_MS)
  }
  const cardFlush = (): Promise<void> => {
    if (blockWrites) return Promise.resolve()
    if (cardsTimer !== undefined) {
      window.clearTimeout(cardsTimer)
      cardsTimer = undefined
    }
    return writeCards()
  }
  flushReady.add(cardFlush)

  /**
   * 给每张卡挂一个深度监听，只用来打「这张卡脏了」的标记
   *
   * 全量写库时不需要（整库反正都要写）；分片写库靠它把写入范围收窄到变过的那几张。
   */
  const cardWatchers = new Map<number, () => void>()
  function trackCards(): void {
    if (isNativeStore) return
    const order = cardStorage.sync(store.cards)
    const alive = new Set(order)
    for (const [slot, stop] of cardWatchers) {
      if (!alive.has(slot)) {
        stop()
        cardWatchers.delete(slot)
      }
    }
    store.cards.forEach((card, i) => {
      const slot = order[i]
      if (cardWatchers.has(slot)) return
      cardWatchers.set(slot, watch(
        () => card,
        () => cardStorage.markDirty(slot),
        { deep: true },
      ))
    })
  }

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
  // 子对话排序记录:独立 key,与主卡排序互不牵连
  const scheduleSubActivity = debounceWrite(KEY_SUB_ACTIVITY, () => store.subActiveAt)
  const { schedule: subActivitySchedule, flush: subActivityFlush } = scheduleSubActivity

  installUnloadFlush()

  const unwatchCards = watch(() => store.cards, cardSchedule, { deep: true })
  // 结构变化（新建 / 删除 / 导入）后要补挂监听：卡的数量或身份变了就重新同步一次
  const unwatchCardCount = watch(() => store.cards.length, () => {
    trackCards()
    cardSchedule()
  })
  const unwatchMyGender = watch(() => store.myGender, myGenderSchedule)
  const unwatchStripVariant = watch(() => store.stripVariantIndex, stripVariantSchedule)
  const unwatchCardActivity = watch(() => store.cardActiveAt, cardActivitySchedule)
  const unwatchSubActivity = watch(() => store.subActiveAt, subActivitySchedule)
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
    unwatchCardCount()
    unwatchMyGender()
    unwatchStripVariant()
    unwatchCardActivity()
    unwatchSubActivity()
    unwatchSettings()
    unwatchUsage()
    flushReady.delete(cardFlush)
    flushReady.delete(myGenderFlush)
    flushReady.delete(stripVariantFlush)
    flushReady.delete(cardActivityFlush)
    flushReady.delete(subActivityFlush)
    flushReady.delete(settingsFlush)
    flushReady.delete(usageFlush)
    for (const stop of cardWatchers.values()) stop()
    cardWatchers.clear()
  }

  /**
   * 从 IndexedDB 恢复数据。
   * 失败/超时静默回退初始数据,绝不抛出。
   */
  async function loadProject(): Promise<void> {
    try {
      // 读取必须**串行**：并发 7 个读取时，原生端未命中缓存会整文件各读一次，
      // 30MB 库在低端机上 OOM → 异常被吞成 null → 被判成"没有数据" → 整库被覆盖。
      // 串行只真读一次，其余命中缓存。
      const native = await getNativeStore()
      isNativeStore = native !== null
      // 网页端优先读分片格式；没有分片就退回旧格式（旧键只读不删，是回退快照）
      const cardsRaw = isNativeStore
        ? await getRecordUnified(KEY_CARDS)
        : await cardStorage.load(webKv)
      const versionRaw = await getRecordUnified(KEY_VERSION)
      const myGenderRaw = await getRecordUnified(KEY_MY_GENDER)
      const stripVariantRaw = await getRecordUnified(KEY_STRIP_VARIANT)
      const settingsRaw = await getRecordUnified(KEY_SETTINGS)
      const usageRaw = await getRecordUnified(KEY_USAGE)
      const cardActivityRaw = await getRecordUnified(KEY_CARD_ACTIVITY)
      const subActivityRaw = await getRecordUnified(KEY_SUB_ACTIVITY)
      // v6: 恢复设置快照(api配置/提示词覆盖/开关等),缺失时跳过
      if (settingsRaw && typeof settingsRaw === 'object') {
        settingsStore.applySettingsSnapshot(settingsRaw as Record<string, unknown>)
      }
      const fromVersion = typeof versionRaw === 'number' ? versionRaw : 0
      if (fromVersion !== PROJECT_VERSION) {
        // 版本不匹配**照样恢复能读出来的数据**：直接 return 等于把用户数据判死刑。
        // 常见触发：「卡片写成功、版本键还没写」时 App 被系统杀掉，重启后版本键缺失。
        // 版本更高（降级运行）时禁止写回，避免旧版本覆盖新数据。
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
      // 逐卡恢复：一条坏消息不能让整库不被恢复（否则随后被空库覆盖 = 数据全丢）
      if (Array.isArray(cardsRaw) && cardsRaw.length > 0) {
        const { cards: restored, dropped } = restoreCardsLoose(cardsRaw)
        if (restored.length > 0) {
          store.replaceAllCards(restored)
          loadState = 'ok'
          // 恢复完再挂脏标记监听：卡的顺序与编号在这一刻才确定
          trackCards()
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
      // 子对话顺序与主卡顺序同批恢复，但互相独立（任一损坏不影响另一个）
      store.applySubActivity(subActivityRaw)
      // 用量统计与卡片数据互不依赖:卡片结构版本不匹配时它也不该被丢弃
      usageStore.applySnapshot(usageRaw)
    } catch (err) {
      devWarn('[persist] 读取失败,使用初始数据', err)
    }
  }

  return { loadProject, disposeWatchers, flushNow: flushPendingWrites }
}
