import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAuthStore } from '../../src/providers/auth'
import { codexProvider } from '../../src/providers/codex'

describe('codexProvider', () => {
	let tmpDir: string
	let store: ReturnType<typeof createAuthStore>

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-test-'))
		store = createAuthStore(path.join(tmpDir, 'auth.json'))
		await store.writeAuth('openai', {
			type: 'oauth',
			access: 'test-access',
			refresh: 'test-refresh',
			expires: Date.now() + 3600000, // 1 hour from now
			accountId: 'test-account-id',
		})
	})

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	test('returns a callable provider when token exists', () => {
		const provider = codexProvider({ authStore: store })
		const model = provider('gpt-5.3-codex')
		expect(model.modelId).toBe('gpt-5.3-codex')
	})
})

describe('codexProvider — missing credentials', () => {
	let tmpDir: string
	let store: ReturnType<typeof createAuthStore>

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-test-nocred-'))
		store = createAuthStore(path.join(tmpDir, 'auth.json'))
	})

	afterAll(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	test('custom fetch throws with instructions when no token stored', async () => {
		const provider = codexProvider({ authStore: store })
		const model = provider('gpt-5.3-codex')

		try {
			await (model as any).config?.fetch?.('https://api.openai.com/v1/chat/completions', {
				headers: { authorization: 'Bearer dummy' },
			})
			expect.unreachable('Should have thrown')
		} catch (e: any) {
			expect(e.message).toContain('No credentials found')
			expect(e.message).toContain('npx @humanlayer/agent-sdk auth codex')
		}
	})
})
