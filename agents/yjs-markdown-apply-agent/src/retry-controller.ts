import type { ApplyRetryPolicy } from './types'

export const DEFAULT_APPLY_RETRY_POLICY: ApplyRetryPolicy = {
	maxAttempts: 3,
	initialBackoffMs: 250,
	maxBackoffMs: 2000,
	waitForQuietMs: 1000,
	maxWaitForQuietMs: 10000,
}

export type RetryDecision =
	| { type: 'retry'; attempt: number; delayMs: number }
	| { type: 'fail'; reason: 'max-attempts-exceeded' | 'quiet-timeout-exceeded' }

export function nextRetryDecision(input: {
	attempt: number
	policy?: Partial<ApplyRetryPolicy>
	waitedForQuietMs?: number
}): RetryDecision {
	const policy = { ...DEFAULT_APPLY_RETRY_POLICY, ...input.policy }
	if (input.attempt >= policy.maxAttempts) {
		return { type: 'fail', reason: 'max-attempts-exceeded' }
	}

	if ((input.waitedForQuietMs ?? 0) > policy.maxWaitForQuietMs) {
		return { type: 'fail', reason: 'quiet-timeout-exceeded' }
	}

	const exponentialDelay = policy.initialBackoffMs * 2 ** Math.max(0, input.attempt - 1)
	return {
		type: 'retry',
		attempt: input.attempt + 1,
		delayMs: Math.min(policy.maxBackoffMs, Math.max(policy.waitForQuietMs, exponentialDelay)),
	}
}
