import { describe, expect, test } from 'bun:test'
import { claudePrompt, codexPrompt } from '@humanlayer/agentlayer-core/prompts'
import {
	createAgentSystemPrompt,
	environmentPrompt,
	repoInstructionsPrompt,
	resolveCodingModelPrompt,
	tarsPersona,
} from '../src/prompts/index'

function createBashMock(outputs: Record<string, { exitCode: number; stdout: string; stderr: string }>) {
	return {
		exec: async (command: string) => outputs[command] ?? { exitCode: 1, stdout: '', stderr: '' },
	} as any
}

describe('justbash prompts', () => {
	test('re-exports core provider prompts', () => {
		expect(resolveCodingModelPrompt('claude')).toBe(claudePrompt)
		expect(resolveCodingModelPrompt('codex')).toBe(codexPrompt)
		expect(tarsPersona(10)).toContain('You are TARS')
	})

	test('builds environment prompt from bash git detection', async () => {
		const cwd = '/repo/apps/demo'
		const bash = createBashMock({
			[`git -C "${cwd}" rev-parse --show-toplevel 2>/dev/null`]: {
				exitCode: 0,
				stdout: '/repo\n',
				stderr: '',
			},
		})

		const prompt = await environmentPrompt(bash, {
			cwd,
			platform: 'darwin',
			date: new Date('2026-04-21T00:00:00Z'),
		})

		expect(prompt).toContain(`Working directory: ${cwd}`)
		expect(prompt).toContain('Is git repo: yes')
		expect(prompt).toContain('Platform: darwin')
	})

	test('builds repo instructions from explicit file path', async () => {
		const cwd = '/repo/apps/demo'
		const filePath = '/repo/CLAUDE.md'
		const bash = createBashMock({
			[`cat "${filePath}" 2>/dev/null`]: {
				exitCode: 0,
				stdout: 'Repository rules here.\n',
				stderr: '',
			},
		})

		const prompt = await repoInstructionsPrompt(bash, {
			cwd,
			filePath,
		})

		expect(prompt).toContain('Repository rules here.')
		expect(prompt).toContain(filePath)
	})

	test('loads local repo instruction candidates alongside shared files', async () => {
		const cwd = '/repo'
		const bash = createBashMock({
			[`cat "${cwd}/CLAUDE.md" 2>/dev/null`]: {
				exitCode: 0,
				stdout: 'Shared Claude rules here.\n',
				stderr: '',
			},
			[`cat "${cwd}/CLAUDE.local.md" 2>/dev/null`]: {
				exitCode: 0,
				stdout: 'Local Claude rules here.\n',
				stderr: '',
			},
			[`cat "${cwd}/AGENTS.local.md" 2>/dev/null`]: {
				exitCode: 0,
				stdout: 'Local agent rules here.\n',
				stderr: '',
			},
		})

		const prompt = await repoInstructionsPrompt(bash, { cwd })

		expect(prompt).toContain('Shared Claude rules here.')
		expect(prompt).toContain('Local Claude rules here.')
		expect(prompt).toContain('Local agent rules here.')
		expect(prompt).toContain(`${cwd}/CLAUDE.local.md`)
		expect(prompt).toContain(`${cwd}/AGENTS.local.md`)
	})

	test('builds combined agent system prompt', async () => {
		const cwd = '/repo/apps/demo'
		const bash = createBashMock({
			[`cat "${cwd}/CLAUDE.md" 2>/dev/null`]: {
				exitCode: 1,
				stdout: '',
				stderr: '',
			},
			'cat "/repo/CLAUDE.md" 2>/dev/null': {
				exitCode: 0,
				stdout: 'Repository rules here.\n',
				stderr: '',
			},
			[`git -C "${cwd}" rev-parse --show-toplevel 2>/dev/null`]: {
				exitCode: 0,
				stdout: '/repo\n',
				stderr: '',
			},
		})

		const prompt = await createAgentSystemPrompt({
			bash,
			cwd,
			model: 'gpt-5.4',
			systemPromptAdditions: ['Extra guidance'],
			date: new Date('2026-04-21T00:00:00Z'),
		})

		expect(prompt[0]).toBe(codexPrompt)
		expect(prompt.join('\n\n')).toContain('Repository rules here.')
		expect(prompt.join('\n\n')).toContain('Extra guidance')
	})
})
