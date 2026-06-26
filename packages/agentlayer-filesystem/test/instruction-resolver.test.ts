import { describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderInstructionSources, resolveInstructionSources } from '../src/prompts/instruction-resolver'

function execFileAsync(command: string, args: string[], cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { cwd }, (error) => {
			if (error) reject(error)
			else resolve()
		})
	})
}

async function initGitRepo(cwd: string): Promise<void> {
	await execFileAsync('git', ['init'], cwd)
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), 'agentlayer-instructions-'))
	const previousHome = process.env.HOME
	const ownsHome = !previousHome?.includes('agentlayer-home-')
	if (ownsHome) process.env.HOME = await mkdtemp(join(tmpdir(), 'agentlayer-home-'))
	try {
		return await fn(dir)
	} finally {
		if (ownsHome) {
			await rm(process.env.HOME!, { recursive: true, force: true })
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
		}
		await rm(dir, { recursive: true, force: true })
	}
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
	const home = await mkdtemp(join(tmpdir(), 'agentlayer-home-'))
	const previousHome = process.env.HOME
	process.env.HOME = home
	try {
		return await fn(home)
	} finally {
		if (previousHome === undefined) delete process.env.HOME
		else process.env.HOME = previousHome
		await rm(home, { recursive: true, force: true })
	}
}

describe('instruction resolver', () => {
	test('loads AGENTS base before AGENTS local from the current directory', async () => {
		await withTempDir(async (cwd) => {
			await writeFile(join(cwd, 'AGENTS.md'), 'Shared agents rules')
			await writeFile(join(cwd, 'AGENTS.local.md'), 'Local agents rules')

			const resolution = await resolveInstructionSources({ cwd })

			expect(resolution.sources.map((source) => source.path)).toEqual([
				join(cwd, 'AGENTS.md'),
				join(cwd, 'AGENTS.local.md'),
			])
			expect(resolution.sources.map((source) => source.family)).toEqual(['agents', 'agents'])
			expect(resolution.sources.map((source) => source.tier)).toEqual(['cwd-project', 'cwd-project-local'])
		})
	})

	test('loads CLAUDE base before CLAUDE local when AGENTS family is absent', async () => {
		await withTempDir(async (cwd) => {
			await writeFile(join(cwd, 'CLAUDE.md'), 'Shared claude rules')
			await writeFile(join(cwd, 'CLAUDE.local.md'), 'Local claude rules')

			const resolution = await resolveInstructionSources({ cwd })

			expect(resolution.sources.map((source) => source.path)).toEqual([
				join(cwd, 'CLAUDE.md'),
				join(cwd, 'CLAUDE.local.md'),
			])
			expect(resolution.sources.map((source) => source.family)).toEqual(['claude', 'claude'])
		})
	})

	test('loads a base-only AGENTS file', async () => {
		await withTempDir(async (cwd) => {
			await writeFile(join(cwd, 'AGENTS.md'), 'Only shared agents rules')

			const resolution = await resolveInstructionSources({ cwd })

			expect(resolution.sources).toHaveLength(1)
			expect(resolution.sources[0]).toMatchObject({
				family: 'agents',
				tier: 'cwd-project',
				path: join(cwd, 'AGENTS.md'),
				contents: 'Only shared agents rules',
			})
		})
	})

	test('renders explicit labels and source lines for each selected file', async () => {
		await withTempDir(async (cwd) => {
			await writeFile(join(cwd, 'AGENTS.md'), 'Shared agents rules')
			await writeFile(join(cwd, 'AGENTS.local.md'), 'Local agents rules')

			const resolution = await resolveInstructionSources({ cwd })
			const rendered = renderInstructionSources(resolution.sources)

			expect(rendered).toContain('# Repository Instructions: Current Directory Project')
			expect(rendered).toContain(`Source: ${join(cwd, 'AGENTS.md')}`)
			expect(rendered).toContain('# Repository Instructions: Current Directory Project Local')
			expect(rendered).toContain(`Source: ${join(cwd, 'AGENTS.local.md')}`)
			expect(rendered).toContain('Shared agents rules')
			expect(rendered).toContain('Local agents rules')
		})
	})

	test('orders global, git root, then nested cwd instructions', async () => {
		await withTempHome(async (home) => {
			await withTempDir(async (repo) => {
				await initGitRepo(repo)
				const cwd = join(repo, 'apps', 'demo')
				await mkdir(cwd, { recursive: true })
				await mkdir(join(home, '.agents'), { recursive: true })
				await writeFile(join(home, '.agents', 'AGENTS.md'), 'Global agents rules')
				await writeFile(join(repo, 'AGENTS.md'), 'Root agents rules')
				await writeFile(join(repo, 'AGENTS.local.md'), 'Root local agents rules')
				await writeFile(join(cwd, 'AGENTS.md'), 'Cwd agents rules')
				await writeFile(join(cwd, 'AGENTS.local.md'), 'Cwd local agents rules')

				const resolution = await resolveInstructionSources({ cwd })

				expect(resolution.sources.map((source) => source.tier)).toEqual([
					'user-global',
					'git-root-project',
					'git-root-project-local',
					'cwd-project',
					'cwd-project-local',
				])
				expect(resolution.sources.map((source) => source.contents)).toEqual([
					'Global agents rules',
					'Root agents rules',
					'Root local agents rules',
					'Cwd agents rules',
					'Cwd local agents rules',
				])
			})
		})
	})

	test('loads cwd-only instructions outside a git repository', async () => {
		await withTempDir(async (cwd) => {
			await writeFile(join(cwd, 'AGENTS.md'), 'Cwd only rules')

			const resolution = await resolveInstructionSources({ cwd })

			expect(resolution.sources.map((source) => source.tier)).toEqual(['cwd-project'])
			expect(resolution.sources[0]?.contents).toBe('Cwd only rules')
		})
	})

	test('does not duplicate project instructions when cwd is the git root', async () => {
		await withTempDir(async (repo) => {
			await initGitRepo(repo)
			await writeFile(join(repo, 'AGENTS.md'), 'Root as cwd rules')

			const resolution = await resolveInstructionSources({ cwd: repo })

			expect(resolution.sources.map((source) => source.tier)).toEqual(['cwd-project'])
			expect(resolution.sources[0]?.path).toBe(join(repo, 'AGENTS.md'))
		})
	})

	test('prefers AGENTS global files by default', async () => {
		await withTempHome(async (home) => {
			await withTempDir(async (cwd) => {
				await mkdir(join(home, '.agents'), { recursive: true })
				await mkdir(join(home, '.codex'), { recursive: true })
				await mkdir(join(home, '.claude'), { recursive: true })
				await writeFile(join(home, '.agents', 'AGENTS.md'), 'Agents global rules')
				await writeFile(join(home, '.codex', 'AGENTS.md'), 'Codex global rules')
				await writeFile(join(home, '.claude', 'CLAUDE.md'), 'Claude global rules')

				const resolution = await resolveInstructionSources({ cwd })

				expect(resolution.sources).toHaveLength(1)
				expect(resolution.sources[0]).toMatchObject({
					family: 'agents',
					tier: 'user-global',
					path: join(home, '.agents', 'AGENTS.md'),
					contents: 'Agents global rules',
				})
			})
		})
	})

	test('hoists CLAUDE global when the most-specific project family is claude', async () => {
		await withTempHome(async (home) => {
			await withTempDir(async (repo) => {
				await initGitRepo(repo)
				const cwd = join(repo, 'apps', 'demo')
				await mkdir(cwd, { recursive: true })
				await mkdir(join(home, '.agents'), { recursive: true })
				await mkdir(join(home, '.claude'), { recursive: true })
				await writeFile(join(home, '.agents', 'AGENTS.md'), 'Agents global rules')
				await writeFile(join(home, '.claude', 'CLAUDE.md'), 'Claude global rules')
				await writeFile(join(repo, 'AGENTS.md'), 'Root agents rules')
				await writeFile(join(cwd, 'CLAUDE.md'), 'Cwd claude rules')

				const resolution = await resolveInstructionSources({ cwd })

				expect(resolution.sources.map((source) => source.contents)).toEqual([
					'Claude global rules',
					'Root agents rules',
					'Cwd claude rules',
				])
				expect(resolution.sources.map((source) => source.family)).toEqual(['claude', 'agents', 'claude'])
			})
		})
	})
})
