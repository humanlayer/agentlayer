import { resolve } from 'node:path'
import {
	type CodingPromptKey,
	type EnvironmentPromptOptions as CoreEnvironmentPromptOptions,
	createAgentSystemPrompt as createCoreAgentSystemPrompt,
	environmentPrompt as createEnvironmentPrompt,
	repoInstructionsPrompt as createRepoInstructionsPrompt,
} from '@humanlayer/agentlayer-core/prompts'
import type { Bash } from 'just-bash'

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
 * Example: ['AGENTS.md', 'TEAM.md'] ignores AGENTS.md and becomes [['TEAM.md']].
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

async function getRepoRoot(bash: Bash, cwd: string): Promise<string | undefined> {
	const result = await bash.exec(`git -C "${cwd}" rev-parse --show-toplevel 2>/dev/null`)
	if (result.exitCode !== 0) return undefined
	const root = result.stdout.trim()
	return root.length > 0 ? root : undefined
}

async function readFileIfExists(bash: Bash, filePath: string): Promise<string | undefined> {
	const result = await bash.exec(`cat "${filePath}" 2>/dev/null`)
	if (result.exitCode !== 0) return undefined
	return result.stdout
}

async function readExistingInstructionFiles(bash: Bash, cwd: string, group: string[]): Promise<RepoInstructionsFile[]> {
	const discoveredFiles: RepoInstructionsFile[] = []

	for (const fileName of group) {
		const filePath = `${cwd}/${fileName}`
		const contents = await readFileIfExists(bash, filePath)
		if (contents?.trim()) {
			discoveredFiles.push({ path: filePath, contents })
		}
	}

	return discoveredFiles
}

async function firstInstructionGroup(
	bash: Bash,
	cwd: string,
	priorityGroups: string[][],
): Promise<RepoInstructionsFile | undefined> {
	for (const group of priorityGroups) {
		const instructions = combineRepoInstructionFiles(await readExistingInstructionFiles(bash, cwd, group))
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
	bash: Bash,
	startCwd: string,
	priorityGroups: string[][],
	skipRepoRootFallback: boolean,
): Promise<RepoInstructionsFile | undefined> {
	const cwdInstructions = await firstInstructionGroup(bash, startCwd, priorityGroups)
	if (cwdInstructions) return cwdInstructions

	if (!skipRepoRootFallback) {
		const repoRoot = await getRepoRoot(bash, startCwd)
		if (repoRoot && repoRoot !== startCwd) {
			return firstInstructionGroup(bash, repoRoot, priorityGroups)
		}
	}

	return undefined
}

export interface EnvironmentPromptOptions extends Omit<CoreEnvironmentPromptOptions, 'isGitRepo'> {
	isGitRepo?: boolean
}

export async function environmentPrompt(bash: Bash, opts: EnvironmentPromptOptions): Promise<string> {
	const isGitRepo = opts.isGitRepo ?? (await getRepoRoot(bash, opts.cwd)) !== undefined
	return createEnvironmentPrompt({
		cwd: opts.cwd,
		isGitRepo,
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

export async function repoInstructionsPrompt(
	bash: Bash,
	opts: RepoInstructionsPromptOptions,
): Promise<string | undefined> {
	if (opts.filePath) {
		const filePath = opts.filePath.startsWith('/') ? opts.filePath : resolve(opts.cwd, opts.filePath)
		const contents = await readFileIfExists(bash, filePath)
		if (!contents?.trim()) {
			if (opts.allowMissing) return undefined
			throw new Error(`Repo instructions file is empty: ${filePath}`)
		}
		return createRepoInstructionsPrompt({ path: filePath, contents })
	}

	const requestedInstructionFileNames = opts.candidates ?? DEFAULT_REPO_INSTRUCTION_CANDIDATES
	const priorityGroups = instructionPriorityGroupsFor(requestedInstructionFileNames)
	const found = await findRepoInstructions(bash, opts.cwd, priorityGroups, opts._skipRepoRootFallback ?? false)

	if (!found) {
		if (opts.allowMissing) return undefined
		const repoRoot = await getRepoRoot(bash, opts.cwd)
		const searched = repoRoot ? [`${opts.cwd} (cwd)`, `${repoRoot} (repo root)`] : [opts.cwd]
		throw new Error(`No repo instructions found. Searched for ${requestedInstructionFileNames.join(', ')} in: ${searched.join(', ')}`)
	}

	return createRepoInstructionsPrompt(found)
}

export interface CreateAgentSystemPromptOptions {
	bash: Bash
	cwd: string
	model: CodingPromptKey | string
	filePath?: string
	candidates?: string[]
	allowMissingRepoInstructions?: boolean
	includeEnvironment?: boolean
	platform?: string
	date?: Date
	systemPromptAdditions?: string[]
}

export async function createAgentSystemPrompt(opts: CreateAgentSystemPromptOptions): Promise<string[]> {
	const repoInstructions = await repoInstructionsPrompt(opts.bash, {
		cwd: opts.cwd,
		filePath: opts.filePath,
		candidates: opts.candidates,
		allowMissing: opts.allowMissingRepoInstructions ?? true,
	})
	const environment =
		opts.includeEnvironment === false
			? undefined
			: await environmentPrompt(opts.bash, {
					cwd: opts.cwd,
					platform: opts.platform,
					date: opts.date,
				})

	return createCoreAgentSystemPrompt({
		model: opts.model,
		repoInstructions,
		environment,
		systemPromptAdditions: opts.systemPromptAdditions,
	})
}
