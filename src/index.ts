// Cookie Jar：每域 + 全局字节配额，超限按
// priority → 过期 → 最近访问 → 创建时间（最后以域/路径/名兜底）确定性驱逐。
// 读路径只更新内存访问水位，批量提交时才落盘；驱逐时以
// max(持久 access, 未刷新水位) 合并最新时间。revision 保证并发下
// 不会基于过期快照驱逐/覆盖刚更新的项。

export type Priority = 'low' | 'medium' | 'high';

const PRIORITY_RANK: Record<Priority, number> = { low: 0, medium: 1, high: 2 };

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  created: number;
  /** 绝对过期时间戳（毫秒）；省略表示会话 cookie */
  expires?: number;
  priority?: Priority;
}

export interface StoredCookie extends Omit<Cookie, 'expires' | 'priority'> {
  expires: number | null;
  priority: Priority;
  /** 最近一次读取时间（持久值） */
  accessed: number;
  /** 受保护前缀（__Secure- / __Host-），仅影响排序 */
  protected: boolean;
  size: number;
}

export interface CookieKey {
  domain: string;
  path: string;
  name: string;
}

export interface SnapshotEntry {
  cookie: StoredCookie;
  /** 项版本：该项每次被替换/touch 都递增 */
  itemRevision: number;
}

export interface Snapshot {
  /** 存储整体版本：任何一次成功提交都单调递增 */
  revision: number;
  entries: SnapshotEntry[];
}

/** dump() 出来的状态可直接写回磁盘并在进程重启后 load() */
export interface PersistedState {
  revision: number;
  entries: SnapshotEntry[];
}

export interface BatchPut {
  type: 'put';
  cookie: StoredCookie;
}
export interface BatchDelete {
  type: 'delete';
  key: CookieKey;
  /** 乐观锁：该项当前必须持有该 itemRevision */
  ifRevision: number;
}
export interface BatchTouch {
  type: 'touch';
  key: CookieKey;
  accessed: number;
  ifRevision: number;
}
export type BatchOp = BatchPut | BatchDelete | BatchTouch;

export interface CommitBatch {
  /** CAS：仅当存储 revision 仍为 baseRevision 时整批生效 */
  baseRevision: number;
  ops: BatchOp[];
}

export interface SetResult {
  status: 'stored' | 'rejected';
  reason?: 'too_large' | 'exceeds_quota';
  /** 本次提交顺带移除的 cookie（同名覆盖、过期清理、配额驱逐），按驱逐顺序排列 */
  evicted: StoredCookie[];
}

export class RevisionMismatchError extends Error {
  constructor() {
    super('cookie store revision mismatch');
    this.name = 'RevisionMismatchError';
  }
}

const encoder = new TextEncoder();
const SESSION_EXPIRES = Number.MAX_SAFE_INTEGER;

export function cookieSize(c: Pick<Cookie, 'name' | 'value'>): number {
  // 配额按 name+value 的 UTF-8 字节数核算
  return encoder.encode(c.name).length + encoder.encode(c.value).length;
}

export function keyString(k: CookieKey): string {
  return `${k.domain} ${k.path} ${k.name}`;
}

/** 受保护前缀（__Secure- / __Host-）。仅影响驱逐排序，并非不可删。 */
export function isProtectedName(name: string): boolean {
  return name.startsWith('__Secure-') || name.startsWith('__Host-');
}

function tupleLess(a: CookieKey, b: CookieKey): boolean {
  return (
    a.domain < b.domain ||
    (a.domain === b.domain &&
      (a.path < b.path || (a.path === b.path && a.name < b.name)))
  );
}

function keyOf(c: StoredCookie): CookieKey {
  return { domain: c.domain, path: c.path, name: c.name };
}

/** 同步存储契约：快照读取 + 原子 CAS 提交 */
export interface CookieStore {
  snapshot(): Snapshot;
  commit(batch: CommitBatch): void;
}

interface StoredRecord {
  cookie: StoredCookie;
  itemRevision: number;
}

/** 默认内存存储；dump/load 可模拟进程重启后从持久层恢复 */
export class MemoryCookieStore implements CookieStore {
  #revision = 0;
  #entries = new Map<string, StoredRecord>();

  constructor(initial?: PersistedState) {
    if (initial) {
      this.#revision = initial.revision;
      for (const e of initial.entries) {
        this.#entries.set(keyString(e.cookie), { cookie: { ...e.cookie }, itemRevision: e.itemRevision });
      }
    }
  }

  snapshot(): Snapshot {
    return {
      revision: this.#revision,
      entries: [...this.#entries.values()].map((e) => ({ cookie: { ...e.cookie }, itemRevision: e.itemRevision })),
    };
  }

  commit(batch: CommitBatch): void {
    if (batch.baseRevision !== this.#revision) throw new RevisionMismatchError();

    // 先在影子映射上整批校验，任何一项失败都不留副作用
    const next = new Map(this.#entries);
    const newItemRevision = this.#revision + 1;
    for (const op of batch.ops) {
      const k = op.type === 'put' ? keyString(op.cookie) : keyString(op.key);
      const cur = next.get(k);
      if (op.type === 'put') {
        next.set(k, { cookie: { ...op.cookie }, itemRevision: newItemRevision });
      } else {
        if (!cur || cur.itemRevision !== op.ifRevision) throw new RevisionMismatchError();
        if (op.type === 'delete') next.delete(k);
        else next.set(k, { cookie: { ...cur.cookie, accessed: op.accessed }, itemRevision: newItemRevision });
      }
    }

    this.#entries = next;
    this.#revision = newItemRevision;
  }

  dump(): PersistedState {
    return {
      revision: this.#revision,
      entries: [...this.#entries.values()].map((e) => ({ cookie: { ...e.cookie }, itemRevision: e.itemRevision })),
    };
  }

  static load(data: PersistedState): MemoryCookieStore {
    return new MemoryCookieStore({
      revision: data.revision,
      entries: data.entries.map((e) => ({ cookie: { ...e.cookie }, itemRevision: e.itemRevision })),
    });
  }
}

export interface CookieJarOptions {
  store?: CookieStore;
  domainQuota?: number;
  globalQuota?: number;
  maxCookieSize?: number;
  now?: () => number;
  /** 测试钩子：驱逐提交前触发（可在此插入并发写入制造 CAS 冲突） */
  beforeEvictionCommit?: () => void | Promise<void>;
}

interface Live {
  c: StoredCookie;
  key: string;
  itemRevision: number;
  size: number;
}

interface Plan {
  puts: StoredCookie[];
  /** 同名覆盖产生的删除（携带旧 itemRevision，非配额驱逐） */
  overwrites: Live[];
  /** 配额驱逐 / 过期清理产生的删除 */
  deletes: Live[];
  touches: BatchTouch[];
  evicted: StoredCookie[];
  /** 驱逐全部存量后仍不满足配额（理论上被前置校验挡住，防御性分支） */
  overQuota: boolean;
}

const DEFAULT_DOMAIN_QUOTA = 4096;
const DEFAULT_GLOBAL_QUOTA = 16384;
const DEFAULT_MAX_COOKIE = 4096;
const MAX_RETRIES = 16;

export class CookieJar {
  #store: CookieStore;
  #domainQuota: number;
  #globalQuota: number;
  #maxCookieSize: number;
  #now: () => number;
  #beforeEvictionCommit?: () => void | Promise<void>;

  /** 读访问水位：key -> 自上次落盘以来见到的最大访问时间 */
  #pending = new Map<string, number>();
  #snapshot: Snapshot;
  #live: Live[] = [];

  constructor(options: CookieJarOptions = {}) {
    this.#store = options.store ?? new MemoryCookieStore();
    this.#domainQuota = options.domainQuota ?? DEFAULT_DOMAIN_QUOTA;
    this.#globalQuota = options.globalQuota ?? DEFAULT_GLOBAL_QUOTA;
    this.#maxCookieSize = options.maxCookieSize ?? DEFAULT_MAX_COOKIE;
    this.#now = options.now ?? (() => Date.now());
    this.#beforeEvictionCommit = options.beforeEvictionCommit;
    this.#snapshot = this.#store.snapshot();
    this.#reindex();
  }

  // ---------- 公开 API ----------

  async set(input: Cookie): Promise<SetResult> {
    const now = this.#now();
    const incoming = this.#normalize(input, now);

    // 超大单 cookie：不触发任何驱逐，直接拒绝
    if (incoming.size > this.#maxCookieSize) return { status: 'rejected', reason: 'too_large', evicted: [] };
    if (incoming.size > this.#domainQuota || incoming.size > this.#globalQuota) {
      return { status: 'rejected', reason: 'exceeds_quota', evicted: [] };
    }

    // 插入即过期且无同名旧项：空操作，不产生任何写
    if (incoming.expires !== null && incoming.expires <= now) {
      const old = this.#live.find((l) => l.key === keyString(incoming));
      if (!old) return { status: 'stored', evicted: [] };
    }

    for (let attempt = 0; ; attempt++) {
      const plan = this.#buildPlan(incoming);

      // 前置校验保证不可达；即便如此也绝不带着超限状态提交
      if (plan.overQuota) return { status: 'rejected', reason: 'exceeds_quota', evicted: [] };

      if (plan.deletes.length > 0 && this.#beforeEvictionCommit) await this.#beforeEvictionCommit();

      const allDeletes = [...plan.overwrites, ...plan.deletes];
      const ops: BatchOp[] = [
        ...allDeletes.map((l) => ({ type: 'delete' as const, key: keyOf(l.c), ifRevision: l.itemRevision })),
        ...plan.puts.map((c) => ({ type: 'put' as const, cookie: c })),
        ...plan.touches,
      ];

      try {
        this.#store.commit({ baseRevision: this.#snapshot.revision, ops });
      } catch (e) {
        if (e instanceof RevisionMismatchError && attempt < MAX_RETRIES) {
          this.#refresh(); // 存储被并发改动：重读后基于新 revision 重新规划
          continue;
        }
        throw e;
      }

      this.#adopt(plan);
      return { status: 'stored', evicted: plan.evicted };
    }
  }

  /** 选择 cookie（同步）。仅抬高内存水位，不产生持久写。 */
  get(host: string, path: string, secure = true): StoredCookie[] {
    const now = this.#now();
    const hits: StoredCookie[] = [];
    for (const l of this.#live) {
      const c = l.c;
      if (c.expires !== null && c.expires <= now) continue;
      if (host !== c.domain && !host.endsWith('.' + c.domain)) continue;
      if (!path.startsWith(c.path)) continue;
      if (c.secure && !secure) continue;
      hits.push(c);
      const w = this.#pending.get(l.key);
      if (w === undefined || now > w) this.#pending.set(l.key, now);
    }
    return hits
      .map((c) => ({ ...c }))
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created);
  }

  /** 将累积的访问水位批量刷入持久层；CAS 冲突时合并水位、重读重试。返回刷写条数 */
  async flushAccessTimes(): Promise<number> {
    for (let attempt = 0; ; attempt++) {
      if (this.#pending.size === 0) return 0;

      // 换出新水位：flush 期间新发生的读取进入独立映射，不受本次提交成败影响
      const inflight = this.#pending;
      this.#pending = new Map();

      const touches: BatchTouch[] = [];
      for (const l of this.#live) {
        const w = inflight.get(l.key);
        if (w !== undefined && w > l.c.accessed) {
          touches.push({ type: 'touch', key: keyOf(l.c), accessed: w, ifRevision: l.itemRevision });
        }
      }
      if (touches.length === 0) return 0;

      try {
        this.#store.commit({ baseRevision: this.#snapshot.revision, ops: touches });
      } catch (e) {
        if (e instanceof RevisionMismatchError && attempt < MAX_RETRIES) {
          this.#mergeWatermark(inflight);
          this.#refresh();
          continue;
        }
        throw e;
      }

      this.#refresh();
      // 仅当刷新期间该 key 的水位没有继续上涨，才算真正落定
      for (const t of touches) {
        const k = keyString(t.key);
        const w = this.#pending.get(k);
        if (w === undefined || w <= t.accessed) this.#pending.delete(k);
      }
      return touches.length;
    }
  }

  get count(): number {
    return this.#live.length;
  }

  domainSize(domain: string): number {
    return this.#live.filter((l) => l.c.domain === domain).reduce((s, l) => s + l.size, 0);
  }

  totalSize(): number {
    return this.#live.reduce((s, l) => s + l.size, 0);
  }

  /** 尚未落盘的访问水位条数 */
  pendingAccessCount(): number {
    return this.#pending.size;
  }

  getAll(): StoredCookie[] {
    return this.#live.map((l) => ({ ...l.c }));
  }

  // ---------- 内部实现 ----------

  #normalize(input: Cookie, now: number): StoredCookie {
    return {
      name: input.name,
      value: input.value,
      domain: input.domain,
      path: input.path,
      secure: input.secure,
      created: input.created,
      expires: input.expires ?? null,
      priority: input.priority ?? 'medium',
      accessed: Math.max(input.created, now),
      protected: isProtectedName(input.name),
      size: cookieSize(input),
    };
  }

  #refresh() {
    this.#snapshot = this.#store.snapshot();
    this.#reindex();
  }

  #reindex() {
    this.#live = this.#snapshot.entries.map((e) => ({
      c: e.cookie,
      key: keyString(e.cookie),
      itemRevision: e.itemRevision,
      size: e.cookie.size ?? cookieSize(e.cookie),
    }));
  }

  #mergeWatermark(other: Map<string, number>) {
    for (const [k, v] of other) {
      const cur = this.#pending.get(k);
      if (cur === undefined || v > cur) this.#pending.set(k, v);
    }
  }

  /** 驱逐时合并持久与未刷新时间：max(accessed, 水位) */
  #effectiveAccessed(l: Live): number {
    const w = this.#pending.get(l.key);
    return w !== undefined && w > l.c.accessed ? w : l.c.accessed;
  }

  #buildPlan(incoming: StoredCookie): Plan {
    const now = this.#now();
    const incomingKey = keyString(incoming);
    const incomingExpired = incoming.expires !== null && incoming.expires <= now;

    const evicted: StoredCookie[] = [];
    const deletes: Live[] = [];
    const overwrites: Live[] = [];
    const puts: StoredCookie[] = incomingExpired ? [] : [incoming];

    // 同名旧项：原子删除后重放（或随过期插入一并清除）；计入 evicted 但不属于配额驱逐
    let candidates = this.#live.filter((l) => {
      if (l.key !== incomingKey) return true;
      overwrites.push(l);
      evicted.push({ ...l.c });
      return false;
    });

    // 1) 已过期项最先驱逐（按统一的确定性顺序）
    candidates.sort((a, b) => this.#rank(a, b));
    candidates = candidates.filter((l) => {
      if (l.c.expires !== null && l.c.expires <= now) {
        deletes.push(l);
        evicted.push({ ...l.c });
        return false;
      }
      return true;
    });

    // candidates 已按 #rank 全局排序（驱逐优先级升序）。
    const removeAt = (i: number) => {
      const [victim] = candidates.splice(i, 1);
      deletes.push(victim);
      evicted.push({ ...victim.c });
    };
    const domainCurrent = new Map<string, number>();
    for (const l of candidates) domainCurrent.set(l.c.domain, (domainCurrent.get(l.c.domain) ?? 0) + l.size);
    const incomingByDomain = new Map<string, number>();
    for (const p of puts) incomingByDomain.set(p.domain, (incomingByDomain.get(p.domain) ?? 0) + p.size);

    // 2a) 逐域裁剪：从全局序最靠前起，删除属于仍超限域的 cookie，直到该域满足配额
    let overQuota = false;
    for (const [domain, incomingSize] of incomingByDomain) {
      const needUnder = this.#domainQuota - incomingSize;
      if (needUnder < 0) {
        overQuota = true; // 单个新 cookie 就超过域配额（前置校验应已拦截）
        break;
      }
      // 多轮扫描（删除会改变下标），每轮删一个该域内排序最靠前的
      for (;;) {
        const used = candidates.filter((l) => l.c.domain === domain).reduce((s, l) => s + l.size, 0);
        if (used <= needUnder) break;
        const idx = candidates.findIndex((l) => l.c.domain === domain);
        if (idx === -1) {
          overQuota = true;
          break;
        }
        removeAt(idx);
      }
      if (overQuota) break;
    }

    // 2b) 全局裁剪：只在总量仍超限时，按全局序从最前端删除（受害者可来自任意域）
    if (!overQuota) {
      const incomingTotal = puts.reduce((s, p) => s + p.size, 0);
      for (;;) {
        const used = candidates.reduce((s, l) => s + l.size, 0);
        if (used + incomingTotal <= this.#globalQuota) break;
        if (candidates.length === 0) {
          overQuota = true;
          break;
        }
        removeAt(0);
      }
    }

    // 3) 水位合并：幸存者把最新访问时间随本次提交一并批量落盘
    const touches: BatchTouch[] = [];
    for (const l of candidates) {
      const w = this.#pending.get(l.key);
      if (w !== undefined && w > l.c.accessed) {
        touches.push({ type: 'touch', key: keyOf(l.c), accessed: w, ifRevision: l.itemRevision });
      }
    }

    return { puts, overwrites, deletes, touches, evicted, overQuota };
  }

  /**
   * 驱逐顺序（升序，排前者先被驱逐）：
   * priority（低→高；受保护名在同优先级内更靠后）→
   * expires（早→晚，会话 cookie 视为最晚）→
   * 合并后的最近访问（久未读→最近读）→
   * created（早→晚）→ 域/路径/名（字典序兜底，保证决胜确定）
   * 受保护前缀与高 priority 只影响排序，绝不构成删除豁免。
   */
  #rank(a: Live, b: Live): number {
    const pa = PRIORITY_RANK[a.c.priority];
    const pb = PRIORITY_RANK[b.c.priority];
    if (pa !== pb) return pa - pb;
    if (a.c.protected !== b.c.protected) return (a.c.protected ? 1 : 0) - (b.c.protected ? 1 : 0);
    const ea = a.c.expires ?? SESSION_EXPIRES;
    const eb = b.c.expires ?? SESSION_EXPIRES;
    if (ea !== eb) return ea < eb ? -1 : 1;
    const aa = this.#effectiveAccessed(a);
    const ab = this.#effectiveAccessed(b);
    if (aa !== ab) return aa - ab;
    if (a.c.created !== b.c.created) return a.c.created - b.c.created;
    if (tupleLess(a.c, b.c)) return -1;
    if (tupleLess(b.c, a.c)) return 1;
    return 0;
  }

  /** 提交成功后吸收结果：被删/被替换者丢弃水位，touch 落定，重载快照 */
  #adopt(plan: Plan) {
    for (const l of [...plan.overwrites, ...plan.deletes]) this.#pending.delete(l.key);
    for (const t of plan.touches) {
      const k = keyString(t.key);
      const w = this.#pending.get(k);
      if (w !== undefined && w <= t.accessed) this.#pending.delete(k);
    }
    this.#refresh();
  }
}
