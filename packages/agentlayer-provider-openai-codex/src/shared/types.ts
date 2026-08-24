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
	/**
	 * Opaque diagnostics context forwarded by the host (e.g. CodeLayer/Riptide).
	 * The provider installs a concrete `LLMDiagnostics` layer that forwards each
	 * structured record to `ctx.onEvent`. The provider never inspects the sink's
	 * internals (file paths, Sentry, loggers).
	 */
	diagnostics?: CodexDiagnosticsContext
}

/**
 * One structured provider-diagnostics record. Built by the provider's
 * diagnostics layer from the host-provided static annotations merged with the
 * per-call `event`, `severity`, `transport`, and dynamic metadata.
 */
export interface CodexDiagnosticRecord {
	/** Diagnostic event key, e.g. `codex.provider.stream.failed`. */
	event: string
	/** `debug` | `info` | `warning` | `error`. */
	severity: CodexDiagnosticSeverity
	/** Transport mode the provider is running, added by the provider. */
	transport: CodexDiagnosticTransport
	/** Static annotations from the host (sessionId, taskId, model, provider, daemonBootId, ...). */
	annotations: Record<string, unknown>
	/** Dynamic per-call metadata (attempt, requestId, operation, terminal, error taxonomy fields). */
	metadata: Record<string, unknown>
}

export type CodexDiagnosticSeverity = 'debug' | 'info' | 'warning' | 'error'

export type CodexDiagnosticTransport = 'sse' | 'websockets' | 'custom_responses'

/**
 * Opaque diagnostics context the host threads through CodeLayer into the Codex
 * provider factory. The host owns `onEvent` (file append, Sentry, etc.); the
 * provider only builds records and calls it.
 */
export interface CodexDiagnosticsContext {
	/** Static correlation annotations: sessionId, taskId, model, provider, daemonBootId. */
	annotations: Record<string, unknown>
	/** Receives each structured diagnostics record. Must never throw into the stream. */
	onEvent(record: CodexDiagnosticRecord): void
}
