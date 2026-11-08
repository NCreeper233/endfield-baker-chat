// groupTransport —— 按 API 模式选群聊传输层
// ⚠ 必须每次调用时现取，不要缓存成常量：用户随时会切模式，缓存后会一直走旧链路。

import type { ApiMode } from '../stores/settings'
import type { GroupTransport } from './groupBackend'
import * as backendGroupTransport from './groupBackend'
import * as customGroupTransport from './customGroupBackend'

/** custom 走本地会话 + 直连用户 API；backend / legacy 走后端群聊服务 */
export function groupTransportFor(apiMode: ApiMode): GroupTransport {
  return apiMode === 'custom' ? customGroupTransport : backendGroupTransport
}
