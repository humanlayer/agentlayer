import { describe, expect, test } from 'bun:test'
import { APPLY_AGENT_SYSTEM_PROMPT, buildAbortSystemInformation, buildApplyUserMessage } from '../src/prompts'
import type { ApplyAttemptAbort, SecureApplyInput } from '../src/types'

const baseInput: SecureApplyInput = {
	path: '/artifacts/plan.md',
	oldString: 'old',
	newString: 'new',
	currentMarkdown: '# Old',
	currentXml: '<heading>Old</heading>',
	snapshotBase64: 'snapshot-1',
	baseStateVectorBase64: 'state-vector-1',
	artifactFragmentName: 'artifact:/artifacts/plan.md',
	baseArtifactRevision: 1,
}

describe('apply prompt cache shape', () => {
	test('keeps stable system prompt separate from dynamic document state', () => {
		const first = buildApplyUserMessage(baseInput)
		const second = buildApplyUserMessage({
			...baseInput,
			currentMarkdown: '# Newer',
			currentXml: '<heading>Newer</heading>',
			snapshotBase64: 'snapshot-2',
			baseStateVectorBase64: 'state-vector-2',
			baseArtifactRevision: 2,
		})

		expect(APPLY_AGENT_SYSTEM_PROMPT).toContain('Stable contract')
		expect(APPLY_AGENT_SYSTEM_PROMPT).not.toContain('snapshot-1')
		expect(first).toContain('snapshot-1')
		expect(second).toContain('snapshot-2')
		expect(first).not.toEqual(second)
	})

	test('adds system-information to retry user message', () => {
		const abort: ApplyAttemptAbort = {
			reason: 'target-fragment-changed',
			path: '/artifacts/plan.md',
			previousRevision: 1,
			currentRevision: 2,
			changeSummary: ['external insert'],
			updatedMarkdown: '# External',
			updatedXml: '<heading>External</heading>',
			snapshotBase64: 'snapshot-2',
			baseStateVectorBase64: 'state-vector-2',
		}

		const systemInformation = buildAbortSystemInformation(abort)
		const retry = buildApplyUserMessage({
			...baseInput,
			systemInformation,
			currentMarkdown: abort.updatedMarkdown,
			currentXml: abort.updatedXml,
			snapshotBase64: abort.snapshotBase64,
			baseStateVectorBase64: abort.baseStateVectorBase64,
			baseArtifactRevision: abort.currentRevision,
		})

		expect(retry).toContain('<system-information>')
		expect(retry).toContain('previous secure apply attempt was aborted')
		expect(retry).toContain('snapshot-2')
	})
})
