import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderInstructionSources, resolveInstructionSources } from '../src/prompts/instruction-resolver'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), 'agentlayer-instructions-'))
	try {
		return await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
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
})
