// @ts-nocheck — vendored from opencode, tested upstream under different tsconfig
import { Context, Effect, Layer } from 'effect'

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

export const LLMDiagnostics = {
	Service,
	noopLayer,
} as const
