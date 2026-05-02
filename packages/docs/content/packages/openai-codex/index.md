# agentlayer-provider-openai-codex

The OpenAI Codex provider lets AgentLayer use ChatGPT Codex models through the AI SDK provider interface.

## Installation

```bash
bun add @humanlayer/agentlayer-provider-openai-codex @humanlayer/agentlayer-provider-auth
```

## Fast Mode

Codex CLI fast mode sets `service_tier: "priority"` on the Codex request. AgentLayer exposes the same behavior with `fastMode: true`.

```ts
import { createCodexProvider } from '@humanlayer/agentlayer-provider-openai-codex'
import { createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'

const codex = createCodexProvider({
  authStore: createMemoryAuthStore({
    codex: {
      kind: 'oauth',
      accessToken: process.env.CODEX_ACCESS_TOKEN!,
      accountId: process.env.CHATGPT_ACCOUNT_ID,
    },
  }),
  fastMode: true,
})

const model = codex.languageModel('gpt-5.4')
```

You can also enable fast mode for one request:

```ts
await model.doStream({
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'Ship this quickly.' }] }],
  providerOptions: {
    codex: {
      fastMode: true,
    },
  },
})
```

## Service Tier

Use `serviceTier` when you want to pass a specific tier. The convenience alias `"fast"` is normalized to Codex's API value `"priority"`.

```ts
await model.doStream({
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'Use priority service.' }] }],
  providerOptions: {
    codex: {
      serviceTier: 'fast',
    },
  },
})
```

Supported values:

| Option | Request body |
| --- | --- |
| `fastMode: true` | `service_tier: "priority"` |
| `serviceTier: "fast"` | `service_tier: "priority"` |
| `serviceTier: "priority"` | `service_tier: "priority"` |
| `serviceTier: "flex"` | `service_tier: "flex"` |

`serviceTier` takes precedence over `fastMode`. Request-level provider options take precedence over provider defaults.

## Auth Store OAuth Fields

When using the auth store with `createCodexProvider`, you can store OAuth tokens using either canonical field names or aliases:

| Field | Aliases | Description |
|-------|---------|-------------|
| `accessToken` | `access` | The OAuth access token (required) |
| `refreshToken` | `refresh` | Refresh token for token rotation |
| `expiresAt` | `expires` | Unix timestamp when the token expires |
| `idToken` | — | OpenID Connect ID token |
| `scope` | — | Granted scopes |
| `tokenType` | — | Token type (e.g., `Bearer`) |

Example with aliases:

```ts
import { createCodexProvider } from '@humanlayer/agentlayer-provider-openai-codex'
import { ensureFileAuthStore } from '@humanlayer/agentlayer-provider-auth'

const authStore = await ensureFileAuthStore()
await authStore.set('codex', {
  kind: 'oauth',
  access: 'your-access-token',
  refresh: 'your-refresh-token',
  expires: 1234567890,
})

const codex = createCodexProvider({ authStore, fastMode: true })
const model = codex.languageModel('gpt-5.4')
```
