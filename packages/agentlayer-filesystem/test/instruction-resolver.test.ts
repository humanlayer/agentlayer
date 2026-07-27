import { describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { renderInstructionSources, resolveInstructionSources } from '../src/prompts/instruction-resolver'

const execFileAsync = promisify(execFile)

type FixturePaths = { home: string; repo: string; cwd: string }

async function withTemporaryRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
	const createdRoot = await mkdtemp(join(tmpdir(), 'agentlayer-instructions-'))
	const root = await realpath(createdRoot)
	try {
		return await run(root)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

async function write(path: string, contents: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, contents)
}

async function createNonGitFixture(root: string): Promise<FixturePaths> {
	const paths = { home: join(root, 'home'), repo: join(root, 'unused-repo'), cwd: join(root, 'cwd') }
	await mkdir(paths.cwd, { recursive: true })
	return paths
}

async function createNestedGitFixture(root: string): Promise<FixturePaths> {
	const paths = { home: join(root, 'home'), repo: join(root, 'repo'), cwd: join(root, 'repo', 'nested') }
	await mkdir(paths.cwd, { recursive: true })
	await execFileAsync('git', ['init'], { cwd: paths.repo })
	return paths
}

async function resolveUserInstructions(files: { codex?: string; agents?: string; claude?: string }) {
	return withTemporaryRoot(async (root) => {
		const { home, cwd } = await createNonGitFixture(root)
		if (files.codex !== undefined) await write(join(home, '.codex', 'AGENTS.md'), files.codex)
		if (files.agents !== undefined) await write(join(home, '.agents', 'AGENTS.md'), files.agents)
		if (files.claude !== undefined) await write(join(home, '.claude', 'CLAUDE.md'), files.claude)
		const resolution = await resolveInstructionSources({ cwd, home })
		const source = resolution.sources.find((candidate) => candidate.tier === 'user-global')
		return source && { ...source, path: source.path.replace(home, '<home>') }
	})
}

async function resolveProjectInstructionsAtRootAndCwd(files: { agents?: string; claude?: string }) {
	return withTemporaryRoot(async (root) => {
		const paths = await createNestedGitFixture(root)
		for (const directory of [paths.repo, paths.cwd]) {
			if (files.agents !== undefined) await writeFile(join(directory, 'AGENTS.md'), files.agents)
			if (files.claude !== undefined) await writeFile(join(directory, 'CLAUDE.md'), files.claude)
		}
		const resolution = await resolveInstructionSources({ cwd: paths.cwd, home: paths.home })
		return resolution.sources
			.filter((source) => source.tier !== 'user-global')
			.map((source) => ({
				...source,
				path: source.path.replace(paths.cwd, '<cwd>').replace(paths.repo, '<repo>'),
			}))
	})
}

async function resolveInstructionsWhenUserRootAndCwdContainMixedInstructionFamilies() {
	return withTemporaryRoot(async (root) => {
		const paths = await createNestedGitFixture(root)
		const ambientHome = join(root, 'ambient-home')
		await write(join(paths.home, '.codex', 'AGENTS.md'), 'USER_CODEX_WINNER')
		await write(join(paths.home, '.agents', 'AGENTS.md'), 'USER_AGENTS_LOSER')
		await write(join(paths.home, '.claude', 'CLAUDE.md'), 'USER_CLAUDE_LOSER')
		await write(join(ambientHome, '.codex', 'AGENTS.md'), 'AMBIENT_HOME_LOSER')
		await writeFile(join(paths.repo, 'AGENTS.md'), ' \n')
		await writeFile(join(paths.repo, 'CLAUDE.md'), 'ROOT_CLAUDE_WINNER')
		await writeFile(join(paths.repo, 'AGENTS.local.md'), 'ROOT_AGENTS_LOCAL_LOSER')
		await writeFile(join(paths.repo, 'CLAUDE.local.md'), 'ROOT_CLAUDE_LOCAL_LOSER')
		await writeFile(join(paths.repo, 'CONTEXT.md'), 'ROOT_CONTEXT_LOSER')
		await writeFile(join(paths.cwd, 'AGENTS.md'), 'CWD_AGENTS_WINNER')
		await writeFile(join(paths.cwd, 'CLAUDE.md'), 'CWD_CLAUDE_LOSER')
		await writeFile(join(paths.cwd, 'AGENTS.local.md'), 'CWD_AGENTS_LOCAL_LOSER')
		await writeFile(join(paths.cwd, 'CLAUDE.local.md'), 'CWD_CLAUDE_LOCAL_LOSER')
		await writeFile(join(paths.cwd, 'CONTEXT.md'), 'CWD_CONTEXT_LOSER')
		const previousHome = process.env.HOME
		process.env.HOME = ambientHome
		try {
			const resolution = await resolveInstructionSources({ cwd: paths.cwd, home: paths.home })
			const rendered = renderInstructionSources(resolution.sources) ?? ''
			const normalize = (value: string) =>
				value.replace(paths.home, '<home>').replace(paths.cwd, '<cwd>').replace(paths.repo, '<repo>')
			return {
				sources: resolution.sources.map((source) => ({ ...source, path: normalize(source.path) })),
				log: {
					global: resolution.log.global && normalize(resolution.log.global),
					rootProject: resolution.log.rootProject && normalize(resolution.log.rootProject),
					cwdProject: resolution.log.cwdProject && normalize(resolution.log.cwdProject),
					skipped: resolution.log.skipped.map((entry) => ({ ...entry, path: normalize(entry.path) })),
				},
				rendered: normalize(rendered),
				excludedMarkersPresent: [
					'USER_AGENTS_LOSER',
					'USER_CLAUDE_LOSER',
					'AMBIENT_HOME_LOSER',
					'ROOT_AGENTS_LOCAL_LOSER',
					'ROOT_CLAUDE_LOCAL_LOSER',
					'ROOT_CONTEXT_LOSER',
					'CWD_CLAUDE_LOSER',
					'CWD_AGENTS_LOCAL_LOSER',
					'CWD_CLAUDE_LOCAL_LOSER',
					'CWD_CONTEXT_LOSER',
				].filter((marker) => rendered.includes(marker)),
			}
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
		}
	})
}

async function resolveInstructionsOutsideGitRepository() {
	return withTemporaryRoot(async (root) => {
		const { home, cwd } = await createNonGitFixture(root)
		await writeFile(join(cwd, 'CLAUDE.md'), 'NON_GIT_CWD')
		const resolution = await resolveInstructionSources({ cwd, home })
		return resolution.sources.map((source) => ({ ...source, path: source.path.replace(cwd, '<cwd>') }))
	})
}

async function resolveInstructionsWhenCwdIsGitRoot() {
	return withTemporaryRoot(async (root) => {
		const paths = await createNestedGitFixture(root)
		await writeFile(join(paths.repo, 'AGENTS.md'), 'ROOT_EQUALS_CWD')
		const resolution = await resolveInstructionSources({ cwd: paths.repo, home: paths.home })
		return {
			sources: resolution.sources.map((source) => ({
				...source,
				path: source.path.replace(paths.repo, '<cwd>'),
			})),
			rootProject: resolution.log.rootProject,
		}
	})
}

describe('instruction resolver', () => {
	test('when all user instruction files exist, the Codex AGENTS file takes exact precedence', async () => {
		const userSource = await resolveUserInstructions({
			codex: 'codex winner',
			agents: 'agents loser',
			claude: 'claude loser',
		})
		expect(userSource).toEqual({
			tier: 'user-global',
			family: 'agents',
			path: '<home>/.codex/AGENTS.md',
			contents: 'codex winner',
		})
	})

	test('when the Codex user file is missing, the Agents user file takes precedence over Claude', async () => {
		const userSource = await resolveUserInstructions({ agents: 'agents winner', claude: 'claude loser' })
		expect(userSource).toEqual({
			tier: 'user-global',
			family: 'agents',
			path: '<home>/.agents/AGENTS.md',
			contents: 'agents winner',
		})
	})

	test('when the Codex user file is whitespace, the Agents user file takes precedence over Claude', async () => {
		const userSource = await resolveUserInstructions({
			codex: ' \n\t',
			agents: 'agents winner',
			claude: 'claude loser',
		})
		expect(userSource).toEqual({
			tier: 'user-global',
			family: 'agents',
			path: '<home>/.agents/AGENTS.md',
			contents: 'agents winner',
		})
	})

	test('when the Codex and Agents user files are missing, the Claude user file is selected', async () => {
		const userSource = await resolveUserInstructions({ claude: 'claude winner' })
		expect(userSource).toEqual({
			tier: 'user-global',
			family: 'claude',
			path: '<home>/.claude/CLAUDE.md',
			contents: 'claude winner',
		})
	})

	test('when the Codex and Agents user files are whitespace, the Claude user file is selected', async () => {
		const userSource = await resolveUserInstructions({
			codex: '\n',
			agents: '  ',
			claude: 'claude winner',
		})
		expect(userSource).toEqual({
			tier: 'user-global',
			family: 'claude',
			path: '<home>/.claude/CLAUDE.md',
			contents: 'claude winner',
		})
	})

	test('when every user instruction file is whitespace, no user source is returned', async () => {
		const userSource = await resolveUserInstructions({ codex: '', agents: '\n', claude: '  ' })
		expect(userSource).toBeUndefined()
	})

	test('when every user instruction file is missing, no user source is returned', async () => {
		const userSource = await resolveUserInstructions({})
		expect(userSource).toBeUndefined()
	})

	test('at both Git root and session cwd, AGENTS takes precedence over CLAUDE', async () => {
		const projectSources = await resolveProjectInstructionsAtRootAndCwd({
			agents: 'agents winner',
			claude: 'claude loser',
		})
		expect(projectSources).toEqual([
			{ tier: 'git-root-project', family: 'agents', path: '<repo>/AGENTS.md', contents: 'agents winner' },
			{ tier: 'cwd-project', family: 'agents', path: '<cwd>/AGENTS.md', contents: 'agents winner' },
		])
	})

	test('at both Git root and session cwd, missing AGENTS falls through to CLAUDE', async () => {
		const projectSources = await resolveProjectInstructionsAtRootAndCwd({ claude: 'claude winner' })
		expect(projectSources).toEqual([
			{ tier: 'git-root-project', family: 'claude', path: '<repo>/CLAUDE.md', contents: 'claude winner' },
			{ tier: 'cwd-project', family: 'claude', path: '<cwd>/CLAUDE.md', contents: 'claude winner' },
		])
	})

	test('at both Git root and session cwd, whitespace AGENTS falls through to CLAUDE', async () => {
		const projectSources = await resolveProjectInstructionsAtRootAndCwd({
			agents: ' \n',
			claude: 'claude winner',
		})
		expect(projectSources).toEqual([
			{ tier: 'git-root-project', family: 'claude', path: '<repo>/CLAUDE.md', contents: 'claude winner' },
			{ tier: 'cwd-project', family: 'claude', path: '<cwd>/CLAUDE.md', contents: 'claude winner' },
		])
	})

	test('at both Git root and session cwd, whitespace project files produce no sources', async () => {
		const projectSources = await resolveProjectInstructionsAtRootAndCwd({ agents: '', claude: '\n' })
		expect(projectSources).toEqual([])
	})

	test('at both Git root and session cwd, missing project files produce no sources', async () => {
		const projectSources = await resolveProjectInstructionsAtRootAndCwd({})
		expect(projectSources).toEqual([])
	})

	test('mixed user, Git-root, and cwd families render in broad-to-specific order and exclude unsupported files', async () => {
		const result = await resolveInstructionsWhenUserRootAndCwdContainMixedInstructionFamilies()
		expect(result).toEqual({
			sources: [
				{
					tier: 'user-global',
					family: 'agents',
					path: '<home>/.codex/AGENTS.md',
					contents: 'USER_CODEX_WINNER',
				},
				{
					tier: 'git-root-project',
					family: 'claude',
					path: '<repo>/CLAUDE.md',
					contents: 'ROOT_CLAUDE_WINNER',
				},
				{ tier: 'cwd-project', family: 'agents', path: '<cwd>/AGENTS.md', contents: 'CWD_AGENTS_WINNER' },
			],
			log: {
				global: '<home>/.codex/AGENTS.md',
				rootProject: '<repo>/CLAUDE.md',
				cwdProject: '<cwd>/AGENTS.md',
				skipped: [{ path: '<repo>/AGENTS.md', reason: 'empty' }],
			},
			rendered: [
				'# Repository Instructions: User Global\nSource: <home>/.codex/AGENTS.md\n\nUSER_CODEX_WINNER',
				'# Repository Instructions: Git Root Project\nSource: <repo>/CLAUDE.md\n\nROOT_CLAUDE_WINNER',
				'# Repository Instructions: Current Directory Project\nSource: <cwd>/AGENTS.md\n\nCWD_AGENTS_WINNER',
			].join('\n\n'),
			excludedMarkersPresent: [],
		})
	})

	test('outside a Git repository, the session cwd instruction is returned as the only project source', async () => {
		const sources = await resolveInstructionsOutsideGitRepository()
		expect(sources).toEqual([
			{ tier: 'cwd-project', family: 'claude', path: '<cwd>/CLAUDE.md', contents: 'NON_GIT_CWD' },
		])
	})

	test('when the session cwd is the canonical Git root, its instruction is returned once as the cwd source', async () => {
		const result = await resolveInstructionsWhenCwdIsGitRoot()
		expect(result).toEqual({
			sources: [
				{
					tier: 'cwd-project',
					family: 'agents',
					path: '<cwd>/AGENTS.md',
					contents: 'ROOT_EQUALS_CWD',
				},
			],
			rootProject: undefined,
		})
	})
})
