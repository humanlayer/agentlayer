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

Resolve a prompt from a model family key, model ID, or LanguageModel object:

```ts
import { resolveCodingModelPrompt } from '@humanlayer/agentlayer-core/prompts'

// Use a preset key
const prompt1 = resolveCodingModelPrompt('claude')

// Pass a model ID - will detect the model family
const prompt2 = resolveCodingModelPrompt('gpt-4o')  // Returns OpenAI prompt

// Pass a LanguageModel object
const prompt3 = resolveCodingModelPrompt(myLanguageModel)
```

Note: Non-key strings are passed to `detectModelFamily()` to determine the appropriate prompt. Custom arbitrary strings are not returned directly.

### createAgentSystemPrompt()

Build a complete system prompt with environment context. Returns an array of prompt strings (synchronous):

```ts
import { createAgentSystemPrompt } from '@humanlayer/agentlayer-core/prompts'

const systemParts: string[] = createAgentSystemPrompt({
  model: 'claude',
  repoInstructions: 'Instructions from CLAUDE.md...',
  environment: '# Environment\n- Working directory: /project\n...',
  systemPromptAdditions: ['Additional context...']
})
```

#### CreateAgentSystemPromptOptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | `LanguageModel \| string \| CodingPromptKey` | Yes | Model to resolve prompt for |
| `repoInstructions` | `string` | No | Pre-formatted repo instructions string |
| `environment` | `string` | No | Pre-formatted environment context string |
| `systemPromptAdditions` | `string[]` | No | Additional prompt sections to append |

## Model Personas

Pre-built system prompt strings optimized for different models:

```ts
import {
  claudePrompt,
  openaiPrompt,
  geminiPrompt,
  codexPrompt,
  defaultPrompt,
  tarsPersona,
} from '@humanlayer/agentlayer-core/prompts'

// These are string constants, not functions
console.log(claudePrompt)  // "You are CodeLayer, the best coding agent..."
console.log(openaiPrompt)  // OpenAI-optimized prompt string
```

### Available Prompts

| Constant | Model Family | Description |
|----------|-------------|-------------|
| `claudePrompt` | Claude | Optimized for Anthropic Claude models |
| `openaiPrompt` | GPT-4/o1 | Optimized for OpenAI models |
| `geminiPrompt` | Gemini | Optimized for Google Gemini |
| `codexPrompt` | Codex | Optimized for code generation |
| `defaultPrompt` | Any | Generic coding assistant prompt |
| `tarsPersona` | Any | TARS-style personality |

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
// Excludes 'default' - only the specific model families
type CodingModelFamily = 'claude' | 'openai' | 'gemini' | 'codex'
```

### CodingPromptKey

```ts
// Includes 'default' as a valid key for systemPrompts
type CodingPromptKey = 'claude' | 'openai' | 'gemini' | 'codex' | 'default'
```

## Environment & Repo Prompts

### environmentPrompt()

Generate environment context:

```ts
import { environmentPrompt } from '@humanlayer/agentlayer-core/prompts'

const env = environmentPrompt({
  cwd: '/project',       // Required
  isGitRepo: true,       // Required
  platform: 'darwin',    // Optional, defaults to process.platform
  date: new Date()       // Optional, defaults to current date
})
// "# Environment\n- Working directory: /project\n- Is git repo: yes\n..."
```

#### EnvironmentPromptOptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | `string` | Yes | Working directory path |
| `isGitRepo` | `boolean` | Yes | Whether the directory is a git repository |
| `platform` | `string` | No | Platform identifier (defaults to `process.platform`) |
| `date` | `Date` | No | Date for context (defaults to current date) |

### repoInstructionsPrompt()

Format repository instructions with a header. This is a synchronous function that takes pre-read file contents:

```ts
import { repoInstructionsPrompt } from '@humanlayer/agentlayer-core/prompts'

// Read the file contents first, then format
const contents = await fs.readFile('/project/CLAUDE.md', 'utf-8')

const instructions = repoInstructionsPrompt({
  path: '/project/CLAUDE.md',
  contents: contents
})
// "# Repository Instructions\nUse the following repository-specific instructions from /project/CLAUDE.md.\n\n..."
```

#### RepoInstructionsPromptOptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | Yes | Path to the instructions file (for display in prompt) |
| `contents` | `string` | Yes | Pre-read file contents |

## Provider Options

### buildCodingProviderOptions()

Build provider-specific options based on the model. Takes a single model parameter:

```ts
import { buildCodingProviderOptions } from '@humanlayer/agentlayer-core/prompts'

const options = buildCodingProviderOptions('claude-sonnet-4-20250514')
// Returns: {
//   anthropic: { thinking: {...}, cacheControl: { type: 'ephemeral' } },
//   openai: { store: false, reasoningEffort: 'medium', ... }
// }

// Also accepts a LanguageModel object
const options2 = buildCodingProviderOptions(myLanguageModel)
```

The function returns an object with provider-specific options including:
- `anthropic`: Thinking mode configuration and cache control
- `openai`: Reasoning effort settings and storage options

## System Prompts Object

Access all prompts via the `systemPrompts` object. Values are the prompt strings themselves:

```ts
import { systemPrompts } from '@humanlayer/agentlayer-core/prompts'

systemPrompts.claude    // The claudePrompt string
systemPrompts.openai    // The openaiPrompt string
systemPrompts.gemini    // The geminiPrompt string
systemPrompts.codex     // The codexPrompt string
systemPrompts.default   // The defaultPrompt string

// Example usage
const prompt = systemPrompts['claude']  // Returns the prompt string directly
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
