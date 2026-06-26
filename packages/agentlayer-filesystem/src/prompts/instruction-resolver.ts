import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
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

const PROJECT_FILES = {
	agents: { base: 'AGENTS.md', local: 'AGENTS.local.md' },
	claude: { base: 'CLAUDE.md', local: 'CLAUDE.local.md' },
} as const

async function readExistingFile(path: string): Promise<string | undefined> {
	try {
		await access(path, constants.F_OK)
		return await readFile(path, 'utf8')
	} catch {
		return undefined
	}
}

async function selectProjectDirectory(cwd: string): Promise<InstructionSource[]> {
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

	if (!family) return []

	const selected = family === 'agents'
		? { base: candidates.agentsBase, local: candidates.agentsLocal }
		: { base: candidates.claudeBase, local: candidates.claudeLocal }

	return [
		...(selected.base.contents !== undefined
			? [{ tier: 'cwd-project' as const, family, path: selected.base.path, contents: selected.base.contents }]
			: []),
		...(selected.local.contents !== undefined
			? [{ tier: 'cwd-project-local' as const, family, path: selected.local.path, contents: selected.local.contents }]
			: []),
	]
}

export async function resolveInstructionSources(opts: { cwd: string }): Promise<InstructionResolution> {
	return { sources: await selectProjectDirectory(opts.cwd) }
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
