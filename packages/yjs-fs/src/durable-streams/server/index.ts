import type { DurableStreamsServerOptions } from '../../surface'
import { startDurableStreamsDevServer } from './dev-server'
export type { DurableStreamsServerOptions }
export type { DurableStreamsDevServer } from './dev-server'
export { startDurableStreamsDevServer } from './dev-server'

export function defineDurableStreamsServer(options: DurableStreamsServerOptions = {}) {
	return {
		options,
		start() {
			startDurableStreamsDevServer(options)
		},
	}
}
