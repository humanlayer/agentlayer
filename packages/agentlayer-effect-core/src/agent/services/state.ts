import type { AgentState } from '@humanlayer/agentlayer-core'
import { Context, Effect, Layer, SynchronizedRef } from 'effect'

/**
 * Services for updating / getting the agent's state
 */

export class AgentStateService extends Context.Tag('AgentStateService')<
	AgentStateService,
	{
		readonly get: Effect.Effect<AgentState>
		readonly update: (f: (state: AgentState) => AgentState) => Effect.Effect<void>
	}
>() {}

/**
 * Effect to create an intii
 * @param initialState
 * @returns
 */
export const AgentStateServiceLive = Layer.effect(
	AgentStateService,
	Effect.gen(function* () {
		const ref = yield* SynchronizedRef.make<AgentState>({
			messages: [],
			toolState: {},
		})
		return {
			get: SynchronizedRef.get(ref),

			update: (f) => SynchronizedRef.update(ref, f),
		}
	}),
)
