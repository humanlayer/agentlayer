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
}

interface DirectorySelection {
	family?: InstructionFamily
	sources: InstructionSource[]
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

async function readExistingFile(path: string): Promise<string | undefined> {
	try {
		await access(path, constants.F_OK)
		return await readFile(path, 'utf8')
	} catch {
		return undefined
	}
}

async function selectProjectDirectory(cwd: string, scope: 'git-root' | 'cwd'): Promise<DirectorySelection> {
	const candidates = {
		agentsBase: { path: join(cwd, PROJECT_FILES.agents.base), contents: await readExistingFile(join(cwd, PROJECT_FILES.agents.base)) },
		agentsLocal: {
			path: join(cwd, PROJECT_FILES.agents.local),
			contents: await readExistingFile(join(cwd, PROJECT_FILES.agents.local)),
		},
		claudeBase: { path: join(cwd, PROJECT_FILES.claude.base), contents: await readExistingFile(join(cwd, PROJECT_FILES.claude.base)) },
		claudeLocal: {
			path: join(cwd, PROJECT_FILES.claude.local),
			contents: await readExistingFile(join(cwd, PROJECT_FILES.claude.local)),
		},
	}

	let family: InstructionFamily | undefined
	if (candidates.agentsBase.contents !== undefined && candidates.agentsLocal.contents !== undefined) family = 'agents'
	else if (candidates.claudeBase.contents !== undefined && candidates.claudeLocal.contents !== undefined) family = 'claude'
	else if (candidates.agentsBase.contents !== undefined) family = 'agents'
	else if (candidates.claudeBase.contents !== undefined) family = 'claude'
	else if (candidates.agentsLocal.contents !== undefined) family = 'agents'
	else if (candidates.claudeLocal.contents !== undefined) family = 'claude'

	if (!family) return { sources: [] }

	const selected = family === 'agents'
		? { base: candidates.agentsBase, local: candidates.agentsLocal }
		: { base: candidates.claudeBase, local: candidates.claudeLocal }
	const baseTier: InstructionTier = scope === 'git-root' ? 'git-root-project' : 'cwd-project'
	const localTier: InstructionTier = scope === 'git-root' ? 'git-root-project-local' : 'cwd-project-local'

	return { family, sources: [
		...(selected.base.contents !== undefined
			? [{ tier: baseTier, family, path: selected.base.path, contents: selected.base.contents }]
			: []),
		...(selected.local.contents !== undefined
			? [{ tier: localTier, family, path: selected.local.path, contents: selected.local.contents }]
			: []),
	] }
}

async function selectGlobal(preferredFamily?: InstructionFamily): Promise<InstructionSource | undefined> {
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

	for (const candidate of candidates) {
		const contents = await readExistingFile(candidate.path)
		if (contents !== undefined) return { tier: 'user-global', family: candidate.family, path: candidate.path, contents }
	}

	return undefined
}

export async function resolveInstructionSources(opts: { cwd: string }): Promise<InstructionResolution> {
	const repoRoot = await getRepoRoot(opts.cwd)
	const cwdRealPath = await realpath(opts.cwd).catch(() => opts.cwd)
	const rootSelection = repoRoot && repoRoot !== cwdRealPath ? await selectProjectDirectory(repoRoot, 'git-root') : { sources: [] }
	const cwdSelection = await selectProjectDirectory(opts.cwd, 'cwd')
	const global = await selectGlobal(cwdSelection.family ?? rootSelection.family)

	return { sources: [...(global ? [global] : []), ...rootSelection.sources, ...cwdSelection.sources] }
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
