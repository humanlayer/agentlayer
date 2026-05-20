import { isAbsolute, resolve } from 'node:path'
import type { AgentEvent } from '@humanlayer/agentlayer-core'
import {
	createSubagentsTool,
	createWebFetchTool,
	type PostToolUseHook,
	type PreRequestHook,
	type PreToolUseHook,
	type SubAgentConfig,
	type Tool,
} from '@humanlayer/agentlayer-core'
import type { ReadToolModalities, Skill } from '@humanlayer/agentlayer-core/interfaces'
import { createFileStateTrackingHook, createReadBeforeWriteHook, createWastedReadHook } from './hooks/file-state'
import {
	createBashOutputTruncationHook,
	createGlobOutputTruncationHook,
	createGrepOutputTruncationHook,
	createListOutputTruncationHook,
	createReadTruncationHook,
} from './hooks/output-truncation'
import { createApplyPatchTool } from './tools/apply-patch'
import { createBashTool } from './tools/bash'
import { createEditTool } from './tools/edit'
import { createGlobTool } from './tools/glob'
import { createGrepTool } from './tools/grep'
import { createListTool } from './tools/list'
import { createReadTool } from './tools/read'
import { createReadMultimodalTool } from './tools/read-multimodal'
import { createSkillToolFromDirs, createSkillToolFromRepoDirs, type SkillDirEntry } from './tools/skill'
import { createWebSearchTool } from './tools/web-search'
import { createWriteTool } from './tools/write'

export interface AgentOutputTruncationOptions {
	maxLines?: number
	maxBytes?: number
	maxLineWidth?: number
}

export interface CreateAgentFilesystemHooksOptions {
	cwd: string
	outputTruncation?: AgentOutputTruncationOptions
}

export function createAgentFilesystemHooks(opts: CreateAgentFilesystemHooksOptions): {
	preToolUse: readonly PreToolUseHook[]
	postToolUse: readonly PostToolUseHook[]
	preRequest: readonly PreRequestHook[]
} {
	const sharedOutputTruncation = opts.outputTruncation
		? {
				...(opts.outputTruncation.maxLines !== undefined ? { maxLines: opts.outputTruncation.maxLines } : {}),
				...(opts.outputTruncation.maxBytes !== undefined ? { maxBytes: opts.outputTruncation.maxBytes } : {}),
			}
		: undefined
	const readOutputTruncation = opts.outputTruncation
		? {
				...(opts.outputTruncation.maxLines !== undefined ? { maxLines: opts.outputTruncation.maxLines } : {}),
				...(opts.outputTruncation.maxBytes !== undefined ? { maxBytes: opts.outputTruncation.maxBytes } : {}),
				...(opts.outputTruncation.maxLineWidth !== undefined
					? { maxLineWidth: opts.outputTruncation.maxLineWidth }
					: {}),
			}
		: undefined

	return {
		preToolUse: [createWastedReadHook({ cwd: opts.cwd }), createReadBeforeWriteHook({ cwd: opts.cwd })],
		postToolUse: [
			createReadTruncationHook(readOutputTruncation),
			createBashOutputTruncationHook(sharedOutputTruncation),
			createGlobOutputTruncationHook(sharedOutputTruncation),
			createGrepOutputTruncationHook(sharedOutputTruncation),
			createListOutputTruncationHook(sharedOutputTruncation),
			createFileStateTrackingHook({ cwd: opts.cwd }),
		],
		preRequest: [],
	} as const
}

export interface CreateAgentFilesystemToolsetOptions {
	cwd: string
	readToolModalities?: ReadToolModalities
}

function createFilesystemReadTool(opts: CreateAgentFilesystemToolsetOptions) {
	return opts.readToolModalities
		? createReadMultimodalTool({ cwd: opts.cwd, readToolModalities: opts.readToolModalities })
		: createReadTool({ cwd: opts.cwd })
}

export function createClaudeAgentFilesystemToolset(opts: CreateAgentFilesystemToolsetOptions) {
	return {
		bash: createBashTool({ cwd: opts.cwd }),
		read: createFilesystemReadTool(opts),
		write: createWriteTool({ cwd: opts.cwd }),
		edit: createEditTool({ cwd: opts.cwd }),
		glob: createGlobTool({ cwd: opts.cwd }),
		grep: createGrepTool({ cwd: opts.cwd }),
		list: createListTool({ cwd: opts.cwd }),
	} as const
}

export function createCodexAgentFilesystemToolset(opts: CreateAgentFilesystemToolsetOptions) {
	return {
		bash: createBashTool({ cwd: opts.cwd }),
		read: createFilesystemReadTool(opts),
		apply_patch: createApplyPatchTool({ cwd: opts.cwd }),
		glob: createGlobTool({ cwd: opts.cwd }),
		grep: createGrepTool({ cwd: opts.cwd }),
		list: createListTool({ cwd: opts.cwd }),
	} as const
}

export interface CreateCodingAgentAuxToolsetOptions {
	cwd: string
	agentTool?: Tool<any, any>
	subagents?: SubAgentConfig[]
	skillTool?: Tool<any, any>
	skillDirs?: string | string[] | SkillDirEntry[]
	skills?: Skill[]
	allowMissingSkills?: boolean
	exaApiKey?: string
	context7ApiKey?: string
	webSearchTool?: Tool<any, any>
	webFetchTool?: Tool<any, any>
	additionalTools?: Record<string, Tool<any, any>>
	onChildEvent?: (event: AgentEvent) => void
}

function resolveSkillDirPath(path: string, cwd: string): string {
	if (path === '~' || path.startsWith('~/') || isAbsolute(path)) {
		return path
	}
	return resolve(cwd, path)
}

function resolveSkillDirsInput(dirs: string | string[] | SkillDirEntry[], cwd: string): SkillDirEntry[] {
	const entries = Array.isArray(dirs) ? dirs : [dirs]
	return entries.map((entry) =>
		typeof entry === 'string'
			? { path: resolveSkillDirPath(entry, cwd) }
			: { ...entry, path: resolveSkillDirPath(entry.path, cwd) },
	)
}

async function resolveSkillTool(opts: CreateCodingAgentAuxToolsetOptions): Promise<Tool<any, any>> {
	if (opts.skillTool) {
		return opts.skillTool
	}

	if (opts.skillDirs) {
		return createSkillToolFromDirs({
			dirs: resolveSkillDirsInput(opts.skillDirs, opts.cwd),
			skills: opts.skills,
		})
	}

	return createSkillToolFromRepoDirs({
		cwd: opts.cwd,
		skills: opts.skills,
		allowMissing: opts.allowMissingSkills ?? true,
	})
}

export async function createCodingAgentAuxToolset(opts: CreateCodingAgentAuxToolsetOptions) {
	const skillTool = await resolveSkillTool(opts)
	const agentTool =
		opts.agentTool ??
		(opts.subagents ? createSubagentsTool({ agents: opts.subagents, onChildEvent: opts.onChildEvent }) : undefined)
	const webSearchTool =
		opts.webSearchTool ?? (opts.exaApiKey ? createWebSearchTool({ exaApiKey: opts.exaApiKey }) : undefined)

	return {
		...(agentTool ? { agent: agentTool } : {}),
		skill: skillTool,
		web_fetch: opts.webFetchTool ?? createWebFetchTool(),
		...(webSearchTool ? { web_search: webSearchTool } : {}),
		...(opts.additionalTools ?? {}),
	} as const
}

export interface CreateCodingAgentToolsetOptions extends CreateCodingAgentAuxToolsetOptions {
	readToolModalities?: ReadToolModalities
}

export async function createClaudeCodingAgentToolset(opts: CreateCodingAgentToolsetOptions) {
	return {
		...createClaudeAgentFilesystemToolset({ cwd: opts.cwd, readToolModalities: opts.readToolModalities }),
		...(await createCodingAgentAuxToolset(opts)),
	} as const
}

export async function createCodexCodingAgentToolset(opts: CreateCodingAgentToolsetOptions) {
	return {
		...createCodexAgentFilesystemToolset({ cwd: opts.cwd, readToolModalities: opts.readToolModalities }),
		...(await createCodingAgentAuxToolset(opts)),
	} as const
}
