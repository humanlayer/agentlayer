# Prompts

The prompts module provides tool descriptions, system prompt templates, and model-specific personas.

## Tool Descriptions

Pre-written descriptions for built-in tools:

```ts
import {
  BASH_DESCRIPTION,
  READ_DESCRIPTION,
  WRITE_DESCRIPTION,
  EDIT_DESCRIPTION,
  MULTI_EDIT_DESCRIPTION,
  APPLY_PATCH_DESCRIPTION,
  GLOB_DESCRIPTION,
  GREP_DESCRIPTION,
  LIST_DESCRIPTION,
  WEB_FETCH_DESCRIPTION,
  WEB_SEARCH_DESCRIPTION,
  CODE_SEARCH_DESCRIPTION,
  SKILL_DESCRIPTION,
  TODO_WRITE_DESCRIPTION,
  STRUCTURED_OUTPUT_DESCRIPTION,
  SUBAGENT_DESCRIPTION_TEMPLATE,
} from '@humanlayer/agentlayer-core/prompts'
```

These are used by tool implementations to provide consistent descriptions.

## System Prompt Generation

### getSystemPromptForModel()

Get the default system prompt for a model family:

```ts
import { getSystemPromptForModel } from '@humanlayer/agentlayer-core/prompts'

const prompt = getSystemPromptForModel('claude')
// Returns the Claude-optimized coding prompt
```

### resolveCodingModelPrompt()

Resolve a prompt key or custom string:

```ts
import { resolveCodingModelPrompt } from '@humanlayer/agentlayer-core/prompts'

// Use a preset
const prompt1 = resolveCodingModelPrompt('claude')

// Or a custom string
const prompt2 = resolveCodingModelPrompt('You are a helpful assistant.')
```

### createAgentSystemPrompt()

Build a complete system prompt with environment context:

```ts
import { createAgentSystemPrompt } from '@humanlayer/agentlayer-core/prompts'

const system = await createAgentSystemPrompt({
  cwd: '/project',
  model: 'claude',
  includeEnvironment: true,
  systemPromptAdditions: ['Additional context...']
})
```

## Model Personas

Pre-built system prompts optimized for different models:

```ts
import {
  claudePrompt,
  openaiPrompt,
  geminiPrompt,
  codexPrompt,
  defaultPrompt,
  tarsPersona,
} from '@humanlayer/agentlayer-core/prompts'

// Each returns a string
const claude = claudePrompt()
const openai = openaiPrompt()
```

### Available Personas

| Function | Model Family | Description |
|----------|-------------|-------------|
| `claudePrompt()` | Claude | Optimized for Anthropic Claude models |
| `openaiPrompt()` | GPT-4/o1 | Optimized for OpenAI models |
| `geminiPrompt()` | Gemini | Optimized for Google Gemini |
| `codexPrompt()` | Codex | Optimized for code generation |
| `defaultPrompt()` | Any | Generic coding assistant prompt |
| `tarsPersona()` | Any | TARS-style personality |

## Model Detection

### detectModelFamily()

Detect the model family from a model ID:

```ts
import { detectModelFamily } from '@humanlayer/agentlayer-core/prompts'

detectModelFamily('claude-sonnet-4-20250514')  // 'claude'
detectModelFamily('gpt-4o')                    // 'openai'
detectModelFamily('gemini-2.0-flash')          // 'gemini'
```

### CodingModelFamily

```ts
type CodingModelFamily = 'claude' | 'openai' | 'gemini' | 'codex' | 'default'
```

## Environment & Repo Prompts

### environmentPrompt()

Generate environment context:

```ts
import { environmentPrompt } from '@humanlayer/agentlayer-core/prompts'

const env = environmentPrompt({
  cwd: '/project',
  platform: 'darwin',
  date: new Date(),
  isGitRepo: true
})
// "Working directory: /project\nPlatform: darwin\n..."
```

### repoInstructionsPrompt()

Load repository instructions (CLAUDE.md, AGENTS.md):

```ts
import { repoInstructionsPrompt } from '@humanlayer/agentlayer-core/prompts'

const instructions = await repoInstructionsPrompt({
  cwd: '/project',
  candidates: ['CLAUDE.md', 'AGENTS.md', 'CONTEXT.md'],
  allowMissing: true
})
```

## Provider Options

### buildCodingProviderOptions()

Build provider-specific options:

```ts
import { buildCodingProviderOptions } from '@humanlayer/agentlayer-core/prompts'

const options = buildCodingProviderOptions({
  model: 'claude-sonnet-4-20250514',
  temperature: 0.7,
  maxTokens: 4096
})
```

## System Prompts Object

Access all prompts via the `systemPrompts` object:

```ts
import { systemPrompts } from '@humanlayer/agentlayer-core/prompts'

systemPrompts.claude    // claudePrompt()
systemPrompts.openai    // openaiPrompt()
systemPrompts.gemini    // geminiPrompt()
systemPrompts.codex     // codexPrompt()
systemPrompts.default   // defaultPrompt()
```

## Type Exports

```ts
import type {
  CodingModelFamily,
  CodingPromptKey,
  CreateAgentSystemPromptOptions,
  EnvironmentPromptOptions,
  RepoInstructionsPromptOptions,
} from '@humanlayer/agentlayer-core/prompts'
```
