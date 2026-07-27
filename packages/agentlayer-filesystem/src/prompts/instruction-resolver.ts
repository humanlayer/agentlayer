import { spawn } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type InstructionFamily = 'agents' | 'claude'

export type InstructionTier = 'user-global' | 'git-root-project' | 'cwd-project'

export interface InstructionSource {
	tier: InstructionTier
	family: InstructionFamily
	path: string
	contents: string
}

export interface InstructionResolution {
	sources: InstructionSource[]
	log: ResolutionLog
}

export interface ResolutionLog {
	global?: string
	rootProject?: string
	cwdProject?: string
	skipped: Array<{ path: string; reason: 'empty' }>
}

interface Candidate {
	family: InstructionFamily
	path: string
}

interface Selection {
	source?: InstructionSource
	skipped: ResolutionLog['skipped']
}

const PROJECT_FILES = [
	{ family: 'agents', name: 'AGENTS.md' },
	{ family: 'claude', name: 'CLAUDE.md' },
] as const

const USER_FILES = [
	{ family: 'agents', path: join('.codex', 'AGENTS.md') },
	{ family: 'agents', path: join('.agents', 'AGENTS.md') },
	{ family: 'claude', path: join('.claude', 'CLAUDE.md') },
] as const

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

async function getRepoRoot(cwd: string): Promise<string | undefined> {
	try {
		const stdout = await execCommand('git', ['rev-parse', '--show-toplevel'], cwd)
		return await realpath(stdout.trim())
	} catch {
		return undefined
	}
}

async function selectFirstNonEmpty(candidates: Candidate[], tier: InstructionTier): Promise<Selection> {
	const skipped: ResolutionLog['skipped'] = []

	for (const candidate of candidates) {
		try {
			const contents = await readFile(candidate.path, 'utf8')
			if (!contents.trim()) {
				skipped.push({ path: candidate.path, reason: 'empty' })
				continue
			}

			return {
				source: { tier, family: candidate.family, path: candidate.path, contents },
				skipped,
			}
		} catch {}
	}

	return { skipped }
}

async function selectProjectDirectory(cwd: string, tier: 'git-root-project' | 'cwd-project'): Promise<Selection> {
	return selectFirstNonEmpty(
		PROJECT_FILES.map((candidate) => ({ family: candidate.family, path: join(cwd, candidate.name) })),
		tier,
	)
}

async function selectGlobal(home = process.env.HOME ?? homedir()): Promise<Selection> {
	return selectFirstNonEmpty(
		USER_FILES.map((candidate) => ({ family: candidate.family, path: join(home, candidate.path) })),
		'user-global',
	)
}

export async function resolveInstructionSources(opts: { cwd: string; home?: string }): Promise<InstructionResolution> {
	const repoRoot = await getRepoRoot(opts.cwd)
	const cwdRealPath = await realpath(opts.cwd).catch(() => opts.cwd)
	const global = await selectGlobal(opts.home)
	const root =
		repoRoot && repoRoot !== cwdRealPath
			? await selectProjectDirectory(repoRoot, 'git-root-project')
			: { skipped: [] }
	const cwd = await selectProjectDirectory(opts.cwd, 'cwd-project')
	const sources = [global.source, root.source, cwd.source].filter(
		(source): source is InstructionSource => source !== undefined,
	)

	return {
		sources,
		log: {
			global: global.source?.path,
			rootProject: root.source?.path,
			cwdProject: cwd.source?.path,
			skipped: [...global.skipped, ...root.skipped, ...cwd.skipped],
		},
	}
}

function labelForTier(tier: InstructionTier): string {
	switch (tier) {
		case 'user-global':
			return 'User Global'
		case 'git-root-project':
			return 'Git Root Project'
		case 'cwd-project':
			return 'Current Directory Project'
	}
}

export function renderInstructionSources(sources: InstructionSource[]): string | undefined {
	if (sources.length === 0) return undefined
	return sources
		.map((source) =>
			[
				`# Repository Instructions: ${labelForTier(source.tier)}`,
				`Source: ${source.path}`,
				'',
				source.contents,
			].join('\n'),
		)
		.join('\n\n')
}
