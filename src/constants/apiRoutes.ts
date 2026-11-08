// apiRoutes —— 后端路线（主 / 备用域名）与各服务 URL 拼接
// 两个域名指向同一套后端、仅域名不同，备用域名用于绕过域名级封锁。

/** localStorage key：玩家选择的后端路线 */
export const API_ROUTE_KEY = 'baker_api_route'

export type ApiRoute = 'primary' | 'backup'

export const API_BASES: Record<ApiRoute, string> = {
  primary: 'https://api.peilika.beer',
  backup: 'https://api2.peilika.beer',
}

export const API_ROUTE_LABELS: Record<ApiRoute, string> = {
  primary: '默认',
  backup: '备用',
}

/**
 * 直接读 localStorage 而非 settings store：本层在 store 初始化前就可能被调用。
 * 未知值或读取失败一律回退 primary。
 */
export function currentApiRoute(): ApiRoute {
  try {
    return localStorage.getItem(API_ROUTE_KEY) === 'backup' ? 'backup' : 'primary'
  } catch {
    return 'primary'
  }
}

export function apiBase(): string {
  return API_BASES[currentApiRoute()]
}

/** 单聊网关完整地址（含 /chat） */
export function gatewayUrl(): string {
  return `${apiBase()}/chat`
}

/** 群聊服务完整地址（含 /group） */
export function groupBaseUrl(): string {
  return `${apiBase()}/group`
}
