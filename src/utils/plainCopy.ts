// plainCopy —— 把响应式对象深拷贝成可结构化克隆的普通值
//
// 落库前需要一份"脱掉 Proxy"的快照：IndexedDB 的 structured clone 克隆不了 Proxy。
// 原先用 JSON.parse(JSON.stringify(x))，代价是把几十 MB 的图片 dataURL 逐字符拼成
// 字符串再解析回来。这里只复制对象骨架、字符串按引用传递，量级完全不同。
//
// 语义刻意贴近 JSON：跳过 undefined 与函数（IndexedDB 能存 undefined，但旧数据里
// 没有这种字段，保持与原来一致更安全）。

import { toRaw } from 'vue'

/** 深拷贝为普通对象/数组；内部对象若仍是 Proxy 会先解包 */
export function toPlain<T>(value: T): T {
  return copy(value) as T
}

function copy(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value

  const raw = toRaw(value as object)
  // 是 Proxy：拿到底层原对象再走一遍（底层对象里的子对象本身也是原始值）
  if ((raw as unknown) !== value) return copy(raw)

  if (Array.isArray(raw)) return raw.map(copy)
  // 二进制 / 时间对象 structured clone 原生支持，直接透传
  if (raw instanceof Date || raw instanceof ArrayBuffer) return raw
  if (typeof Blob !== 'undefined' && raw instanceof Blob) return raw

  if (raw instanceof Map) {
    const out: Record<string, unknown> = {}
    raw.forEach((v, k) => { out[String(k)] = copy(v) })
    return out
  }
  if (raw instanceof Set) return [...raw].map(copy)

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || typeof v === 'function') continue
    out[k] = copy(v)
  }
  return out
}
