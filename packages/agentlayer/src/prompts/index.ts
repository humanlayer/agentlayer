export { claudePrompt } from './claude'
export { codexPrompt } from './codex'
export { defaultPrompt } from './default'
export { type EnvironmentPromptOptions, environmentPrompt } from './environment'
export { geminiPrompt } from './gemini'
export { openaiPrompt } from './openai'
export { orchestratorPrompt } from './orchestrator'
export { type RepoInstructionsPromptOptions, repoInstructionsPrompt } from './repo-instructions'
export { structuredOutputPrompt } from './structured-output'
export { tarsPersona } from './TARS'
export { todoWritePrompt } from './todo'

import { claudePrompt } from './claude'
import { codexPrompt } from './codex'
import { defaultPrompt } from './default'
import { geminiPrompt } from './gemini'
import { openaiPrompt } from './openai'

export const systemPrompts = {
	default: defaultPrompt,
	claude: claudePrompt,
	codex: codexPrompt,
	gemini: geminiPrompt,
	openai: openaiPrompt,
} as const
