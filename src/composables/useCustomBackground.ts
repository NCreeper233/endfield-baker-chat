// =============================================================================
// 自定义页面背景(useCustomBackground)
// -----------------------------------------------------------------------------
// 用户上传的背景图(data URL)属于"设置类"数据,规则:
//   - 持久化:localStorage 独立 key(刷新保留)
//   - 不进 IndexedDB:与卡片工程数据隔离,不随 .baker 导出,不受清空对话影响
//   - 异常/超配额:静默降级(本次会话仍生效,仅刷新丢失),绝不影响主流程
// =============================================================================
import { ref, watch } from 'vue'

/** 背景图 localStorage key(设置类数据独立 key,不进 IndexedDB) */
const BG_STORAGE_KEY = 'endfield-baker-bg'

/** 读取上次保存的背景图(无记录或读取异常时返回 null) */
function loadSavedBg(): string | null {
  try {
    return localStorage.getItem(BG_STORAGE_KEY)
  } catch {
    return null
  }
}

/**
 * 自定义页面背景(上传 data URL),带 localStorage 持久化。
 *
 * @returns { customBg } 可写 ref:App.vue 上传成功后赋值,watch 自动落 localStorage
 */
export function useCustomBackground() {
  const customBg = ref<string | null>(loadSavedBg())

  watch(customBg, (v) => {
    try {
      if (v) {
        localStorage.setItem(BG_STORAGE_KEY, v)
      } else {
        localStorage.removeItem(BG_STORAGE_KEY)
      }
    } catch (err) {
      // 背景图过大超 localStorage 配额等:仅本次会话生效,刷新丢失,不影响主流程
      console.warn('[bg] 背景保存失败(可能超出容量),刷新后将恢复默认背景', err)
    }
  })

  return { customBg }
}
