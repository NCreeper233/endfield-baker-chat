<script setup lang="ts">
// =============================================================================
// 数据管理弹窗(DataManagerDialog)
// -----------------------------------------------------------------------------
// 提供全局操作(控制全部对话):
//   - 数据统计(卡片 / 对话 / 消息 / 序列化大小)
//   - 导出工程(两种格式,直接下载):
//       · 导出数据 = .zip 压缩包(文本 JSON + 独立图片文件)
//       · 导出 JSON = 单文件 JSON(旧版兼容格式,图片 dataURL 内联)
//   - 导入工程(选文件 → 解析校验 → 二次确认 → 整体替换):
//       · .zip 走压缩包解压(见 zipExport)
//       · .json 走旧版兼容层(见 jsonCompat:自动识别旧格式并补全缺失字段)
//   - 清空全部对话(删除所有子对话,每个角色保留一个空子对话,清除消息与上下文)
//   - 清空全部消息(仅清空可见消息,AI 上下文记忆保留)
//   - 清空全部上下文(仅清空 AI 记忆,可见消息保留)
//   - 一键清空历史与上下文(同时清空全部消息 + 全部上下文)
//   - 云同步(临时):一键上传到 local.peilika.beer 换一个取件码;
//     在别的设备输入取件码即可取回并导入。服务器最多保留 24~48 小时
//     (每天 12:00 检查一次,超过 24 小时的自动清理)
//
// 破坏性操作均为两段式确认(弹窗内切换确认态),不动用现有素材图。
// =============================================================================
import { computed, ref, watch, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../../stores/chat'
import { useSettingsStore } from '../../stores/settings'
import { MATERIALS } from '../../constants/materials'
import {
  downloadProject,
  importFromZip,
  getNativeSaveFile,
  type ProjectPayload,
} from '../../utils/zipExport'
import {
  downloadProjectJson,
  importFromJson,
  exportToJson,
  IMPORT_FILE_ACCEPT,
} from '../../utils/jsonCompat'
import { isNativeAndroid } from '../../utils/nativeExport'
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

// ---- 导出状态（恢复为正式版实现）-------------------------------------------
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

/** 是否打包环境（Electron/APK）——正式版同款判定 */
function isNativePlatform(): boolean {
  // 统一走 utils/platform：Electron / Android / iOS 都算"打包端"，
  // 走 exportToZipInWorker（打包+base64）+ 各自的原生保存通道；
  // 纯浏览器（含手机浏览器）走 downloadProject 的 <a download>。
  return isElectron() || isNative()
}

/** 导出后提示（大图过滤信息） */
function applyExportInfo(filteredImages: number, totalBytes: number, kind: string) {
  const mb = (totalBytes / 1024 / 1024).toFixed(1)
  if (filteredImages > 0) {
    exportInfo.value = `${kind}完成(约 ${mb}MB)。因数据量较大,已自动过滤 ${filteredImages} 张超大图片(保留"[图片]"占位)。`
  } else {
    exportInfo.value = `${kind}完成(约 ${mb}MB)。`
  }
}

// ---- 两段式确认状态 ---------------------------------------------------------
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

const fileInput = ref<HTMLInputElement | null>(null)

/** 导入合并进行中（合并是同步的，但数据量大时仍会让出一次绘制） */
const isMergingImport = ref(false)



/**
 * 统一导出入口
 *
 * @param kind      zip(压缩包) / json(单文件)
 * @param emergency 应急导出：安卓上直接写进手机「下载/BAKER」，不需要 root/数据线
 */
/**
 * 导出数据(.zip) —— **恢复为正式版实现**（2026-09-30 按用户要求）
 *
 * 正式版的路径就是两条，简单可靠：
 *   1. 打包端(EXE/APK)：exportToZipInWorker(打包+base64) → getNativeSaveFile() → saveFile()
 *      原生插件内部用 ACTION_CREATE_DOCUMENT 拉起系统文件管理器
 *   2. 浏览器：downloadProject() 直接下载
 *
 * 已移除测试版后加的全套自研机制（分块写入 beginWrite/appendChunk/finishWrite、
 * probePlugin 探测、强制超时、时间线打点、已用时显示）——它们没能解决问题，
 * 反而增加了"卡在 preparing"这类不可见故障面。
 */
async function onExport() {
  if (isExporting.value) return
  isExporting.value = true
  exportInfo.value = ''
  importError.value = ''
  try {
    // 空数据守卫(2026-10-04)：以前这种情况会"成功"导出一个 0 字节空包，
    // 用户拿到手以为数据丢了 —— 直接说清楚更有用
    if (!cards.value || cards.value.length === 0) {
      throw new Error('当前没有可导出的数据（列表为空）。若你确认有聊天记录，请先重启应用再试；' +
                      '仍为空说明本地数据文件异常，可把数据目录里的 endfield-baker-data.json 发我排查。')
    }
    const fileName = `BAKER-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19).replace(/-/g, '')}.zip`
    if (isNativePlatform()) {
      // 打包端(EXE/APK)：Worker 内序列化 + 压缩 + base64，再经原生保存
      const { base64, filteredImages, totalBytes } = await exportToZipInWorker(
        cards.value,
        chatStore.myGender,
        chatStore.stripVariantIndex,
        settingsStore.promptOverrides,
        settingsStore.getSettingsSnapshot(),
      )
      const saveFile = await getNativeSaveFile()
      if (!saveFile) throw new Error('未找到系统保存组件')
      const result = await saveFile({ fileName, base64 })
      if (result?.canceled) throw new Error('已取消导出')
      applyExportInfo(filteredImages, totalBytes, '导出数据')
    } else {
      const { filteredImages, totalBytes } = await downloadProject(
        cards.value,
        chatStore.myGender,
        chatStore.stripVariantIndex,
        settingsStore.promptOverrides,
        settingsStore.getSettingsSnapshot(),
      )
      applyExportInfo(filteredImages, totalBytes, '导出数据')
    }
  } catch (err) {
    importError.value = err instanceof Error ? err.message : '导出失败'
  } finally {
    isExporting.value = false
  }
}

/** 导出为单文件 JSON（正式版同款：downloadProjectJson 内部处理平台差异） */
async function onExportJson() {
  if (isExportingJson.value) return
  isExportingJson.value = true
  exportInfo.value = ''
  importError.value = ''
  try {
    const { filteredImages, totalBytes } = await downloadProjectJson(
      cards.value,
      chatStore.myGender,
      chatStore.stripVariantIndex,
      settingsStore.promptOverrides,
      settingsStore.getSettingsSnapshot(),
      // v7：把当前列表人物顺序一起写进包（覆盖导入时应用）
      chatStore.exportCardOrder(),
    )
    applyExportInfo(filteredImages, totalBytes, '导出 JSON')
  } catch (err) {
    importError.value = err instanceof Error ? err.message : '导出失败'
  } finally {
    isExportingJson.value = false
  }
}

/** 应急导出（仅安卓）——沿用正式版的 JSON 导出通道 */
async function onEmergencyExport() {
  if (isExportingEmergency.value) return
  isExportingEmergency.value = true
  exportInfo.value = ''
  importError.value = ''
  try {
    const { filteredImages, totalBytes } = await downloadProjectJson(
      cards.value,
      chatStore.myGender,
      chatStore.stripVariantIndex,
      settingsStore.promptOverrides,
      settingsStore.getSettingsSnapshot(),
      // v7：把当前列表人物顺序一起写进包（覆盖导入时应用）
      chatStore.exportCardOrder(),
    )
    applyExportInfo(filteredImages, totalBytes, '应急导出')
  } catch (err) {
    importError.value = err instanceof Error ? err.message : '应急导出失败'
  } finally {
    isExportingEmergency.value = false
  }
}


// ---- 云同步(临时数据中转) ----------------------------------------------------
/** 上传中 */
const cloudBusy = ref(false)
/** 取回中 */
const cloudFetching = ref(false)
/** 上传成功后拿到的取件码信息 */
const cloudResult = ref<CloudUploadResult | null>(null)
/** 取回用的取件码输入 */
const cloudCodeInput = ref('')

/**
 * 取件码校验
 *
 * 服务端规则（见 local-data/local_data_service.py）：
 *   CODE_LEN = 8
 *   ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   ← 去掉 0O1I 等易混字符
 * 即**恰好 8 位、只含大写字母与数字**。
 *
 * 输入上限取 8 + 2 = 10 作冗余：既挡住乱粘贴的超长串，
 * 又给用户"多打一两个字符"留出容错，不会因为差一位就完全无法输入。
 * （服务端本身会按 CODE_LEN 截断，所以多出的字符不会造成后端异常。）
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

// ---- 破坏性操作:统一两段式确认(先切确认态,再由 onConfirm 真正执行) ---------
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
 * 应用导入包里的**人物顺序**（v7）
 *
 * 为什么必须放在 applyCards **之后**：replaceAllCards 会清空排序记录
 * （旧下标/旧记录与新卡片树无关），所以只有替换完再写顺序才生效。
 *
 * 旧包没有 order 字段时的兜底：按 cards 数组本身的顺序当顺序 ——
 * 导出时 cards 就是按"最近活跃在前"排列的，所以这个兜底同样能还原原顺序。
 *
 * @param payload 导入包
 * @param deriveFromCards 是否允许用 cards 数组顺序兜底
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
 * 合并导入（2026-09-30 新增）
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
      <div class="dm__panel" :class="{ 'dm__panel--narrow': !!confirmKind }">
        <!-- 右上角 × 关闭按钮(内嵌模式不显示) -->
        <button v-if="!embedded" class="dm__close" type="button" aria-label="关闭" @click="emit('close')">×</button>
        <h2 v-if="!embedded" class="dm__title">数据管理</h2>
        <p class="dm__stats">
          干员 {{ stats.cardCount }} · 对话 {{ stats.convCount }} · 消息 {{ stats.msgCount }} · 数据
          {{ stats.sizeKB }} KB
        </p>

        <!-- 二次确认页 -->
        <div v-if="confirmKind" class="dm__confirm">
          <!-- 导入：让用户选「合并」还是「覆盖」（2026-09-30 新增） -->
          <template v-if="confirmKind === 'import'">
            <p class="dm__confirm-text">导入方式：合并保留现有数据，覆盖会替换全部数据。</p>
            <p class="dm__subtitle">
              合并规则：同一角色已有对话时，导入的对话会作为**新的对话卡**追加到该角色下；
              本地没有的角色则直接新建；群聊一律直接追加。
            </p>
            <div class="dm__actions">
              <button class="dm__btn dm__btn--primary" type="button" @click="onConfirmMerge">
                {{ isMergingImport ? '合并中…' : '合并数据' }}
              </button>
              <button class="dm__btn dm__btn--danger" type="button" :disabled="isMergingImport" @click="onConfirmOverwrite">
                覆盖数据
              </button>
              <button class="dm__btn" type="button" :disabled="isMergingImport" @click="onCancelConfirm">取消</button>
            </div>
          </template>
          <template v-else>
            <p class="dm__confirm-text">{{ confirmTexts[confirmKind] }}</p>
            <div class="dm__actions">
              <button class="dm__btn dm__btn--primary" type="button" @click="onConfirm">确认</button>
              <button class="dm__btn" type="button" @click="onCancelConfirm">取消</button>
            </div>
          </template>
        </div>

        <!-- 主页面:导出/导入 + 三个全局清空按钮 -->
        <template v-else>
          <div class="dm__actions">
            <button class="dm__btn dm__btn--primary" type="button" :disabled="isExporting" @click="onExport">
              {{ isExporting ? '导出中…' : '导出数据' }}
            </button>
            <!-- 旧版兼容:导出为单文件 JSON -->
            <button class="dm__btn" type="button" :disabled="isExportingJson" @click="onExportJson">
              {{ isExportingJson ? '导出中…' : '导出 JSON' }}
            </button>
            <!-- 应急导出：只在安卓出现。免 root / 免数据线，直接写进手机下载目录 -->
            <button
              v-if="androidNative"
              class="dm__btn dm__btn--emergency"
              type="button"
              :disabled="isExportingEmergency"
              @click="onEmergencyExport"
            >
              {{ isExportingEmergency ? '应急导出中…' : '应急导出到手机' }}
            </button>
            <button class="dm__btn" type="button" @click="onPickFile">导入数据</button>
          </div>

          <div class="dm__divider"></div>

          <!-- 云同步(临时数据中转):上传换取件码 / 输码取回 -->
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

          <div class="dm__divider"></div>

          <div class="dm__actions dm__actions--menu">
            <button class="dm__btn dm__btn--danger" type="button" @click="onRequestClear">删除全部对话</button>
            <button class="dm__btn" type="button" @click="onRequestClearMessages">清空全部消息</button>
            <button class="dm__btn" type="button" @click="onRequestClearContext">清空全部上下文</button>
            <!-- 一键清空:同时执行清空全部消息 + 清空全部上下文(AI 不再记得之前对话) -->
            <button class="dm__btn dm__btn--danger" type="button" @click="onRequestClearEverything">一键清空历史与上下文</button>
          </div>
        </template>

        <!-- 导出成功后的"分享文件"：落在公共下载目录时不需要，但留着也无害 -->


        <p v-if="importError || cloudError" class="dm__error">{{ cloudError || importError }}</p>
        <p v-else-if="exportInfo" class="dm__info">{{ exportInfo }}</p>
        <p v-if="cloudInfo && !cloudError && !importError" class="dm__info">{{ cloudInfo }}</p>

        <input ref="fileInput" type="file" :accept="IMPORT_FILE_ACCEPT" hidden @change="onFileChange" />
      </div>
    </div>
  </Transition>
</template>

<style scoped lang="scss">
@use '../../styles/variables' as *;
@use '../../styles/mixins' as *;

// 提示小字统一配色（2026-09-30 按用户要求改为**白色**）
//   云同步说明（“最多保留 24~48 小时”那行）/ 进度信息 / 结果提示都用它；
//   错误行仍是红色。
//   注意：进度条相关文字另有专门的黄色（$progress-text-color），见下。
$hint-text-color: #ffffff;

// 进度条 & 进度文字统一**黄色**（用户要求：底下的蓝色进度条和蓝色提示字都改黄）
//   进度条本体见 .dm__progress-bar；这里给文字与阶段徽标用同一套金色。
$progress-text-color: #ffef00;

// ---- 云同步区块 ----
// 2026-09-30 修复:原先没有声明 color,靠继承 —— 深色父级下这行说明会显示成黑色,
// 与其它提示小字(#9fe0ff 淡蓝)风格不一致。显式指定同一套配色。
.dm__subtitle {
  margin: 0 0 8px;
  font-size: 13px;
  color: $hint-text-color;
  // 深色底上 0.75 的白字偏灰、观感发闷；提到 0.9 与主字体一致清晰
  opacity: 0.9;
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

// ---- 进度条(上传 / 取回) ----
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
  // 2026-09-30：改为**按钮同款亮黄**（= $color-subcard-selected #ffef00）。
  // 之前用的金色渐变偏暗，和界面上的强调黄不一致。
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
</style>
