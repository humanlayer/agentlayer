# @humanlayer/agentlayer-provider-auth

Storage and normalization for provider credentials (OAuth tokens and API keys) used by AgentLayer's model providers. It defines a small `AuthStore` interface with an in-memory implementation for tests and a file-backed implementation that persists to `~/.local/share/agentlayer/auth.json` (or `$XDG_DATA_HOME`), with automatic import from AgentSDK's and OpenCode's auth files so existing logins keep working.

## Install

```sh
bun add @humanlayer/agentlayer-provider-auth
```

## Usage

```ts
import { ensureFileAuthStore, requireAuth, type AuthInfo } from '@humanlayer/agentlayer-provider-auth'

// Creates the store, importing from the Agent SDK auth file on first use if
// the AgentLayer auth file doesn't exist yet.
const authStore = await ensureFileAuthStore()

await authStore.set('copilot', { kind: 'api', apiKey: 'sk-...' })

const auth = await authStore.get('codex') // AuthInfo | undefined
const apiAuth = await requireAuth(authStore, 'copilot', 'api') // throws if missing/wrong kind
```

For tests, use `createMemoryAuthStore(initialAuth?)` instead — same `AuthStore` interface, nothing touches disk.

## Key exports

- `AuthStore` — interface with `get`/`set`/`delete`/`getAll`, all async; `get`/`getAll` return deep clones of stored data, and `set` stores a deep clone of its input, so callers can't mutate stored state.
- `AuthInfo` — discriminated union: `OAuthAuthInfo` (`kind: 'oauth'`, `accessToken`, optional `refreshToken`/`expiresAt`/`idToken`/`scope`/`tokenType`/`accountId`/`enterpriseUrl`) or `ApiAuthInfo` (`kind: 'api'`, `apiKey`, optional `metadata`).
- `createMemoryAuthStore(initialAuth?)` — in-memory `AuthStore`.
- `createFileAuthStore(options?)` — file-backed `AuthStore`. `options.filePath` defaults to `getDefaultAgentLayerAuthPath()`.
- `ensureFileAuthStore(options?)` — like `createFileAuthStore`, but first seeds the AgentLayer auth file from the Agent SDK auth file (`getDefaultAgentSdkAuthPath()`) if the AgentLayer file doesn't exist yet. Use this at startup.
- `readAuth` / `writeAuth` / `removeAuth` / `readAllAuth` — one-shot convenience wrappers around `createFileAuthStore(options).get/set/delete/getAll`.
- `requireAuth(store, providerId, expectedKind?)` — fetches auth or throws; with `expectedKind` it also narrows the return type and throws on a `kind` mismatch.
- `normalizeProviderId(providerId)` — trims trailing slashes and maps known aliases/subpaths (`openai`, `openai.codex`, `codex.*` → `codex`; `github-copilot` → `copilot`; `github-copilot-enterprise` → `copilot-enterprise`) to their canonical id; unrecognized ids pass through unchanged. Returns `string` (not `CanonicalAuthProviderId`). All store methods normalize the id internally.
- `getDefaultAgentLayerAuthPath()` / `getDefaultAgentSdkAuthPath()` / `getDefaultOpenCodeAuthPath()` — resolve default file locations, each overridable via `AGENTLAYER_AUTH_PATH`, `AGENT_SDK_AUTH_PATH`, `OPENCODE_AUTH_PATH`.

## Notes

- File stores are written with mode `0o600`.
- Pass `openCodeAuthFilePath` (or set `enableOpenCodeFallback: true`) to have `get`/`getAll` fall back to and import entries from an OpenCode `auth.json`, translating its `type`/`access`/`refresh`/`expires`/`key` fields into `AuthInfo`. Imported entries are written back to the AgentLayer file but never overwrite existing entries.
- Consumers: `@humanlayer/agentlayer-provider-openai-codex`, `@humanlayer/agentlayer-provider-github-copilot`, and `agents/codelayer` all read credentials through this package (see `agents/codelayer/src/providers.ts`).
