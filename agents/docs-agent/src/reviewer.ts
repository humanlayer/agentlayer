import { anthropic } from '@ai-sdk/anthropic'
import { Agent, extractLastAssistantText, maxSteps, startState } from '@humanlayer/agentlayer-core'
import {
	createGlobTool,
	createGrepTool,
	createListTool,
	createReadTool,
} from '@humanlayer/agentlayer-filesystem/tools'

export interface DocsReviewerOptions {
	cwd: string
	diff: string
	changedFiles: string[]
	dryRun?: boolean
}

function buildReviewPrompt(diff: string, changedFiles: string[]) {
	return [
		'Review whether the current documentation adequately covers these source changes.',
		'Inspect the existing docs under packages/docs/content/ before deciding what to recommend.',
		'Only recommend concrete markdown updates that are justified by the diff.',
		'If the docs already cover the change, say so briefly and avoid speculative work.',
		'Respond in markdown with these sections:',
		'## Verdict',
		'## Recommended Updates',
		'## Files Worth Updating',
		'',
		'Changed source files:',
		...changedFiles.map((file) => `- ${file}`),
		'',
		'Git diff:',
		'```diff',
		diff,
		'```',
	].join('\n')
}

function buildHeuristicReview(changedFiles: string[]) {
	const changedList = changedFiles.length > 0 ? changedFiles.map((file) => `- ${file}`).join('\n') : '- none'
	return [
		'## Verdict',
		'Dry-run fallback: the Anthropic reviewer was not invoked, so this is a heuristic pass only.',
		'',
		'## Recommended Updates',
		'- Check whether any public API, tool contract, or runtime behavior changes need updates in `packages/docs/content/index.md` or `packages/docs/content/introduction/architecture.md`.',
		'- If examples or setup flows changed, add or refresh markdown under `packages/docs/content/` before merging.',
		'',
		'## Files Worth Updating',
		changedList,
	].join('\n')
}

export async function runDocsReviewer(opts: DocsReviewerOptions) {
	if (!opts.diff.trim()) {
		return ['## Verdict', 'No relevant source changes were detected for docs review.', '', '## Recommended Updates', '- None.', '', '## Files Worth Updating', '- none'].join('\n')
	}

	if (!process.env.ANTHROPIC_API_KEY || opts.dryRun) {
		return buildHeuristicReview(opts.changedFiles)
	}

	const agent = new Agent({
		model: anthropic('claude-sonnet-4-20250514'),
		tools: {
			read: createReadTool({ cwd: opts.cwd }),
			glob: createGlobTool({ cwd: opts.cwd }),
			grep: createGrepTool({ cwd: opts.cwd }),
			list: createListTool({ cwd: opts.cwd }),
		},
		system: [
			'You review AgentLayer documentation for source changes.',
			'The docs live under packages/docs/content/.',
			'Only recommend concrete markdown updates tied to the provided diff.',
			'Do not suggest changes outside packages/docs/content/.',
		],
		stopWhen: [maxSteps(12)],
	})

	const result = await agent.run({
		state: startState([{ role: 'user', content: buildReviewPrompt(opts.diff, opts.changedFiles) }]),
	}).result

	return extractLastAssistantText(result)
}
