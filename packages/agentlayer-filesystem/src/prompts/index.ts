import { execSync } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
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

const DEFAULT_REPO_INSTRUCTION_CANDIDATES = ['CLAUDE.md', 'AGENTS.md', 'CONTEXT.md']

function getRepoRoot(cwd: string): string | undefined {
	const originalCwd = process.cwd()
	try {
		process.chdir(cwd)
		return execSync('git rev-parse --show-toplevel', {
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim()
	} catch {
		process.chdir(originalCwd)
	}

	let current = resolve(cwd)
	while (true) {
		if (existsSync(resolve(current, '.git'))) {
			return current
		}
		const parent = dirname(current)
		if (parent === current) return undefined
		current = parent
	}
}

async function firstExistingCandidate(cwd: string, candidates: string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		const candidatePath = resolve(cwd, candidate)
		try {
			await access(candidatePath, constants.F_OK)
			return candidatePath
		} catch {}
	}

	return undefined
}

async function findRepoInstructions(
	startCwd: string,
	candidates: string[],
	skipRepoRootFallback: boolean,
): Promise<{ path: string; contents: string } | undefined> {
	const cwdPath = await firstExistingCandidate(startCwd, candidates)
	if (cwdPath) {
		const contents = await readFile(cwdPath, 'utf8')
		if (contents.trim()) {
			return { path: cwdPath, contents }
		}
	}

	if (!skipRepoRootFallback) {
		const repoRoot = getRepoRoot(startCwd)
		if (repoRoot && repoRoot !== startCwd) {
			const rootPath = await firstExistingCandidate(repoRoot, candidates)
			if (rootPath) {
				const contents = await readFile(rootPath, 'utf8')
				if (contents.trim()) {
					return { path: rootPath, contents }
				}
			}
		}
	}

	return undefined
}

function isGitRepo(cwd: string): boolean {
	return getRepoRoot(cwd) !== undefined
}

export interface EnvironmentPromptOptions extends Omit<CoreEnvironmentPromptOptions, 'isGitRepo'> {
	isGitRepo?: boolean
}

export function environmentPrompt(opts: EnvironmentPromptOptions): string {
	return createEnvironmentPrompt({
		cwd: opts.cwd,
		isGitRepo: opts.isGitRepo ?? isGitRepo(opts.cwd),
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

	const candidates = opts.candidates ?? DEFAULT_REPO_INSTRUCTION_CANDIDATES
	const found = await findRepoInstructions(opts.cwd, candidates, opts._skipRepoRootFallback ?? false)

	if (!found) {
		if (opts.allowMissing) return undefined
		const repoRoot = getRepoRoot(opts.cwd)
		const searched = repoRoot ? [`${opts.cwd} (cwd)`, `${repoRoot} (repo root)`] : [opts.cwd]
		throw new Error(`No repo instructions found. Searched for ${candidates.join(', ')} in: ${searched.join(', ')}`)
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
			: environmentPrompt({ cwd: opts.cwd, platform: opts.platform, date: opts.date })

	return createCoreAgentSystemPrompt({
		model: opts.model,
		repoInstructions,
		environment,
		systemPromptAdditions: opts.systemPromptAdditions,
	})
}
