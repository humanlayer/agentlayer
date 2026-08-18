import { describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Agent, defineTool, startState, WebFetchTool } from '@humanlayer/agentlayer-core'
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
import {
	assistantText,
	assistantWithToolCall,
	mockModel as createMockToolModel,
	getToolResults,
	makeToolContext,
	outputValue,
	userMessage,
} from './mocks'

function mockModel(modelId: string) {
	return { modelId } as any
}

const execFileAsync = promisify(execFile)

async function initGitRepo(cwd: string) {
	await execFileAsync('git', ['init'], { cwd })
}

async function withTemporaryDirectory<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), prefix))
	try {
		return await run(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

let homeEnvironmentQueue = Promise.resolve()

async function withHomeEnvironment<T>(home: string, run: () => Promise<T>): Promise<T> {
	const waitForPreviousMutation = homeEnvironmentQueue
	let releaseEnvironment: () => void = () => undefined
	homeEnvironmentQueue = new Promise<void>((resolve) => {
		releaseEnvironment = resolve
	})
	await waitForPreviousMutation

	const originalHome = process.env.HOME
	process.env.HOME = home
	try {
		return await run()
	} finally {
		if (originalHome === undefined) delete process.env.HOME
		else process.env.HOME = originalHome
		releaseEnvironment()
	}
}

async function withSkillResolutionFixture<T>(run: (nestedCwd: string) => Promise<T>): Promise<T> {
	return withTemporaryDirectory('agentlayer-skill-repo-', async (repoDir) =>
		withTemporaryDirectory('agentlayer-other-cwd-', async (unrelatedDir) => {
			await initGitRepo(repoDir)
			await mkdir(join(repoDir, '.claude', 'skills'), { recursive: true })
			await writeFile(join(repoDir, '.claude', 'skills', 'plan.md'), '# Plan\n\nDo the plan.')
			const nestedCwd = join(repoDir, 'packages', 'app')
			await mkdir(nestedCwd, { recursive: true })
			const originalCwd = process.cwd()
			process.chdir(unrelatedDir)
			try {
				return await run(nestedCwd)
			} finally {
				process.chdir(originalCwd)
			}
		}),
	)
}

async function buildPublicPromptWithMixedInstructionSources() {
	const originalHome = process.env.HOME
	return withTemporaryDirectory('agentlayer-system-prompt-', async (fixtureRoot) => {
		const tempHome = join(fixtureRoot, 'home')
		const repoDir = join(fixtureRoot, 'repo')
		const nestedCwd = join(repoDir, 'apps', 'demo')
		await mkdir(nestedCwd, { recursive: true })
		await initGitRepo(repoDir)
		const repoRealPath = await realpath(repoDir)
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
		return withHomeEnvironment(tempHome, async () => {
			const prompt = await createAgentSystemPrompt({
				cwd: nestedCwd,
				model: mockModel('gpt-5.4'),
				systemPromptAdditions: ['Extra guidance'],
				date: new Date('2026-04-21T00:00:00Z'),
			})
			const joinedPrompt = prompt.join('\n\n')
			const normalize = (value: string) =>
				value.replace(tempHome, '<home>').replace(nestedCwd, '<cwd>').replace(repoRealPath, '<repo>')
			const instructionSections = [
				...joinedPrompt.matchAll(/# Repository Instructions: ([^\n]+)\nSource: ([^\n]+)\n\n([^\n]+)/g),
			].map(([, title, path, content]) => ({ title, path: normalize(path ?? ''), content }))
			const excludedMarkers = [
				'PUBLIC_USER_AGENTS_LOSER',
				'PUBLIC_USER_CLAUDE_LOSER',
				'PUBLIC_ROOT_AGENTS_LOCAL_LOSER',
				'PUBLIC_ROOT_CLAUDE_LOCAL_LOSER',
				'PUBLIC_ROOT_CONTEXT_LOSER',
				'PUBLIC_CWD_CLAUDE_LOSER',
				'PUBLIC_CWD_AGENTS_LOCAL_LOSER',
				'PUBLIC_CWD_CLAUDE_LOCAL_LOSER',
				'PUBLIC_CWD_CONTEXT_LOSER',
			].filter((marker) => joinedPrompt.includes(marker))
			return {
				basePrompt: prompt[0] === codexPrompt ? 'codex' : 'other',
				instructionSections,
				excludedMarkers,
				environmentAndAdditionOrder:
					joinedPrompt.indexOf(`Working directory: ${nestedCwd}`) < joinedPrompt.indexOf('Extra guidance')
						? ['environment', 'addition']
						: ['addition', 'environment'],
			}
		})
	}).then((projection) => ({ ...projection, homeRestored: process.env.HOME === originalHome }))
}

async function withEmptyPromptFixture<T>(run: (repoDir: string) => Promise<T>): Promise<T> {
	return withTemporaryDirectory('agentlayer-system-prompt-', async (repoDir) =>
		withTemporaryDirectory('agentlayer-empty-home-', async (tempHome) => {
			return withHomeEnvironment(tempHome, () => run(repoDir))
		}),
	)
}

describe('createSkillToolFromRepoDirs', () => {
	test('when the process cwd is unrelated, the provided cwd determines the repository whose skills are loaded', async () => {
		await withSkillResolutionFixture(async (nestedCwd) => {
			const skillTool = await createSkillToolFromRepoDirs({ cwd: nestedCwd })
			expect(skillTool.description).toContain('plan')
		})
	})
})

describe('createAgentSystemPrompt', () => {
	test('the public prompt builder derives HOME from the environment and renders user, root, then cwd instructions', async () => {
		const result = await buildPublicPromptWithMixedInstructionSources()
		expect(result).toEqual({
			basePrompt: 'codex',
			instructionSections: [
				{ title: 'User Global', path: '<home>/.codex/AGENTS.md', content: 'PUBLIC_USER_CODEX_WINNER' },
				{ title: 'Git Root Project', path: '<repo>/CLAUDE.md', content: 'PUBLIC_ROOT_CLAUDE_WINNER' },
				{ title: 'Current Directory Project', path: '<cwd>/AGENTS.md', content: 'PUBLIC_CWD_AGENTS_WINNER' },
			],
			excludedMarkers: [],
			environmentAndAdditionOrder: ['environment', 'addition'],
			homeRestored: true,
		})
	})

	test('when the model is Anthropic-style, the public prompt builder uses the Claude base prompt', async () => {
		await withTemporaryDirectory('agentlayer-system-prompt-', async (repoDir) => {
			const prompt = await createAgentSystemPrompt({
				cwd: repoDir,
				model: mockModel('claude-sonnet-4-5'),
				includeEnvironment: false,
			})
			expect(prompt[0]).toBe(claudePrompt)
		})
	})

	test('when repository instructions are required and every source is absent, prompt creation rejects', async () => {
		await withEmptyPromptFixture(async (repoDir) => {
			await expect(
				createAgentSystemPrompt({
					cwd: repoDir,
					model: mockModel('gpt-5.4'),
					allowMissingRepoInstructions: false,
					includeEnvironment: false,
				}),
			).rejects.toThrow('No repo instructions found')
		})
	})
})

describe('createAgentFilesystemHooks', () => {
	test('returns bundled hook phases', async () => {
		await withTemporaryDirectory('agentlayer-hooks-', async (dir) => {
			const hooks = createAgentFilesystemHooks({ cwd: dir })
			expect(hooks.preToolUse).toHaveLength(2)
			expect(hooks.postToolUse).toHaveLength(7)
			expect(hooks.preRequest).toHaveLength(0)
		})
	})

	test('forwards configured output limits to the web output hook', async () => {
		await withTemporaryDirectory('agentlayer-hooks-', async (dir) => {
			const hooks = createAgentFilesystemHooks({
				cwd: dir,
				outputTruncation: { maxLines: 1, maxBytes: 100_000 },
			})
			const agent = new Agent({
				model: createMockToolModel([
					assistantWithToolCall('web_fetch', { url: 'https://example.com' }),
					assistantText('Done.'),
				]),
				tools: {
					web_fetch: WebFetchTool.define(async () => 'first line\nsecond line'),
				},
				hooks: {
					preToolUse: [...hooks.preToolUse],
					postToolUse: [...hooks.postToolUse],
					preRequest: [...hooks.preRequest],
					compaction: [...hooks.compaction],
				},
			})
			const result = await agent.run({ state: startState([userMessage('go')]) }).result
			const [toolResult] = getToolResults(result.state.messages)
			const output = outputValue(toolResult!)

			expect(output).toContain('first line')
			expect(output).not.toContain('second line')
			expect(output).toContain('Full output saved to')
		})
	})
})

describe('coding agent toolsets', () => {
	test('claude filesystem toolset swaps in multimodal read when modalities are provided', async () => {
		await withTemporaryDirectory('agentlayer-toolset-', async (dir) => {
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
		})
	})

	test('codex filesystem toolset swaps in multimodal read for PDF modality', async () => {
		await withTemporaryDirectory('agentlayer-toolset-', async (dir) => {
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
		})
	})

	test('text-only modalities still use multimodal read with modality rejection', async () => {
		await withTemporaryDirectory('agentlayer-toolset-', async (dir) => {
			await writeFile(join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

			const tools = createClaudeAgentFilesystemToolset({ cwd: dir, readToolModalities: ['text'] })
			await expect(
				tools.read.execute({ file_path: 'image.png', limit: 2000 }, makeToolContext()),
			).rejects.toThrow('image support is unavailable')
		})
	})

	test('omitted modalities preserve text-only binary rejection', async () => {
		await withTemporaryDirectory('agentlayer-toolset-', async (dir) => {
			await writeFile(join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))

			const tools = createCodexAgentFilesystemToolset({ cwd: dir })
			await expect(
				tools.read.execute({ file_path: 'image.png', limit: 2000 }, makeToolContext()),
			).rejects.toThrow('Cannot read binary file:')
		})
	})

	test('coding toolset accepts typed modalities without model options', async () => {
		await withTemporaryDirectory('agentlayer-toolset-', async (dir) => {
			const modalities = ['text', 'image', 'pdf'] as const
			const tools = await createCodexCodingAgentToolset({ cwd: dir, readToolModalities: modalities })

			expect('read' in tools).toBe(true)
		})
	})

	test('creates a claude coding toolset with filesystem and aux tools', async () => {
		await withTemporaryDirectory('agentlayer-toolset-', async (dir) => {
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
		})
	})

	test('creates a codex coding toolset with apply_patch instead of write/edit', async () => {
		await withTemporaryDirectory('agentlayer-toolset-', async (dir) => {
			const tools = await createCodexCodingAgentToolset({ cwd: dir })

			expect('apply_patch' in tools).toBe(true)
			expect('write' in tools).toBe(false)
			expect('edit' in tools).toBe(false)
			expect('skill' in tools).toBe(true)
			expect('web_fetch' in tools).toBe(true)
		})
	})
})
