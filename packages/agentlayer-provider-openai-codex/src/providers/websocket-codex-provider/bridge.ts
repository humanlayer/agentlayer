import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { Effect, Fiber, Stream } from 'effect'

// Debug logging gated behind DEBUG_CODEX_WS=1
const DEBUG = process.env.DEBUG_CODEX_WS === '1'
const dbg = (...args: unknown[]) => {
	if (DEBUG) console.error('[codex-ws]', ...args)
}

/**
 * Convert an Effect Stream into a ReadableStream, with optional AbortSignal
 * support. When the abort signal fires, the Effect fiber is interrupted which
 * propagates through the vendor's acquireRelease to close the WebSocket.
 */
export function effectStreamToReadableStream(
	effectStream: Stream.Stream<LanguageModelV3StreamPart, unknown>,
	abortSignal?: AbortSignal,
): ReadableStream<LanguageModelV3StreamPart> {
	let cancelled = false
	let fiberRef: ReturnType<typeof Effect.runFork> | undefined

	return new ReadableStream<LanguageModelV3StreamPart>({
		start(controller) {
			dbg('ReadableStream.start — launching fiber')
			// Run the Effect stream, pushing each element into the ReadableStream controller
			const program = Stream.runForEach(effectStream, (part) =>
				Effect.sync(() => {
					if (!cancelled) {
						dbg('enqueue:', part.type)
						controller.enqueue(part)
					}
				}),
			).pipe(Effect.scoped)

			const fiber = Effect.runFork(program)
			fiberRef = fiber

			// When the fiber completes, close or error the controller
			Fiber.join(fiber)
				.pipe(Effect.runPromise)
				.then(() => {
					dbg('fiber completed — closing controller')
					if (!cancelled) controller.close()
				})
				.catch((err) => {
					dbg('fiber failed:', err instanceof Error ? err.message : typeof err, err)
					if (!cancelled) {
						const error =
							err instanceof Error ? err : new Error(`LLM stream failed: ${JSON.stringify(err)}`)
						try {
							controller.error(error)
						} catch {
							// controller may already be closed
						}
					}
				})

			// Wire abort signal to fiber interruption (DQ6 pattern)
			if (abortSignal) {
				if (abortSignal.aborted) {
					cancelled = true
					Fiber.interrupt(fiber)
						.pipe(Effect.runPromise)
						.catch(() => {})
					controller.close()
				} else {
					const onAbort = () => {
						cancelled = true
						Fiber.interrupt(fiber)
							.pipe(Effect.runPromise)
							.catch(() => {})
						try {
							controller.close()
						} catch {
							// controller may already be closed
						}
					}
					abortSignal.addEventListener('abort', onAbort, { once: true })
				}
			}
		},
		cancel() {
			dbg('ReadableStream.cancel called')
			cancelled = true
			if (fiberRef) {
				Fiber.interrupt(fiberRef)
					.pipe(Effect.runPromise)
					.catch(() => {})
			}
		},
	})
}
