import {
	LLMDiagnostics,
	type Service as LLMDiagnosticsService,
} from '@humanlayer/opencode-llm-vendor/route/diagnostics'
import { Effect, Layer } from 'effect'
import type {
	CodexDiagnosticRecord,
	CodexDiagnosticSeverity,
	CodexDiagnosticsContext,
	CodexDiagnosticTransport,
} from './types'

export interface CodexDiagnosticsLayerOptions {
	/** Transport mode this provider runs, stamped onto every record. */
	transport: CodexDiagnosticTransport
}

/**
 * Build a concrete `LLMDiagnostics` layer that forwards each vendor diagnostic
 * call to the host-provided `ctx.onEvent`. Each call assembles a structured
 * {@link CodexDiagnosticRecord} merging the host's static `annotations`, the
 * provider's `transport`, and the per-call `event`/severity/metadata.
 *
 * Every `onEvent` invocation is wrapped so a throwing sink can never affect the
 * model stream's control flow — sink failures are swallowed.
 */
export function makeCodexDiagnosticsLayer(
	ctx: CodexDiagnosticsContext,
	options: CodexDiagnosticsLayerOptions,
): Layer.Layer<LLMDiagnosticsService> {
	const emit = (severity: CodexDiagnosticSeverity, event: string, metadata?: Record<string, unknown>) =>
		Effect.sync(() => {
			const record: CodexDiagnosticRecord = {
				event,
				severity,
				transport: options.transport,
				annotations: ctx.annotations,
				metadata: metadata ?? {},
			}
			try {
				ctx.onEvent(record)
			} catch {
				// Diagnostics must never break the model stream.
			}
		})

	return Layer.succeed(
		LLMDiagnostics.Service,
		LLMDiagnostics.Service.of({
			debug: (event, metadata) => emit('debug', event, metadata),
			info: (event, metadata) => emit('info', event, metadata),
			warning: (event, metadata) => emit('warning', event, metadata),
			error: (event, metadata) => emit('error', event, metadata),
		}),
	)
}
