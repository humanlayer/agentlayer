import { execSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const DEFAULT_REPO_INSTRUCTION_CANDIDATES = ['CLAUDE.md', 'AGENTS.md', 'CONTEXT.md']

async function getRepoRoot(): Promise<string | undefined> {
	try {
		return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim()
	} catch {
		return undefined
	}
}

async function firstExistingCandidate(cwd: string, candidates: string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		const candidatePath = join(cwd, candidate)
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
	// Check cwd first
	const cwdPath = await firstExistingCandidate(startCwd, candidates)
	if (cwdPath) {
		const contents = await readFile(cwdPath, 'utf8')
		if (contents.trim()) {
			return { path: cwdPath, contents }
		}
	}

	// Fall back to git root
	if (!skipRepoRootFallback) {
		const repoRoot = await getRepoRoot()
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

export interface RepoInstructionsPromptOptions {
	cwd?: string
	filePath?: string
	candidates?: string[]
	allowMissing?: boolean
	_skipRepoRootFallback?: boolean
}

export async function repoInstructionsPrompt(opts: RepoInstructionsPromptOptions = {}): Promise<string | undefined> {
	const cwd = opts.cwd ?? process.cwd()

	// Explicit filePath takes precedence
	if (opts.filePath) {
		const candidatePath = isAbsolute(opts.filePath) ? opts.filePath : resolve(cwd, opts.filePath)
		const contents = await readFile(candidatePath, 'utf8')
		if (!contents.trim()) {
			if (opts.allowMissing) return undefined
			throw new Error(`Repo instructions file is empty: ${candidatePath}`)
		}
		return [
			`# Repository Instructions`,
			`Use the following repository-specific instructions from ${candidatePath}.`,
			'',
			contents,
		].join('\n')
	}

	// Search cwd then repo root
	const candidates = opts.candidates ?? DEFAULT_REPO_INSTRUCTION_CANDIDATES
	const found = await findRepoInstructions(cwd, candidates, opts._skipRepoRootFallback ?? false)

	if (!found) {
		if (opts.allowMissing) return undefined
		const repoRoot = await getRepoRoot()
		const searched = repoRoot ? [`${cwd} (cwd)`, `${repoRoot} (repo root)`] : [cwd]
		throw new Error(`No repo instructions found. Searched for ${candidates.join(', ')} in: ${searched.join(', ')}`)
	}

	return [
		`# Repository Instructions`,
		`Use the following repository-specific instructions from ${found.path}.`,
		'',
		found.contents,
	].join('\n')
}
