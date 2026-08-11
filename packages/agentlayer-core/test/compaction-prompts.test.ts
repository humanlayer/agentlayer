import { describe, expect, test } from 'bun:test'
import {
	buildCompactionRequestText,
	buildTurnPrefixCompactionRequestText,
	DEFAULT_COMPACTION_PROMPT,
	DEFAULT_COMPACTION_UPDATE_PROMPT,
	TURN_PREFIX_COMPACTION_PROMPT,
} from '../src/compaction'

describe('compaction prompts', () => {
	test('frames an initial summary request with every required section', () => {
		const request = buildCompactionRequestText({ conversationText: '[User]: implement it' })
		expect(request.startsWith('<conversation>\n[User]: implement it\n</conversation>\n\n')).toBe(true)
		expect(request).toContain(DEFAULT_COMPACTION_PROMPT)
		expect(request).not.toContain('<previous-summary>')
		for (const heading of [
			'## Goal',
			'## Constraints & Preferences',
			'## Progress',
			'## Key Decisions',
			'## Next Steps',
			'## Critical Context',
		]) {
			expect(request).toContain(heading)
		}
		expect(request).not.toContain('## Commands & Verification')
		expect(request).not.toContain('commands or workflows')
		expect(request).not.toContain('verification workflow')
	})

	test('frames incremental updates without command or verification preservation instructions', () => {
		const request = buildCompactionRequestText({
			conversationText: '[Assistant]: implementation is complete',
			previousSummary: '## Progress\n### In Progress\n- [ ] Implement the change',
		})
		expect(request).toContain(
			'<previous-summary>\n## Progress\n### In Progress\n- [ ] Implement the change\n</previous-summary>',
		)
		expect(request).toContain(DEFAULT_COMPACTION_UPDATE_PROMPT)
		expect(request).not.toContain('## Commands & Verification')
		expect(request).not.toContain('PRESERVE still-valid commands')
		expect(request).not.toContain('REMOVE stale commands')
		expect(request).not.toContain('verification workflows')
	})

	test('appends manual guidance after rather than replacing the fixed template', () => {
		const request = buildCompactionRequestText({
			conversationText: '[User]: continue',
			additionalInstructions: 'Focus on unresolved blockers.',
		})
		expect(request).toContain(DEFAULT_COMPACTION_PROMPT)
		expect(request).toEndWith('Additional user guidance for this summary:\nFocus on unresolved blockers.')
		expect(request.indexOf('Use this EXACT format:')).toBeLessThan(request.indexOf('Additional user guidance'))
	})

	test('initial and incremental overrides replace only their corresponding default templates', () => {
		const initial = buildCompactionRequestText({
			conversationText: 'initial work',
			compactionPrompt: 'Use the initial company checkpoint format.',
			compactionUpdatePrompt: 'Use the incremental company checkpoint format.',
			additionalInstructions: 'Focus on the active blocker.',
		})
		expect(initial).toBe(
			'<conversation>\ninitial work\n</conversation>\n\nUse the initial company checkpoint format.\n\nAdditional user guidance for this summary:\nFocus on the active blocker.',
		)
		expect(initial).not.toContain(DEFAULT_COMPACTION_PROMPT)
		expect(initial).not.toContain('incremental company')

		const incremental = buildCompactionRequestText({
			conversationText: 'new work',
			previousSummary: 'old work',
			compactionPrompt: 'Use the initial company checkpoint format.',
			compactionUpdatePrompt: 'Use the incremental company checkpoint format.',
			additionalInstructions: 'Focus on the active blocker.',
		})
		expect(incremental).toBe(
			'<conversation>\nnew work\n</conversation>\n\n<previous-summary>\nold work\n</previous-summary>\n\nUse the incremental company checkpoint format.\n\nAdditional user guidance for this summary:\nFocus on the active blocker.',
		)
		expect(incremental).not.toContain(DEFAULT_COMPACTION_UPDATE_PROMPT)
		expect(incremental).not.toContain('initial company')
	})

	test('frames a concise turn-prefix request without one-shot summary guidance', () => {
		const request = buildTurnPrefixCompactionRequestText('[User]: oversized turn')
		expect(request).toContain(TURN_PREFIX_COMPACTION_PROMPT)
		expect(request).toContain('<conversation>\n[User]: oversized turn\n</conversation>')
		expect(request).not.toContain('Additional user guidance')
	})
})
