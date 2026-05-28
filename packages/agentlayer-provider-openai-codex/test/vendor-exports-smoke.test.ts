import { describe, expect, it } from 'bun:test'

describe('vendor package export subpaths', () => {
	it('resolves @humanlayer/opencode-llm-vendor/route/client', async () => {
		const mod = await import('@humanlayer/opencode-llm-vendor/route/client')
		expect(mod).toBeDefined()
		// LLMClient should be exported with a layer property
		expect(mod.layer).toBeDefined()
	})

	it('resolves @humanlayer/opencode-llm-vendor/route/executor', async () => {
		const mod = await import('@humanlayer/opencode-llm-vendor/route/executor')
		expect(mod).toBeDefined()
		// RequestExecutor should export a defaultLayer
		expect(mod.defaultLayer).toBeDefined()
	})

	it('resolves @humanlayer/opencode-llm-vendor/route/auth', async () => {
		const mod = await import('@humanlayer/opencode-llm-vendor/route/auth')
		expect(mod).toBeDefined()
		// Auth should export a bearer function
		expect(mod.bearer).toBeDefined()
	})

	it('resolves @humanlayer/opencode-llm-vendor/route/transport/websocket', async () => {
		const mod = await import('@humanlayer/opencode-llm-vendor/route/transport/websocket')
		expect(mod).toBeDefined()
		// WebSocketExecutor should export a layer and Service
		expect(mod.layer).toBeDefined()
		expect(mod.Service).toBeDefined()
	})
})
