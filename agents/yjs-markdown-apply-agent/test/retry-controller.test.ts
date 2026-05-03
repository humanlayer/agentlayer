import { describe, expect, test } from 'bun:test'
import { nextRetryDecision } from '../src/retry-controller'

describe('apply retry controller', () => {
	test('backs off with a quiet-period floor', () => {
		expect(
			nextRetryDecision({
				attempt: 1,
				policy: { initialBackoffMs: 100, waitForQuietMs: 750, maxBackoffMs: 5000 },
			}),
		).toEqual({ type: 'retry', attempt: 2, delayMs: 750 })
	})

	test('caps retry delay', () => {
		expect(
			nextRetryDecision({
				attempt: 5,
				policy: { maxAttempts: 10, initialBackoffMs: 1000, waitForQuietMs: 100, maxBackoffMs: 1500 },
			}),
		).toEqual({ type: 'retry', attempt: 6, delayMs: 1500 })
	})

	test('fails after retry budget is exhausted', () => {
		expect(nextRetryDecision({ attempt: 3, policy: { maxAttempts: 3 } })).toEqual({
			type: 'fail',
			reason: 'max-attempts-exceeded',
		})
	})

	test('fails after quiet wait budget is exhausted', () => {
		expect(nextRetryDecision({ attempt: 1, waitedForQuietMs: 11_000, policy: { maxWaitForQuietMs: 10_000 } })).toEqual({
			type: 'fail',
			reason: 'quiet-timeout-exceeded',
		})
	})
})
