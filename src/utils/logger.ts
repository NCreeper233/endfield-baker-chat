// logger —— 开发日志出口
// 内部异常兜底一律经这里输出：import.meta.env.DEV 在生产构建被替换为 false，
// 分支随之被摇掉，发布包里不含任何 console 调用。

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
