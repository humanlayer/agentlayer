# yjs-fs-agents

Placeholder package. `src/index.ts` currently only contains `export {}` — there is no agent implementation here yet. This document exists so the directory isn't undocumented; update it once real code lands.

## Current state

```json
// package.json
{
  "name": "@humanlayer/yjs-fs-agents",
  "private": true,
  "exports": { ".": { "bun": "./src/index.ts", "source": "./src/index.ts", "default": "./src/index.ts" } }
}
```

- No `dependencies` are declared.
- `devDependencies` hint at the intended stack: `@humanlayer/agentlayer-core`, `@humanlayer/yjs-fs`, `@ai-sdk/anthropic`, `@ai-sdk/provider`, `ai`, `zod`.
- The only script is `typecheck` (`tsgo --noEmit`); there's no `dev`/`start`/`build`/`test` script, and no `test/` directory.
- Listed as an `internalPackage` (non-publishable) in `scripts/release/manifest.ts`, alongside `agents/docs-agent`. No other package or workflow in the repo imports from it.

## What it's presumably meant to become

Given the name and dev-dependency list, this package is scaffolded to host one or more agents that read/write a `YjsFilesystem` (from `@humanlayer/yjs-fs`) via `agentlayer-core`'s `Agent`/tool interfaces, backed by an Anthropic model through the `ai` SDK. That combination is already implemented and runnable elsewhere in the repo — see:

- `examples/yjs-fs-agent/src/run.ts` — a working CLI (`bun run --cwd examples/yjs-fs-agent dev`) that wires `Agent` + `YjsFilesystem` + Yjs-backed tools (`createYjsFsReadTool`, `createYjsFsWriteTool`, `createYjsFsEditTool`, etc.) together, with `--mode justbash|secure-exec` variants for bash execution.
- `packages/agentlayer-yjs-fs`, `packages/agentlayer-yjs-fs-justbash`, `packages/agentlayer-yjs-fs-secure-exec` — the actual tool/hook adapters between `yjs-fs` and `agentlayer-core`, which this package does not yet depend on.
- `packages/yjs-fs/README.md` — describes the underlying CRDT filesystem (`YjsFilesystem`) this package's `devDependencies` point at.

## Verify before building

Before adding code here, check whether `examples/yjs-fs-agent` (or a newer package) already covers the intended use case — this directory may be an abandoned or not-yet-started scaffold rather than a gap that needs filling.
