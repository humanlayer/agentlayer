import type { AgentState } from '@humanlayer/agentlayer-core'
import { Context, Effect, Layer, SynchronizedRef } from 'effect'
import { SpanName } from '../observability/span-names'
/**
 * Services for updating / getting the agent's state
 */

export class AgentStateService extends Context.Tag('AgentStateService')<
	AgentStateService,
	{
		readonly get: Effect.Effect<AgentState>
		readonly set: (state: AgentState) => Effect.Effect<void>
		readonly update: (f: (state: AgentState) => AgentState) => Effect.Effect<void>
		readonly updateEffect: <E, R>(
			f: (state: AgentState) => Effect.Effect<AgentState, E, R>,
		) => Effect.Effect<void, E, R>
		readonly modifyEffect: <A, E, R>(
			f: (state: AgentState) => Effect.Effect<readonly [A, AgentState], E, R>,
		) => Effect.Effect<A, E, R>
	}
>() {}

/**
 * Effect to create an intii
 * @param initialState
 * @returns
 */
export const AgentStateServiceLive = (initialState: AgentState = { messages: [], toolState: {} }) =>
	Layer.effect(
		AgentStateService,
		Effect.gen(function* () {
			const ref = yield* SynchronizedRef.make<AgentState>(initialState)

			const modifyEffect = <A, E, R>(
				f: (state: AgentState) => Effect.Effect<readonly [A, AgentState], E, R>,
			): Effect.Effect<A, E, R> =>
				Effect.gen(function* () {
					const result = yield* SynchronizedRef.modifyEffect(ref, f)
					const state = yield* SynchronizedRef.get(ref)

					yield* Effect.logDebug('agent state updated').pipe(
						Effect.annotateLogs({
							'agent.state.messages.count': state.messages.length,
							'agent.state.toolState.keys.count': Object.keys(state.toolState ?? {}).length,
							'agent.state.pendingToolCalls.count': state.pendingToolCalls?.length ?? 0,
						}),
					)

					return result
				}).pipe(Effect.withSpan(SpanName.agentStateUpdate()))

			const updateEffect = <E, R>(
				f: (state: AgentState) => Effect.Effect<AgentState, E, R>,
			): Effect.Effect<void, E, R> =>
				modifyEffect((state) =>
					Effect.gen(function* () {
						const nextState = yield* f(state)
						return [undefined, nextState] as const
					}),
				)

			return {
				get: SynchronizedRef.get(ref),
				set: (state) => updateEffect(() => Effect.succeed(state)),
				update: (f) => updateEffect((state) => Effect.succeed(f(state))),
				updateEffect,
				modifyEffect,
			}
		}),
	)
