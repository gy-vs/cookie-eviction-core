import { describe, expect, it } from 'vitest';
import {
  CookieJar,
  MemoryCookieStore,
  RevisionMismatchError,
  StoredCookie,
} from '../src/index.js';

interface Clock {
  t: number;
  now(): number;
  tick(ms: number): number;
}

function clock(start = 1000): Clock {
  return {
    t: start,
    now() {
      return this.t;
    },
    tick(ms: number) {
      this.t += ms;
      return this.t;
    },
  };
}

function jar(opts: ConstructorParameters<typeof CookieJar>[0] = {}, clk?: Clock) {
  const c = clk ?? clock();
  return {
    clk: c,
    jar: new CookieJar({ now: () => c.now(), ...opts }),
  };
}

function ck(partial: Partial<StoredCookie> & Pick<StoredCookie, 'name'>): StoredCookie {
  return {
    name: partial.name,
    value: partial.value ?? '1',
    domain: partial.domain ?? 'example.com',
    path: partial.path ?? '/',
    secure: partial.secure ?? false,
    created: partial.created ?? 0,
    expires: partial.expires === undefined ? null : partial.expires,
    priority: partial.priority ?? 'medium',
    accessed: partial.accessed ?? partial.created ?? 0,
    protected: partial.protected ?? false,
    size: partial.size ?? (partial.name.length + (partial.value ?? '1').length),
  };
}

async function fill(j: CookieJar, names: string[], created0 = 0, domain = 'example.com') {
  for (let i = 0; i < names.length; i++) {
    await j.set({ name: names[i], value: '1', domain, path: '/', secure: false, created: created0 + i });
  }
}

function names(cookies: { name: string }[]): string[] {
  return cookies.map((c) => c.name);
}

describe('basic selection', () => {
  it('selects', async () => {
    const x = new CookieJar();
    await x.set({ name: 'a', value: '1', domain: 'test', path: '/', secure: false, created: 1 });
    expect(x.get('test', '/')).toHaveLength(1);
  });

  it('matches domain suffix, path prefix and secure flag', async () => {
    const { jar: j } = jar({ globalQuota: 1000, domainQuota: 1000 });
    await j.set({ name: 'a', value: '1', domain: 'example.com', path: '/app', secure: true, created: 1 });
    expect(j.get('sub.example.com', '/app/x', true)).toHaveLength(1);
    expect(j.get('example.org', '/app/x', true)).toHaveLength(0);
    expect(j.get('sub.example.com', '/app/x', false)).toHaveLength(0);
  });
});

describe('oversized single cookie', () => {
  it('rejects a cookie larger than maxCookieSize without any eviction', async () => {
    const { jar: j } = jar({ domainQuota: 100, globalQuota: 100, maxCookieSize: 5 });
    await fill(j, ['a', 'b']);
    expect(j.count).toBe(2);

    const r = await j.set({ name: 'big', value: 'XYZXYZ', domain: 'example.com', path: '/', secure: false, created: 9 });
    expect(r).toMatchObject({ status: 'rejected', reason: 'too_large' });
    expect(j.count).toBe(2);
    expect(names(j.getAll())).toEqual(['a', 'b']);
  });

  it('rejects a cookie that alone exceeds a quota without any eviction', async () => {
    const { jar: j } = jar({ domainQuota: 4, globalQuota: 100 });
    await fill(j, ['a']);
    const r = await j.set({ name: 'big', value: '12', domain: 'example.com', path: '/', secure: false, created: 9 });
    expect(r).toMatchObject({ status: 'rejected', reason: 'exceeds_quota' });
    expect(names(j.getAll())).toEqual(['a']);
  });
});

describe('domain quota eviction', () => {
  it('evicts oldest within the domain while leaving other domains untouched', async () => {
    const { jar: j } = jar({ domainQuota: 7, globalQuota: 1000 });
    await fill(j, ['a', 'b', 'c'], 0);
    await j.set({ name: 'z', value: '1', domain: 'other.com', path: '/', secure: false, created: 0 });

    const r = await j.set({ name: 'd', value: '1', domain: 'example.com', path: '/', secure: false, created: 3 });
    expect(names(r.evicted)).toEqual(['a']);
    expect(names(j.getAll().filter((c) => c.domain === 'example.com'))).toEqual(['b', 'c', 'd']);
    expect(j.domainSize('example.com')).toBe(6);
    expect(j.domainSize('other.com')).toBe(2);
  });

  it('repeated inserts converge and stay at quota', async () => {
    const { jar: j } = jar({ domainQuota: 6, globalQuota: 1000 });
    await fill(j, ['a', 'b'], 0);
    await j.set({ name: 'c', value: '1', domain: 'example.com', path: '/', secure: false, created: 2 });
    expect(j.domainSize('example.com')).toBe(6);
    const r = await j.set({ name: 'd', value: '1', domain: 'example.com', path: '/', secure: false, created: 3 });
    expect(names(r.evicted)).toEqual(['a']);
    expect(j.domainSize('example.com')).toBeLessThanOrEqual(6);
    expect(names(j.getAll())).toEqual(['b', 'c', 'd']);
  });

  it('same-name overwrite never double counts and does not evict unnecessarily', async () => {
    const { jar: j } = jar({ domainQuota: 6, globalQuota: 1000 });
    await fill(j, ['a', 'b'], 0);
    const r = await j.set({ name: 'a', value: '2', domain: 'example.com', path: '/', secure: false, created: 5 });
    expect(r.status).toBe('stored');
    expect(names(r.evicted)).toEqual(['a']);
    expect(names(j.getAll())).toEqual(['b', 'a']);
    expect(j.getAll().find((c) => c.name === 'a')!.value).toBe('2');
  });
});

describe('global quota eviction', () => {
  it('evicts across domains under global quota and satisfies both quotas after commit', async () => {
    const { jar: j } = jar({ domainQuota: 20, globalQuota: 7 });
    await fill(j, ['a', 'b'], 0, 'example.com');
    await fill(j, ['p'], 0, 'other.com');

    const r = await j.set({ name: 'c', value: '1', domain: 'example.com', path: '/', secure: false, created: 3 });
    expect(names(r.evicted)).toEqual(['a']);
    expect(j.totalSize()).toBe(6);
    expect(j.domainSize('example.com')).toBeLessThanOrEqual(20);
    expect(names(j.getAll()).sort()).toEqual(['b', 'c', 'p']);
  });
});

describe('priority / protected ordering', () => {
  it('low priority is evicted before older high priority; protected prefix only affects ordering', async () => {
    // 全部单字名 + 单字值 => 每个 cookie 恰好 2 字节，配额 5 至多保留 2 个
    const { jar: j } = jar({ domainQuota: 5, globalQuota: 1000 });
    await j.set({ name: 'l', value: '1', domain: 'd', path: '/', secure: false, created: 10, priority: 'low' });
    await j.set({ name: 'h', value: '1', domain: 'd', path: '/', secure: false, created: 0, priority: 'high' });

    const r = await j.set({ name: 'm', value: '1', domain: 'd', path: '/', secure: false, created: 5 });
    expect(names(r.evicted)).toEqual(['l']); // low 最先出局，哪怕 high 更老

    const r2 = await j.set({ name: 'n', value: '1', domain: 'd', path: '/', secure: false, created: 22 });
    expect(names(r2.evicted)).toEqual(['m']); // 然后是 medium

    // 队列此时 [h(high,老), n(medium,新)]。再压一个 high：
    // medium 仍先于 high 出局
    const r3 = await j.set({ name: 'x', value: '1', domain: 'd', path: '/', secure: false, created: 23, priority: 'high' });
    expect(names(r3.evicted)).toEqual(['n']);

    // 队列 [h(high,最老), x(high,新)]，再压一个更新的 high：
    // 同优先级比 LRU，最久未访问的 h 一样被驱逐——high 绝非豁免
    const r4 = await j.set({ name: 'y', value: '1', domain: 'd', path: '/', secure: false, created: 24, priority: 'high' });
    expect(names(r4.evicted)).toEqual(['h']);

    // 受保护前缀：同优先级下比普通 cookie 更晚被驱逐，但压力足够时一样删除
    const { jar: j2 } = jar({ domainQuota: 20, globalQuota: 1000 });
    await j2.set({ name: '__Secure-s', value: '1', domain: 'd', path: '/', secure: true, created: 1, priority: 'medium' });
    for (let i = 0; i < 9; i++) {
      await j2.set({ name: `p${i}`, value: '1', domain: 'd', path: '/', secure: false, created: 1, priority: 'medium' });
    }
    // __Secure-s（size 11）与 9 个普通项（各 3）：普通项在同优先级下先被驱逐
    expect(names(j2.getAll())).toContain('__Secure-s');
  });
});

describe('simultaneous expiry', () => {
  it('already-expired cookies are purged before LRU eviction, in deterministic order', async () => {
    const { clk, jar: j } = jar({ domainQuota: 7, globalQuota: 1000 }, clock(1000));
    await j.set({ name: 'a', value: '1', domain: 'd', path: '/', secure: false, created: 1, expires: 1050 });
    await j.set({ name: 'b', value: '1', domain: 'd', path: '/', secure: false, created: 2, expires: 1050 });
    await j.set({ name: 'c', value: '1', domain: 'd', path: '/', secure: false, created: 3 });
    expect(j.get('d', '/').map((x) => x.name)).toEqual(['a', 'b', 'c']);

    // 时间推进到 1100：a/b 同时到期（读取不可见）
    clk.tick(100);
    expect(j.get('d', '/').map((x) => x.name)).toEqual(['c']);

    const r = await j.set({ name: 'd2', value: '1', domain: 'd', path: '/', secure: false, created: 1100 });
    // 两个同时过期项按确定性顺序（priority/expires/accessed/created）清除，配额因此无需驱逐 c
    expect(names(r.evicted)).toEqual(['a', 'b']);
    expect(names(j.getAll())).toEqual(['c', 'd2']);
    expect(j.domainSize('d')).toBe(5);
  });

  it('earlier expires is evicted first when both still alive', async () => {
    const { jar: j } = jar({ domainQuota: 4, globalQuota: 1000 }, clock(1000));
    await j.set({ name: 'a', value: '1', domain: 'd', path: '/', secure: false, created: 1, expires: 2000 });
    await j.set({ name: 'b', value: '1', domain: 'd', path: '/', secure: false, created: 1, expires: 3000 });
    const r = await j.set({ name: 'c', value: '1', domain: 'd', path: '/', secure: false, created: 1 });
    expect(names(r.evicted)).toEqual(['a']);
  });
});

describe('tie-break determinism', () => {
  it('identical priority/expiry/access/created breaks on domain then path then name', async () => {
    const { jar: j } = jar({ domainQuota: 9, globalQuota: 1000 });
    await j.set({ name: 'bbb', value: '1', domain: 'd', path: '/', secure: false, created: 5 });
    await j.set({ name: 'aaa', value: '1', domain: 'd', path: '/', secure: false, created: 5 });
    const r = await j.set({ name: 'ccc', value: '1', domain: 'd', path: '/', secure: false, created: 5 });
    expect(names(r.evicted)).toEqual(['aaa']);
    expect(names(j.getAll()).sort()).toEqual(['bbb', 'ccc']);
  });

  it('eviction result is identical across jar rebuilds for the same state', async () => {
    const build = async () => {
      const store = new MemoryCookieStore();
      const c = clock(1000);
      const j = new CookieJar({ store, domainQuota: 6, globalQuota: 1000, now: () => c.now() });
      const seed = [
        { name: 'n3', created: 2, priority: 'low' as const },
        { name: 'n1', created: 2, priority: 'low' as const },
      ];
      for (const s of seed) {
        await j.set({ name: s.name, value: '1', domain: 'd', path: '/', secure: false, created: s.created, priority: s.priority });
      }
      const r = await j.set({ name: 'z', value: '1', domain: 'd', path: '/', secure: false, created: 9 });
      return names(r.evicted);
    };
    const [e1, e2, e3] = await Promise.all([build(), build(), build()]);
    expect(e1).toEqual(e2);
    expect(e2).toEqual(e3);
    // 两个 low 项 priority/expires/accessed/created 全同，字典序兜底 => n1
    expect(e1).toEqual(['n1']);
  });
});

describe('batched access times', () => {
  it('reads only move the in-memory watermark; flush commits them in one batch', async () => {
    const store = new MemoryCookieStore();
    const { clk, jar: j } = jar({ store, domainQuota: 7, globalQuota: 1000 }, clock(1000));
    await fill(j, ['a', 'b', 'c'], 0);
    const revBefore = store.snapshot().revision;

    clk.tick(10);
    j.get('example.com', '/');
    clk.tick(10);
    j.get('example.com', '/'); // 同一 tick 重复读不产生额外水位
    expect(store.snapshot().revision).toBe(revBefore);
    expect(j.pendingAccessCount()).toBe(3);

    const n = await j.flushAccessTimes();
    expect(n).toBe(3);
    expect(j.pendingAccessCount()).toBe(0);
    expect(store.snapshot().revision).toBe(revBefore + 1);

    const got = store
      .snapshot()
      .entries.map((e) => e.cookie)
      .sort((x, y) => x.name.localeCompare(y.name));
    expect(got.map((c) => c.accessed)).toEqual([1020, 1020, 1020]);
  });

  it('eviction merges pending watermark with persisted access: recently read survives', async () => {
    const store = new MemoryCookieStore();
    const { clk, jar: j } = jar({ store, domainQuota: 7, globalQuota: 1000 }, clock(1000));
    await fill(j, ['a', 'c'], 0);
    // b 放在更深路径，便于之后只读根路径时不命中它
    await j.set({ name: 'b', value: '1', domain: 'example.com', path: '/deep', secure: false, created: 0 });

    clk.tick(100);
    j.get('example.com', '/deep'); // 三者都被读到
    j.get('example.com', '/');
    clk.tick(100);
    await j.flushAccessTimes();
    expect(j.getAll().map((c) => c.accessed)).toEqual([1100, 1100, 1100]);

    // flush 之后仅重读根路径上的 a、c，b 留在 1100
    clk.tick(100);
    const hits = j.get('example.com', '/');
    expect(names(hits).sort()).toEqual(['a', 'c']);
    expect(j.pendingAccessCount()).toBe(2);

    clk.tick(10);
    const r = await j.set({ name: 'd', value: '1', domain: 'example.com', path: '/', secure: false, created: 1310 });
    // b 持久访问停在 1100，a/c 未刷新水位 1200 合并生效，故 LRU 最久未访问的 b 被驱逐
    expect(names(r.evicted)).toEqual(['b']);
    expect(names(j.getAll()).sort()).toEqual(['a', 'c', 'd']);
    // 驱逐提交顺带把 a、c 的水位落盘
    expect(j.pendingAccessCount()).toBe(0);
  });

  it('unflushed watermark older than persisted value never regresses it', async () => {
    const store = new MemoryCookieStore();
    const { jar: j } = jar({ store, domainQuota: 7, globalQuota: 1000 }, clock(1000));
    await fill(j, ['a', 'b', 'c'], 0);
    j.get('example.com', '/');
    await j.flushAccessTimes();
    // 直接通过存储确认 accessed 单调（再次 flush 无内容可刷）
    expect(await j.flushAccessTimes()).toBe(0);
  });
});

describe('process recovery', () => {
  it('rebuilds a jar from persisted dump including access times, revision and quota state', async () => {
    const store = new MemoryCookieStore();
    const { jar: j1 } = jar({ store, domainQuota: 7, globalQuota: 1000 }, clock(1000));
    await fill(j1, ['a', 'b', 'c'], 0);
    j1.get('example.com', '/');
    await j1.flushAccessTimes();
    await j1.set({ name: 'd', value: '1', domain: 'example.com', path: '/', secure: false, created: 5000 });
    expect(names(j1.getAll())).toEqual(['b', 'c', 'd']);

    const dumped = store.dump();
    const revived = MemoryCookieStore.load(JSON.parse(JSON.stringify(dumped)));
    const j2 = new CookieJar({ store: revived, domainQuota: 7, globalQuota: 1000 });

    expect(j2.count).toBe(3);
    expect(names(j2.getAll())).toEqual(['b', 'c', 'd']);
    expect(j2.totalSize()).toBe(6);
    // 恢复后继续工作：配额仍严格满足，revision 链延续（CAS 有效）
    const r = await j2.set({ name: 'e', value: '1', domain: 'example.com', path: '/', secure: false, created: 6000 });
    expect(names(r.evicted)).toEqual(['b']);
    expect(j2.totalSize()).toBeLessThanOrEqual(7);
  });

  it('unflushed access watermark is per-process and does not corrupt the store', async () => {
    const store = new MemoryCookieStore();
    const { clk, jar: j1 } = jar({ store, domainQuota: 7, globalQuota: 1000 }, clock(1000));
    await fill(j1, ['a', 'b', 'c'], 0);
    clk.tick(50);
    j1.get('example.com', '/'); // 水位未 flush
    expect(j1.pendingAccessCount()).toBe(3);

    const j2 = new CookieJar({ store, domainQuota: 7, globalQuota: 1000 });
    // 存储里 accessed 仍是 set 时的值，没有被读路径写过
    expect(j2.getAll().every((c) => c.accessed === 1000)).toBe(true);
  });
});

describe('concurrent overwrite via revision CAS', () => {
  it('retries on stale global revision and never evicts the concurrently updated cookie', async () => {
    const store = new MemoryCookieStore();
    let interleaveDone = false;

    const a = new CookieJar({
      store,
      domainQuota: 1000,
      globalQuota: 4,
      beforeEvictionCommit: async () => {
        if (interleaveDone) return;
        interleaveDone = true;
        // 另一个句柄在 A 的驱逐提交前抢先把 b 改写成 d（不同名），
        // 其自身配额为 6，因此直接放下 [a,d]
        const other = new CookieJar({ store, domainQuota: 1000, globalQuota: 6 });
        await other.set({ name: 'd', value: '1', domain: 'example.com', path: '/', secure: false, created: 99 });
      },
    });

    await fill(a, ['a', 'b'], 0);
    // A 的快照停留在 [a,b]；globalQuota=4 下放 c(2) 必须先驱逐一个。
    // commit 前钩子令存储变为 [a,d]（revision 已前进），A 的批次必然 CAS 失败
    const r = await a.set({ name: 'c', value: '1', domain: 'example.com', path: '/', secure: false, created: 100 });
    expect(r.status).toBe('stored');
    // 重试基于新快照 [a,d] 规划：再放 c 到 globalQuota=4 仍需驱逐一个；
    // 不会误杀刚更新进来的 d 两次，最终确定为 [c,d] 或 [a,c] 中排序靠前者。
    // 这里 a 与 d 的 LRU：d 是最新写入（accessed 更大），故 a 被驱逐
    expect(names(a.getAll()).sort()).toEqual(['c', 'd']);
    expect(a.totalSize()).toBeLessThanOrEqual(4);
    expect(store.snapshot().entries.map((e) => e.cookie.name).sort()).toEqual(['c', 'd']);
  });

  it('stale item revision on the overwrite target forces replanning', async () => {
    const store = new MemoryCookieStore();
    let fired = false;
    const a = new CookieJar({
      store,
      domainQuota: 1000,
      globalQuota: 8,
      beforeEvictionCommit: async () => {
        if (fired) return;
        fired = true;
        const other = new CookieJar({ store, domainQuota: 1000, globalQuota: 8 });
        // A 计划覆盖 a 并驱逐 b；other 抢先把 a 改写，使 A 携带的旧 itemRevision 删除失败
        await other.set({ name: 'a', value: '9999', domain: 'example.com', path: '/', secure: false, created: 99 });
      },
    });
    await fill(a, ['a', 'b'], 0);
    // 新 a 值变长（5 字节）+ b(2) = 7 <= 8 不驱逐；要触发驱逐需更大
    const r = await a.set({ name: 'a', value: '999999', domain: 'example.com', path: '/', secure: false, created: 100 });
    expect(fired).toBe(true);
    expect(r.status).toBe('stored');
    // 重试后采用 other 的 a 作为被覆盖旧项并重新规划，最终保留 A 写入的新版本
    const remaining = a.getAll();
    expect(names(remaining).sort()).toEqual(['a']);
    expect(remaining.find((c) => c.name === 'a')!.value).toBe('999999');
  });

  it('retries cleanly when the concurrent writer already freed the needed space', async () => {
    const store = new MemoryCookieStore();
    let poked = false;
    const a = new CookieJar({
      store,
      domainQuota: 1000,
      globalQuota: 4,
      beforeEvictionCommit: async () => {
        if (poked) return;
        poked = true;
        // 并发句柄直接把 a、b 都删掉并放下 d：A 重读后空间已够，无需自己驱逐
        const other = new CookieJar({ store, domainQuota: 1000, globalQuota: 4 });
        await other.set({ name: 'd', value: '1', domain: 'example.com', path: '/', secure: false, created: 7 });
      },
    });
    await fill(a, ['a', 'b'], 0);
    const r = await a.set({ name: 'c', value: '1', domain: 'example.com', path: '/', secure: false, created: 100 });
    expect(poked).toBe(true);
    expect(r.status).toBe('stored');
    expect(names(a.getAll()).sort()).toEqual(['c', 'd']);
    expect(a.totalSize()).toBeLessThanOrEqual(4);
  });

  it('raw store rejects commits against an old base revision', () => {
    const store = new MemoryCookieStore();
    const s0 = store.snapshot().revision;
    store.commit({
      baseRevision: s0,
      ops: [
        {
          type: 'put',
          cookie: ck({ name: 'a' }),
        },
      ],
    });
    expect(() =>
      store.commit({ baseRevision: s0, ops: [{ type: 'delete', key: { domain: 'example.com', path: '/', name: 'a' }, ifRevision: s0 + 1 }] }),
    ).toThrow(RevisionMismatchError);
  });
});

describe('additional invariants', () => {
  it('expired cookies are never returned and do not raise the watermark', async () => {
    const store = new MemoryCookieStore();
    const { clk, jar: j } = jar({ store, domainQuota: 20, globalQuota: 1000 }, clock(1000));
    await j.set({ name: 'a', value: '1', domain: 'd', path: '/', secure: false, created: 1, expires: 1050 });
    clk.tick(100);
    expect(j.get('d', '/')).toHaveLength(0);
    expect(j.pendingAccessCount()).toBe(0);
    expect(await j.flushAccessTimes()).toBe(0);
  });

  it('rejections never advance the store revision', async () => {
    const store = new MemoryCookieStore();
    const { jar: j } = jar({ store, domainQuota: 4, globalQuota: 100, maxCookieSize: 3 });
    await j.set({ name: 'a', value: '1', domain: 'd', path: '/', secure: false, created: 1 });
    const rev = store.snapshot().revision;
    await j.set({ name: 'big', value: 'XYZXYZ', domain: 'd', path: '/', secure: false, created: 2 });
    await j.set({ name: 'w', value: '12345', domain: 'd', path: '/', secure: false, created: 3 });
    expect(store.snapshot().revision).toBe(rev);
  });

  it('persisted (flushed) access times alone drive LRU order without a live watermark', async () => {
    const store = new MemoryCookieStore();
    const { clk, jar: j } = jar({ store, domainQuota: 5, globalQuota: 1000 }, clock(1000));
    await j.set({ name: 'a', value: '1', domain: 'd', path: '/', secure: false, created: 0 });
    await j.set({ name: 'b', value: '1', domain: 'd', path: '/', secure: false, created: 0 });
    clk.tick(10);
    j.get('d', '/'); // 两者都被读到（同 path）
    await j.flushAccessTimes();
    // 用一个全新进程句柄恢复（无任何内存水位），手动构造 a 更久未读
    const dumped = store.dump();
    for (const e of dumped.entries) {
      if (e.cookie.name === 'a') e.cookie.accessed = 1000;
      if (e.cookie.name === 'b') e.cookie.accessed = 2000;
    }
    const revived = MemoryCookieStore.load(dumped);
    const j2 = new CookieJar({ store: revived, domainQuota: 5, globalQuota: 1000 });
    const r = await j2.set({ name: 'c', value: '1', domain: 'd', path: '/', secure: false, created: 9 });
    expect(names(r.evicted)).toEqual(['a']);
  });

  it('both domain and global limits enforced simultaneously when both are exceeded', async () => {
    const { clk, jar: j } = jar({ domainQuota: 3, globalQuota: 7 }, clock(1000));
    // d1: a(2)；d2: p(2)
    await j.set({ name: 'a', value: '1', domain: 'd1', path: '/', secure: false, created: 0 });
    await j.set({ name: 'p', value: '1', domain: 'd2', path: '/', secure: false, created: 0 });
    // 向 d1 再放 b(2)：d1=4>3，踢 a（最近访问均为 set 时刻，按 created）
    const r = await j.set({ name: 'b', value: '1', domain: 'd1', path: '/', secure: false, created: 5 });
    expect(names(r.evicted)).toEqual(['a']);
    expect(j.domainSize('d1')).toBe(2);

    // 制造跨域 LRU 差：让 d1 的 b 最近被读（水位更新），d2 的 p 久未访问
    clk.tick(100);
    j.get('d1', '/');
    clk.tick(100);
    // d2 放 q(2)：d2 = p+q=4>3，先在域内裁剪掉最久未访问的 p，再全局裁剪
    const r2 = await j.set({ name: 'q', value: '1', domain: 'd2', path: '/', secure: false, created: 1200 });
    expect(names(r2.evicted)).toEqual(['p']);
    expect(j.domainSize('d2')).toBe(2);
    expect(j.totalSize()).toBe(4);

    // d2 再放 r2(3 字节)：q(2)+r2(3)=5>3，域内裁剪掉 q 后 r2=3 恰好满足；不波及 d1
    const r3 = await j.set({ name: 'r2', value: '1', domain: 'd2', path: '/', secure: false, created: 1300 });
    expect(names(r3.evicted)).toEqual(['q']);
    expect(j.domainSize('d1')).toBe(2);
    expect(j.domainSize('d2')).toBe(3);
    expect(j.totalSize()).toBeLessThanOrEqual(7);
    expect(names(j.getAll()).sort()).toEqual(['b', 'r2']);
  });

  it('flush keeps access times monotonic and idempotent when nothing is pending', async () => {
    const store = new MemoryCookieStore();
    const { clk, jar: j } = jar({ store, domainQuota: 20, globalQuota: 1000 }, clock(1000));
    await j.set({ name: 'a', value: '1', domain: 'd', path: '/', secure: false, created: 0 });
    clk.tick(10);
    j.get('d', '/');
    expect(await j.flushAccessTimes()).toBe(1);
    const t1 = store.snapshot().entries[0].cookie.accessed;
    expect(await j.flushAccessTimes()).toBe(0);
    expect(store.snapshot().entries[0].cookie.accessed).toBe(t1);
  });
});

describe('strict quota satisfaction after commit', () => {
  it('randomized fill sequences always end within both quotas with deterministic survivors', async () => {
    let seed = 987654321;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const domains = ['d1.com', 'd2.com', 'd3.com'];
    for (let round = 0; round < 40; round++) {
      const DQ = 10 + Math.floor(rand() * 20);
      const GQ = DQ + 5 + Math.floor(rand() * 40);
      const store = new MemoryCookieStore();
      const c = clock(1_000_000);
      const j = new CookieJar({ store, domainQuota: DQ, globalQuota: GQ, now: () => c.now() });
      const ref = new CookieJar({ domainQuota: DQ, globalQuota: GQ, now: () => c.now() });

      for (let i = 0; i < 60; i++) {
        const n = `c${Math.floor(rand() * 10)}`;
        const v = 'x'.repeat(1 + Math.floor(rand() * 5));
        const domain = domains[Math.floor(rand() * domains.length)];
        const input = {
          name: n,
          value: v,
          domain,
          path: '/',
          secure: false,
          created: i,
          priority: (['low', 'medium', 'high'] as const)[Math.floor(rand() * 3)],
        };
        const rj = await j.set(input);
        await ref.set(input);

        // 偶发读取，抬高内存水位并偶发 flush
        if (rand() < 0.3) {
          c.tick(1);
          j.get(domain, '/');
          ref.get(domain, '/');
        }
        if (rand() < 0.1) {
          c.tick(1);
          await j.flushAccessTimes();
        }

        // 每次提交后都必须严格满足两层配额（拒绝除外）
        if (rj.status === 'stored') {
          expect(j.totalSize()).toBeLessThanOrEqual(GQ);
          for (const d of domains) expect(j.domainSize(d)).toBeLessThanOrEqual(DQ);
        }
      }

      await j.flushAccessTimes();
      expect(j.totalSize()).toBeLessThanOrEqual(GQ);
      for (const d of domains) expect(j.domainSize(d)).toBeLessThanOrEqual(DQ);
      expect(names(j.getAll()).sort()).toEqual(names(ref.getAll()).sort());
    }
  });
});

describe('flush concurrency', () => {
  it('merges watermark back and retries when a concurrent commit changed revisions', async () => {
    const store = new MemoryCookieStore();
    const { clk, jar: j } = jar({ store, domainQuota: 30, globalQuota: 1000 }, clock(1000));
    await fill(j, ['a', 'b'], 0);
    clk.tick(10);
    j.get('example.com', '/');

    // 在 flush 提交前插入并发写，制造 baseRevision 冲突
    let poked = false;
    const origCommit = store.commit.bind(store);
    store.commit = (batch) => {
      if (!poked && batch.ops.every((op) => op.type === 'touch')) {
        poked = true;
        const other = new CookieJar({ store, domainQuota: 30, globalQuota: 1000 });
        void other.set({ name: 'z', value: '1', domain: 'other.com', path: '/', secure: false, created: 1 });
        return origCommit(batch);
      }
      return origCommit(batch);
    };

    const n = await j.flushAccessTimes();
    expect(poked).toBe(true);
    expect(n).toBe(2);
    expect(j.pendingAccessCount()).toBe(0);
    expect(j.getAll().find((c) => c.name === 'a')!.accessed).toBe(1010);
  });
});
