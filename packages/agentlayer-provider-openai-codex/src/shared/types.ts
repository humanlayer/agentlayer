import type { AuthStore } from '@humanlayer/agentlayer-provider-auth'
import type { CodexFetchLike } from '../oauth'

export interface CodexRequestOptions {
	/**
	 * Enable Codex fast mode. This sends `service_tier: "priority"`, matching
	 * the Codex CLI's fast-mode request behavior.
	 */
	fastMode?: boolean
	/**
	 * Explicit Codex service tier. The convenience value `"fast"` is normalized
	 * to the API value `"priority"`.
	 */
	serviceTier?: string | null
}

export interface CodexProviderOptions extends CodexRequestOptions {
	authStore?: AuthStore
	providerId?: string
	fetch?: CodexFetchLike
	version?: string
	sessionId?: string
	now?: () => number
}
