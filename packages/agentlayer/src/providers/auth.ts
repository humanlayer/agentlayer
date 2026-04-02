import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

const AuthOauth = z.object({
	type: z.literal('oauth'),
	refresh: z.string(),
	access: z.string(),
	expires: z.number(),
	accountId: z.string().optional(),
	enterpriseUrl: z.string().optional(),
})

const AuthApi = z.object({
	type: z.literal('api'),
	key: z.string(),
})

const AuthInfo = z.discriminatedUnion('type', [AuthOauth, AuthApi])
export type AuthInfo = z.infer<typeof AuthInfo>

type AuthOfType<T extends AuthInfo['type']> = Extract<AuthInfo, { type: T }>

export const DEFAULT_AUTH_DIR = path.join(os.homedir(), '.humanlayer', 'agent-sdk')
export const DEFAULT_AUTH_PATH = path.join(DEFAULT_AUTH_DIR, 'auth.json')

// OpenCode stores tokens at ~/.local/share/opencode/auth.json
const OPENCODE_AUTH_PATH = path.join(
	process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
	'opencode',
	'auth.json',
)

export interface AuthStore {
	readAuth(id: string): Promise<AuthInfo | undefined>
	writeAuth(id: string, info: AuthInfo): Promise<void>
	removeAuth(id: string): Promise<void>
	readAllAuth(): Promise<Record<string, AuthInfo>>
	requireAuth<T extends AuthInfo['type'] = AuthInfo['type']>(
		id: string,
		authCommand: string,
		expectedType?: T,
	): Promise<AuthOfType<T>>
	readonly authPath: string
}

export function createAuthStore(authPath: string, opts?: { fallbackPaths?: string[] }): AuthStore {
	const authDir = path.dirname(authPath)
	const fallbackPaths = opts?.fallbackPaths ?? []

	async function readStore(): Promise<Record<string, AuthInfo>> {
		try {
			const file = Bun.file(authPath)
			if (!(await file.exists())) return {}
			const raw = await file.json()
			const result: Record<string, AuthInfo> = {}
			for (const [key, value] of Object.entries(raw)) {
				const parsed = AuthInfo.safeParse(value)
				if (parsed.success) result[key] = parsed.data
			}
			return result
		} catch {
			return {}
		}
	}

	async function writeStoreFile(store: Record<string, AuthInfo>): Promise<void> {
		await Bun.write(authPath, JSON.stringify(store, null, 2))
		const { chmod } = await import('node:fs/promises')
		await chmod(authPath, 0o600)
	}

	async function importFromFallback(id: string): Promise<AuthInfo | undefined> {
		for (const fallback of fallbackPaths) {
			try {
				const file = Bun.file(fallback)
				if (!(await file.exists())) continue
				const raw = await file.json()
				const entry = raw[id]
				if (!entry) continue
				const parsed = AuthInfo.safeParse(entry)
				if (!parsed.success) continue
				// Copy to our store
				await store.writeAuth(id, parsed.data)
				return parsed.data
			} catch {}
		}
		return undefined
	}

	const store: AuthStore = {
		authPath,

		async readAuth(id: string): Promise<AuthInfo | undefined> {
			const entries = await readStore()
			if (entries[id]) return entries[id]
			return importFromFallback(id)
		},

		async writeAuth(id: string, info: AuthInfo): Promise<void> {
			const { mkdir } = await import('node:fs/promises')
			await mkdir(authDir, { recursive: true })
			const entries = await readStore()
			entries[id] = info
			await writeStoreFile(entries)
		},

		async removeAuth(id: string): Promise<void> {
			const entries = await readStore()
			delete entries[id]
			await writeStoreFile(entries)
		},

		async readAllAuth(): Promise<Record<string, AuthInfo>> {
			return readStore()
		},

		async requireAuth<T extends AuthInfo['type'] = AuthInfo['type']>(
			id: string,
			authCommand: string,
			expectedType?: T,
		): Promise<AuthOfType<T>> {
			const auth = await store.readAuth(id)
			if (!auth) {
				throw new Error(`No credentials found for "${id}". Run \`${authCommand}\` to authenticate.`)
			}
			if (expectedType && auth.type !== expectedType) {
				throw new Error(
					`Expected "${expectedType}" credentials for "${id}", found "${auth.type}". Run \`${authCommand}\` to re-authenticate.`,
				)
			}
			return auth as AuthOfType<T>
		},
	}

	return store
}

// Default store: ~/.humanlayer/agent-sdk/auth.json with OpenCode fallback
const defaultStore = createAuthStore(DEFAULT_AUTH_PATH, {
	fallbackPaths: [OPENCODE_AUTH_PATH],
})

export const readAuth = defaultStore.readAuth
export const writeAuth = defaultStore.writeAuth
export const removeAuth = defaultStore.removeAuth
export const readAllAuth = defaultStore.readAllAuth
export const requireAuth = defaultStore.requireAuth
