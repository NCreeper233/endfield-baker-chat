// delay —— 等待 ms 毫秒（「对方正在输入」的节奏控制）

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
