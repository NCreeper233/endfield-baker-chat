// =============================================================================
// groupTransport —— 群聊传输层的"按模式二选一"
// -----------------------------------------------------------------------------
// 群聊有两条独立链路:
//   - apiMode === 'custom'  → utils/customGroupBackend.ts
//                             (前端本地会话状态 + 直连用户自定义 API,无后端)
//   - 其余(backend / legacy)→ utils/groupBackend.ts
//                             (后端群聊服务 /group/*;legacy 模式群聊沿用后端)
//
// 为什么单独抽一个选择器:调用点有三处(useGroupChat 的回合调度、
// useGroupChat.disposeSession、stores/chat 的删除卡片释放会话),分散写
// `apiMode === 'custom' ? a : b` 很容易将来只改一处而走散。
//
// ⚠ 选择结果必须**在每次调用时现取**(不要缓存成模块常量):
//   用户可以在设置里随时切换 API 模式,缓存会让切模式后仍然走旧链路。
// =============================================================================

import type { ApiMode } from '../stores/settings'
import type { GroupTransport } from './groupBackend'
import * as backendGroupTransport from './groupBackend'
import * as customGroupTransport from './customGroupBackend'

/** 按当前 API 模式返回该用的群聊传输层 */
export function groupTransportFor(apiMode: ApiMode): GroupTransport {
  return apiMode === 'custom' ? customGroupTransport : backendGroupTransport
}
