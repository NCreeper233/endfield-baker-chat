// =============================================================================
// 数据持久化(useChatPersistence)
// -----------------------------------------------------------------------------
//   - 介质:IndexedDB(库 endfield-baker,单 objectStore "data")
//   - 自动保存:deep watch(cards)→ 300ms 防抖 → 深拷贝写库;运行时态不持久化
//   - 启动恢复:loadProject() 读取并校验,失败/超时静默回退初始数据
//   - 导出/导入:ZIP 压缩包(文本 JSON + 独立图片),见 utils/zipExport.ts
//   - 结构版本:PROJECT_VERSION = 1
// =============================================================================
import { watch } from 'vue'
import { useChatStore } from '../stores/chat'
import {
  isCards,
  sanitizeCards,
  PROJECT_VERSION,
} from '../utils/zipExport'
import type { Card } from '../types/chat'

const DB_NAME = 'endfield-baker'
const STORE_NAME = 'data'
const KEY_CARDS = 'cards'
const KEY_MY_GENDER = 'myGender'
const KEY_STRIP_VARIANT = 'stripVariant'
const KEY_VERSION = 'version'

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
export function flushPendingWrites(): void {
  for (const flush of [...flushReady]) flush()
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

// ---- 持久化生命周期 ---------------------------------------------------------

/**
 * 注册自动保存并返回启动恢复函数。
 * 需在应用挂载前调用,保证恢复数据先于首帧渲染。
 */
export function useChatPersistence(store: ReturnType<typeof useChatStore>) {
  /**
   * 防抖写库器:schedule(延迟写) + flush(立即写)
   * 写入统一 doWrite:深拷贝后落库,并同步库内结构版本。
   */
  const debounceWrite = (key: string, get: () => unknown) => {
    let timer: number | undefined

    const doWrite = async () => {
      try {
        const db = await getDb()
        await putRecord(db, key, JSON.parse(JSON.stringify(get())))
        if (KEY_VERSION !== key) await putRecord(db, KEY_VERSION, PROJECT_VERSION)
      } catch (err) {
        console.warn(`[persist] 写入 ${key} 失败`, err)
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

    const flush = () => {
      if (blockWrites) return
      if (timer !== undefined) {
        window.clearTimeout(timer)
        timer = undefined
      }
      void doWrite()
    }

    flushReady.add(flush)
    return { schedule, flush }
  }

  const scheduleCards = debounceWrite(KEY_CARDS, () => store.cards)
  const scheduleMyGender = debounceWrite(KEY_MY_GENDER, () => store.myGender)
  const scheduleStripVariant = debounceWrite(KEY_STRIP_VARIANT, () => store.stripVariantIndex)
  const { schedule: cardSchedule, flush: cardFlush } = scheduleCards
  const { schedule: myGenderSchedule, flush: myGenderFlush } = scheduleMyGender
  const { schedule: stripVariantSchedule, flush: stripVariantFlush } = scheduleStripVariant

  installUnloadFlush()

  const unwatchCards = watch(() => store.cards, cardSchedule, { deep: true })
  const unwatchMyGender = watch(() => store.myGender, myGenderSchedule)
  const unwatchStripVariant = watch(() => store.stripVariantIndex, stripVariantSchedule)

  function disposeWatchers() {
    unwatchCards()
    unwatchMyGender()
    unwatchStripVariant()
    flushReady.delete(cardFlush)
    flushReady.delete(myGenderFlush)
    flushReady.delete(stripVariantFlush)
  }

  /**
   * 从 IndexedDB 恢复数据。
   * 失败/超时静默回退初始数据,绝不抛出。
   */
  async function loadProject(): Promise<void> {
    try {
      const db = await getDb()
      const [cardsRaw, versionRaw, myGenderRaw, stripVariantRaw] = await Promise.all([
        getRecord(db, KEY_CARDS),
        getRecord(db, KEY_VERSION),
        getRecord(db, KEY_MY_GENDER),
        getRecord(db, KEY_STRIP_VARIANT),
      ])
      const fromVersion = typeof versionRaw === 'number' ? versionRaw : 0
      if (fromVersion !== PROJECT_VERSION) {
        if (fromVersion > PROJECT_VERSION) {
          console.warn(`[persist] 库内结构版本 ${fromVersion} 高于本应用 ${PROJECT_VERSION},使用初始数据`)
          blockWrites = true
        } else {
          console.warn(`[persist] 库内结构版本 ${fromVersion} 低于本应用 ${PROJECT_VERSION},使用初始数据`)
        }
        return
      }
      if (myGenderRaw === 'female' || myGenderRaw === 'male') {
        store.setMyGender(myGenderRaw)
      }
      if (typeof stripVariantRaw === 'number') {
        store.setStripVariant(stripVariantRaw)
      }
      if (isCards(cardsRaw)) {
        store.replaceAllCards(sanitizeCards(cardsRaw as Card[]))
      }
    } catch (err) {
      console.warn('[persist] 读取失败,使用初始数据', err)
    }
  }

  return { loadProject, disposeWatchers, flushNow: flushPendingWrites }
}
