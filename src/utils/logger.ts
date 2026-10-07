// =============================================================================
// logger.ts —— 统一的开发日志出口
// -----------------------------------------------------------------------------
// 为什么要有它：
//   项目里原本散落 25 处 `console.warn/info/error`，都是真实异常兜底
//   （写入失败 / 功能降级 / 渲染自愈……），对开发者有价值，
//   但**不该出现在发布版**：玩家按 F12 看到一堆内部报错会以为程序坏了。
//
// 做法：所有内部分支只经这里输出，而这里在**生产构建里被整体消除** ——
//   `import.meta.env.DEV` 在 `vite build` 时会被替换成 `false`，
//   整个 if 分支随之被 tree-shaking 掉，发布包里**不含任何 console 调用**。
//
// 因此：开发环境（`npm run dev`）照旧能看到日志；发布版干净。
//
// 用法：import { devWarn, devInfo, devError } from '../utils/logger'
//       devWarn('[group] 创建会话失败:', e)
// =============================================================================

/** 开发环境才输出（生产构建会被完全消除） */
function enabled(): boolean {
  return import.meta.env.DEV === true
}

export function devWarn(...args: unknown[]): void {
  if (enabled()) console.warn(...args)
}

export function devInfo(...args: unknown[]): void {
  if (enabled()) console.info(...args)
}

export function devError(...args: unknown[]): void {
  if (enabled()) console.error(...args)
}

/** 开发环境才执行的副作用（如内置数据完整性自检） */
export function devOnly(fn: () => void): void {
  if (enabled()) fn()
}
