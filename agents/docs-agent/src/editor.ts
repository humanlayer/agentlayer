import { isAbsolute, relative } from 'node:path'
import {
	Agent,
	createApprovalHook,
	EditTool,
	extractLastAssistantText,
	maxSteps,
	startState,
	WriteTool,
} from '@humanlayer/agentlayer-core'
import { createClaudeAgentFilesystemToolset } from '@humanlayer/agentlayer-filesystem'
import { DEFAULT_MODELS, resolveModel } from '@humanlayer/codelayer'

const DOCS_ROOT = 'packages/docs/content/'

export interface DocsEditorOptions {
	cwd: string
	diff: string
	recommendations: string
	dryRun?: boolean
}

function toRepoRelativePath(cwd: string, filePath: string) {
	const normalized = filePath.replaceAll('\\', '/').replace(/^\.\//, '')
	if (!isAbsolute(normalized)) {
		return normalized
	}
	return relative(cwd, normalized).replaceAll('\\', '/')
}

function buildEditorPrompt(diff: string, recommendations: string) {
	return [
		'Update the AgentLayer documentation to cover the supplied code changes.',
		'Only edit markdown files under packages/docs/content/.',
		'Read the relevant existing docs before writing changes.',
		'Keep edits concrete, minimal, and aligned to the diff.',
		'Before finishing, run `bun run --cwd packages/docs docs:build` and fix any docs issues you introduced.',
		'',
		'Reviewer recommendations:',
		recommendations,
		'',
		'Git diff:',
		'```diff',
		diff,
		'```',
	].join('\n')
}

export async function runDocsEditor(opts: DocsEditorOptions) {
	if (!process.env.FIREWORKS_API_KEY) {
		if (opts.dryRun) {
			return 'Dry run: skipped editor because FIREWORKS_API_KEY is not set.'
		}
		throw new Error('FIREWORKS_API_KEY is required to run docs-agent apply mode.')
	}

	const markdownOnly = createApprovalHook([WriteTool, EditTool] as const, (ctx) => {
		const filePath = toRepoRelativePath(opts.cwd, ctx.input.file_path)
		if (!filePath.startsWith(DOCS_ROOT)) {
			return ctx.deny(`Docs agent may only edit ${DOCS_ROOT}, got ${ctx.input.file_path}`)
		}
		if (!filePath.endsWith('.md')) {
			return ctx.deny(`Docs agent may only edit markdown files, got ${ctx.input.file_path}`)
		}
		return ctx.next()
	})

	const agent = new Agent({
		model: await resolveModel('firepass', DEFAULT_MODELS.firepass),
		tools: createClaudeAgentFilesystemToolset({ cwd: opts.cwd }),
		system: [
			'You update AgentLayer docs to match code changes.',
			'Only modify markdown files under packages/docs/content/.',
			'Do not edit source code, package metadata, workflows, or configuration files.',
			'Validate docs with `bun run --cwd packages/docs docs:build` before you finish.',
		],
		hooks: {
			approval: [markdownOnly],
		},
		stopWhen: [maxSteps(20)],
	})

	const result = await agent.run({
		state: startState([{ role: 'user', content: buildEditorPrompt(opts.diff, opts.recommendations) }]),
	}).result

	return extractLastAssistantText(result)
}
