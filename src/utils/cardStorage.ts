// cardStorage —— 卡片数据的分片读写（每张主卡一个 key）
//
// 为什么分片：原先整库只存一个 `cards` 键，任何一条消息落库都要把几十 MB 的图片
// dataURL 整体序列化一遍。分片后一次保存只写"变了的那几张卡"，索引键很小。
//
// 旧格式兼容（刻意保守）：
//   · 旧 `cards` 键**只读不删**。新格式读失败（缺卡 / 格式不对）就退回旧格式，
//     所以任何一步出错都还能回到迁移前那一份快照。
//   · 首次保存是**一次事务**写完所有分片 + 索引，要么全成要么全无；失败则继续
//     按旧格式写，不会留下"半套新数据"。
//   · slot 编号落盘后不再变动（删除只删键、不重排），避免每次都把编号重算一遍。

/** 存储后端最小接口（网页端由 IndexedDB 实现，单测用内存实现） */
export interface CardKV {
  get(key: string): Promise<unknown>
  putMany(entries: Array<[string, unknown]>): Promise<void>
  del(keys: string[]): Promise<void>
}

/** 分片格式的索引键 */
const KEY_INDEX = 'cardsV2'
/** 旧格式（整库一个键）—— 迁移后不再写入，只作为回退快照保留 */
export const KEY_LEGACY_CARDS = 'cards'

const cardKey = (slot: number): string => `card:${slot}`

interface CardIndex {
  v: 2
  slots: number[]
  next: number
  /**
   * 每个 slot 对应的卡片身份（顺序与 slots 一致）
   *
   * 用来在载入后校验「位置 → slot」的映射仍然成立。恢复流程会补齐内置卡、
   * 修正群聊卡，卡的顺序可能与落盘时不同；只按位置认 slot 就会把内容写到别人的键上。
   * 指纹对不上时整库重写一次，内容一定回到正确位置。
   */
  keys: string[]
}

function parseIndex(raw: unknown): CardIndex | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Partial<CardIndex>
  if (v.v !== 2 || !Array.isArray(v.slots)) return null
  if (!v.slots.every((s) => typeof s === 'number' && Number.isFinite(s))) return null
  const keys = Array.isArray(v.keys) && v.keys.every((k) => typeof k === 'string')
    ? (v.keys as string[])
    : []
  return {
    v: 2,
    slots: v.slots as number[],
    next: typeof v.next === 'number' ? v.next : 0,
    keys,
  }
}

/** 一次卡片写库该走哪条路 */
export type CardWritePlan =
  /** 不写：载入未成功 / 结构异常 / 降级只读 */
  | { mode: 'skip' }
  /** 只写旧格式的整库键（打包端；以及网页端还没迁移成功时） */
  | { mode: 'legacy' }
  /** 先写旧格式，再尝试迁移成分片（网页端首次迁移） */
  | { mode: 'legacy+split' }
  /** 只写分片（已迁移完成） */
  | { mode: 'split' }

/**
 * 决定这一次写库走哪条路（纯函数）
 *
 * 这里钉的是一条**数据安全不变量**：网页端只要还没迁移成功（format === 1），
 * 就必须先把旧 `cards` 整库写一遍，再去尝试分片迁移。
 * 迁移可能失败（配额、事务被中断、页面被杀），那时若只尝试分片写，
 * 用户这条新消息就谁都没存 —— 先把旧格式写成与升级前逐字相同的样子，
 * 才能保证「至少和以前一样存得住」。
 */
export function planCardWrite(input: {
  loadState: 'unknown' | 'ok' | 'empty' | 'invalid'
  isNative: boolean
  format: 1 | 2
  blocked: boolean
}): CardWritePlan {
  if (input.blocked) return { mode: 'skip' }
  if (input.loadState === 'unknown' || input.loadState === 'invalid') return { mode: 'skip' }
  if (input.isNative) return { mode: 'legacy' }
  if (input.format === 1) return { mode: 'legacy+split' }
  return { mode: 'split' }
}

export class CardStorage {
  /** 1 = 旧格式（整库一个键），2 = 分片 */
  format: 1 | 2 = 1

  /** 下一个可用 slot */
  private nextSlot = 0
  /** 卡片对象 → slot（弱引用，卡片被移除后自动回收） */
  private slotByCard = new WeakMap<object, number>()
  /** 本次保存时卡片在数组里的顺序（slot） */
  private order: number[] = []
  /** 上次已落盘的 slot 列表（用于删除孤儿键） */
  private prevSlots: number[] = []
  /** 待写 slot */
  private dirty = new Set<number>()
  /** 刚载入时的 slot 序列：首次 sync 时按顺序还原，保证键名不变 */
  private pendingSlots: number[] = []
  /** 落盘时每个 slot 对应的卡片身份（与 prevSlots 同序） */
  private prevKeys: string[] = []
  /**
   * 本次保存要不要整库重写
   *
   * 载入后恢复流程会补内置卡、修群聊卡，顺序可能与落盘时不同。此时"位置 → slot"
   * 的映射已经不可信，只写脏卡会把内容写到别人的键上，所以整库重写一次把位置纠正。
   */
  private forceFullWrite = false

  /**
   * 读取卡片数组
   *
   * @returns 原始卡片数组（未归一化）；没有任何记录时返回 null
   */
  async load(kv: CardKV): Promise<unknown[] | null> {
    const index = parseIndex(await kv.get(KEY_INDEX))
    if (index) {
      const cards: unknown[] = []
      let missing = 0
      for (const slot of index.slots) {
        const card = await kv.get(cardKey(slot))
        if (card === undefined || card === null) {
          missing++
          continue
        }
        cards.push(card)
      }
      this.adoptIndex(index)
      if (missing === 0) return cards
      // 分片缺卡：旧格式还在就退回旧格式（旧格式是迁移前那份完整快照）
      const legacy = await kv.get(KEY_LEGACY_CARDS)
      if (Array.isArray(legacy) && legacy.length > 0) {
        // 退回旧格式 = 重新迁移一次，索引里的编号不再作数
        this.reset()
        return legacy
      }
      // 旧格式也没有 → 用能读出来的那些，总比整库丢掉好
      return cards
    }

    const legacy = await kv.get(KEY_LEGACY_CARDS)
    return Array.isArray(legacy) ? legacy : null
  }

  private reset(): void {
    this.format = 1
    this.nextSlot = 0
    this.prevSlots = []
    this.prevKeys = []
    this.pendingSlots = []
    this.order = []
    this.dirty.clear()
    this.forceFullWrite = false
  }

  private adoptIndex(index: CardIndex): void {
    this.format = 2
    this.nextSlot = index.next
    this.prevSlots = [...index.slots]
    this.prevKeys = [...index.keys]
    this.pendingSlots = [...index.slots]
    this.forceFullWrite = false
  }

  /**
   * 保存前同步：给新卡分配 slot，返回当前顺序
   *
   * 每次保存都调一次 —— 结构变化（新建 / 删除 / 导入）后新卡才有编号。
   *
   * @param keyOf 卡片身份（用来核对"位置 → slot"的映射是否还成立）
   */
  sync(cards: readonly object[], keyOf?: (card: object) => string): number[] {
    const order: number[] = []
    const used = new Set<number>()
    /** 还没有编号的卡片数 */
    const slotless = cards.reduce(
      (n, card) => (this.slotByCard.get(card) === undefined ? n + 1 : n), 0,
    )
    /**
     * 能否按位置还原编号
     *
     * 载入时的卡数与索引里的编号数一致 → 顺序没变，沿用原编号（键名不变）。
     * 一旦结构变了（载入后先删/加了卡），位置对应关系就不可靠了，宁可重新编号：
     * 内容仍然是这张卡的，只是换了个键，旧键作为孤儿被清掉。
     */
    const positional = this.pendingSlots.length > 0 && this.pendingSlots.length === slotless
    /**
     * 按位置还原的编号不需要标脏
     *
     * 这些卡刚从分片里读出来、内容与磁盘一致；真正的改动由调用方的深度监听标脏。
     * 旧格式（format 1）要整体重写，标不标脏没区别。
     */
    const markRestoredDirty = !(positional && this.format === 2)
    let fresh = 0

    for (const card of cards) {
      let slot = this.slotByCard.get(card)
      if (slot === undefined) {
        const restored = positional ? this.pendingSlots[fresh] : undefined
        // 索引损坏（重复编号）时绝不能两张卡共用一个键，退回新编号
        slot = restored !== undefined && !used.has(restored) ? restored : this.allocSlot(used)
        fresh++
        this.slotByCard.set(card, slot)
        if (markRestoredDirty) this.dirty.add(slot)
      }
      used.add(slot)
      order.push(slot)
    }

    this.pendingSlots = []
    this.order = order

    // 恢复流程可能补内置卡 / 修群聊卡，导致顺序与落盘时不同。
    // 位置映射一旦不可信，就必须整库重写，否则只写脏卡会把内容写到别人的键上。
    if (keyOf && this.format === 2) {
      const keys = cards.map((c) => keyOf(c))
      if (this.prevKeys.length !== keys.length) {
        // 卡数变了（补卡 / 删卡）：上面的分支已经重新编号或标脏，这里只需记下新指纹
        this.prevKeys = [...keys]
      } else if (keys.some((k, i) => k !== this.prevKeys[i])) {
        this.forceFullWrite = true
        this.prevKeys = [...keys]
      }
    }
    return order
  }

  private allocSlot(used: Set<number>): number {
    while (used.has(this.nextSlot)) this.nextSlot++
    return this.nextSlot++
  }

  /** 标记某张卡变脏（由调用方的深度监听触发） */
  markDirty(slot: number): void {
    this.dirty.add(slot)
  }

  /** 取卡片当前 slot（可能还没分配） */
  slotOf(card: object): number | undefined {
    return this.slotByCard.get(card)
  }

  /**
   * 写库
   *
   * @param toValue 把单张卡变成可结构化克隆的普通值（通常顺带剥掉错误气泡）
   * @param keyOf   卡片身份，同时写进索引、用于下次载入时校验位置映射
   * @returns 本次实际写了几张卡
   */
  async save(
    kv: CardKV,
    cards: readonly object[],
    toValue: (card: object) => unknown,
    keyOf: (card: object) => string,
  ): Promise<number> {
    const order = this.sync(cards, keyOf)
    const current = new Set(order)
    const keys = cards.map((c) => keyOf(c))
    const writeAll = this.format === 1 || this.forceFullWrite
    const entries: Array<[string, unknown]> = []
    let written = 0

    for (const card of cards) {
      const slot = this.slotByCard.get(card)
      if (slot === undefined) continue
      // 迁移那次 / 顺序对不上那次必须把所有卡都写一遍，之后只写脏的
      if (writeAll || this.dirty.has(slot)) {
        entries.push([cardKey(slot), toValue(card)])
        written++
      }
    }
    const index: CardIndex = { v: 2, slots: order, next: this.nextSlot, keys }
    entries.push([KEY_INDEX, index])

    // 一次事务写完：索引与分片同时生效，不会出现"索引指向不存在的卡"
    await kv.putMany(entries)

    // 孤儿键（被删掉的卡）单独删：删失败只是留下垃圾，索引已经不带它了
    const stale = this.prevSlots.filter((s) => !current.has(s))
    if (stale.length > 0) {
      try {
        await kv.del(stale.map(cardKey))
      } catch {
        // 忽略：不影响读取
      }
    }

    this.prevSlots = [...order]
    this.prevKeys = [...keys]
    this.dirty.clear()
    this.forceFullWrite = false
    this.format = 2
    return written
  }
}
