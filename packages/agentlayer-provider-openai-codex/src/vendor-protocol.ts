import type { Effect, Schema } from 'effect'
import { protocol as _protocol } from './vendor/opencode-llm/protocols/openai-responses'

export interface ProtocolStream {
	event: Schema.Schema<unknown>
	initial: () => unknown
	step: (state: unknown, event: unknown) => Effect.Effect<readonly [unknown, readonly unknown[]], unknown>
	terminal: (event: unknown) => boolean
}

export const protocol: { stream: ProtocolStream } = _protocol as { stream: ProtocolStream }
