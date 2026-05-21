/**
 * Debug logging for Codex provider.
 * Enable with DEBUG_AGENTLAYER=1 or DEBUG_AGENTLAYER=verbose
 */

const DEBUG = process.env.DEBUG_AGENTLAYER

export const debug = {
	enabled: !!DEBUG,
	verbose: DEBUG === 'verbose',

	log(category: string, message: string, data?: Record<string, unknown>) {
		if (!this.enabled) return
		const timestamp = new Date().toISOString()
		const dataStr = data ? ` ${JSON.stringify(data)}` : ''
		console.log(`[${timestamp}] [codex:${category}] ${message}${dataStr}`)
	},

	api(message: string, data?: Record<string, unknown>) {
		this.log('api', message, data)
	},

	stream(message: string, data?: Record<string, unknown>) {
		if (!this.verbose) return
		this.log('stream', message, data)
	},

	streamImportant(message: string, data?: Record<string, unknown>) {
		this.log('stream', message, data)
	},
}
