import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@humanlayer/agentlayer-core'
import { claudePrompt, codexPrompt } from '@humanlayer/agentlayer-core/prompts'
import { z } from 'zod'
import {
	createAgentFilesystemHooks,
	createAgentSystemPrompt,
	createClaudeCodingAgentToolset,
	createCodexCodingAgentToolset,
	createSkillToolFromRepoDirs,
} from '../src'

function mockModel(modelId: string) {
	return { modelId } as any
}

async function initGitRepo(cwd: string) {
	await mkdir(join(cwd, '.git'), { recursive: true })
}

describe('createSkillToolFromRepoDirs', () => {
	test('uses the provided cwd when resolving repo root', async () => {
		const repoDir = await mkdtemp(join(tmpdir(), 'agentlayer-skill-repo-'))
		try {
			await initGitRepo(repoDir)
			await mkdir(join(repoDir, '.claude', 'skills'), { recursive: true })
			await writeFile(join(repoDir, '.claude', 'skills', 'plan.md'), '# Plan\n\nDo the plan.')
			const nestedCwd = join(repoDir, 'packages', 'app')
			await mkdir(nestedCwd, { recursive: true })

			const skillTool = await createSkillToolFromRepoDirs({ cwd: nestedCwd })
			expect(skillTool.description).toContain('plan')
		} finally {
			await rm(repoDir, { recursive: true, force: true })
		}
	})
})

describe('createAgentSystemPrompt', () => {
	test('builds codex prompt with repo instructions and environment', async () => {
		const repoDir = await mkdtemp(join(tmpdir(), 'agentlayer-system-prompt-'))
		try {
			await initGitRepo(repoDir)
			await writeFile(join(repoDir, 'CLAUDE.md'), 'Repository rules here.')
			const nestedCwd = join(repoDir, 'apps', 'demo')
			await mkdir(nestedCwd, { recursive: true })

			const prompt = await createAgentSystemPrompt({
				cwd: nestedCwd,
				model: mockModel('gpt-5.4'),
				systemPromptAdditions: ['Extra guidance'],
				date: new Date('2026-04-21T00:00:00Z'),
			})

			expect(prompt[0]).toBe(codexPrompt)
			expect(prompt.join('\n\n')).toContain('Repository rules here.')
			expect(prompt.join('\n\n')).toContain(`Working directory: ${nestedCwd}`)
			expect(prompt.join('\n\n')).toContain('Extra guidance')
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
