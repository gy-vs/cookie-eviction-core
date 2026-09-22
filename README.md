# HTTP Cookie Jar

带**每域配额**与**全局配额**、确定性 LRU 驱逐、批量访问时间与乐观并发控制的 TypeScript cookie 存储库。

运行 `npm install`，然后 `npm test`（测试）和 `npm run build`（构建）。

## 配额与驱逐

- 配额按 `name + value` 的 UTF-8 字节核算（`cookieSize`）。
- 单个 cookie 超过 `maxCookieSize`，或本身就超过任一层配额时：**直接拒绝，不触发任何驱逐**（`status: 'rejected'`）。
- 超限时先做**每域**裁剪、再做**全局**裁剪，只删除满足配额所必需的最少项。
- 驱逐顺序（升序，越靠前越先被驱逐）：
  1. `priority`：`low → medium → high`
  2. 同优先级下 `__Secure-` / `__Host-` 受保护前缀更靠后
  3. `expires`：更早过期的先走；会话 cookie 视为最晚
  4. **最近访问**：久未读的先走（取持久值与未落盘水位的较大者）
  5. `created`：更早创建的先走
  6. `domain → path → name` 字典序兜底，保证结果完全确定

  > 受保护前缀与高 `priority` **只影响排序，绝不构成删除豁免**；压力足够时一样被驱逐。
- 已过期 cookie 在读取时不可见，并在下一次写入时按同一确定性顺序批量清除。
- 提交成功后**严格**满足两层配额；防御性地，任何规划后仍超限的批次都不会提交。

## 访问水位（避免每次读取都落盘）

读取（`get`）是同步的，只抬高进程内的访问水位 `key -> max(时间)`，**不产生持久写**。

- `flushAccessTimes()` 把累积水位合并为**一批** `touch` 提交。
- 驱逐时排序使用 `max(持久 accessed, 未刷新水位)`，因此刚读过但尚未 flush 的 cookie 不会被误删；幸存者的水位也会随驱逐批次一并落盘。
- flush 期间的并发写导致 CAS 失败时，水位会合并回内存、重读快照后重试，时间戳单调不倒退。

## 并发控制（revision）

存储接口只暴露 `snapshot()` 与原子 `commit(batch)`：

- 每个批次携带 `baseRevision`（全局 CAS）。
- 删除/touch 还携带目标项当前的 `itemRevision`。
- 任一层版本过期都会整批失败（`RevisionMismatchError`），`set`/`flushAccessTimes` 内部重读快照并基于新版本重新规划，从而**不会用过期快照驱逐或覆盖刚被其它进程更新的项**。

`MemoryCookieStore.dump()` / `MemoryCookieStore.load()` 可把状态序列化到磁盘并在进程重启后恢复（revision、itemRevision、访问时间与配额占用一并保留）。

## 快速示例

```ts
import { CookieJar, MemoryCookieStore } from './dist/index.js';

const store = new MemoryCookieStore();
const jar = new CookieJar({ store, domainQuota: 4096, globalQuota: 16384 });

await jar.set({ name: 'sid', value: '...', domain: 'example.com', path: '/', secure: true, created: Date.now(), priority: 'high' });
jar.get('example.com', '/', true);        // 只读，不落盘
await jar.flushAccessTimes();             // 批量提交访问时间

const persisted = JSON.stringify(store.dump());   // 进程退出前
const restored = MemoryCookieStore.load(JSON.parse(persisted)); // 重启后
```
