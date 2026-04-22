export type DurableStreamsClientOptions = {
	mode: 'single-stream' | 'per-document'
}

export type DurableStreamsServerOptions = {
	mode: DurableStreamsClientOptions['mode']
}
