import { describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { defineTool } from '@humanlayer/agentlayer-core'
import { claudePrompt, codexPrompt } from '@humanlayer/agentlayer-core/prompts'
import { z } from 'zod'
import {
	createAgentFilesystemHooks,
	createAgentSystemPrompt,
	createClaudeAgentFilesystemToolset,
	createClaudeCodingAgentToolset,
	createCodexAgentFilesystemToolset,
	createCodexCodingAgentToolset,
	createSkillToolFromRepoDirs,
} from '../src'
import { makeToolContext } from './mocks'

function mockModel(modelId: string) {
	return { modelId } as any
}

const execFileAsync = promisify(execFile)

async function initGitRepo(cwd: string) {
	await execFileAsync('git', ['init'], { cwd })
}

describe('createSkillToolFromRepoDirs', () => {
	test('uses the provided cwd when resolving repo root', async () => {
		const repoDir = await mkdtemp(join(tmpdir(), 'agentlayer-skill-repo-'))
		const originalCwd = process.cwd()
		const unrelatedDir = await mkdtemp(join(tmpdir(), 'agentlayer-other-cwd-'))
		try {
			await initGitRepo(repoDir)
			await mkdir(join(repoDir, '.claude', 'skills'), { recursive: true })
			await writeFile(join(repoDir, '.claude', 'skills', 'plan.md'), '# Plan\n\nDo the plan.')
			const nestedCwd = join(repoDir, 'packages', 'app')
			await mkdir(nestedCwd, { recursive: true })
			process.chdir(unrelatedDir)

			const skillTool = await createSkillToolFromRepoDirs({ cwd: nestedCwd })
			expect(skillTool.description).toContain('plan')
		} finally {
			process.chdir(originalCwd)
			await rm(unrelatedDir, { recursive: true, force: true })
			await rm(repoDir, { recursive: true, force: true })
		}
	})
})

describe('createAgentSystemPrompt', () => {
	test('builds codex prompt with repo instructions and environment', async () => {
		const repoDir = await mkdtemp(join(tmpdir(), 'agentlayer-system-prompt-'))
		try {
			await initGitRepo(repoDir)
			const repoRealPath = await realpath(repoDir)
			const nestedCwd = join(repoDir, 'apps', 'demo')
			await mkdir(nestedCwd, { recursive: true })
			await writeFile(join(repoDir, 'AGENTS.md'), 'Root repository rules here.')
			await writeFile(join(repoDir, 'AGENTS.local.md'), 'Root local rules here.')
			await writeFile(join(nestedCwd, 'CLAUDE.md'), 'Repository rules here.')

			const prompt = await createAgentSystemPrompt({
				cwd: nestedCwd,
				model: mockModel('gpt-5.4'),
				systemPromptAdditions: ['Extra guidance'],
				date: new Date('2026-04-21T00:00:00Z'),
			})

			expect(prompt[0]).toBe(codexPrompt)
			const joinedPrompt = prompt.join('\n\n')
			expect(joinedPrompt).toContain('# Repository Instructions: Git Root Project')
			expect(joinedPrompt).toContain(`Source: ${join(repoRealPath, 'AGENTS.md')}`)
			expect(joinedPrompt).toContain('# Repository Instructions: Git Root Project Local')
			expect(joinedPrompt).toContain(`Source: ${join(repoRealPath, 'AGENTS.local.md')}`)
			expect(joinedPrompt).toContain('# Repository Instructions: Current Directory Project')
			expect(joinedPrompt).toContain(`Source: ${join(nestedCwd, 'CLAUDE.md')}`)
			expect(joinedPrompt).toContain('Root repository rules here.')
			expect(joinedPrompt).toContain('Root local rules here.')
			expect(joinedPrompt).toContain('Repository rules here.')
			expect(joinedPrompt).toContain(`Working directory: ${nestedCwd}`)
			expect(joinedPrompt).toContain('Extra guidance')
			expect(joinedPrompt.indexOf('Root local rules here.')).toBeLessThan(
				joinedPrompt.indexOf('Repository rules here.'),
			)
			expect(joinedPrompt.indexOf(`Working directory: ${nestedCwd}`)).toBeLessThan(
				joinedPrompt.indexOf('Extra guidance'),
			)
		} finally {
			await rm(repoDir, { recursive: true, force: true })
		}
	})

	test('defaults to claude prompt for anthropic-style models', async () => {
		const repoDir = await mkdtemp(join(tmpdir(), 'agentlayer-system-prompt-'))
		try {
			const prompt = await createAgentSystemPrompt({
				cwd: repoDir,
				model: mockModel('claude-sonnet-4-5'),
				includeEnvironment: false,
			})
			expect(prompt[0]).toBe(claudePrompt)
		} finally {
			await rm(repoDir, { recursive: true, force: true })
		}
	})

	test('throws when repo instructions are required but no usable sources resolve', async () => {
		const repoDir = await mkdtemp(join(tmpdir(), 'agentlayer-system-prompt-'))
		const previousHome = process.env.HOME
		const tempHome = await mkdtemp(join(tmpdir(), 'agentlayer-empty-home-'))
		process.env.HOME = tempHome
		try {
			await expect(
				createAgentSystemPrompt({
					cwd: repoDir,
					model: mockModel('gpt-5.4'),
					allowMissingRepoInstructions: false,
					includeEnvironment: false,
				}),
			).rejects.toThrow('No repo instructions found')
		} finally {
			await rm(tempHome, { recursive: true, force: true })
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await rm(repoDir, { recursive: true, force: true })
		}
	})
})

describe('createAgentFilesystemHooks', () => {
	test('returns bundled hook phases', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'agentlayer-hooks-'))
		try {
			const hooks = createAgentFilesystemHooks({ cwd: dir })
			expect(hooks.preToolUse).toHaveLength(2)
			expect(hooks.postToolUse).toHaveLength(6)
			expect(hooks.preRequest).toHaveLength(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe('coding agent toolsets', () => {
	test('claude filesystem toolset swaps in multimodal read when modalities are provided', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'agentlayer-toolset-'))
		try {
			const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
			await writeFile(join(dir, 'image.png'), bytes)

			const tools = createClaudeAgentFilesystemToolset({ cwd: dir, readToolModalities: ['text', 'image'] })
			const raw = await tools.read.execute({ file_path: 'image.png', limit: 2000 }, makeToolContext())

			expect(typeof raw).toBe('object')
			expect(raw).toMatchObject({ type: 'image', mediaType: 'image/png' })
			if (typeof raw === 'object' && raw !== null && raw.type === 'image') {
				expect(raw.mediaType).toBe('image/png')
				expect(Array.from(raw.content)).toEqual(Array.from(bytes))
			}
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	test('codex filesystem toolset swaps in multimodal read for PDF modality', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'agentlayer-toolset-'))
		try {
			const bytes = Buffer.from('%PDF-1.7\n')
			await writeFile(join(dir, 'document.pdf'), bytes)

			const tools = createCodexAgentFilesystemToolset({ cwd: dir, readToolModalities: ['text', 'pdf'] })
			const raw = await tools.read.execute({ file_path: 'document.pdf', limit: 2000 }, makeToolContext())

			expect(typeof raw).toBe('object')
			expect(raw).toMatchObject({ type: 'pdf', mediaType: 'application/pdf' })
			if (typeof raw === 'object' && raw !== null && raw.type === 'pdf') {
				expect(raw.mediaType).toBe('application/pdf')
				expect(Array.from(raw.content)).toEqual(Array.from(bytes))
			}
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	test('text-only modalities still use multimodal read with modality rejection', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'agentlayer-toolset-'))
		try {
			await writeFile(join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

			const tools = createClaudeAgentFilesystemToolset({ cwd: dir, readToolModalities: ['text'] })
			await expect(
				tools.read.execute({ file_path: 'image.png', limit: 2000 }, makeToolContext()),
			).rejects.toThrow('image support is unavailable')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	test('omitted modalities preserve text-only binary rejection', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'agentlayer-toolset-'))
		try {
			await writeFile(join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))

			const tools = createCodexAgentFilesystemToolset({ cwd: dir })
			await expect(
				tools.read.execute({ file_path: 'image.png', limit: 2000 }, makeToolContext()),
			).rejects.toThrow('Cannot read binary file:')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	test('coding toolset accepts typed modalities without model options', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'agentlayer-toolset-'))
		try {
			const modalities = ['text', 'image', 'pdf'] as const
			const tools = await createCodexCodingAgentToolset({ cwd: dir, readToolModalities: modalities })

			expect('read' in tools).toBe(true)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	test('creates a claude coding toolset with filesystem and aux tools', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'agentlayer-toolset-'))
		try {
			await mkdir(join(dir, '.claude', 'skills'), { recursive: true })
			await writeFile(join(dir, '.claude', 'skills', 'plan.md'), '# Plan\n\nPlan skill')
			const agentTool = defineTool({
				name: 'agent',
				description: 'Subagent tool',
				input: z.object({ prompt: z.string() }),
				output: z.string(),
				execute: async () => 'ok',
			})

			const tools = await createClaudeCodingAgentToolset({
				cwd: dir,
				agentTool,
				exaApiKey: 'test-key',
			})

			expect('bash' in tools).toBe(true)
			expect('read' in tools).toBe(true)
			expect('write' in tools).toBe(true)
			expect('edit' in tools).toBe(true)
			expect('agent' in tools).toBe(true)
			expect('skill' in tools).toBe(true)
			expect('web_fetch' in tools).toBe(true)
			expect('web_search' in tools).toBe(true)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	test('creates a codex coding toolset with apply_patch instead of write/edit', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'agentlayer-toolset-'))
		try {
			const tools = await createCodexCodingAgentToolset({ cwd: dir })

			expect('apply_patch' in tools).toBe(true)
			expect('write' in tools).toBe(false)
			expect('edit' in tools).toBe(false)
			expect('skill' in tools).toBe(true)
			expect('web_fetch' in tools).toBe(true)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
