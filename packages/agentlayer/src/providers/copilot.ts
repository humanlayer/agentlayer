import type { AuthStore } from './auth'
import { requireAuth } from './auth'
import { createOpenaiCompatible } from './sdk/copilot'

// GPT-5 and later use Responses API, except gpt-5-mini
function shouldUseCopilotResponsesApi(modelId: string): boolean {
	const match = modelId.match(/^gpt-(\d+)/)
	if (!match || !match[1]) return false
	const version = parseInt(match[1], 10)
	if (version < 5) return false
	if (modelId.includes('mini')) return false
	return true
}

export interface CopilotProviderOptions {
	enterprise?: string
	authStore?: AuthStore
}

export function copilotProvider(opts?: CopilotProviderOptions) {
	const authId = opts?.enterprise ? 'github-copilot-enterprise' : 'github-copilot'
	const baseURL = opts?.enterprise ? `https://copilot-api.${opts.enterprise}` : 'https://api.githubcopilot.com'
	const authRequire = opts?.authStore ? opts.authStore.requireAuth : requireAuth

	const customFetch: typeof globalThis.fetch = Object.assign(
		async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const cmd = opts?.enterprise
				? 'npx @humanlayer/agent-sdk auth copilot-enterprise'
				: 'npx @humanlayer/agent-sdk auth copilot'
			const auth = await authRequire(authId, cmd, 'oauth')
			const headers = new Headers(init?.headers)
			headers.delete('authorization')
			headers.set('Authorization', `Bearer ${auth.access}`)
			headers.set('Openai-Intent', 'conversation-edits')
			headers.set('x-initiator', 'agent')
			return globalThis.fetch(url, { ...init, headers })
		},
		{ preconnect: globalThis.fetch.preconnect },
	)

	const sdk = createOpenaiCompatible({
		name: opts?.enterprise ? 'github-copilot-enterprise' : 'github-copilot',
		baseURL,
		apiKey: '', // dummy — stripped in custom fetch
		fetch: customFetch,
	})

	// Return a callable that selects chat vs responses based on model
	return (modelId: string) => {
		if (shouldUseCopilotResponsesApi(modelId)) {
			return sdk.responses(modelId)
		}
		return sdk.chat(modelId)
	}
}
