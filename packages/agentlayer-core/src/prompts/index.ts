import APPLY_PATCH_DESCRIPTION from './apply-patch.txt'
import BASH_DESCRIPTION from './bash.txt'
import CODE_SEARCH_DESCRIPTION from './code-search.txt'
import {
	buildCodingProviderOptions,
	type CodingModelFamily,
	type CodingPromptKey,
	type CreateAgentSystemPromptOptions,
	createAgentSystemPrompt,
	detectModelFamily,
	getSystemPromptForModel,
	resolveCodingModelPrompt,
	systemPrompts,
} from './coding'
import EDIT_DESCRIPTION from './edit.txt'
import { type EnvironmentPromptOptions, environmentPrompt } from './environment'
import GLOB_DESCRIPTION from './glob.txt'
import GREP_DESCRIPTION from './grep.txt'
import HASH_READ_DESCRIPTION from './hash-read.txt'
import HASHLINE_EDIT_DESCRIPTION from './hashline-edit.txt'
import LIST_DESCRIPTION from './list.txt'
import MULTI_EDIT_DESCRIPTION from './multiedit.txt'
import { claudePrompt, codexPrompt, defaultPrompt, geminiPrompt, openaiPrompt, tarsPersona } from './providers'
import READ_DESCRIPTION from './read.txt'
import { type RepoInstructionsPromptOptions, repoInstructionsPrompt } from './repo-instructions'
import SKILL_DESCRIPTION from './skill.txt'
import STRUCTURED_OUTPUT_DESCRIPTION from './structured-output.txt'
import SUBAGENT_DESCRIPTION_TEMPLATE from './subagent.txt'
import TODO_WRITE_DESCRIPTION from './todo-write.txt'
import WEB_FETCH_DESCRIPTION from './web-fetch.txt'
import WEB_SEARCH_DESCRIPTION from './web-search.txt'
import WRITE_DESCRIPTION from './write.txt'

export {
	APPLY_PATCH_DESCRIPTION,
	BASH_DESCRIPTION,
	buildCodingProviderOptions,
	claudePrompt,
	CODE_SEARCH_DESCRIPTION,
	codexPrompt,
	createAgentSystemPrompt,
	defaultPrompt,
	detectModelFamily,
	EDIT_DESCRIPTION,
	environmentPrompt,
	GLOB_DESCRIPTION,
	geminiPrompt,
	getSystemPromptForModel,
	GREP_DESCRIPTION,
	HASH_READ_DESCRIPTION,
	HASHLINE_EDIT_DESCRIPTION,
	LIST_DESCRIPTION,
	MULTI_EDIT_DESCRIPTION,
	openaiPrompt,
	READ_DESCRIPTION,
	repoInstructionsPrompt,
	resolveCodingModelPrompt,
	SKILL_DESCRIPTION,
	STRUCTURED_OUTPUT_DESCRIPTION,
	SUBAGENT_DESCRIPTION_TEMPLATE,
	systemPrompts,
	tarsPersona,
	TODO_WRITE_DESCRIPTION,
	WEB_FETCH_DESCRIPTION,
	WEB_SEARCH_DESCRIPTION,
	WRITE_DESCRIPTION,
	type CodingModelFamily,
	type CodingPromptKey,
	type CreateAgentSystemPromptOptions,
	type EnvironmentPromptOptions,
	type RepoInstructionsPromptOptions,
}
