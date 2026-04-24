export interface OAuthAuthInfo {
	kind: 'oauth'
	accessToken: string
	refreshToken?: string
	expiresAt?: number
	idToken?: string
	scope?: string
	tokenType?: string
	accountId?: string
}

export interface ApiAuthInfo {
	kind: 'api'
	apiKey: string
}

export type AuthInfo = OAuthAuthInfo | ApiAuthInfo

export interface AuthStore {
	get(providerId: string): Promise<AuthInfo | undefined>
	set(providerId: string, auth: AuthInfo): Promise<void>
	delete(providerId: string): Promise<void>
	getAll(): Promise<Record<string, AuthInfo>>
}

export function createMemoryAuthStore(initialAuth: Record<string, AuthInfo> = {}): AuthStore {
	const store = new Map<string, AuthInfo>()

	for (const [providerId, auth] of Object.entries(initialAuth)) {
		store.set(providerId, structuredClone(auth))
	}

	return {
		async get(providerId) {
			const auth = store.get(providerId)
			return auth ? structuredClone(auth) : undefined
		},
		async set(providerId, auth) {
			store.set(providerId, structuredClone(auth))
		},
		async delete(providerId) {
			store.delete(providerId)
		},
		async getAll() {
			return Object.fromEntries(
				Array.from(store.entries(), ([providerId, auth]) => [providerId, structuredClone(auth)]),
			)
		},
	}
}

export async function requireAuth(store: AuthStore, providerId: string): Promise<AuthInfo> {
	const auth = await store.get(providerId)
	if (!auth) {
		throw new Error(`Missing auth for provider: ${providerId}`)
	}
	return auth
}
