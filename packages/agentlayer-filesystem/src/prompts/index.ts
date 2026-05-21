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

const DEFAULT_REPO_INSTRUCTION_CANDIDATES = ['CLAUDE.md', 'AGENTS.md', 'CONTEXT.md']

async function getRepoRoot(cwd: string): Promise<string | undefined> {
	try {
		const stdout = await execCommand('git', ['rev-parse', '--show-toplevel'], cwd)
		return stdout.trim()
	} catch {
		return undefined
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
		const repoRoot = await getRepoRoot(startCwd)
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

	const candidates = opts.candidates ?? DEFAULT_REPO_INSTRUCTION_CANDIDATES
	const found = await findRepoInstructions(opts.cwd, candidates, opts._skipRepoRootFallback ?? false)

	if (!found) {
		if (opts.allowMissing) return undefined
		const repoRoot = await getRepoRoot(opts.cwd)
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
			: await environmentPrompt({ cwd: opts.cwd, platform: opts.platform, date: opts.date })

	return createCoreAgentSystemPrompt({
		model: opts.model,
		repoInstructions,
		environment,
		systemPromptAdditions: opts.systemPromptAdditions,
	})
}
