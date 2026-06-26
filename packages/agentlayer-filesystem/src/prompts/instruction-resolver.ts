import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type InstructionFamily = 'agents' | 'claude'

export type InstructionTier =
	| 'user-global'
	| 'git-root-project'
	| 'git-root-project-local'
	| 'cwd-project'
	| 'cwd-project-local'

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

export type InstructionRule =
	| 'complete-agents-pair'
	| 'complete-claude-pair'
	| 'agents-base'
	| 'claude-base'
	| 'agents-local-only'
	| 'claude-local-only'
	| 'none'

export interface ResolutionLog {
	family?: InstructionFamily
	rule: InstructionRule
	global?: string
	rootProject?: string
	rootProjectLocal?: string
	cwdProject?: string
	cwdProjectLocal?: string
	skipped: Array<{ path: string; reason: 'empty' | 'other-family' }>
}

interface DirectorySelection {
	family?: InstructionFamily
	rule: InstructionRule
	sources: InstructionSource[]
	skipped: ResolutionLog['skipped']
}

const PROJECT_FILES = {
	agents: { base: 'AGENTS.md', local: 'AGENTS.local.md' },
	claude: { base: 'CLAUDE.md', local: 'CLAUDE.local.md' },
} as const

const GLOBAL_FILES = {
	agents: [join('.agents', 'AGENTS.md'), join('.codex', 'AGENTS.md')],
	claude: [join('.claude', 'CLAUDE.md')],
} as const

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

async function readCandidate(path: string): Promise<{ path: string; contents?: string; empty: boolean }> {
	try {
		await access(path, constants.F_OK)
		const contents = await readFile(path, 'utf8')
		return { path, contents: contents.trim() ? contents : undefined, empty: !contents.trim() }
	} catch {
		return { path, empty: false }
	}
}

async function selectProjectDirectory(cwd: string, scope: 'git-root' | 'cwd'): Promise<DirectorySelection> {
	const candidates = {
		agentsBase: await readCandidate(join(cwd, PROJECT_FILES.agents.base)),
		agentsLocal: await readCandidate(join(cwd, PROJECT_FILES.agents.local)),
		claudeBase: await readCandidate(join(cwd, PROJECT_FILES.claude.base)),
		claudeLocal: await readCandidate(join(cwd, PROJECT_FILES.claude.local)),
	}
	const allCandidates = [candidates.agentsBase, candidates.agentsLocal, candidates.claudeBase, candidates.claudeLocal]
	const skipped: ResolutionLog['skipped'] = allCandidates
		.filter((candidate) => candidate.empty)
		.map((candidate) => ({ path: candidate.path, reason: 'empty' as const }))

	let family: InstructionFamily | undefined
	let rule: InstructionRule = 'none'
	if (candidates.agentsBase.contents !== undefined && candidates.agentsLocal.contents !== undefined) {
		family = 'agents'
		rule = 'complete-agents-pair'
	} else if (candidates.claudeBase.contents !== undefined && candidates.claudeLocal.contents !== undefined) {
		family = 'claude'
		rule = 'complete-claude-pair'
	} else if (candidates.agentsBase.contents !== undefined) {
		family = 'agents'
		rule = 'agents-base'
	} else if (candidates.claudeBase.contents !== undefined) {
		family = 'claude'
		rule = 'claude-base'
	} else if (candidates.agentsLocal.contents !== undefined) {
		family = 'agents'
		rule = 'agents-local-only'
	} else if (candidates.claudeLocal.contents !== undefined) {
		family = 'claude'
		rule = 'claude-local-only'
	}

	if (!family) return { rule, sources: [], skipped }

	const selected = family === 'agents'
		? { base: candidates.agentsBase, local: candidates.agentsLocal }
		: { base: candidates.claudeBase, local: candidates.claudeLocal }
	const baseTier: InstructionTier = scope === 'git-root' ? 'git-root-project' : 'cwd-project'
	const localTier: InstructionTier = scope === 'git-root' ? 'git-root-project-local' : 'cwd-project-local'

	const unselected = family === 'agents' ? [candidates.claudeBase, candidates.claudeLocal] : [candidates.agentsBase, candidates.agentsLocal]
	skipped.push(
		...unselected
			.filter((candidate) => candidate.contents !== undefined)
			.map((candidate) => ({ path: candidate.path, reason: 'other-family' as const })),
	)

	return { family, rule, skipped, sources: [
		...(selected.base.contents !== undefined
			? [{ tier: baseTier, family, path: selected.base.path, contents: selected.base.contents }]
			: []),
		...(selected.local.contents !== undefined
			? [{ tier: localTier, family, path: selected.local.path, contents: selected.local.contents }]
			: []),
	] }
}

async function selectGlobal(preferredFamily?: InstructionFamily): Promise<{ source?: InstructionSource; skipped: ResolutionLog['skipped'] }> {
	const home = process.env.HOME ?? homedir()
	const candidates = preferredFamily === 'claude'
		? [
			{ family: 'claude' as const, path: join(home, GLOBAL_FILES.claude[0]) },
			{ family: 'agents' as const, path: join(home, GLOBAL_FILES.agents[0]) },
			{ family: 'agents' as const, path: join(home, GLOBAL_FILES.agents[1]) },
		]
		: [
			{ family: 'agents' as const, path: join(home, GLOBAL_FILES.agents[0]) },
			{ family: 'agents' as const, path: join(home, GLOBAL_FILES.agents[1]) },
			{ family: 'claude' as const, path: join(home, GLOBAL_FILES.claude[0]) },
		]
	const skipped: ResolutionLog['skipped'] = []

	for (const candidate of candidates) {
		const result = await readCandidate(candidate.path)
		if (result.contents !== undefined) {
			return { source: { tier: 'user-global', family: candidate.family, path: candidate.path, contents: result.contents }, skipped }
		}
		if (result.empty) skipped.push({ path: candidate.path, reason: 'empty' })
	}

	return { skipped }
}

export async function resolveInstructionSources(opts: { cwd: string }): Promise<InstructionResolution> {
	const repoRoot = await getRepoRoot(opts.cwd)
	const cwdRealPath = await realpath(opts.cwd).catch(() => opts.cwd)
	const rootSelection: DirectorySelection = repoRoot && repoRoot !== cwdRealPath
		? await selectProjectDirectory(repoRoot, 'git-root')
		: { rule: 'none', sources: [], skipped: [] }
	const cwdSelection = await selectProjectDirectory(opts.cwd, 'cwd')
	const global = await selectGlobal(cwdSelection.family ?? rootSelection.family)
	const sources = [...(global.source ? [global.source] : []), ...rootSelection.sources, ...cwdSelection.sources]

	return {
		sources,
		log: {
			family: cwdSelection.family ?? rootSelection.family ?? global.source?.family,
			rule: cwdSelection.rule !== 'none' ? cwdSelection.rule : (rootSelection.rule ?? 'none'),
			global: global.source?.path,
			rootProject: rootSelection.sources.find((source) => source.tier === 'git-root-project')?.path,
			rootProjectLocal: rootSelection.sources.find((source) => source.tier === 'git-root-project-local')?.path,
			cwdProject: cwdSelection.sources.find((source) => source.tier === 'cwd-project')?.path,
			cwdProjectLocal: cwdSelection.sources.find((source) => source.tier === 'cwd-project-local')?.path,
			skipped: [...global.skipped, ...rootSelection.skipped, ...cwdSelection.skipped],
		},
	}
}

function labelForTier(tier: InstructionTier): string {
	switch (tier) {
		case 'user-global':
			return 'User Global'
		case 'git-root-project':
			return 'Git Root Project'
		case 'git-root-project-local':
			return 'Git Root Project Local'
		case 'cwd-project':
			return 'Current Directory Project'
		case 'cwd-project-local':
			return 'Current Directory Project Local'
	}
}

export function renderInstructionSources(sources: InstructionSource[]): string | undefined {
	if (sources.length === 0) return undefined
	return sources
		.map((source) => [`# Repository Instructions: ${labelForTier(source.tier)}`, `Source: ${source.path}`, '', source.contents].join('\n'))
		.join('\n\n')
}
