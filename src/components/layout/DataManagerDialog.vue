<script setup lang="ts">
// DataManagerDialog —— 数据管理：统计、导出（.zip / 单文件 JSON）、导入、四种清空、云同步取件码
// 破坏性操作均为两段式确认（弹窗内切换确认态）。.json 走旧格式兼容层，图片内联；
// .zip 走压缩包，图片为独立文件。
import { computed, ref, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../../stores/chat'
import { useSettingsStore } from '../../stores/settings'
import VersionDialogShell from './VersionDialogShell.vue'
import {
  downloadProject,
  projectExportFileName,
  type ProjectPayload,
} from '../../utils/zipExport'
import {
  downloadProjectJson,
  importFromJson,
  exportToJson,
  IMPORT_FILE_ACCEPT,
} from '../../utils/jsonCompat'
import { isNativeAndroid, revealSavedFile, saveExportFileSmart } from '../../utils/nativeExport'
import { isElectron, isNative } from '../../utils/platform'
import {
  uploadCloudData,
  fetchCloudData,
  formatBytes,
  formatSpeed,
  formatDuration,
  type CloudUploadResult,
  type CloudProgress,
} from '../../utils/cloudData'
import {
  exportToZipInWorker,
  importFromZipInWorker,
  terminateZipWorker,
} from '../../utils/zipWorkerClient'
import { flushPendingWrites } from '../../composables/useChatPersistence'
import { mergeCards, describeMerge } from '../../utils/importMerge'
import type { Card } from '../../types/chat'

const props = defineProps<{
  /** 是否展开(由 App 的清除数据按钮控制) */
  open: boolean
  /**
   * 内嵌模式(设置弹窗内嵌时置 true):
   * 不渲染遮罩/关闭按钮/标题,面板铺满所在容器宽度,仅保留功能内容。
   */
  embedded?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const chatStore = useChatStore()
const settingsStore = useSettingsStore()
const { cards } = storeToRefs(chatStore)

// 组件卸载时终止导入导出 Worker,释放内存(大文件场景尤为关键)
onUnmounted(() => {
  stopExportTimer()
  terminateZipWorker()
})

/** 数据统计(卡片 / 对话 / 消息 / 序列化大小) */
const stats = computed(() => {
  // 对话只统计有内容的(有消息或有 AI 记忆),空对话不计入
  const hasContent = (cv: { messages: unknown[]; contextHistory?: unknown[] }) =>
    cv.messages.length > 0 || (cv.contextHistory?.length ?? 0) > 0
  const convCount = cards.value.reduce(
    (n, c) => n + c.conversations.filter(hasContent).length,
    0,
  )
  const msgCount = cards.value.reduce(
    (n, c) => n + c.conversations.reduce((m, cv) => m + cv.messages.length, 0),
    0,
  )
  const sizeKB = JSON.stringify({
    cards: cards.value,
  }).length / 1024
  return { cardCount: cards.value.length, convCount, msgCount, sizeKB: sizeKB.toFixed(1) }
})

// 导出状态
/** 导出中（ZIP 正在序列化+压缩） */
const isExporting = ref(false)
/** JSON 导出中 */
const isExportingJson = ref(false)
/** 应急导出中（仅安卓） */
const isExportingEmergency = ref(false)
/** 导出结果提示（成功后的体积/过滤信息） */
const exportInfo = ref('')

/** 是否安卓端（决定是否显示"应急导出"按钮） */
const androidNative = isNativeAndroid()

// ---- 导出落点（安卓写进「下载/Baker AI」，界面要把它显示出来）----
/** 刚导出成功的文件位置（给人看） */
const savedPath = ref('')
/** 刚导出成功的文件 uri（再打开用） */
const savedUri = ref('')
/** 刚导出成功的文件 MIME */
const savedMime = ref('application/octet-stream')
/** 导出已耗时（秒）—— 打包几十 MB 时要让用户看到"还在动"，而不是一个死按钮 */
const exportSeconds = ref(0)
let exportTicker: ReturnType<typeof setInterval> | null = null

/** 三个导出按钮共用一个计时器：谁在跑就数谁 */
function startExportTimer() {
  stopExportTimer()
  exportSeconds.value = 0
  exportTicker = setInterval(() => {
    exportSeconds.value += 1
  }, 1000)
}

function stopExportTimer() {
  if (exportTicker) {
    clearInterval(exportTicker)
    exportTicker = null
  }
}

/** 按钮文案：导出中… 3s（超过 2 秒才显示秒数，避免闪一下又没了） */
function exportingLabel(text: string): string {
  if (exportSeconds.value > 2) return `${text} ${exportSeconds.value}s`
  return text
}

/** 记下落点（浏览器端 path 为空，不显示这一行） */
function rememberSaved(info: { path?: string; uri?: string }, mime: string) {
  savedPath.value = info.path ?? ''
  savedUri.value = info.uri ?? ''
  savedMime.value = mime
}

/** 再打开一次文件管理器（自动跳转失败，或用户离开后又想看时用） */
async function openSavedFolder() {
  await revealSavedFile({ path: savedPath.value, uri: savedUri.value, mime: savedMime.value })
}

/** 清空上一次的落点（每次重新导出前） */
function clearSaved() {
  savedPath.value = ''
  savedUri.value = ''
}

/** 是否打包环境（Electron/APK）——正式版同款判定 */
function isNativePlatform(): boolean {
  // 统一走 utils/platform：Electron / Android / iOS 都算"打包端"，
  // 走 exportToZipInWorker（打包+base64）+ 各自的原生保存通道；
  // 纯浏览器（含手机浏览器）走 downloadProject 的 <a download>。
  return isElectron() || isNative()
}

/**
 * 两类处理分开报：重编码是「图还在，只是压小了」，剔除是「图没进包，只剩占位」。
 * totalBytes 是 utils 返回的真实字节（ZIP = blob.size，JSON = UTF-8 长度），
 * 提示里的 MB 数必须与用户拿到的文件一致。
 */
function applyExportInfo(
  filteredImages: number,
  reencodedImages: number,
  totalBytes: number,
  kind: string,
) {
  const mb = (totalBytes / 1024 / 1024).toFixed(1)
  const notes: string[] = []
  if (reencodedImages > 0) {
    notes.push(
      `已重编码 ${reencodedImages} 张大图（最长边 1600、画质略有压缩，体积已显著减小）`,
    )
  }
  if (filteredImages > 0) {
    notes.push(`已剔除 ${filteredImages} 张超大图片（保留"[图片]"占位）`)
  }
  exportInfo.value = `${kind}完成(约 ${mb}MB)。` + (notes.length > 0 ? notes.join('；') + '。' : '')
}

// 两段式确认状态
type ConfirmKind = 'clear' | 'clearMessages' | 'clearContext' | 'clearEverything' | 'import' | null
const confirmKind = ref<ConfirmKind>(null)
const importError = ref('')
const pendingImport = ref<ProjectPayload | null>(null)

const confirmTexts: Record<Exclude<ConfirmKind, null>, string> = {
  clear: '将删除全部对话，确定吗？',
  clearMessages: '将清空全部对话的消息（上下文记忆保留），确定吗？',
  clearContext: '将清空全部对话的上下文（消息记录保留），确定吗？',
  clearEverything: '将同时清空全部消息与全部上下文（AI 将不再记得之前的对话），确定吗？',
  import: '导入将覆盖当前全部数据，确定吗？',
}

/** 确认弹窗的标题(与触发按钮同名,让玩家一眼看出自己在确认什么) */
const confirmTitles: Record<Exclude<ConfirmKind, null>, string> = {
  clear: '删除全部对话',
  clearMessages: '清空全部消息',
  clearContext: '清空全部上下文',
  clearEverything: '一键清空历史与上下文',
  import: '导入数据',
}

/** 当前确认弹窗标题(null 时给个兜底,弹窗本身不显示) */
const confirmTitle = computed(() =>
  confirmKind.value ? confirmTitles[confirmKind.value] : '确认操作',
)

const fileInput = ref<HTMLInputElement | null>(null)

/** 导入合并进行中（合并是同步的，但数据量大时仍会让出一次绘制） */
const isMergingImport = ref(false)

/**
 * 导出数据(.zip)
 *
 * 两条路径，简单可靠：
 *   1. 打包端(EXE/APK)：exportToZipInWorker(打包+base64) → saveExportFileSmart()
 *      —— 小文件走系统保存框；大文件走分块写入 + 收尾回读校验，失败明确报错
 *   2. 浏览器：downloadProject() 直接下载
 */
async function onExport() {
  if (isExporting.value) return
  isExporting.value = true
  exportInfo.value = ''
  importError.value = ''
  clearSaved()
  startExportTimer()
  try {
    // 空数据守卫：空库不能"成功"导出一个 0 字节空包，
    // 直接说清楚更有用
    if (!cards.value || cards.value.length === 0) {
      throw new Error('当前没有可导出的数据（列表为空）。若你确认有聊天记录，请先重启应用再试；' +
                      '仍为空说明本地数据文件异常，可把数据目录里的 endfield-baker-data.json 发我排查。')
    }
    // 统一用 zipExport 的本地时间戳，否则 ZIP 与 JSON 会差 8 小时
    const fileName = projectExportFileName()
    if (isNativePlatform()) {
      // 打包端(EXE/APK)：Worker 内序列化 + 压缩 + base64，再经原生保存
      const { base64, filteredImages, reencodedImages, totalBytes } = await exportToZipInWorker(
        cards.value,
        chatStore.myGender,
        chatStore.stripVariantIndex,
        settingsStore.promptOverrides,
        settingsStore.getSettingsSnapshot(),
      )
      // 以前这里走整包 base64 的 saveFile，且**不校验落盘字节**：
      // 数据一大桥层就静默截断 → 得到 0 字节空包还提示"导出完成"。
      // 现在统一走 saveExportFileSmart：小文件走原生保存通道（带空内容守卫），
      // 大文件走分块写入（逐块 SHA-256 + 收尾回读校验），失败会明确报错。
      const saved = await saveExportFileSmart({ fileName, base64, mime: 'application/zip' })
      rememberSaved(saved, 'application/zip')
      // 优先用落盘字节（分块通道回读校验过），拿不到再退回 blob 真实体积
      applyExportInfo(filteredImages, reencodedImages, saved.bytes || totalBytes, '导出数据')
    } else {
      const res = await downloadProject(
        cards.value,
        chatStore.myGender,
        chatStore.stripVariantIndex,
        settingsStore.promptOverrides,
        settingsStore.getSettingsSnapshot(),
      )
      rememberSaved(res, 'application/zip')
      applyExportInfo(res.filteredImages, res.reencodedImages, res.totalBytes, '导出数据')
    }
  } catch (err) {
    importError.value = err instanceof Error ? err.message : '导出失败'
  } finally {
    stopExportTimer()
    isExporting.value = false
  }
}

/** 导出为单文件 JSON（正式版同款：downloadProjectJson 内部处理平台差异） */
async function onExportJson() {
  if (isExportingJson.value) return
  isExportingJson.value = true
  exportInfo.value = ''
  importError.value = ''
  clearSaved()
  startExportTimer()
  try {
    const res = await downloadProjectJson(
      cards.value,
      chatStore.myGender,
      chatStore.stripVariantIndex,
      settingsStore.promptOverrides,
      settingsStore.getSettingsSnapshot(),
      // v7：把当前列表人物顺序一起写进包（覆盖导入时应用）
      chatStore.exportCardOrder(),
    )
    rememberSaved(res, 'application/json')
    applyExportInfo(res.filteredImages, res.reencodedImages, res.totalBytes, '导出 JSON')
  } catch (err) {
    importError.value = err instanceof Error ? err.message : '导出失败'
  } finally {
    stopExportTimer()
    isExportingJson.value = false
  }
}

/** 应急导出（仅安卓）——沿用正式版的 JSON 导出通道 */
async function onEmergencyExport() {
  if (isExportingEmergency.value) return
  isExportingEmergency.value = true
  exportInfo.value = ''
  importError.value = ''
  clearSaved()
  startExportTimer()
  try {
    const res = await downloadProjectJson(
      cards.value,
      chatStore.myGender,
      chatStore.stripVariantIndex,
      settingsStore.promptOverrides,
      settingsStore.getSettingsSnapshot(),
      // v7：把当前列表人物顺序一起写进包（覆盖导入时应用）
      chatStore.exportCardOrder(),
    )
    rememberSaved(res, 'application/json')
    applyExportInfo(res.filteredImages, res.reencodedImages, res.totalBytes, '应急导出')
  } catch (err) {
    importError.value = err instanceof Error ? err.message : '应急导出失败'
  } finally {
    stopExportTimer()
    isExportingEmergency.value = false
  }
}


// 云同步（临时数据中转）
/** 上传中 */
const cloudBusy = ref(false)
/** 取回中 */
const cloudFetching = ref(false)
/** 上传成功后拿到的取件码信息 */
const cloudResult = ref<CloudUploadResult | null>(null)
/** 取回用的取件码输入 */
const cloudCodeInput = ref('')

/**
 * 服务端规则：恰好 8 位，字母表去掉了 0O1I 等易混字符，只含大写字母与数字。
 * 输入上限取 +2 冗余：挡住超长粘贴，又给多打一两个字符留出容错（服务端按长度截断）。
 */
const CODE_LEN = 8
/**
 * 输入上限 = 取件码长度 + 2 字符冗余
 *
 * 为什么留冗余：取件码恰好 8 位（服务端 CODE_LEN），但用户可能多打一两个字符；
 * 留 2 个余量既不会因为"差一位"就没法输入，也不会让人往输入框里粘一整篇文章。
 * 超过上限时**直接截断**（否则粘贴超长串会把输入框撑爆）。
 */
const CODE_MAX_INPUT = CODE_LEN + 2

/** 只保留字母与数字（提交/失焦时用它做最终净化）*/
function sanitizeCode(raw: string): string {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_MAX_INPUT)
}

/**
 * 输入处理
 *
 * ⚠️ 这里**故意不静默过滤非法字符** —— 否则用户输入符号时输入框永远不会变红，
 * 与"输入其他符号直接变红"的预期不符。做法：
 *   · 统一转大写、去掉空白（空格不算"非法符号"，粘贴带空格很常见）
 *   · 只在超过上限时截断
 *   · 非法字符**留在输入框里**，由 codeInvalid 把输入框变红、按钮置灰
 */
function onCodeInput(e: Event) {
  const el = e.target as HTMLInputElement
  // 转大写 + 去掉所有空白字符（含全角空格），其余字符保留用于校验提示
  const cleaned = (el.value || '').toUpperCase().replace(/\s+/g, '').slice(0, CODE_MAX_INPUT)
  if (cleaned !== el.value) el.value = cleaned
  cloudCodeInput.value = cleaned
}

/** 输入是否合法：恰好只含字母数字、长度在 1..上限 之间 */
const codeValid = computed(() => {
  const v = cloudCodeInput.value
  return v.length > 0 && v.length <= CODE_MAX_INPUT && /^[A-Z0-9]+$/.test(v)
})

/** 是否显示"取件码无效"（空输入不算无效，避免一打开就报错）*/
const codeInvalid = computed(() => cloudCodeInput.value.length > 0 && !codeValid.value)

/** 失焦时净化掉非法字符（用户已经看到红字提示了，这里帮他改好）*/
function onCodeBlur() {
  const clean = sanitizeCode(cloudCodeInput.value)
  if (clean !== cloudCodeInput.value) cloudCodeInput.value = clean
}

/** 云同步区提示 / 错误 */
const cloudInfo = ref('')
const cloudError = ref('')
/** 是否展开"从云端取回"输入框 */
const cloudFetchOpen = ref(false)

/**
 * 云同步进度：阶段 + 最近一帧传输数据(字节/速度/耗时/预计剩余)。
 * 阶段说明：packing=本地打包导出中；upload/download=正在传输；parsing=下载完成本地解析导入中。
 */
type CloudStage = 'idle' | 'packing' | 'upload' | 'download' | 'parsing'
const cloudStage = ref<CloudStage>('idle')
const cloudProgress = ref<CloudProgress | null>(null)

/** 让浏览器先画一帧再跑重活(打包/解析会阻塞主线程，否则进度条不出现) */
const paint = () => new Promise<void>((r) => setTimeout(r, 32))

/** 进度条宽度(%)：总量未知时返回 -1(走不确定动画) */
const cloudPercent = computed(() => {
  const p = cloudProgress.value
  if (cloudStage.value === 'packing' || cloudStage.value === 'parsing') return -1
  // 字节传完但服务器还在处理 → 用不确定动画，避免"卡在 100%"的观感
  if (p?.waitingServer) return -1
  if (!p || p.percent < 0) return -1
  return p.percent
})

/** 进度条右侧文字 */
const cloudProgressText = computed(() => {
  if (cloudStage.value === 'packing') return '正在打包数据…'
  if (cloudStage.value === 'parsing') return '下载完成，正在解析并导入…'
  const p = cloudProgress.value
  if (!p) return cloudStage.value === 'upload' ? '正在上传…' : '正在取回…'
  if (p.waitingServer) {
    // 数据已发完，服务器在解压/组装（实测约 1 分钟）—— 明确告知，别让用户以为卡死
    return `已上传 ${formatBytes(p.loaded)}，正在等待服务器处理…（已用 ${formatDuration(p.elapsedMs)}）`
  }
  const size = p.total > 0 ? `${formatBytes(p.loaded)} / ${formatBytes(p.total)}` : formatBytes(p.loaded)
  const parts = [size, formatSpeed(p.speedBps), p.percent >= 0 ? `${p.percent}%` : '传输中']
  parts.push(`已用 ${formatDuration(p.elapsedMs)}`)
  if (p.etaMs !== null) parts.push(`剩余约 ${formatDuration(p.etaMs)}`)
  if (p.total <= 0) parts.push('(服务器未提供总长度)')
  return parts.join(' · ')
})

/** 传输开始时的统一初始化 */
function startCloudProgress(stage: CloudStage) {
  cloudStage.value = stage
  cloudProgress.value = null
}
function endCloudProgress() {
  cloudStage.value = 'idle'
  cloudProgress.value = null
}
/** 传给 cloudData 的回调 */
function onCloudProgress(p: CloudProgress) {
  cloudStage.value = p.phase
  cloudProgress.value = p
}

/** 一键上传:用与本地导出完全相同的 JSON 包上传 */
async function onCloudUpload() {
  if (cloudBusy.value) return
  cloudBusy.value = true
  cloudInfo.value = ''
  cloudError.value = ''
  cloudResult.value = null
  startCloudProgress('packing')
  await paint()
  try {
    const { json, filteredImages } = exportToJson(
      cards.value,
      chatStore.myGender,
      chatStore.stripVariantIndex,
      settingsStore.promptOverrides,
      settingsStore.getSettingsSnapshot(),
      // v7：把当前列表人物顺序一起写进包（覆盖导入时应用）
      chatStore.exportCardOrder(),
    )
    startCloudProgress('upload')
    const r = await uploadCloudData(json, onCloudProgress)
    cloudResult.value = r
    const mb = (r.raw_bytes / 1024 / 1024).toFixed(1)
    cloudInfo.value =
      '已上传(约 ' + mb + 'MB)。请到别的设备打开「数据管理 → 拉取历史数据」，输入上面的取件码。' +
      (filteredImages > 0 ? ' 已自动过滤 ' + filteredImages + ' 张超大图片。' : '') +
      ' 服务器每天 12:00 检查一次，超过 24 小时的会被清理。'
  } catch (err) {
    cloudError.value = err instanceof Error ? err.message : '上传失败'
  } finally {
    endCloudProgress()
    cloudBusy.value = false
  }
}

/** 从云端取回:拿到 JSON → 走与本地导入完全相同的解析与二次确认流程 */
async function onCloudFetch() {
  if (cloudFetching.value) return
  // 前置校验：不合法直接不发请求（按钮此时本就是灰的，这里再兜一层）
  if (!codeValid.value) return
  cloudFetching.value = true
  cloudInfo.value = ''
  cloudError.value = ''
  startCloudProgress('download')
  try {
    const text = await fetchCloudData(cloudCodeInput.value, onCloudProgress)
    cloudStage.value = 'parsing'
    await paint()
    pendingImport.value = importFromJson(text)
    confirmKind.value = 'import'
    cloudFetchOpen.value = false
  } catch (err) {
    cloudError.value = err instanceof Error ? err.message : '取回失败'
  } finally {
    endCloudProgress()
    cloudFetching.value = false
  }
}

/** 复制取件码 */
async function onCopyCloudCode() {
  const code = cloudResult.value?.code
  if (!code) return
  try {
    await navigator.clipboard.writeText(code)
    cloudInfo.value = '取件码 ' + code + ' 已复制到剪贴板'
  } catch {
    cloudInfo.value = '取件码：' + code + '（选中手动复制）'
  }
}

/** 一键清空:同时清空全部消息 + 全部上下文(AI 不再记得之前的对话) */
function onRequestClearEverything() {
  confirmKind.value = 'clearEverything'
}

// 破坏性操作：统一两段式确认（先切确认态，再由 onConfirm 执行）
/** 删除全部对话 */
function onRequestClear() {
  confirmKind.value = 'clear'
}

/** 清空全部消息(保留 AI 上下文记忆) */
function onRequestClearMessages() {
  confirmKind.value = 'clearMessages'
}

/** 清空全部上下文(保留可见消息) */
function onRequestClearContext() {
  confirmKind.value = 'clearContext'
}

function onPickFile() {
  importError.value = ''
  fileInput.value?.click()
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    // 按扩展名/MIME 分流:JSON 走旧版兼容层,ZIP 走压缩包解压(Worker 内执行,防大文件卡死/OOM)
    const name = file.name.toLowerCase()
    const isJson = name.endsWith('.json') || file.type.includes('json')
    pendingImport.value = isJson
      ? importFromJson(await file.text())
      : await importFromZipInWorker(file)
    importError.value = ''
    confirmKind.value = 'import'
  } catch (err) {
    pendingImport.value = null
    confirmKind.value = null
    importError.value = err instanceof Error ? err.message : '文件解析失败'
  }
}

/** 替换卡片树后同步运行时态 */
function applyCards(next: Card[]) {
  chatStore.replaceAllCards(next)
}

/**
 * ⚠️ 必须放在 applyCards 之后：replaceAllCards 会清空排序记录，替换完再写才生效。
 * 旧包没有 order 字段时按 cards 数组顺序兜底 —— 导出时它就是「最近活跃在前」。
 */
function applyImportedOrder(payload: ProjectPayload, deriveFromCards: boolean) {
  let order = payload.order
  if ((!order || order.length === 0) && deriveFromCards) {
    // 用卡片的稳定标识序列兜底（与 chatStore.cardActiveKey 同一套规则）
    order = (payload.cards ?? []).map((c) => {
      const members = c.members ?? []
      if (members.length >= 2) return `g:${[...members].sort().join('|')}`
      return `s:${c.conversations[0]?.name ?? ''}`
    })
  }
  if (order && order.length) chatStore.applyCardOrder(order)
}

/** 应用导入包里的全局设置（合并/覆盖两种模式共用） */
function applyImportedSettings(payload: ProjectPayload) {
  chatStore.setMyGender(payload.myGender ?? 'male')
  chatStore.setStripVariant(payload.stripVariantIndex ?? 0)
  // v6: 优先应用完整设置快照(API配置/提示词覆盖/think/force_search/智能总结/公告标记)
  if (payload.settings && typeof payload.settings === 'object') {
    settingsStore.applySettingsSnapshot(payload.settings)
  }
  // 兼容旧包:无 settings 快照时,单独恢复自定义提示词覆盖
  if (payload.promptOverrides) {
    settingsStore.promptOverrides = { ...payload.promptOverrides }
  }
}

/**
 * 覆盖导入：用导入的卡片**替换**全部本地数据（原行为）
 */
function onConfirmOverwrite() {
  const payload = pendingImport.value
  if (!payload) return
  applyCards(payload.cards)
  // 覆盖导入 → **应用**导入包里的顺序（必须在 applyCards 之后，见函数注释）
  applyImportedOrder(payload, true)
  applyImportedSettings(payload)
  flushPendingWrites()
  confirmKind.value = null
  pendingImport.value = null
  emit('close')
}

/**
 * 合并导入
 *
 * 规则见 utils/importMerge.ts：同角色已有对话 → 追加为新的对话卡；
 * 本地无该角色 → 新建；本地同名角色为空 → 直接写入；群聊 → 直接追加。
 */
async function onConfirmMerge() {
  const payload = pendingImport.value
  if (!payload || isMergingImport.value) return
  isMergingImport.value = true
  try {
    // 让出一次绘制，避免大包合并时弹窗"卡住不动"
    await new Promise<void>((r) => setTimeout(r, 16))
    // 合并**忽略**导入顺序、保留本地顺序：先把当前顺序抓下来，
    // 因为 applyCards(→replaceAllCards) 会清空排序记录。
    const localOrderBeforeMerge = chatStore.exportCardOrder()
    const { cards: merged, stats } = mergeCards(chatStore.cards as Card[], payload.cards)
    applyCards(merged)
    // 合并导入 → **忽略**导入包里的顺序，保留本地已有顺序
    // （applyCards 会清空排序记录，所以这里把"合并前"的本地顺序原样写回）
    chatStore.applyCardOrder(localOrderBeforeMerge)
    applyImportedSettings(payload)
    flushPendingWrites()
    exportInfo.value = describeMerge(stats)
    importError.value = ''
  } catch (err) {
    importError.value = err instanceof Error ? err.message : '合并失败'
  } finally {
    isMergingImport.value = false
    confirmKind.value = null
    pendingImport.value = null
    emit('close')
  }
}

function onConfirm() {
  if (confirmKind.value === 'clear') {
    chatStore.clearAllConversations()
    flushPendingWrites()
    emit('close')
  } else if (confirmKind.value === 'clearMessages') {
    chatStore.clearAllMessages()
    flushPendingWrites()
    emit('close')
  } else if (confirmKind.value === 'clearContext') {
    chatStore.clearAllContext()
    flushPendingWrites()
    emit('close')
  } else if (confirmKind.value === 'clearEverything') {
    // 一键清空:先清消息(同步进 contextHistory),再清上下文记忆
    chatStore.clearAllMessages()
    chatStore.clearAllContext()
    flushPendingWrites()
    emit('close')
  }
  // 注意：'import' 不再走这里 —— 它有两个明确按钮（合并/覆盖），见上面两个函数
  // 复位确认态(内嵌模式无 open 翻转驱动 watch,必须主动复位)
  confirmKind.value = null
  pendingImport.value = null
}

function onCancelConfirm() {
  confirmKind.value = null
  pendingImport.value = null
}
</script>

<template>
  <Transition name="dm">
    <div
      v-if="open"
      class="dm"
      :class="{ 'dm--embedded': embedded }"
      @click.self="emit('close')"
    >
      <div class="dm__panel">
        <!-- 右上角 × 关闭按钮(内嵌模式不显示) -->
        <button v-if="!embedded" class="dm__close" type="button" aria-label="关闭" @click="emit('close')">×</button>
        <h2 v-if="!embedded" class="dm__title">数据管理</h2>
        <p class="dm__stats">
          干员 {{ stats.cardCount }} · 对话 {{ stats.convCount }} · 消息 {{ stats.msgCount }} · 数据
          {{ stats.sizeKB }} KB
        </p>

        <!-- 主页面:导出/导入 + 三个全局清空按钮 -->
        <template v-if="!confirmKind">
          <h3 v-if="embedded" class="dm__group">数据</h3>
          <div class="dm__actions">
            <button class="dm__btn dm__btn--primary" type="button" :disabled="isExporting" @click="onExport">
              {{ isExporting ? exportingLabel('导出中…') : '导出数据' }}
            </button>
            <!-- 旧版兼容:导出为单文件 JSON -->
            <button class="dm__btn" type="button" :disabled="isExportingJson" @click="onExportJson">
              {{ isExportingJson ? exportingLabel('导出中…') : '导出 JSON' }}
            </button>
            <!-- 应急导出：只在安卓出现。免 root / 免数据线，直接写进手机下载目录 -->
            <button
              v-if="androidNative"
              class="dm__btn dm__btn--emergency"
              type="button"
              :disabled="isExportingEmergency"
              @click="onEmergencyExport"
            >
              {{ isExportingEmergency ? exportingLabel('应急导出中…') : '应急导出到手机' }}
            </button>
            <button class="dm__btn" type="button" @click="onPickFile">导入数据</button>
          </div>

          <!--
            导出落点 + 结果紧贴按钮：以前这些字在面板最底部，手机上要滚下去才看得到，
            用户整段只看到按钮变回原样，以为「点了没反应」。现在落点就在按钮下面。
          -->
          <p v-if="savedPath" class="dm__saved">
            已保存到：<code class="dm__saved-path">{{ savedPath }}</code>
            <button class="dm__btn dm__btn--tiny" type="button" @click="openSavedFolder">打开文件夹</button>
          </p>
          <p v-if="importError" class="dm__error dm__error--inline">{{ importError }}</p>
          <p v-else-if="exportInfo" class="dm__info dm__info--inline">{{ exportInfo }}</p>

          <div class="dm__divider" v-if="!embedded"></div>

          <!-- 云同步(临时数据中转):上传换取件码 / 输码取回 -->
          <h3 v-if="embedded" class="dm__group">云同步</h3>
          <p class="dm__subtitle">云同步（临时 · 最多保留 24~48 小时）</p>
          <div class="dm__actions">
            <button class="dm__btn dm__btn--primary" type="button" :disabled="cloudBusy" @click="onCloudUpload">
              {{ cloudBusy ? '上传中…' : '一键上传数据' }}
            </button>
            <button class="dm__btn" type="button" :disabled="cloudFetching" @click="cloudFetchOpen = !cloudFetchOpen">
              {{ cloudFetchOpen ? '取消' : '拉取历史数据' }}
            </button>
          </div>

          <!-- 进度条:上传/取回时显示当前进度、速度、已用时间与预计剩余 -->
          <div v-if="cloudStage !== 'idle'" class="dm__progress">
            <div class="dm__progress-track">
              <div
                class="dm__progress-bar"
                :class="{ 'dm__progress-bar--indeterminate': cloudPercent < 0 }"
                :style="cloudPercent >= 0 ? { width: cloudPercent + '%' } : undefined"
              ></div>
            </div>
            <div class="dm__progress-text">
              <span class="dm__progress-phase">
                {{ cloudProgress?.waitingServer ? '服务端'
                   : cloudStage === 'packing' ? '打包'
                   : cloudStage === 'upload' ? '上传'
                   : cloudStage === 'download' ? '取回' : '导入' }}
              </span>
              <span>{{ cloudProgressText }}</span>
            </div>
          </div>

          <div v-if="cloudResult" class="dm__code">
            <span class="dm__code-label">取件码</span>
            <code class="dm__code-value" @click="onCopyCloudCode">{{ cloudResult.code }}</code>
            <button class="dm__btn dm__btn--tiny" type="button" @click="onCopyCloudCode">复制</button>
            <span class="dm__code-hint">
              在别的设备输入这串码即可取回。服务器每天 12:00 检查一次，超过 24 小时的数据会被清理
              （本次上传时间 {{ cloudResult.uploaded_at }}）
            </span>
          </div>

          <div v-if="cloudFetchOpen" class="dm__fetch">
            <input
              :value="cloudCodeInput"
              class="dm__input"
              :class="{ 'dm__input--invalid': codeInvalid }"
              type="text"
              inputmode="text"
              autocapitalize="characters"
              autocomplete="off"
              spellcheck="false"
              :maxlength="CODE_MAX_INPUT"
              placeholder="输入 8 位取件码"
              @input="onCodeInput"
              @blur="onCodeBlur"
              @keyup.enter="onCloudFetch"
            />
            <button
              class="dm__btn dm__btn--primary"
              type="button"
              :disabled="cloudFetching || !codeValid"
              @click="onCloudFetch"
            >
              {{ cloudFetching ? '取回中…' : '取回并导入' }}
            </button>
            <!-- 只在格式错误时提示；正常情况不占任何高度，保持界面干净 -->
            <p v-if="codeInvalid" class="dm__fetch-error">取件码无效</p>
          </div>

          <div class="dm__divider" v-if="!embedded"></div>

          <h3 v-if="embedded" class="dm__group dm__group--danger">危险操作</h3>
          <div class="dm__actions dm__actions--menu">
            <button class="dm__btn dm__btn--danger" type="button" @click="onRequestClear">删除全部对话</button>
            <button class="dm__btn" type="button" @click="onRequestClearMessages">清空全部消息</button>
            <button class="dm__btn" type="button" @click="onRequestClearContext">清空全部上下文</button>
            <!-- 一键清空:同时执行清空全部消息 + 清空全部上下文(AI 不再记得之前对话) -->
            <button class="dm__btn dm__btn--danger" type="button" @click="onRequestClearEverything">一键清空历史与上下文</button>
          </div>
        </template>

        <!-- 导出成功后的"分享文件"：落在公共下载目录时不需要，但留着也无害 -->


        <p v-if="cloudError" class="dm__error">{{ cloudError }}</p>
        <p v-else-if="cloudInfo" class="dm__info">{{ cloudInfo }}</p>

        <input ref="fileInput" type="file" :accept="IMPORT_FILE_ACCEPT" hidden @change="onFileChange" />
      </div>

      <!--
        破坏性操作的二次确认:与公告 / 提醒 / 更新弹窗同一副外壳。
        以前是"把面板内容换成确认页",玩家会失去上下文;现在改成覆盖式弹窗,
        背景里的数据页还在,取消即原样返回。
      -->
      <VersionDialogShell
        :open="!!confirmKind"
        :title="confirmTitle"
        kind="alert"
        :closable="!isMergingImport"
        @close="onCancelConfirm"
      >
        <!-- 导入:让用户选「合并」还是「覆盖」 -->
        <template v-if="confirmKind === 'import'">
          <p class="dm__confirm-text">导入方式:合并保留现有数据，覆盖会替换全部数据。</p>
          <p class="dm__confirm-note">
            合并规则：同一角色已有对话时，导入的对话会作为新的对话卡追加到该角色下；
            本地没有的角色则直接新建；群聊一律直接追加。
          </p>
        </template>
        <p v-else-if="confirmKind" class="dm__confirm-text">{{ confirmTexts[confirmKind] }}</p>

        <template #actions>
          <template v-if="confirmKind === 'import'">
            <button class="pn-btn" type="button" :disabled="isMergingImport" @click="onConfirmMerge">
              <span class="pn-btn__tex" aria-hidden="true"></span>
              <span class="pn-btn__deco" aria-hidden="true"></span>
              <span class="pn-btn__label">{{ isMergingImport ? '合并中…' : '合并数据' }}</span>
            </button>
            <button class="pn-btn dm-act--danger" type="button" :disabled="isMergingImport" @click="onConfirmOverwrite">
              <span class="pn-btn__label">覆盖数据</span>
            </button>
            <button class="pn-btn dm-act--ghost" type="button" :disabled="isMergingImport" @click="onCancelConfirm">
              <span class="pn-btn__label">取消</span>
            </button>
          </template>
          <template v-else>
            <button class="pn-btn dm-act--danger" type="button" @click="onConfirm">
              <span class="pn-btn__label">确认</span>
            </button>
            <button class="pn-btn dm-act--ghost" type="button" @click="onCancelConfirm">
              <span class="pn-btn__label">取消</span>
            </button>
          </template>
        </template>
      </VersionDialogShell>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 提示小字统一配色（白色）
//   云同步说明（“最多保留 24~48 小时”那行）/ 进度信息 / 结果提示都用它；
//   错误行仍是红色。
//   注意：进度条相关文字另有专门的黄色（$progress-text-color），见下。
//   云同步区块必须**显式声明** color：深色父级下靠继承会显示成黑色。
$hint-text-color: #ffffff;

// 进度条 & 进度文字统一**黄色**（与界面强调黄同源）
//   进度条本体见 .dm__progress-bar；这里给文字与阶段徽标用同一套金色。
$progress-text-color: #ffef00;
.dm__subtitle {
  margin: 0 0 8px;
  font-size: 13px;
  color: $hint-text-color;
  // 深色底上 0.75 的白字偏灰、观感发闷；提到 0.9 与主字体一致清晰
  opacity: 0.9;
}
// 导出落点 / 结果提示：紧贴导出按钮，必须足够显眼
//   落点用黄框（"文件在这儿"），失败用红字，成功说明用白字
.dm__saved {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(255, 239, 0, 0.08);
  border: 1px solid rgba(255, 239, 0, 0.35);
  color: $hint-text-color;
  font-size: 13px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  word-break: break-all;
}
.dm__saved-path {
  font-size: 13px;
  color: $progress-text-color;
  word-break: break-all;
}
.dm__error {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: #ff6b6b;
  word-break: break-word;
}
.dm__info {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: $hint-text-color;
  opacity: 0.9;
  word-break: break-word;
}
.dm__code {
  margin: 8px 0 4px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.dm__code-label {
  font-size: 13px;
  color: $hint-text-color;
  opacity: 0.9;
}
.dm__code-value {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 3px;
  cursor: pointer;
  user-select: all;
  // 原实现**没有声明 color** → 继承成黑色，在深色面板上几乎看不见。
  // 改用主题主文字色（与其他白字同源，见 styles/_variables.scss 的 $color-text-primary）。
  color: $color-text-primary;
}
.dm__code-hint {
  flex: 1 0 100%;
  font-size: 12px;
  line-height: 1.5;
  color: $hint-text-color;
}
.dm__fetch-error {
  flex: 1 0 100%;
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: #ff8f8f;
}
.dm__fetch {
  display: flex;
  gap: 8px;
  margin: 8px 0 4px;

  // 窄屏（手机）适配：原来是单行 flex —— 输入框 `flex:1; min-width:0`，
  // 旁边还要挤出按钮，结果输入框被压成很细的一条。
  // 改为**上下堆叠**：输入框独占整行（能完整显示出 8 位取件码），按钮在下一行。
  // 断点用 768px —— 与项目统一的 MOBILE_BREAKPOINT（composables/useMobile.ts）一致。
  @media (max-width: 768px) {
    flex-direction: column;
    align-items: stretch;

    .dm__btn {
      width: 100%;
    }
  }
}
.dm__input {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(0, 0, 0, 0.25);
  // 原来写 `color: inherit` → 在深色弹窗里继承成黑色，输入内容几乎看不见。
  // 改为主题主文字色（与页面内其他白字同源）。
  color: $color-text-primary;
  font-size: 16px;          // ≥16px 可避免 iOS Safari 聚焦时自动放大页面
  letter-spacing: 2px;
  text-transform: uppercase;
  // 手机上留足触控高度，且取件码不会因为宽度不够而看不见
  min-height: 40px;
  box-sizing: border-box;

  &::placeholder {
    color: rgba(255, 255, 255, 0.45);
  }

  // 校验不通过：红框（与提示红字同色系）
  &--invalid {
    border-color: #ff8f8f;
    background: rgba(255, 143, 143, 0.08);
  }
}
.dm__btn--tiny {
  padding: 4px 10px;
  font-size: 12px;
}
// 导出后的"分享文件"一行
.dm__share {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 2px;
}
// 应急导出:和普通按钮区分开(橙黄,提示"这是出问题时的救命按钮")
.dm__btn--emergency {
  background: #b4761f;
  color: #fff8ec;
}

// 进度条（上传 / 取回）
.dm__progress {
  margin: 10px 0 6px;
}
.dm__progress-track {
  position: relative;
  height: 8px;
  border-radius: 6px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.12);
}
.dm__progress-bar {
  height: 100%;
  width: 0;
  border-radius: 6px;
  // 按钮同款亮黄（= $color-subcard-selected），与界面强调色保持一致
  background: linear-gradient(90deg, #ffef00, #ffe95c);
  transition: width 0.18s linear;
}
// 总量未知(服务器未给 Content-Length)时走来回滚动动画
.dm__progress-bar--indeterminate {
  width: 35% !important;
  animation: dm-progress-slide 1.1s ease-in-out infinite;
}
@keyframes dm-progress-slide {
  0% {
    margin-left: -35%;
  }
  100% {
    margin-left: 100%;
  }
}
.dm__progress-text {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: $progress-text-color;
  font-variant-numeric: tabular-nums;
}
.dm__progress-phase {
  padding: 0 6px;
  border-radius: 4px;
  // 徽标底色同样亮黄（原来是蓝色 rgba(110,210,255,.18)）
  background: rgba(255, 239, 0, 0.18);
  color: $progress-text-color;
}
// 诊断行:原生组件状态(不可用时一眼看出问题在哪)
.dm__progress-diag {
  flex: 1 0 100%;
  color: $progress-text-color;
  opacity: 0.9;
}


// 数据管理弹窗:半透明遮罩 + 居中深色面板(CSS 绘制,不新增素材图)
@include dialog-shell(dm, 500px, 14px, 'stats', true);

// 内嵌模式(设置弹窗内):去掉遮罩/居中定位,面板铺满容器宽度
.dm {
  &--embedded {
    position: static;
    inset: auto;
    display: block;
    background: transparent;
    z-index: auto;

    .dm__panel {
      width: 100%;
      max-width: none;
      padding: 0;
      border: none;
      box-shadow: none;
      background: transparent;
    }
  }

  &__panel--narrow {
    width: 348px;
  }

  &__confirm-text {
    margin: 0 0 14px;
    font-family: $font-harmony;
    font-size: 16px;
    color: $color-subcard-text;
  }

  &__divider {
    height: 1px;
    margin: 14px 0;
    background: rgba(255, 255, 255, 0.1);
  }

  &__error {
    margin: 12px 0 0;
    font-family: $font-harmony;
    font-size: 14px;
    color: #ff8f8f;
  }

  &__info {
    margin: 12px 0 0;
    font-family: $font-harmony;
    font-size: 13px;
    color: $hint-text-color;
  }

  &__actions--menu {
    flex-direction: column;
    gap: 10px;
  }

  &__btn--danger {
    background: #7a2e2e;
    color: #f0eeee;
  }
}

// 二次确认弹窗（VersionDialogShell 的白底正文区）
// 弹窗正文是浅色底,原先那套深色面板用的浅灰字在这里会看不清,单独覆盖一档。
.dm__confirm-text {
  margin: 0 0 10px;
  color: #1f1f1f;
  font-family: $font-harmony;
  font-size: 14px;
  line-height: 1.75;
}

.dm__confirm-note {
  margin: 0;
  color: #5f5f5f;
  font-family: $font-harmony;
  font-size: 13px;
  line-height: 1.75;
}

// 弹窗按钮:危险操作红底、次要操作浅底,主操作沿用 .pn-btn 的深色
.dm-act--danger {
  background: #7a2e2e;
  color: #f0eeee;
  box-shadow: 0 0 0 0.05em #7a2e2e, 0 0 0 0.05em #a86a6a inset;

  &:hover:not(:disabled) {
    background: #632424;
    color: #f8f4f4;
    box-shadow: 0 0 0 0.05em #632424, 0 0 0 0.05em #a86a6a inset;
  }
}

.dm-act--ghost {
  background: rgba(0, 0, 0, 0.06);
  color: #2a2a2a;
  box-shadow: 0 0 0 1.5px rgba(0, 0, 0, 0.18) inset;

  &:hover:not(:disabled) {
    background: rgba(0, 0, 0, 0.12);
    color: #111;
  }
}
</style>
