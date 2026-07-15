// @ts-nocheck — vendored from opencode, tested upstream under different tsconfig
import { Context, Effect, Layer } from 'effect'
import { LLMError as LLMErrorClass } from '../schema'

/**
 * Generic, implementation-agnostic diagnostics service for the LLM route
 * pipeline. The vendor emits structured provider diagnostics (retries,
 * swallowed fallback errors, timeouts, provider-error events, terminal
 * failures) through this service without depending on file I/O, Sentry, or any
 * daemon logger.
 *
 * Consumers (e.g. `agentlayer-provider-openai-codex`) install a concrete layer
 * that forwards each call to a host-provided sink. When no sink is provided the
 * `noopLayer` is used so the service requirement is always satisfiable and the
 * stream control flow is never affected.
 *
 * Modeled on `WebSocketExecutor` (`Context.Service`) so it can be resolved
 * optionally via `Effect.serviceOption` and provided as a normal layer.
 */
export interface Interface {
	readonly debug: (event: string, metadata?: Record<string, unknown>) => Effect.Effect<void>
	readonly info: (event: string, metadata?: Record<string, unknown>) => Effect.Effect<void>
	readonly warning: (event: string, metadata?: Record<string, unknown>) => Effect.Effect<void>
	readonly error: (event: string, metadata?: Record<string, unknown>) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()('@opencode/LLM/Diagnostics') {}

/**
 * Default no-op implementation used when no diagnostics sink is installed.
 * Every method is a successful, side-effect-free effect so resolving the
 * service never changes control flow.
 */
export const noopLayer: Layer.Layer<Service> = Layer.succeed(
	Service,
	Service.of({
		debug: () => Effect.void,
		info: () => Effect.void,
		warning: () => Effect.void,
		error: () => Effect.void,
	}),
)

// Serialize the vendored `LLMError` reason taxonomy into a flat metadata bag
// for diagnostics records. Carries the typed reason tag rather than flattening
// everything into a single string. Never includes prompt text, deltas, tokens,
// auth headers, or full bodies.
export const llmErrorMetadata = (error: unknown): Record<string, unknown> => {
	if (!(error instanceof LLMErrorClass)) {
		return { reasonTag: 'unknown', retryable: false }
	}
	const reason = error.reason
	return {
		module: error.module,
		method: error.method,
		retryable: error.retryable,
		reasonTag: reason?._tag,
		status: reason && 'status' in reason ? reason.status : undefined,
		retryAfterMs: error.retryAfterMs,
		transportKind: reason && 'kind' in reason ? reason.kind : undefined,
	}
}

// Heuristic for detecting transport-level errors (socket close, connection
// reset, network failures) from raw JavaScript Error objects or Effect HTTP
// client errors. Used by both http.ts (Stream.mapError for typed failures)
// and client.ts (streamError for defects/Die causes that bypass mapError).
export const isTransportError = (error: unknown): boolean => {
	if (error instanceof Error) {
		const msg = error.message.toLowerCase()
		if (
			msg.includes('socket') ||
			msg.includes('econnreset') ||
			msg.includes('econnrefused') ||
			msg.includes('epipe') ||
			msg.includes('etimedout') ||
			msg.includes('network') ||
			msg.includes('aborted') ||
			msg.includes('closed unexpectedly') ||
			msg.includes('connection') ||
			msg.includes('fetch failed')
		)
			return true
	}
	return false
}

// Fallback diagnostics used when no `LLMDiagnostics` sink is installed in the
// runtime. Every method is a successful, side-effect-free effect so emitting a
// diagnostic never changes stream control flow.
export const noopDiagnostics: Interface = {
	debug: () => Effect.void,
	info: () => Effect.void,
	warning: () => Effect.void,
	error: () => Effect.void,
}

export const LLMDiagnostics = {
	Service,
	noopLayer,
} as const
