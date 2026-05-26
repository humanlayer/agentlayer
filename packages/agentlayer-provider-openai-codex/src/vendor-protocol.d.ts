import type { Effect, Schema } from 'effect'

export interface ProtocolStream {
	event: Schema.Schema<unknown>
	initial: () => unknown
	step: (state: unknown, event: unknown) => Effect.Effect<readonly [unknown, readonly unknown[]], unknown>
	terminal: (event: unknown) => boolean
}

export declare const protocol: { stream: ProtocolStream }
