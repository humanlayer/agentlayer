# agentlayer-provider-openai-codex

OpenAI Codex provider for AgentLayer and the AI SDK. It talks to the ChatGPT Codex responses endpoint and supports ChatGPT OAuth/API-key auth through `@humanlayer/agentlayer-provider-auth`.

## Installation

```bash
bun add @humanlayer/agentlayer-provider-openai-codex @humanlayer/agentlayer-provider-auth
```

## Providers

This package exports three provider implementations, each with different tradeoffs:

### 1. `createCodexProvider` — Full hand-rolled SSE

The original provider. Implements full SSE byte-stream parsing, event dispatch, and a 120-second per-chunk watchdog timer (`readWithTimeout`). Does not depend on `@ai-sdk/openai` for streaming.

```ts
import { createCodexProvider } from '@humanlayer/agentlayer-provider-openai-codex'

const codex = createCodexProvider({ /* auth options */ })
const model = codex.languageModel('codex-mini-latest')
```

**Pros:** Battle-tested, built-in 120s per-chunk watchdog, full control over SSE parsing.
**Cons:** Custom SSE parser must track upstream protocol changes manually.

### 2. `createCodexResponsesProvider` — Thin wrapper over @ai-sdk/openai

Delegates all SSE parsing to `@ai-sdk/openai`'s `responses()` implementation. Only handles auth, headers, URL rewriting, and request body cleanup. Includes a configurable per-chunk watchdog (`wrapSSE`) that wraps the response body stream.

```ts
import { createCodexResponsesProvider } from '@humanlayer/agentlayer-provider-openai-codex'

const codex = createCodexResponsesProvider({ /* auth options */ })
const model = codex.languageModel('codex-mini-latest')
```

**Pros:** Stays current with `@ai-sdk/openai` protocol changes automatically, configurable chunk timeout.
**Cons:** Depends on `@ai-sdk/openai`'s parsing behavior.

**Options:**

| Option | Default | Effect |
| --- | --- | --- |
| `chunkTimeout` | `120000` (2 min) | Per-chunk SSE timeout in ms. Set to `false` or `0` to disable. |

### 3. `createCodexEffectProvider` — Effect-based protocol parser (vendored from opencode)

Uses the OpenAI Responses protocol parser from [opencode](https://github.com/nichochar/opencode), vendored as an Effect-based state machine. Builds the request body directly, sends via the same codex auth layer, and parses SSE events through the opencode protocol's `step()` function. Includes the same configurable per-chunk watchdog.

```ts
import { createCodexEffectProvider } from '@humanlayer/agentlayer-provider-openai-codex'

const codex = createCodexEffectProvider({ /* auth options */ })
const model = codex.languageModel('codex-mini-latest')
```

**Pros:** Battle-tested protocol parser from opencode, handles edge cases in the OpenAI Responses stream format, Effect-based state machine for structured event parsing.
**Cons:** Adds `effect` as a dependency (~vendored from opencode, `@ts-nocheck` on vendored protocol file due to tsconfig differences).

**Options:**

| Option | Default | Effect |
| --- | --- | --- |
| `chunkTimeout` | `120000` (2 min) | Per-chunk SSE timeout in ms. Set to `false` or `0` to disable. |

## Common Options

All three providers accept the same base options:

```ts
interface CodexProviderOptions {
  authStore?: AuthStore       // Auth store for OAuth/API key management
  providerId?: string         // Provider ID in the auth store (default: 'codex')
  fetch?: CodexFetchLike      // Custom fetch implementation
  version?: string            // Codex CLI version to report in User-Agent
  sessionId?: string          // Session ID header
  now?: () => number          // Clock override for token expiry checks
  fastMode?: boolean          // Send service_tier: "priority"
  serviceTier?: string | null // Explicit service tier
}
```

## Fast Mode

Codex CLI fast mode sends `service_tier: "priority"` in the request body. All three providers expose the same behavior with `fastMode: true`.

```ts
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

You can also enable it per request through provider options:

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

If you need to set the tier explicitly, use `serviceTier`. The alias `"fast"` is normalized to Codex's API value `"priority"`.

```ts
await model.doStream({
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'Use the priority tier.' }] }],
  providerOptions: {
    codex: {
      serviceTier: 'fast', // sends service_tier: 'priority'
    },
  },
})
```

`serviceTier` takes precedence over `fastMode`, which lets callers opt into `"flex"` or clear the tier explicitly when needed.

## Provider Options

Both `openai` and `codex` provider option namespaces are accepted for request-level options.

| Option | Effect |
| --- | --- |
| `fastMode: true` | Sends `service_tier: "priority"` |
| `serviceTier: "fast"` | Sends `service_tier: "priority"` |
| `serviceTier: "priority"` | Sends `service_tier: "priority"` |
| `serviceTier: "flex"` | Sends `service_tier: "flex"` |
