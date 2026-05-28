import { CODEX_FAST_SERVICE_TIER } from './constants'

export function normalizeCodexServiceTier(serviceTier: string | null | undefined): string | null | undefined {
	if (serviceTier == null) {
		return serviceTier
	}
	return serviceTier === 'fast' ? CODEX_FAST_SERVICE_TIER : serviceTier
}
