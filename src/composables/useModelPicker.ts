// =============================================================================
// useModelPicker:从 Base URL 拉取模型列表的状态机
// -----------------------------------------------------------------------------
// 设置面板里有两处需要"填地址 → 拉模型 → 下拉选":主 API 与总结 API。
// 两处行为完全一致(地址为空则提示、拉取中、失败原因、地址或密钥一变就清空),
// 故收敛到这一个 composable —— 复制第二份必然会在日后某次改动里走散。
//
// 缓存与去重**不**在这一层:交给 utils/modelList(按 (url, apiKey) 缓存 10 分钟,
// 成功与失败都缓存),所以打开面板、切模式时无脑再拉一次是安全的,
// 真正打网络的只有每组地址+密钥的第一次。
// =============================================================================

import { ref, watch } from 'vue'
import { fetchModelList } from '../utils/modelList'
import type { RemoteModel } from '../utils/modelList'

/** 地址与密钥(用函数传入:两者都是响应式的,每次现取) */
export interface ModelPickerSource {
  baseUrl: string
  apiKey: string
}

export function useModelPicker(source: () => ModelPickerSource) {
  /** 已获取到的模型(为空表示尚未成功获取) */
  const options = ref<RemoteModel[]>([])
  /** 是否正在获取 */
  const loading = ref(false)
  /** 获取失败原因(为空表示无错误) */
  const error = ref('')

  /** 清空列表与错误(不动 loading:进行中的请求回来时仍会写入结果) */
  function clear(): void {
    options.value = []
    error.value = ''
  }

  /**
   * 拉一次模型列表
   *
   * @param force true = 忽略缓存(用户手动点击);false = 自动路径,走缓存
   */
  async function load(force: boolean): Promise<void> {
    const { baseUrl, apiKey } = source()
    const url = baseUrl.trim()
    if (!url) {
      options.value = []
      error.value = '请先填写 Base URL'
      return
    }
    loading.value = true
    error.value = ''
    const result = await fetchModelList(url, apiKey.trim(), force)
    loading.value = false
    options.value = result.models
    error.value = result.ok ? '' : result.error
  }

  // 地址 / 密钥变了:旧列表不再代表当前端点,先清空。
  // 否则会出现"地址已改，下拉里还是上一个端点的模型"这种很容易选错的状态。
  // 这里只清不拉:输入过程中每敲一个字符都发请求是不可接受的。
  watch(
    () => {
      const s = source()
      return `${s.baseUrl}\u0000${s.apiKey}`
    },
    clear,
  )

  return { options, loading, error, load, clear }
}
