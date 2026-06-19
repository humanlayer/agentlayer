import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

function execCommand(command: string, args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
		let stdout = ''
		proc.stdout.on('data', (data: Buffer) => {
			stdout += data.toString()
		})
		proc.on('close', (code) => {
			if (code === 0) resolve(stdout)
			else reject(new Error(`Command failed with code ${code}`))
		})
		proc.on('error', reject)
	})
}

import {
	type CodingPromptKey,
	type EnvironmentPromptOptions as CoreEnvironmentPromptOptions,
	createAgentSystemPrompt as createCoreAgentSystemPrompt,
	environmentPrompt as createEnvironmentPrompt,
	repoInstructionsPrompt as createRepoInstructionsPrompt,
} from '@humanlayer/agentlayer-core/prompts'
import type { LanguageModel } from 'ai'

export {
	buildCodingProviderOptions,
	type CodingModelFamily,
	type CodingPromptKey,
	detectModelFamily,
	getSystemPromptForModel,
	resolveCodingModelPrompt,
	systemPrompts,
	tarsPersona,
} from '@humanlayer/agentlayer-core/prompts'

// Each group is mutually exclusive with the groups after it: load all matching
// files from the first group that exists, then stop (AGENTS beats CLAUDE).
const REPO_INSTRUCTION_PRIORITY_GROUPS: string[][] = [
	['AGENTS.md', 'AGENTS.local.md'],
	['CLAUDE.md', 'CLAUDE.local.md'],
	['CONTEXT.md'],
]

const DEFAULT_REPO_INSTRUCTION_CANDIDATES = REPO_INSTRUCTION_PRIORITY_GROUPS.flat()

interface RepoInstructionsFile {
	path: string
	contents: string
}

/**
 * Keeps the built-in priority-group ordering, but removes built-in file names
 * that the caller did not request.
 *
 * Example: ['CLAUDE.local.md'] becomes [[], ['CLAUDE.local.md'], []].
 * Example: ['AGENTS.md', 'CLAUDE.md'] becomes [['AGENTS.md'], ['CLAUDE.md'], []].
 */
function filterBuiltInPriorityGroupsToRequestedFileNames(requestedInstructionFileNames: string[]): string[][] {
	const requestedFileNames = new Set(requestedInstructionFileNames)

	return REPO_INSTRUCTION_PRIORITY_GROUPS.map((group) =>
		group.filter((fileName) => requestedFileNames.has(fileName)),
	)
}

/**
 * Turns caller-provided custom file names into single-file priority groups
 * after the built-in AGENTS/CLAUDE/CONTEXT groups.
 *
 * Example: ['README.md'] becomes [['README.md']].
 * Example: ['AGENTS.md', 'PROJECT.md'] ignores AGENTS.md and becomes [['PROJECT.md']].
 */
function wrapCustomFileNamesInPriorityGroups(requestedInstructionFileNames: string[]): string[][] {
	const builtInCandidates = new Set(REPO_INSTRUCTION_PRIORITY_GROUPS.flat())

	return requestedInstructionFileNames
		.filter((fileName) => !builtInCandidates.has(fileName))
		.map((fileName) => [fileName])
}

function instructionPriorityGroupsFor(requestedInstructionFileNames: string[]): string[][] {
	const requestedBuiltInGroups = filterBuiltInPriorityGroupsToRequestedFileNames(requestedInstructionFileNames)
	const customCandidateGroups = wrapCustomFileNamesInPriorityGroups(requestedInstructionFileNames)

	return [...requestedBuiltInGroups, ...customCandidateGroups].filter((group) => group.length > 0)
}

async function getRepoRoot(cwd: string): Promise<string | undefined> {
	try {
		const stdout = await execCommand('git', ['rev-parse', '--show-toplevel'], cwd)
		return stdout.trim()
	} catch {
		return undefined
	}
}

async function readExistingInstructionFiles(cwd: string, group: string[]): Promise<RepoInstructionsFile[]> {
	const discoveredFiles: RepoInstructionsFile[] = []

	for (const fileName of group) {
		const filePath = resolve(cwd, fileName)
		try {
			await access(filePath, constants.F_OK)
			const contents = await readFile(filePath, 'utf8')
			if (contents.trim()) {
				discoveredFiles.push({ path: filePath, contents })
			}
		} catch {}
	}

	return discoveredFiles
}

async function firstInstructionGroup(cwd: string, priorityGroups: string[][]): Promise<RepoInstructionsFile | undefined> {
	for (const group of priorityGroups) {
		const instructions = combineRepoInstructionFiles(await readExistingInstructionFiles(cwd, group))
		if (instructions) return instructions
	}
}

function combineRepoInstructionFiles(files: RepoInstructionsFile[]): RepoInstructionsFile | undefined {
	if (files.length === 0) return undefined
	if (files.length === 1) return files[0]

	return {
		path: files.map((file) => file.path).join(', '),
		contents: files.map((file) => [`## ${file.path}`, '', file.contents.trimEnd()].join('\n')).join('\n\n'),
	}
}

async function findRepoInstructions(
	startCwd: string,
	priorityGroups: string[][],
	skipRepoRootFallback: boolean,
): Promise<RepoInstructionsFile | undefined> {
	const cwdInstructions = await firstInstructionGroup(startCwd, priorityGroups)
	if (cwdInstructions) return cwdInstructions

	if (!skipRepoRootFallback) {
		const repoRoot = await getRepoRoot(startCwd)
		if (repoRoot && repoRoot !== startCwd) {
			return firstInstructionGroup(repoRoot, priorityGroups)
		}
	}

	return undefined
}

async function isGitRepo(cwd: string): Promise<boolean> {
	return (await getRepoRoot(cwd)) !== undefined
}

export interface EnvironmentPromptOptions extends Omit<CoreEnvironmentPromptOptions, 'isGitRepo'> {
	isGitRepo?: boolean
}

export async function environmentPrompt(opts: EnvironmentPromptOptions): Promise<string> {
	return createEnvironmentPrompt({
		cwd: opts.cwd,
		isGitRepo: opts.isGitRepo ?? (await isGitRepo(opts.cwd)),
		platform: opts.platform,
		date: opts.date,
	})
}

export interface RepoInstructionsPromptOptions {
	cwd: string
	filePath?: string
	candidates?: string[]
	allowMissing?: boolean
	_skipRepoRootFallback?: boolean
}

export async function repoInstructionsPrompt(opts: RepoInstructionsPromptOptions): Promise<string | undefined> {
	if (opts.filePath) {
		const candidatePath = isAbsolute(opts.filePath) ? opts.filePath : resolve(opts.cwd, opts.filePath)
		const contents = await readFile(candidatePath, 'utf8')
		if (!contents.trim()) {
			if (opts.allowMissing) return undefined
			throw new Error(`Repo instructions file is empty: ${candidatePath}`)
		}
		return createRepoInstructionsPrompt({ path: candidatePath, contents })
	}

	const requestedInstructionFileNames = opts.candidates ?? DEFAULT_REPO_INSTRUCTION_CANDIDATES
	const priorityGroups = instructionPriorityGroupsFor(requestedInstructionFileNames)
	const found = await findRepoInstructions(opts.cwd, priorityGroups, opts._skipRepoRootFallback ?? false)

	if (!found) {
		if (opts.allowMissing) return undefined
		const repoRoot = await getRepoRoot(opts.cwd)
		const searched = repoRoot ? [`${opts.cwd} (cwd)`, `${repoRoot} (repo root)`] : [opts.cwd]
		throw new Error(`No repo instructions found. Searched for ${requestedInstructionFileNames.join(', ')} in: ${searched.join(', ')}`)
	}

	return createRepoInstructionsPrompt(found)
}

export interface CreateAgentSystemPromptOptions {
	cwd: string
	model: LanguageModel | string | CodingPromptKey
	filePath?: string
	candidates?: string[]
	allowMissingRepoInstructions?: boolean
	includeEnvironment?: boolean
	platform?: string
	date?: Date
	systemPromptAdditions?: string[]
}

export async function createAgentSystemPrompt(opts: CreateAgentSystemPromptOptions): Promise<string[]> {
	const repoInstructions = await repoInstructionsPrompt({
		cwd: opts.cwd,
		filePath: opts.filePath,
		candidates: opts.candidates,
		allowMissing: opts.allowMissingRepoInstructions ?? true,
	})
	const environment =
		opts.includeEnvironment === false
			? undefined
			: await environmentPrompt({ cwd: opts.cwd, platform: opts.platform, date: opts.date })

	return createCoreAgentSystemPrompt({
		model: opts.model,
		repoInstructions,
		environment,
		systemPromptAdditions: opts.systemPromptAdditions,
	})
}
