// =============================================================================
// 后端路线(测试版)
// -----------------------------------------------------------------------------
// 背景:部分网络环境无法解析/连通 api.peilika.beer,因此准备了备用域名
// api2.peilika.beer。两者指向**同一套测试版后端**(网关 5501 + 群聊 5810),
// 请求规则与回复完全一致,唯一差别是域名 —— 换域名可绕过域名层面的封锁。
//
// 迁移到正式版时只需改 API_BASES 两个值:
//   primary: 'https://api.peilika.beer'
//   backup : 'https://api2.peilika.beer'
// 其余逻辑(选择、持久化、URL 拼接)不需要改动。
// =============================================================================

/** localStorage key:玩家选择的后端路线 */
export const API_ROUTE_KEY = 'baker_api_route'

/** 路线标识:primary = 默认(api-test),backup = 备用(api2-test) */
export type ApiRoute = 'primary' | 'backup'

/** 两条路线的域名(不含路径) */
export const API_BASES: Record<ApiRoute, string> = {
  primary: 'https://api.peilika.beer',
  backup: 'https://api2.peilika.beer',
}

/** 路线显示名(设置界面用) */
export const API_ROUTE_LABELS: Record<ApiRoute, string> = {
  primary: '默认',
  backup: '备用',
}

/**
 * 当前路线的标识
 *
 * 直接读 localStorage 而不是从 settings store 取,是为了让 utils/ 层不依赖
 * store(backend.ts / groupBackend.ts 在 store 初始化前就可能被调用)。
 * 未知值/读取失败一律回退 primary。
 */
export function currentApiRoute(): ApiRoute {
  try {
    return localStorage.getItem(API_ROUTE_KEY) === 'backup' ? 'backup' : 'primary'
  } catch {
    return 'primary'
  }
}

/** 当前路线的域名(不含路径) */
export function apiBase(): string {
  return API_BASES[currentApiRoute()]
}

/** 单聊网关完整地址(含 /chat) */
export function gatewayUrl(): string {
  return `${apiBase()}/chat`
}

/** 群聊服务完整地址(含 /group) */
export function groupBaseUrl(): string {
  return `${apiBase()}/group`
}
