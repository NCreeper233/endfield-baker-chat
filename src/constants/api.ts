// api —— 旧版（legacy）模式的固定端点
// 放 constants 而非 store：infra 要构造请求，不能反向依赖状态层。

/** legacy 模式直连 Agnes，内置 Key 由服务端 /api/legacy-key 下发 */
export const LEGACY_API_BASE_URL = 'https://api.agnes-ai.cn/v1'
export const LEGACY_API_MODEL = 'agnes-2.5-flash'
