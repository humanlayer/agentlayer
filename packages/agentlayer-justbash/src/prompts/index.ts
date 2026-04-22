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

const DEFAULT_REPO_INSTRUCTION_CANDIDATES = ['CLAUDE.md', 'AGENTS.md', 'CONTEXT.md']

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

async function firstExistingCandidate(bash: Bash, cwd: string, candidates: string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		const filePath = `${cwd}/${candidate}`
		const contents = await readFileIfExists(bash, filePath)
		if (contents !== undefined) return filePath
	}

	return undefined
}

async function findRepoInstructions(
	bash: Bash,
	startCwd: string,
	candidates: string[],
	skipRepoRootFallback: boolean,
): Promise<{ path: string; contents: string } | undefined> {
	const cwdPath = await firstExistingCandidate(bash, startCwd, candidates)
	if (cwdPath) {
		const contents = await readFileIfExists(bash, cwdPath)
		if (contents?.trim()) {
			return { path: cwdPath, contents }
		}
	}

	if (!skipRepoRootFallback) {
		const repoRoot = await getRepoRoot(bash, startCwd)
		if (repoRoot && repoRoot !== startCwd) {
			const rootPath = await firstExistingCandidate(bash, repoRoot, candidates)
			if (rootPath) {
				const contents = await readFileIfExists(bash, rootPath)
				if (contents?.trim()) {
					return { path: rootPath, contents }
				}
			}
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

	const candidates = opts.candidates ?? DEFAULT_REPO_INSTRUCTION_CANDIDATES
	const found = await findRepoInstructions(bash, opts.cwd, candidates, opts._skipRepoRootFallback ?? false)

	if (!found) {
		if (opts.allowMissing) return undefined
		const repoRoot = await getRepoRoot(bash, opts.cwd)
		const searched = repoRoot ? [`${opts.cwd} (cwd)`, `${repoRoot} (repo root)`] : [opts.cwd]
		throw new Error(`No repo instructions found. Searched for ${candidates.join(', ')} in: ${searched.join(', ')}`)
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
