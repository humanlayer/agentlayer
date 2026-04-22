# AgentLayer

AgentLayer is HumanLayer's toolkit for building coding agents. It is a Bun monorepo with the following packages:

## Monorepo Map 

### Packages under `packages/`
- `agentlayer-core` - contains the core agent loop, core tool interfaces separated from their executors/implementations, platform-independent isomorphic tools, prompts, and hooks.
- `agentlayer-filesystem` - contains implementations of core tool interfaces based on the filesystem - e.g. read/write/edit/apply_patch based on the core's interfaces
- `agentlayer-justbash` - contains implementations of core tool interfaces using Vercel's `just-bash` (https://github.com/vercel-labs/just-bash)
- `docs` - agent SDK documentation based on vite press
- `yjs-fs` - a Y.js CRDT-based filesystem designed for agents.

### Agents under `agents/`
(Assorted - look if you need to see; not listed here as they are still in progress).

## Key Commands
Run tests with bun: `bun run test`

Run typecheck with `tsgo`: `bun run typecheck`

Run it for a single package: `bun run --cwd packages/... typecheck`

Run biome formatter (only can be run for the whole repo at once): `bun run biome`

We use `bun:test`. When in doubt, read the [docs](https://bun.com/docs/test)

## Open Source Contribution Workflow

- `CONTRIBUTING.md` is the source of truth for contributor policy.
- External issues are allowed from anyone except denounced users.
- External pull requests require a vouch; point contributors to http://humanlayer.com/discord to request one.
- Keep `.github/pull_request_template.md`, `.github/VOUCHED.td`, and the Vouch workflows aligned with `CONTRIBUTING.md` whenever contributor-facing policy changes.
