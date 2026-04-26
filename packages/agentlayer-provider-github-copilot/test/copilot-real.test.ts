import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type AuthInfo, createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { generateText } from 'ai'
import { createCopilotProvider, listCopilotModels } from '../src'

interface AgentSdkAuthEntry {
	type?: string
	kind?: string
	access?: string
	accessToken?: string
	refresh?: string
	refreshToken?: string
	expires?: number
	expiresAt?: number
	enterpriseUrl?: string
}

async function readAgentSdkCopilotAuth(): Promise<AuthInfo | undefined> {
	try {
		const path = process.env.AGENTLAYER_AGENT_SDK_AUTH_PATH ?? join(homedir(), '.humanlayer/agent-sdk/auth.json')
		const contents = await readFile(path, 'utf8')
		const parsed = JSON.parse(contents) as Record<string, AgentSdkAuthEntry | undefined>
		const copilot = parsed.copilot ?? parsed['github-copilot']
		const accessToken = copilot?.accessToken ?? copilot?.access
		const refreshToken = copilot?.refreshToken ?? copilot?.refresh ?? accessToken
		if (!copilot || (copilot.type !== 'oauth' && copilot.kind !== 'oauth') || !accessToken) return undefined

		return {
			kind: 'oauth',
			accessToken,
			refreshToken,
			expiresAt: copilot.expiresAt ?? copilot.expires,
			...(copilot.enterpriseUrl ? { enterpriseUrl: copilot.enterpriseUrl } : {}),
		} as AuthInfo
	} catch {
		return undefined
	}
}

const hasRealCopilotAuth = await readAgentSdkCopilotAuth().then(Boolean)

describe.skipIf(!hasRealCopilotAuth || !!process.env.CI)('copilot real auth integration', () => {
	test(
		'lists models and generates text with auth from ~/.humanlayer/agent-sdk/auth.json',
		async () => {
			const auth = await readAgentSdkCopilotAuth()
			expect(auth).toBeDefined()
			if (!auth) throw new Error('Missing Copilot auth')

			const authStore = createMemoryAuthStore({ 'github-copilot': auth })
			const models = await listCopilotModels({ authStore, version: '0.0.0-dev' })
			const modelIds = Object.keys(models)
			expect(modelIds.length).toBeGreaterThan(0)

			const preferredModel = modelIds.includes('gpt-4.1')
				? 'gpt-4.1'
				: (modelIds.find((id) => id.includes('gpt-4')) ?? modelIds[0])
			expect(preferredModel).toBeString()

			const copilot = createCopilotProvider({ authStore, version: '0.0.0-dev' })
			const result = await generateText({
				model: copilot.languageModel(preferredModel!),
				prompt: 'Reply with exactly: agentlayer-copilot-ok',
				maxOutputTokens: 16,
				temperature: 0,
			})

			expect(result.text.toLowerCase()).toContain('agentlayer-copilot-ok')
		},
		{ timeout: 30_000 },
	)
})
