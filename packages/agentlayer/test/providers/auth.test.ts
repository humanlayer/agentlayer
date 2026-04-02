import { describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAuthStore } from '../../src/providers/auth'

// Helper to create isolated store for each test
async function createTestStore() {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-auth-test-'))
	const store = createAuthStore(path.join(tmpDir, 'auth.json'))
	return { store, tmpDir }
}

describe('auth store', () => {
	test('writeAuth → readAuth round-trip', async () => {
		const { store, tmpDir } = await createTestStore()
		try {
			await store.writeAuth('test-provider', { type: 'oauth', access: 'tok', refresh: 'ref', expires: 0 })
			const result = await store.readAuth('test-provider')
			expect(result).toEqual({ type: 'oauth', access: 'tok', refresh: 'ref', expires: 0 })
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true })
		}
	})

	test('auth file has 0o600 permissions', async () => {
		const { store, tmpDir } = await createTestStore()
		try {
			await store.writeAuth('test-perm', { type: 'oauth', access: 'a', refresh: 'r', expires: 0 })
			const stat = await fs.stat(store.authPath)
			expect(stat.mode & 0o777).toBe(0o600)
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true })
		}
	})

	test('readAuth returns undefined for missing entry', async () => {
		const { store, tmpDir } = await createTestStore()
		try {
			const result = await store.readAuth(`nonexistent-${Date.now()}`)
			expect(result).toBeUndefined()
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true })
		}
	})

	test('removeAuth deletes entry', async () => {
		const { store, tmpDir } = await createTestStore()
		try {
			await store.writeAuth('to-remove', { type: 'oauth', access: 'a', refresh: 'r', expires: 0 })
			await store.removeAuth('to-remove')
			const result = await store.readAuth('to-remove')
			expect(result).toBeUndefined()
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true })
		}
	})

	test('readAllAuth returns all entries', async () => {
		const { store, tmpDir } = await createTestStore()
		try {
			await store.writeAuth('p1', { type: 'oauth', access: 'a1', refresh: 'r1', expires: 0 })
			await store.writeAuth('p2', { type: 'api', key: 'k2' })
			const all = await store.readAllAuth()
			expect(all.p1).toBeDefined()
			expect(all.p2).toBeDefined()
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true })
		}
	})

	test('requireAuth throws for missing entry', async () => {
		const { store, tmpDir } = await createTestStore()
		try {
			await expect(store.requireAuth('missing', 'some-command')).rejects.toThrow('No credentials found')
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true })
		}
	})

	test('requireAuth returns narrowed type', async () => {
		const { store, tmpDir } = await createTestStore()
		try {
			await store.writeAuth('typed', { type: 'oauth', access: 'a', refresh: 'r', expires: 0 })
			const auth = await store.requireAuth('typed', 'cmd', 'oauth')
			expect(auth.access).toBe('a')
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true })
		}
	})
})

describe('auth store fallback', () => {
	test('imports from fallback path on first read', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-auth-fallback-'))
		try {
			const sourcePath = path.join(tmpDir, 'source', 'auth.json')
			const consumerPath = path.join(tmpDir, 'consumer', 'auth.json')
			const sourceStore = createAuthStore(sourcePath)
			const consumerStore = createAuthStore(consumerPath, { fallbackPaths: [sourcePath] })

			await sourceStore.writeAuth('fallback-test', { type: 'oauth', access: 'fb', refresh: 'fb', expires: 0 })
			const result = await consumerStore.readAuth('fallback-test')
			expect(result).toEqual({ type: 'oauth', access: 'fb', refresh: 'fb', expires: 0 })
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true })
		}
	})

	test('copies fallback entry into consumer store', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-auth-fallback-'))
		try {
			const sourcePath = path.join(tmpDir, 'source', 'auth.json')
			const consumerPath = path.join(tmpDir, 'consumer', 'auth.json')
			const sourceStore = createAuthStore(sourcePath)
			const consumerStore = createAuthStore(consumerPath, { fallbackPaths: [sourcePath] })

			await sourceStore.writeAuth('copy-test', { type: 'oauth', access: 'cp', refresh: 'cp', expires: 0 })
			await consumerStore.readAuth('copy-test') // triggers import

			const all = await consumerStore.readAllAuth()
			expect(all['copy-test']).toBeDefined()
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true })
		}
	})
})
