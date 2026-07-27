import { describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
	type InstructionSource,
	renderInstructionSources,
	resolveInstructionSources,
} from '../src/prompts/instruction-resolver'

const execFileAsync = promisify(execFile)

async function initGitRepo(cwd: string): Promise<void> {
	await execFileAsync('git', ['init'], { cwd })
}

async function withFixture<T>(fn: (root: string) => Promise<T>): Promise<T> {
	const createdRoot = await mkdtemp(join(tmpdir(), 'agentlayer-instructions-'))
	const root = await realpath(createdRoot)
	try {
		return await fn(root)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

async function write(path: string, contents: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, contents)
}

describe('instruction resolver', () => {
	test('uses fixed user preference and falls through every missing or empty position', async () => {
		const cases = [
			{
				name: 'all candidates collide',
				files: { codex: 'codex winner', agents: 'agents loser', claude: 'claude loser' },
				expectedPath: join('.codex', 'AGENTS.md'),
				expectedContents: 'codex winner',
			},
			{
				name: 'missing codex falls through to agents',
				files: { agents: 'agents winner', claude: 'claude loser' },
				expectedPath: join('.agents', 'AGENTS.md'),
				expectedContents: 'agents winner',
			},
			{
				name: 'empty codex falls through to agents',
				files: { codex: ' \n\t', agents: 'agents winner', claude: 'claude loser' },
				expectedPath: join('.agents', 'AGENTS.md'),
				expectedContents: 'agents winner',
			},
			{
				name: 'missing codex and agents fall through to claude',
				files: { claude: 'claude winner' },
				expectedPath: join('.claude', 'CLAUDE.md'),
				expectedContents: 'claude winner',
			},
			{
				name: 'empty codex and agents fall through to claude',
				files: { codex: '\n', agents: '  ', claude: 'claude winner' },
				expectedPath: join('.claude', 'CLAUDE.md'),
				expectedContents: 'claude winner',
			},
			{
				name: 'all empty yields no user source',
				files: { codex: '', agents: '\n', claude: '  ' },
			},
			{
				name: 'all missing yields no user source',
				files: {},
			},
		] as const

		for (const fixture of cases) {
			await withFixture(async (root) => {
				const home = join(root, 'home')
				const cwd = join(root, 'cwd')
				await mkdir(cwd, { recursive: true })
				if ('codex' in fixture.files) await write(join(home, '.codex', 'AGENTS.md'), fixture.files.codex)
				if ('agents' in fixture.files) await write(join(home, '.agents', 'AGENTS.md'), fixture.files.agents)
				if ('claude' in fixture.files) await write(join(home, '.claude', 'CLAUDE.md'), fixture.files.claude)

				const resolution = await resolveInstructionSources({ cwd, home })
				const userSource = resolution.sources.find((source) => source.tier === 'user-global')

				if ('expectedPath' in fixture) {
					expect(userSource, fixture.name).toEqual({
						tier: 'user-global',
						family: fixture.expectedPath.startsWith('.claude') ? 'claude' : 'agents',
						path: join(home, fixture.expectedPath),
						contents: fixture.expectedContents,
					})
				} else {
					expect(userSource, fixture.name).toBeUndefined()
				}
			})
		}
	})

	test('uses AGENTS then CLAUDE independently at cwd and Git-root levels', async () => {
		const cases = [
			{ name: 'collision', agents: 'agents winner', claude: 'claude loser', expected: 'agents winner' },
			{ name: 'missing AGENTS', claude: 'claude winner', expected: 'claude winner' },
			{ name: 'empty AGENTS', agents: ' \n', claude: 'claude winner', expected: 'claude winner' },
			{ name: 'all empty', agents: '', claude: '\n' },
			{ name: 'all missing' },
		] as const

		for (const fixture of cases) {
			await withFixture(async (root) => {
				const home = join(root, 'home')
				const repo = join(root, 'repo')
				const cwd = join(repo, 'nested')
				await mkdir(cwd, { recursive: true })
				await initGitRepo(repo)

				for (const directory of [repo, cwd]) {
					if ('agents' in fixture) await writeFile(join(directory, 'AGENTS.md'), fixture.agents)
					if ('claude' in fixture) await writeFile(join(directory, 'CLAUDE.md'), fixture.claude)
				}

				const resolution = await resolveInstructionSources({ cwd, home })
				const projectSources = resolution.sources.filter((source) => source.tier !== 'user-global')

				if ('expected' in fixture) {
					expect(
						projectSources.map(({ tier, family, path, contents }) => ({ tier, family, path, contents })),
						fixture.name,
					).toEqual([
						{
							tier: 'git-root-project',
							family: fixture.expected.startsWith('claude') ? 'claude' : 'agents',
							path: join(repo, fixture.expected.startsWith('claude') ? 'CLAUDE.md' : 'AGENTS.md'),
							contents: fixture.expected,
						},
						{
							tier: 'cwd-project',
							family: fixture.expected.startsWith('claude') ? 'claude' : 'agents',
							path: join(cwd, fixture.expected.startsWith('claude') ? 'CLAUDE.md' : 'AGENTS.md'),
							contents: fixture.expected,
						},
					])
				} else {
					expect(projectSources, fixture.name).toEqual([])
				}
			})
		}
	})

	test('selects exactly one mixed source per level and renders exact broad-to-specific order', async () => {
		await withFixture(async (root) => {
			const explicitHome = join(root, 'explicit-home')
			const ambientHome = join(root, 'ambient-home')
			const repo = join(root, 'repo')
			const cwd = join(repo, 'apps', 'demo')
			await mkdir(cwd, { recursive: true })
			await initGitRepo(repo)

			await write(join(explicitHome, '.codex', 'AGENTS.md'), 'USER_CODEX_WINNER')
			await write(join(explicitHome, '.agents', 'AGENTS.md'), 'USER_AGENTS_LOSER')
			await write(join(explicitHome, '.claude', 'CLAUDE.md'), 'USER_CLAUDE_LOSER')
			await write(join(ambientHome, '.codex', 'AGENTS.md'), 'AMBIENT_HOME_LOSER')
			await writeFile(join(repo, 'AGENTS.md'), ' \n')
			await writeFile(join(repo, 'CLAUDE.md'), 'ROOT_CLAUDE_WINNER')
			await writeFile(join(repo, 'AGENTS.local.md'), 'ROOT_AGENTS_LOCAL_LOSER')
			await writeFile(join(repo, 'CLAUDE.local.md'), 'ROOT_CLAUDE_LOCAL_LOSER')
			await writeFile(join(repo, 'CONTEXT.md'), 'ROOT_CONTEXT_LOSER')
			await writeFile(join(cwd, 'AGENTS.md'), 'CWD_AGENTS_WINNER')
			await writeFile(join(cwd, 'CLAUDE.md'), 'CWD_CLAUDE_LOSER')
			await writeFile(join(cwd, 'AGENTS.local.md'), 'CWD_AGENTS_LOCAL_LOSER')
			await writeFile(join(cwd, 'CLAUDE.local.md'), 'CWD_CLAUDE_LOCAL_LOSER')
			await writeFile(join(cwd, 'CONTEXT.md'), 'CWD_CONTEXT_LOSER')

			const previousHome = process.env.HOME
			process.env.HOME = ambientHome
			try {
				const resolution = await resolveInstructionSources({ cwd, home: explicitHome })
				const expectedSources: InstructionSource[] = [
					{
						tier: 'user-global',
						family: 'agents',
						path: join(explicitHome, '.codex', 'AGENTS.md'),
						contents: 'USER_CODEX_WINNER',
					},
					{
						tier: 'git-root-project',
						family: 'claude',
						path: join(repo, 'CLAUDE.md'),
						contents: 'ROOT_CLAUDE_WINNER',
					},
					{
						tier: 'cwd-project',
						family: 'agents',
						path: join(cwd, 'AGENTS.md'),
						contents: 'CWD_AGENTS_WINNER',
					},
				]
				const [userSource, rootSource, cwdSource] = expectedSources
				if (!userSource || !rootSource || !cwdSource) throw new Error('Expected three instruction sources')
				expect(resolution.sources).toEqual(expectedSources)
				expect(resolution.sources).toHaveLength(3)
				expect(resolution.log).toEqual({
					global: userSource.path,
					rootProject: rootSource.path,
					cwdProject: cwdSource.path,
					skipped: [{ path: join(repo, 'AGENTS.md'), reason: 'empty' }],
				})

				const rendered = renderInstructionSources(resolution.sources)
				const expectedRendered = [
					`# Repository Instructions: User Global\nSource: ${userSource.path}\n\nUSER_CODEX_WINNER`,
					`# Repository Instructions: Git Root Project\nSource: ${rootSource.path}\n\nROOT_CLAUDE_WINNER`,
					`# Repository Instructions: Current Directory Project\nSource: ${cwdSource.path}\n\nCWD_AGENTS_WINNER`,
				].join('\n\n')
				expect(rendered).toBe(expectedRendered)

				const loserMarkers = [
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
				]
				for (const marker of loserMarkers) expect(rendered).not.toContain(marker)
			} finally {
				if (previousHome === undefined) delete process.env.HOME
				else process.env.HOME = previousHome
			}
		})
	})

	test('loads one cwd source outside Git and deduplicates cwd when it is the canonical Git root', async () => {
		await withFixture(async (root) => {
			const home = join(root, 'home')
			const nonGitCwd = join(root, 'non-git')
			await mkdir(nonGitCwd, { recursive: true })
			await writeFile(join(nonGitCwd, 'CLAUDE.md'), 'NON_GIT_CWD')
			const nonGit = await resolveInstructionSources({ cwd: nonGitCwd, home })
			expect(nonGit.sources).toEqual([
				{
					tier: 'cwd-project',
					family: 'claude',
					path: join(nonGitCwd, 'CLAUDE.md'),
					contents: 'NON_GIT_CWD',
				},
			])

			const repo = join(root, 'repo')
			await mkdir(repo)
			await initGitRepo(repo)
			await writeFile(join(repo, 'AGENTS.md'), 'ROOT_EQUALS_CWD')
			const atRoot = await resolveInstructionSources({ cwd: repo, home })
			expect(atRoot.sources).toEqual([
				{
					tier: 'cwd-project',
					family: 'agents',
					path: join(repo, 'AGENTS.md'),
					contents: 'ROOT_EQUALS_CWD',
				},
			])
			expect(atRoot.log.rootProject).toBeUndefined()
		})
	})
})
