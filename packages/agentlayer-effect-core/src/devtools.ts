import { DevTools } from '@effect/experimental'
import { NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'

const program = Effect.log('Hello!').pipe(
	Effect.delay(2000),
	Effect.withSpan('Hi', { attributes: { foo: 'bar' } }),
	Effect.forever,
)
const DevToolsLive = DevTools.layer()

program.pipe(Effect.provide(DevToolsLive), NodeRuntime.runMain)
