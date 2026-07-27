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
	test('builds an isolated codex prompt with exact user, root, and cwd preference', async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), 'agentlayer-system-prompt-'))
		const originalHome = process.env.HOME
		try {
			const tempHome = join(fixtureRoot, 'home')
			const repoDir = join(fixtureRoot, 'repo')
			await mkdir(repoDir, { recursive: true })
			await initGitRepo(repoDir)
			const repoRealPath = await realpath(repoDir)
			const nestedCwd = join(repoDir, 'apps', 'demo')
			await mkdir(nestedCwd, { recursive: true })
			await mkdir(join(tempHome, '.codex'), { recursive: true })
			await mkdir(join(tempHome, '.agents'), { recursive: true })
			await mkdir(join(tempHome, '.claude'), { recursive: true })
			await writeFile(join(tempHome, '.codex', 'AGENTS.md'), 'PUBLIC_USER_CODEX_WINNER')
			await writeFile(join(tempHome, '.agents', 'AGENTS.md'), 'PUBLIC_USER_AGENTS_LOSER')
			await writeFile(join(tempHome, '.claude', 'CLAUDE.md'), 'PUBLIC_USER_CLAUDE_LOSER')
			await writeFile(join(repoDir, 'AGENTS.md'), '  \n')
			await writeFile(join(repoDir, 'CLAUDE.md'), 'PUBLIC_ROOT_CLAUDE_WINNER')
			await writeFile(join(repoDir, 'AGENTS.local.md'), 'PUBLIC_ROOT_AGENTS_LOCAL_LOSER')
			await writeFile(join(repoDir, 'CLAUDE.local.md'), 'PUBLIC_ROOT_CLAUDE_LOCAL_LOSER')
			await writeFile(join(repoDir, 'CONTEXT.md'), 'PUBLIC_ROOT_CONTEXT_LOSER')
			await writeFile(join(nestedCwd, 'AGENTS.md'), 'PUBLIC_CWD_AGENTS_WINNER')
			await writeFile(join(nestedCwd, 'CLAUDE.md'), 'PUBLIC_CWD_CLAUDE_LOSER')
			await writeFile(join(nestedCwd, 'AGENTS.local.md'), 'PUBLIC_CWD_AGENTS_LOCAL_LOSER')
			await writeFile(join(nestedCwd, 'CLAUDE.local.md'), 'PUBLIC_CWD_CLAUDE_LOCAL_LOSER')
			await writeFile(join(nestedCwd, 'CONTEXT.md'), 'PUBLIC_CWD_CONTEXT_LOSER')
			process.env.HOME = tempHome

			const prompt = await createAgentSystemPrompt({
				cwd: nestedCwd,
				model: mockModel('gpt-5.4'),
				systemPromptAdditions: ['Extra guidance'],
				date: new Date('2026-04-21T00:00:00Z'),
			})

			expect(prompt[0]).toBe(codexPrompt)
			const joinedPrompt = prompt.join('\n\n')
			const orderedMarkers = ['PUBLIC_USER_CODEX_WINNER', 'PUBLIC_ROOT_CLAUDE_WINNER', 'PUBLIC_CWD_AGENTS_WINNER']
			const markerPositions = orderedMarkers.map((marker) => joinedPrompt.indexOf(marker))
			for (const marker of orderedMarkers) expect(joinedPrompt).toContain(marker)
			expect(markerPositions).toEqual([...markerPositions].sort((left, right) => left - right))
			expect(joinedPrompt.match(/# Repository Instructions:/g)).toHaveLength(3)
			expect(joinedPrompt).toContain('# Repository Instructions: User Global')
			expect(joinedPrompt).toContain(`Source: ${join(tempHome, '.codex', 'AGENTS.md')}`)
			expect(joinedPrompt).toContain('# Repository Instructions: Git Root Project')
			expect(joinedPrompt).toContain(`Source: ${join(repoRealPath, 'CLAUDE.md')}`)
			expect(joinedPrompt).toContain('# Repository Instructions: Current Directory Project')
			expect(joinedPrompt).toContain(`Source: ${join(nestedCwd, 'AGENTS.md')}`)
			const loserMarkers = [
				'PUBLIC_USER_AGENTS_LOSER',
				'PUBLIC_USER_CLAUDE_LOSER',
				'PUBLIC_ROOT_AGENTS_LOCAL_LOSER',
				'PUBLIC_ROOT_CLAUDE_LOCAL_LOSER',
				'PUBLIC_ROOT_CONTEXT_LOSER',
				'PUBLIC_CWD_CLAUDE_LOSER',
				'PUBLIC_CWD_AGENTS_LOCAL_LOSER',
				'PUBLIC_CWD_CLAUDE_LOCAL_LOSER',
				'PUBLIC_CWD_CONTEXT_LOSER',
			]
			for (const marker of loserMarkers) expect(joinedPrompt).not.toContain(marker)
			expect(joinedPrompt).toContain(`Working directory: ${nestedCwd}`)
			expect(joinedPrompt).toContain('Extra guidance')
			expect(joinedPrompt.indexOf(`Working directory: ${nestedCwd}`)).toBeLessThan(
				joinedPrompt.indexOf('Extra guidance'),
			)
		} finally {
			if (originalHome === undefined) delete process.env.HOME
			else process.env.HOME = originalHome
			expect(process.env.HOME).toBe(originalHome)
			await rm(fixtureRoot, { recursive: true, force: true })
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
