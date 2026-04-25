import type { YjsProvider } from '@durable-streams/y-durable-streams'

const AWARENESS_HEARTBEAT_INTERVAL_MS = 15_000
const PROVIDER_AWARENESS_PATCHED = Symbol('yjs-fs-editor.provider-awareness-patched')

type ConnectionContext = {
	controller: AbortController
	id: number
}

type RuntimeProvider = {
	[PROVIDER_AWARENESS_PATCHED]?: boolean
	awareness?: {
		clientID: number
	}
	awarenessHeartbeat: ReturnType<typeof setInterval> | null
	headers: HeadersInit | undefined
	broadcastAwareness: () => void
	applyAwarenessUpdates: (bytes: Uint8Array) => void
	awarenessUrl: (name?: string) => string
	startAwareness: (ctx: ConnectionContext) => void
	subscribeAwareness: (ctx: ConnectionContext) => Promise<void>
	connected: boolean
	connecting: boolean
}

export function patchProviderAwareness(provider: YjsProvider): void {
	const runtimeProvider = provider as unknown as RuntimeProvider
	if (runtimeProvider[PROVIDER_AWARENESS_PATCHED]) {
		return
	}

	runtimeProvider[PROVIDER_AWARENESS_PATCHED] = true

	runtimeProvider.startAwareness = function startAwareness(ctx: ConnectionContext): void {
		if (!this.awareness || ctx.controller.signal.aborted) {
			return
		}

		this.broadcastAwareness()

		this.awarenessHeartbeat = setInterval(() => {
			this.broadcastAwareness()
		}, AWARENESS_HEARTBEAT_INTERVAL_MS)

		void this.subscribeAwareness(ctx)
	}

	runtimeProvider.subscribeAwareness = async function subscribeAwareness(ctx: ConnectionContext): Promise<void> {
		if (!this.awareness) {
			return
		}

		const signal = ctx.controller.signal
		let offset = '-1'

		try {
			while (!signal.aborted && (this.connected || this.connecting)) {
				const url = new URL(this.awarenessUrl())
				url.searchParams.set('offset', offset)

				if (offset !== '-1') {
					url.searchParams.set('live', 'long-poll')
				}

				const response = await fetch(url, {
					method: 'GET',
					headers: this.headers,
					signal,
				})

				if (!response.ok) {
					throw new Error(`Awareness request failed: ${response.status} ${response.statusText}`)
				}

				const nextOffset = response.headers.get('stream-next-offset')
				const upToDate = response.headers.has('stream-up-to-date')
				const bytes = new Uint8Array(await response.arrayBuffer())

				if (bytes.length > 0) {
					this.applyAwarenessUpdates(bytes)
				}

				if (nextOffset) {
					offset = nextOffset
				}

				if (!upToDate && offset === '-1') {
					continue
				}
			}
		} catch (error) {
			if (signal.aborted || (!this.connected && !this.connecting)) {
				return
			}

			console.error('Provider awareness subscription failed:', error)
			await delay(1000, signal)

			if (this.connected) {
				await this.subscribeAwareness(ctx)
			}
		}
	}
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		return
	}

	await new Promise<void>((resolve) => {
		const timeout = globalThis.setTimeout(() => {
			signal.removeEventListener('abort', onAbort)
			resolve()
		}, ms)

		const onAbort = () => {
			globalThis.clearTimeout(timeout)
			resolve()
		}

		signal.addEventListener('abort', onAbort, { once: true })
	})
}
