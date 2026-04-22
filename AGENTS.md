# AgentLayer

AgentLayer is HumanLayer's toolkit for building coding agents. It is a Bun monorepo with the following packages:

## Monorepo Map of `packages/`
- `agentlayer-core` - contains the core agent loop, core tool interfaces separated from their executors/implementations, platform-independent isomorphic tools, prompts, and hooks.
- `agentlayer-filesystem` - contains implementations of core tool interfaces based on the filesystem - e.g. read/write/edit/apply_patch based on the core's interfaces
- `agentlayer-justbash` - contains implementations of core tool interfaces using Vercel's `just-bash` (https://github.com/vercel-labs/just-bash)
- `docs` - agent SDK documentation based on vite press
- `yjs-fs` - a Y.js CRDT-based filesystem designed for agents.

## Key Commands
Run tests with bun: `bun run test`

Run typecheck with `tsgo`: `bun run typecheck`

Run it for a single package: `bun run --cwd packages/... typecheck`

Run biome formatter (only can be run for the whole repo at once): `bun run biome`
