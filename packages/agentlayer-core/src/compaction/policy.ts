/** Why a compaction checkpoint was created. */
export type CompactionTrigger = 'manual' | 'threshold' | 'overflow'

/** Provider-neutral compaction configuration for an Agent. */
export type AutoCompactConfig =
	| { enabled: false }
	| {
			enabled?: true
			/** Override the automatic compaction threshold. */
			thresholdTokens?: number
			/** Override the context window used for compaction budget calculations. */
			contextWindow?: number
			/** Tokens kept free below the output allowance. */
			reserveTokens?: number
			/** Recent native-message context retained after a checkpoint. */
			keepRecentTokens?: number
			/** Replace the default instruction for an initial checkpoint while retaining request framing. */
			compactionPrompt?: string
			/** Replace the default instruction for an incremental checkpoint while retaining request framing. */
			compactionUpdatePrompt?: string
	  }

export interface ResolvedCompactionPolicy {
	enabled: boolean
	thresholdTokens?: number
	contextWindow?: number
	reserveTokens: number
	keepRecentTokens: number
	compactionPrompt?: string
	compactionUpdatePrompt?: string
}

export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384
export const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20_000
export const MAX_COMPACTION_OUTPUT_TOKENS = 32_000
export const COMPACTION_OUTPUT_BUDGET_RATIO = 0.8
export const TURN_PREFIX_OUTPUT_BUDGET_RATIO = 0.5

/** Resolve the provider-neutral output cap for a history or split-turn-prefix summary. */
export function resolveCompactionMaxOutputTokens(input: {
	reserveTokens?: number
	modelOutputLimit?: number
	turnPrefix?: boolean
}): number {
	const outputBudget = Math.max(1, Math.floor(input.reserveTokens ?? DEFAULT_COMPACTION_RESERVE_TOKENS))
	const ratio = input.turnPrefix ? TURN_PREFIX_OUTPUT_BUDGET_RATIO : COMPACTION_OUTPUT_BUDGET_RATIO
	const reservedCap = Math.max(1, Math.floor(outputBudget * ratio))
	return input.modelOutputLimit === undefined
		? reservedCap
		: Math.max(1, Math.min(reservedCap, Math.floor(input.modelOutputLimit)))
}

/** Resolve omitted configuration to the default-enabled policy. */
export function resolveCompactionPolicy(config?: AutoCompactConfig): ResolvedCompactionPolicy {
	if (config?.enabled === false) {
		return {
			enabled: false,
			reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS,
			keepRecentTokens: DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
		}
	}

	return {
		enabled: true,
		...(config?.thresholdTokens !== undefined ? { thresholdTokens: config.thresholdTokens } : {}),
		...(config?.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}),
		reserveTokens: config?.reserveTokens ?? DEFAULT_COMPACTION_RESERVE_TOKENS,
		keepRecentTokens: config?.keepRecentTokens ?? DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
		...(config?.compactionPrompt !== undefined ? { compactionPrompt: config.compactionPrompt } : {}),
		...(config?.compactionUpdatePrompt !== undefined
			? { compactionUpdatePrompt: config.compactionUpdatePrompt }
			: {}),
	}
}

/** Fold-compatible usable context budget before automatic compaction. */
export function compactionUsableTokens(input: { contextWindow: number; reserveTokens?: number }): number {
	const contextWindow = Math.max(1, Math.floor(input.contextWindow))
	const outputBudget = Math.min(MAX_COMPACTION_OUTPUT_TOKENS, Math.floor(contextWindow / 4))
	const reserve = Math.min(input.reserveTokens ?? DEFAULT_COMPACTION_RESERVE_TOKENS, Math.floor(contextWindow / 8))
	return Math.max(1, contextWindow - outputBudget - reserve)
}

/** Resolve an explicit threshold or derive one from the effective context window. */
export function resolveCompactionThreshold(
	policy: ResolvedCompactionPolicy,
	contextWindowLimit?: number,
): number | undefined {
	if (policy.thresholdTokens !== undefined) return Math.max(1, Math.floor(policy.thresholdTokens))
	const contextWindow = policy.contextWindow ?? contextWindowLimit
	if (contextWindow === undefined) return undefined
	return compactionUsableTokens({ contextWindow, reserveTokens: policy.reserveTokens })
}
