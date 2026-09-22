# HTTP Cookie Jar

TypeScript library for cookie storage with quotas and deterministic eviction.

Run `npm install`, then `npm test` and `npm run build`.

## Features

- **Per-domain and global quotas** (`perDomainQuota`, `globalQuota`) plus a
  per-cookie size cap (`maxCookieBytes`, UTF-8 bytes of `name=value`).
- **Deterministic eviction order** — lower priority first, then earlier expiry
  (session cookies last), then least recently used, then oldest creation, then
  canonical `(domain, path, name)` key as the final tie-break.
- **Protected prefixes** (`__Host-`, `__Secure-`) and explicit `priority`
  only influence the sort; they never make a cookie un-evictable.
- **Batched access times**: reads update an in-memory watermark only (no
  per-read storage writes). `flush()` (or reaching `flushThreshold`) commits
  them in one batch; eviction merges persisted `lastAccess` with the unflushed
  watermark, so recently read cookies survive even before a flush.
- **Revision (compare-and-swap) commits**: concurrent writers reload and
  rebuild stale plans, so a freshly updated cookie cannot be evicted by a
  racing stale plan. Quotas strictly hold in every committed snapshot.
- **Process recovery**: state is a versioned snapshot (`CookieDocument`) in a
  pluggable `CookieStore`; expired leftovers are healed on the next commit.

## Usage

```ts
import { CookieJar, MemoryCookieStore } from './dist/index.js';

const jar = await CookieJar.open({
  store: new MemoryCookieStore(),
  perDomainQuota: 50,
  globalQuota: 3000,
  maxCookieBytes: 4096,
  flushThreshold: 32,
});

const res = await jar.set({
  name: 'sid', value: 'abc', domain: 'example.com', path: '/', secure: true,
  priority: 'high', expires: Date.now() + 3600_000,
});
// res: { stored, oversize, expired[], evicted[], accessesFlushed, rev }

await jar.get('example.com', '/'); // access recorded in memory
await jar.flush();                 // batch-persist access times
```
