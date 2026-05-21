import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	createFileAuthStore,
	ensureFileAuthStore,
	readAllAuth,
	readAuth,
	removeAuth,
	requireAuth,
	writeAuth,
} from '../src'

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(tmpdir(), 'agentlayer-auth-'))
}

describe('createFileAuthStore', () => {
	test('writes, reads, lists, and removes auth entries on disk', async () => {
		const dir = await makeTempDir()
		const filePath = path.join(dir, 'agentlayer', 'auth.json')
		const store = createFileAuthStore({ filePath })

		await store.set('codex', {
			kind: 'oauth',
			accessToken: 'access-token',
			refreshToken: 'refresh-token',
			expiresAt: 123,
			accountId: 'account-id',
		})
		await store.set('copilot', {
			kind: 'api',
			apiKey: 'api-key',
			metadata: { source: 'test' },
		})

		expect(await store.get('codex')).toEqual({
			kind: 'oauth',
			accessToken: 'access-token',
			refreshToken: 'refresh-token',
			expiresAt: 123,
			accountId: 'account-id',
		})
		expect(await store.getAll()).toEqual({
			codex: {
				kind: 'oauth',
				accessToken: 'access-token',
				refreshToken: 'refresh-token',
				expiresAt: 123,
				accountId: 'account-id',
			},
			copilot: {
				kind: 'api',
				apiKey: 'api-key',
				metadata: { source: 'test' },
			},
		})

		await store.delete('codex')

		expect(await store.get('codex')).toBeUndefined()
		expect(await store.getAll()).toEqual({
			copilot: {
				kind: 'api',
				apiKey: 'api-key',
				metadata: { source: 'test' },
			},
		})
	})

	test('writes auth files with mode 0o600', async () => {
		const dir = await makeTempDir()
		const filePath = path.join(dir, 'auth.json')
		const store = createFileAuthStore({ filePath })

		await store.set('codex', { kind: 'oauth', accessToken: 'access-token' })

		const stat = await fs.stat(filePath)
		expect(stat.mode & 0o777).toBe(0o600)
	})

	test('supports convenience read, write, remove, and list helpers', async () => {
		const dir = await makeTempDir()
		const filePath = path.join(dir, 'auth.json')
		const options = { filePath }

		await writeAuth(
			'copilot',
			{ kind: 'oauth', accessToken: 'access-token', refreshToken: 'refresh-token' },
			options,
		)

		expect(await readAuth('copilot', options)).toEqual({
			kind: 'oauth',
			accessToken: 'access-token',
			refreshToken: 'refresh-token',
		})
		expect(await readAllAuth(options)).toEqual({
			copilot: {
				kind: 'oauth',
				accessToken: 'access-token',
				refreshToken: 'refresh-token',
			},
		})

		await removeAuth('copilot', options)

		expect(await readAuth('copilot', options)).toBeUndefined()
	})

	test('requireAuth returns matching auth and rejects missing or mismatched auth', async () => {
		const dir = await makeTempDir()
		const filePath = path.join(dir, 'auth.json')
		const store = createFileAuthStore({ filePath })

		await store.set('copilot', { kind: 'api', apiKey: 'api-key' })

		await expect(requireAuth(store, 'copilot', 'api')).resolves.toEqual({ kind: 'api', apiKey: 'api-key' })
		await expect(requireAuth(store, 'codex')).rejects.toThrow('Missing auth for provider: codex')
		await expect(requireAuth(store, 'copilot', 'oauth')).rejects.toThrow(
			'Expected oauth auth for provider: copilot, got api',
		)
	})

	test('normalizes canonical provider ids and compatibility aliases', async () => {
		const dir = await makeTempDir()
		const filePath = path.join(dir, 'auth.json')
		const store = createFileAuthStore({ filePath })

		await store.set('openai', { kind: 'oauth', accessToken: 'codex-access' })
		await store.set('github-copilot', { kind: 'oauth', accessToken: 'copilot-access' })
		await store.set('github-copilot-enterprise/', {
			kind: 'oauth',
			accessToken: 'enterprise-access',
			enterpriseUrl: 'github.example.com',
		})

		expect(await store.get('codex')).toEqual({ kind: 'oauth', accessToken: 'codex-access' })
		expect(await store.get('copilot')).toEqual({ kind: 'oauth', accessToken: 'copilot-access' })
		expect(await store.get('copilot-enterprise')).toEqual({
			kind: 'oauth',
			accessToken: 'enterprise-access',
			enterpriseUrl: 'github.example.com',
		})
		expect(await store.getAll()).toEqual({
			codex: { kind: 'oauth', accessToken: 'codex-access' },
			copilot: { kind: 'oauth', accessToken: 'copilot-access' },
			'copilot-enterprise': {
				kind: 'oauth',
				accessToken: 'enterprise-access',
				enterpriseUrl: 'github.example.com',
			},
		})
	})

	test('imports OpenCode auth file entries as canonical AgentLayer auth', async () => {
		const dir = await makeTempDir()
		const filePath = path.join(dir, 'agentlayer', 'auth.json')
		const openCodeAuthFilePath = path.join(dir, 'opencode', 'auth.json')
		await fs.mkdir(path.dirname(openCodeAuthFilePath), { recursive: true })
		await fs.writeFile(
			openCodeAuthFilePath,
			JSON.stringify({
				openai: {
					type: 'oauth',
					access: 'codex-access',
					refresh: 'codex-refresh',
					expires: 456,
					accountId: 'account-id',
				},
				'github-copilot': {
					type: 'oauth',
					access: 'copilot-access',
					refresh: 'copilot-refresh',
					expires: 0,
				},
				'copilot-enterprise': {
					type: 'oauth',
					access: 'enterprise-access',
					refresh: 'enterprise-refresh',
					expires: 0,
					enterpriseUrl: 'github.example.com',
				},
				anthropic: {
					type: 'api',
					key: 'anthropic-key',
					metadata: { source: 'opencode' },
				},
			}),
		)
		const store = createFileAuthStore({ filePath, openCodeAuthFilePath })

		expect(await store.get('codex')).toEqual({
			kind: 'oauth',
			accessToken: 'codex-access',
			refreshToken: 'codex-refresh',
			expiresAt: 456,
			accountId: 'account-id',
		})
		expect(await store.get('copilot')).toEqual({
			kind: 'oauth',
			accessToken: 'copilot-access',
			refreshToken: 'copilot-refresh',
			expiresAt: 0,
		})
		expect(await store.get('copilot-enterprise')).toEqual({
			kind: 'oauth',
			accessToken: 'enterprise-access',
			refreshToken: 'enterprise-refresh',
			expiresAt: 0,
			enterpriseUrl: 'github.example.com',
		})
		expect(await store.get('anthropic')).toEqual({
			kind: 'api',
			apiKey: 'anthropic-key',
			metadata: { source: 'opencode' },
		})

		expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual({
			codex: {
				kind: 'oauth',
				accessToken: 'codex-access',
				refreshToken: 'codex-refresh',
				expiresAt: 456,
				accountId: 'account-id',
			},
			copilot: {
				kind: 'oauth',
				accessToken: 'copilot-access',
				refreshToken: 'copilot-refresh',
				expiresAt: 0,
			},
			'copilot-enterprise': {
				kind: 'oauth',
				accessToken: 'enterprise-access',
				refreshToken: 'enterprise-refresh',
				expiresAt: 0,
				enterpriseUrl: 'github.example.com',
			},
			anthropic: {
				kind: 'api',
				apiKey: 'anthropic-key',
				metadata: { source: 'opencode' },
			},
		})
	})

	test('does not overwrite existing AgentLayer auth with OpenCode fallback auth', async () => {
		const dir = await makeTempDir()
		const filePath = path.join(dir, 'agentlayer', 'auth.json')
		const openCodeAuthFilePath = path.join(dir, 'opencode', 'auth.json')
		await fs.mkdir(path.dirname(openCodeAuthFilePath), { recursive: true })
		await fs.writeFile(
			openCodeAuthFilePath,
			JSON.stringify({ openai: { type: 'oauth', access: 'fallback-access' } }),
		)
		const store = createFileAuthStore({ filePath, openCodeAuthFilePath })

		await store.set('codex', { kind: 'oauth', accessToken: 'agentlayer-access' })

		expect(await store.get('openai')).toEqual({ kind: 'oauth', accessToken: 'agentlayer-access' })
	})

	test('ensureFileAuthStore imports Agent SDK auth only when AgentLayer auth is missing', async () => {
		const dir = await makeTempDir()
		const filePath = path.join(dir, 'agentlayer', 'auth.json')
		const agentSdkAuthFilePath = path.join(dir, 'agent-sdk', 'auth.json')
		const openCodeAuthFilePath = path.join(dir, 'opencode', 'auth.json')
		await fs.mkdir(path.dirname(agentSdkAuthFilePath), { recursive: true })
		await fs.writeFile(
			agentSdkAuthFilePath,
			JSON.stringify({
				copilot: { type: 'oauth', access: 'copilot-access', refresh: 'copilot-refresh', expires: 0 },
				openai: { type: 'oauth', access: 'codex-access', refresh: 'codex-refresh', expires: 123 },
			}),
		)

		const store = await ensureFileAuthStore({ filePath, agentSdkAuthFilePath, openCodeAuthFilePath })

		expect(await store.get('copilot')).toEqual({
			kind: 'oauth',
			accessToken: 'copilot-access',
			refreshToken: 'copilot-refresh',
			expiresAt: 0,
		})
		expect(await store.get('codex')).toEqual({
			kind: 'oauth',
			accessToken: 'codex-access',
			refreshToken: 'codex-refresh',
			expiresAt: 123,
		})

		await fs.writeFile(
			filePath,
			JSON.stringify({ copilot: { kind: 'oauth', accessToken: 'existing-agentlayer-access' } }),
		)
		await fs.writeFile(
			agentSdkAuthFilePath,
			JSON.stringify({
				copilot: {
					type: 'oauth',
					access: 'new-agent-sdk-access',
					refresh: 'new-agent-sdk-refresh',
					expires: 0,
				},
			}),
		)

		const existingStore = await ensureFileAuthStore({ filePath, agentSdkAuthFilePath, openCodeAuthFilePath })
		expect(await existingStore.get('copilot')).toEqual({ kind: 'oauth', accessToken: 'existing-agentlayer-access' })
	})
})
