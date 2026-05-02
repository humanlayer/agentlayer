import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface OAuthAuthInfo {
	kind: 'oauth'
	accessToken: string
	refreshToken?: string
	expiresAt?: number
	idToken?: string
	scope?: string
	tokenType?: string
	accountId?: string
	enterpriseUrl?: string
}

export interface ApiAuthInfo {
	kind: 'api'
	apiKey: string
	metadata?: Record<string, string>
}

export type AuthInfo = OAuthAuthInfo | ApiAuthInfo
export type AuthKind = AuthInfo['kind']
export type CanonicalAuthProviderId = 'codex' | 'copilot' | 'copilot-enterprise'

export const AUTH_PROVIDER_IDS = {
	codex: 'codex',
	copilot: 'copilot',
	copilotEnterprise: 'copilot-enterprise',
} as const satisfies Record<string, CanonicalAuthProviderId>

export const AUTH_PROVIDER_ALIASES: Record<string, CanonicalAuthProviderId> = {
	openai: AUTH_PROVIDER_IDS.codex,
	'openai.codex': AUTH_PROVIDER_IDS.codex,
	codex: AUTH_PROVIDER_IDS.codex,
	'github-copilot': AUTH_PROVIDER_IDS.copilot,
	copilot: AUTH_PROVIDER_IDS.copilot,
	'github-copilot-enterprise': AUTH_PROVIDER_IDS.copilotEnterprise,
	'copilot-enterprise': AUTH_PROVIDER_IDS.copilotEnterprise,
}

export interface AuthStore {
	get(providerId: string): Promise<AuthInfo | undefined>
	set(providerId: string, auth: AuthInfo): Promise<void>
	delete(providerId: string): Promise<void>
	getAll(): Promise<Record<string, AuthInfo>>
}

export interface FileAuthStoreOptions {
	filePath?: string
	agentSdkAuthFilePath?: string
	openCodeAuthFilePath?: string
	enableOpenCodeFallback?: boolean
}

interface ResolvedFileAuthStoreOptions {
	filePath: string
	agentSdkAuthFilePath: string
	openCodeAuthFilePath: string
	enableOpenCodeFallback: boolean
}

export function createMemoryAuthStore(initialAuth: Record<string, AuthInfo> = {}): AuthStore {
	const store = new Map<string, AuthInfo>()

	for (const [providerId, auth] of Object.entries(initialAuth)) {
		store.set(normalizeProviderId(providerId), cloneAuth(auth))
	}

	return {
		async get(providerId) {
			const auth = store.get(normalizeProviderId(providerId))
			return auth ? cloneAuth(auth) : undefined
		},
		async set(providerId, auth) {
			store.set(normalizeProviderId(providerId), cloneAuth(auth))
		},
		async delete(providerId) {
			store.delete(normalizeProviderId(providerId))
		},
		async getAll() {
			return cloneAuthRecord(Object.fromEntries(store.entries()))
		},
	}
}

export function createFileAuthStore(options: FileAuthStoreOptions = {}): AuthStore {
	const resolved = resolveFileAuthStoreOptions(options)

	return {
		async get(providerId) {
			const key = normalizeProviderId(providerId)
			const auth = (await readAuthFile(resolved.filePath))[key]
			if (auth) return cloneAuth(auth)

			if (!resolved.enableOpenCodeFallback) return undefined

			const fallbackAuth = (await readAuthFile(resolved.openCodeAuthFilePath))[key]
			if (!fallbackAuth) return undefined

			const allAuth = await readAuthFile(resolved.filePath)
			await writeAuthFile(resolved.filePath, { ...allAuth, [key]: fallbackAuth })
			return cloneAuth(fallbackAuth)
		},
		async set(providerId, auth) {
			const key = normalizeProviderId(providerId)
			const allAuth = await readAuthFile(resolved.filePath)
			await writeAuthFile(resolved.filePath, { ...allAuth, [key]: auth })
		},
		async delete(providerId) {
			const key = normalizeProviderId(providerId)
			const allAuth = await readAuthFile(resolved.filePath)
			delete allAuth[key]
			await writeAuthFile(resolved.filePath, allAuth)
		},
		async getAll() {
			const allAuth = await readAuthFile(resolved.filePath)
			if (!resolved.enableOpenCodeFallback) return cloneAuthRecord(allAuth)

			const fallbackAuth = await readAuthFile(resolved.openCodeAuthFilePath)
			let imported = false
			const merged = { ...allAuth }
			for (const [providerId, auth] of Object.entries(fallbackAuth)) {
				if (merged[providerId]) continue
				merged[providerId] = auth
				imported = true
			}

			if (imported) {
				await writeAuthFile(resolved.filePath, merged)
			}

			return cloneAuthRecord(merged)
		},
	}
}

export async function ensureFileAuthStore(options: FileAuthStoreOptions = {}): Promise<AuthStore> {
	const resolved = resolveFileAuthStoreOptions(options)
	if (!(await fileExists(resolved.filePath))) {
		const agentSdkAuth = await readAuthFile(resolved.agentSdkAuthFilePath)
		if (Object.keys(agentSdkAuth).length > 0) {
			await writeAuthFile(resolved.filePath, agentSdkAuth)
		}
	}
	return createFileAuthStore(options)
}

export function getDefaultAgentLayerAuthPath(): string {
	if (process.env.AGENTLAYER_AUTH_PATH) return process.env.AGENTLAYER_AUTH_PATH
	return path.join(getXdgDataHome(), 'agentlayer', 'auth.json')
}

export function getDefaultAgentSdkAuthPath(): string {
	if (process.env.AGENT_SDK_AUTH_PATH) return process.env.AGENT_SDK_AUTH_PATH
	return path.join(os.homedir(), '.humanlayer', 'agent-sdk', 'auth.json')
}

export function getDefaultOpenCodeAuthPath(): string {
	if (process.env.OPENCODE_AUTH_PATH) return process.env.OPENCODE_AUTH_PATH
	return path.join(getXdgDataHome(), 'opencode', 'auth.json')
}

export async function readAuth(providerId: string, options?: FileAuthStoreOptions): Promise<AuthInfo | undefined> {
	return createFileAuthStore(options).get(providerId)
}

export async function writeAuth(providerId: string, auth: AuthInfo, options?: FileAuthStoreOptions): Promise<void> {
	return createFileAuthStore(options).set(providerId, auth)
}

export async function removeAuth(providerId: string, options?: FileAuthStoreOptions): Promise<void> {
	return createFileAuthStore(options).delete(providerId)
}

export async function readAllAuth(options?: FileAuthStoreOptions): Promise<Record<string, AuthInfo>> {
	return createFileAuthStore(options).getAll()
}

export async function requireAuth(store: AuthStore, providerId: string): Promise<AuthInfo>
export async function requireAuth<TKind extends AuthKind>(
	store: AuthStore,
	providerId: string,
	expectedKind: TKind,
): Promise<Extract<AuthInfo, { kind: TKind }>>
export async function requireAuth(store: AuthStore, providerId: string, expectedKind?: AuthKind): Promise<AuthInfo> {
	const auth = await store.get(providerId)
	if (!auth) {
		throw new Error(`Missing auth for provider: ${providerId}`)
	}
	if (expectedKind && auth.kind !== expectedKind) {
		throw new Error(`Expected ${expectedKind} auth for provider: ${providerId}, got ${auth.kind}`)
	}
	return auth
}

export function normalizeProviderId(providerId: string): string {
	const normalized = providerId.trim().replace(/\/+$/, '')
	return AUTH_PROVIDER_ALIASES[normalized] ?? normalized
}

function resolveFileAuthStoreOptions(options: FileAuthStoreOptions): ResolvedFileAuthStoreOptions {
	return {
		filePath: options.filePath ?? getDefaultAgentLayerAuthPath(),
		agentSdkAuthFilePath: options.agentSdkAuthFilePath ?? getDefaultAgentSdkAuthPath(),
		openCodeAuthFilePath: options.openCodeAuthFilePath ?? getDefaultOpenCodeAuthPath(),
		enableOpenCodeFallback: options.enableOpenCodeFallback ?? options.openCodeAuthFilePath != null,
	}
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch (error) {
		if (isNotFoundError(error)) return false
		throw error
	}
}

function getXdgDataHome(): string {
	return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share')
}

async function readAuthFile(filePath: string): Promise<Record<string, AuthInfo>> {
	let text: string
	try {
		text = await fs.readFile(filePath, 'utf8')
	} catch (error) {
		if (isNotFoundError(error)) return {}
		throw error
	}

	const parsed = JSON.parse(text) as unknown
	if (!isRecord(parsed)) return {}

	const allAuth: Record<string, AuthInfo> = {}
	for (const [providerId, value] of Object.entries(parsed)) {
		const auth = decodeAuthInfo(value)
		if (!auth) continue
		allAuth[normalizeProviderId(providerId)] = auth
	}
	return allAuth
}

async function writeAuthFile(filePath: string, auth: Record<string, AuthInfo>): Promise<void> {
	const normalizedAuth = Object.fromEntries(
		Object.entries(auth).map(([providerId, value]) => [normalizeProviderId(providerId), cloneAuth(value)]),
	)
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await fs.writeFile(filePath, `${JSON.stringify(normalizedAuth, null, '\t')}\n`, { mode: 0o600 })
	await fs.chmod(filePath, 0o600)
}

function decodeAuthInfo(value: unknown): AuthInfo | undefined {
	if (!isRecord(value)) return undefined

	if (value.kind === 'oauth') return decodeOAuthAuthInfo(value)
	if (value.kind === 'api') return decodeApiAuthInfo(value)
	if (value.type === 'oauth') return decodeOpenCodeOAuthAuthInfo(value)
	if (value.type === 'api') return decodeOpenCodeApiAuthInfo(value)

	return undefined
}

function decodeOAuthAuthInfo(value: Record<string, unknown>): OAuthAuthInfo | undefined {
	const accessToken = typeof value.accessToken === 'string' ? value.accessToken : value.access
	if (typeof accessToken !== 'string') return undefined
	return {
		kind: 'oauth',
		accessToken,
		...optionalString('refreshToken', value.refreshToken ?? value.refresh),
		...optionalNumber('expiresAt', value.expiresAt ?? value.expires),
		...optionalString('idToken', value.idToken),
		...optionalString('scope', value.scope),
		...optionalString('tokenType', value.tokenType),
		...optionalString('accountId', value.accountId),
		...optionalString('enterpriseUrl', value.enterpriseUrl),
	}
}

function decodeApiAuthInfo(value: Record<string, unknown>): ApiAuthInfo | undefined {
	if (typeof value.apiKey !== 'string') return undefined
	return {
		kind: 'api',
		apiKey: value.apiKey,
		...optionalStringRecord('metadata', value.metadata),
	}
}

function decodeOpenCodeOAuthAuthInfo(value: Record<string, unknown>): OAuthAuthInfo | undefined {
	if (typeof value.access !== 'string') return undefined
	return {
		kind: 'oauth',
		accessToken: value.access,
		...optionalString('refreshToken', value.refresh),
		...optionalNumber('expiresAt', value.expires),
		...optionalString('accountId', value.accountId),
		...optionalString('enterpriseUrl', value.enterpriseUrl),
	}
}

function decodeOpenCodeApiAuthInfo(value: Record<string, unknown>): ApiAuthInfo | undefined {
	if (typeof value.key !== 'string') return undefined
	return {
		kind: 'api',
		apiKey: value.key,
		...optionalStringRecord('metadata', value.metadata),
	}
}

function optionalString(key: string, value: unknown): Record<string, string> {
	return typeof value === 'string' ? { [key]: value } : {}
}

function optionalNumber(key: string, value: unknown): Record<string, number> {
	return typeof value === 'number' ? { [key]: value } : {}
}

function optionalStringRecord(key: string, value: unknown): Record<string, Record<string, string>> {
	if (!isRecord(value)) return {}
	const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
	return entries.length > 0 ? { [key]: Object.fromEntries(entries) } : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFoundError(error: unknown): boolean {
	return isRecord(error) && error.code === 'ENOENT'
}

function cloneAuth<T extends AuthInfo>(auth: T): T {
	return structuredClone(auth)
}

function cloneAuthRecord(auth: Record<string, AuthInfo>): Record<string, AuthInfo> {
	return Object.fromEntries(Object.entries(auth).map(([providerId, value]) => [providerId, cloneAuth(value)]))
}
