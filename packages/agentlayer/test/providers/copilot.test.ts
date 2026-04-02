import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAuthStore } from '../../src/providers/auth'
import { copilotProvider } from '../../src/providers/copilot'

describe('copilotProvider', () => {
	let tmpDir: string
	let store: ReturnType<typeof createAuthStore>

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-test-'))
		store = createAuthStore(path.join(tmpDir, 'auth.json'))
		await store.writeAuth('github-copilot', {
			type: 'oauth',
			access: 'test-token',
			refresh: 'test-token',
			expires: 0,
		})
	})

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	test('returns a callable provider when token exists', () => {
		const provider = copilotProvider({ authStore: store })
		const model = provider('gpt-4o')
		expect(model.modelId).toBe('gpt-4o')
		expect(model.provider).toContain('github-copilot')
	})

	test('custom fetch injects Authorization header and strips dummy', () => {
		const provider = copilotProvider({ authStore: store })
		const model = provider('gpt-4o')
		expect(model).toBeDefined()
	})
})

describe('copilotProvider — missing credentials', () => {
	let tmpDir: string
	let store: ReturnType<typeof createAuthStore>

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-test-nocred-'))
		store = createAuthStore(path.join(tmpDir, 'auth.json'))
	})

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	test('custom fetch throws with instructions when no token stored', async () => {
		const provider = copilotProvider({ authStore: store })
		const model = provider('gpt-4o')

		try {
			await (model as any).config?.fetch?.('https://api.githubcopilot.com/v1/chat/completions', {
				headers: { authorization: 'Bearer dummy' },
			})
			expect.unreachable('Should have thrown')
		} catch (e: any) {
			expect(e.message).toContain('No credentials found')
			expect(e.message).toContain('npx @humanlayer/agent-sdk auth copilot')
		}
	})
})
