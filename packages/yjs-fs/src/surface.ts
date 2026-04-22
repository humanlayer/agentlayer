import type { DurableStreamsTransportMode } from './durable-streams/shared'

export type DurableStreamsClientOptions = {
	mode: DurableStreamsTransportMode
}

export type DurableStreamsServerOptions = {
	mode: DurableStreamsTransportMode
}
