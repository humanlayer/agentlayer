# agentlayer-provider-openai-codex

OpenAI Codex provider for AgentLayer and the AI SDK. It talks to the ChatGPT Codex responses endpoint and supports ChatGPT OAuth/API-key auth through `@humanlayer/agentlayer-provider-auth`.

## Installation

```bash
bun add @humanlayer/agentlayer-provider-openai-codex @humanlayer/agentlayer-provider-auth
```

## Fast Mode

Codex CLI fast mode sends `service_tier: "priority"` in the request body. This provider exposes the same behavior with `fastMode: true`.

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
