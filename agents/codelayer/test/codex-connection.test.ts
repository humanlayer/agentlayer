import { describe, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFileAuthStore, createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { getCodexConfigPath, readCodexBedrockConfig } from '../src/codex/codex-config'
import { resolveCodexConnection, type CodexConnection } from '../src/codex/connection'

async function tempDirectory(): Promise<string> {
	return fs.mkdtemp(path.join(tmpdir(), 'codelayer-codex-'))
}

describe('Codex config and connection resolution', () => {
	test('parses the supported amazon-bedrock fields from CODEX_HOME', async () => {
		const home = await tempDirectory()
		await fs.writeFile(path.join(home, 'config.toml'), `
model_provider = "amazon-bedrock"
model = "openai.gpt-5.6-sol"
[model_providers.amazon-bedrock]
base_url = "https://bedrock.example.test/openai/v1"
[model_providers.amazon-bedrock.aws]
profile = "work"
region = "us-west-2"
`)
		expect(getCodexConfigPath({ codexHome: home })).toBe(path.join(home, 'config.toml'))
		expect(await readCodexBedrockConfig({ codexHome: home })).toEqual({
			modelProvider: 'amazon-bedrock',
			model: 'openai.gpt-5.6-sol',
			profile: 'work',
			region: 'us-west-2',
			baseUrl: 'https://bedrock.example.test/openai/v1',
		})
	})

	test('$CODEX_HOME overrides the default ~/.codex config path', async () => {
		const homeDirectory = await tempDirectory()
		const codexHome = await tempDirectory()
		await fs.mkdir(path.join(homeDirectory, '.codex'))
		await fs.writeFile(path.join(homeDirectory, '.codex', 'config.toml'), 'model = "home-model"\n')
		await fs.writeFile(path.join(codexHome, 'config.toml'), 'model = "codex-home-model"\n')

		expect(await readCodexBedrockConfig({
			env: { CODEX_HOME: codexHome },
			homeDirectory,
		})).toEqual({ model: 'codex-home-model' })
	})

	test('applies explicit, active marker, legacy override, config, and fallback precedence', async () => {
		const codexHome = await tempDirectory()
		await fs.writeFile(path.join(codexHome, 'config.toml'), `
model_provider = "amazon-bedrock"
model = "config-model"
[model_providers.amazon-bedrock.aws]
region = "us-west-2"
`)
		const explicit: CodexConnection = { type: 'bedrock', region: 'eu-west-1', model: 'explicit-model' }
		const common = { selectedModelId: 'gpt-5.6-sol', codexHome, env: {} }

		expect(await resolveCodexConnection({
			...common,
			explicitConnection: explicit,
			authStore: createMemoryAuthStore({ codex_bedrock: { kind: 'aws-profile', active: false } }),
		})).toMatchObject({ type: 'bedrock', region: 'eu-west-1', model: 'explicit-model' })

		expect(await resolveCodexConnection({
			...common,
			authStore: createMemoryAuthStore({ codex_bedrock: { kind: 'aws-profile', active: false } }),
			hasLegacyOverride: true,
		})).toEqual({ type: 'chatgpt' })

		expect(await resolveCodexConnection({
			...common,
			authStore: createMemoryAuthStore({ codex_bedrock: {
				kind: 'aws-profile', active: true, region: 'us-east-1', model: 'saved-model',
			} }),
		})).toMatchObject({ type: 'bedrock', region: 'us-east-1', model: 'saved-model' })

		expect(await resolveCodexConnection({
			...common, authStore: createMemoryAuthStore(), hasLegacyOverride: true,
		})).toEqual({ type: 'custom-responses' })

		expect(await resolveCodexConnection({
			...common, authStore: createMemoryAuthStore(),
		})).toMatchObject({ type: 'bedrock', region: 'us-west-2', model: 'config-model' })
		expect(await resolveCodexConnection({
			...common,
			authStore: createMemoryAuthStore({
				codex_bedrock: { kind: 'aws-profile', profile: 'saved-but-not-selected', region: 'us-east-1' },
			}),
		})).toMatchObject({
			type: 'bedrock',
			profile: 'saved-but-not-selected',
			region: 'us-east-1',
			model: 'config-model',
		})

		expect(await resolveCodexConnection({
			selectedModelId: 'gpt-5.6-sol', codexHome: path.join(codexHome, 'missing'), env: {},
			authStore: createMemoryAuthStore(),
		})).toEqual({ type: 'chatgpt' })
	})

	test('merges unselected saved Bedrock overrides over Codex TOML', async () => {
		const codexHome = await tempDirectory()
		await fs.writeFile(path.join(codexHome, 'config.toml'), `
model_provider = "amazon-bedrock"
model = "toml-model"
[model_providers.amazon-bedrock]
base_url = "https://toml.example.test/openai/v1"
[model_providers.amazon-bedrock.aws]
profile = "toml-profile"
region = "us-west-2"
`)
		const result = await resolveCodexConnection({
			authStore: createMemoryAuthStore({
				codex_bedrock: {
					kind: 'aws-profile',
					profile: 'saved-profile',
					region: 'eu-central-1',
					model: 'saved-model',
					baseUrl: 'https://saved.example.test/openai/v1',
				},
			}),
			selectedModelId: 'selected-model',
			codexHome,
		})

		expect(result).toEqual({
			type: 'bedrock',
			profile: 'saved-profile',
			region: 'eu-central-1',
			model: 'saved-model',
			baseURL: 'https://saved.example.test/openai/v1',
			endpointURL: 'https://saved.example.test/openai/v1/responses',
		})
	})

	test('fails closed on malformed stored Bedrock auth instead of using valid Codex TOML', async () => {
		const directory = await tempDirectory()
		const codexHome = path.join(directory, 'codex')
		const authPath = path.join(directory, 'auth.json')
		await fs.mkdir(codexHome)
		await fs.writeFile(path.join(codexHome, 'config.toml'), `
model_provider = "amazon-bedrock"
[model_providers.amazon-bedrock.aws]
region = "us-east-1"
`)
		await fs.writeFile(authPath, JSON.stringify({
			codex_bedrock: { kind: 'aws-profile', active: 'true', region: 'us-west-2' },
		}))

		await expect(resolveCodexConnection({
			authStore: createFileAuthStore({ filePath: authPath }),
			selectedModelId: 'gpt-5.6-sol',
			codexHome,
		})).rejects.toThrow('Invalid auth entry for provider: codex_bedrock')
	})

	test('resolves regional endpoint and prefixes only unprefixed selected models', async () => {
		for (const selectedModelId of ['gpt-5.6-sol', 'openai.gpt-5.6-sol']) {
			const result = await resolveCodexConnection({
				explicitConnection: { type: 'bedrock', region: 'us-east-1' },
				authStore: createMemoryAuthStore(),
				selectedModelId,
				env: {},
			})
			expect(result).toMatchObject({
				type: 'bedrock',
				model: 'openai.gpt-5.6-sol',
				baseURL: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1',
				endpointURL: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses',
			})
		}
	})

	test('uses the injected AWS region chain with the selected profile when region is omitted', async () => {
		const regionProvider = mock(async () => 'ap-southeast-2')
		const result = await resolveCodexConnection({
			explicitConnection: { type: 'bedrock', profile: 'work' },
			authStore: createMemoryAuthStore(),
			selectedModelId: 'gpt-5.6-sol',
			regionProvider,
		})

		expect(regionProvider).toHaveBeenCalledWith('work')
		expect(result).toMatchObject({
			type: 'bedrock',
			region: 'ap-southeast-2',
			baseURL: 'https://bedrock-mantle.ap-southeast-2.api.aws/openai/v1',
		})
	})

	test('fails closed for unsupported, incomplete, malformed, and unsafe Bedrock config', async () => {
		const codexHome = await tempDirectory()
		await fs.writeFile(path.join(codexHome, 'config.toml'), 'model_provider = "amazon-bedrock-runtime"\n')
		await expect(resolveCodexConnection({
			authStore: createMemoryAuthStore(), selectedModelId: 'model', codexHome, env: {},
		})).rejects.toThrow('not supported')

		await expect(resolveCodexConnection({
			explicitConnection: { type: 'bedrock' }, authStore: createMemoryAuthStore(),
			selectedModelId: 'model', env: {}, homeDirectory: codexHome,
			regionProvider: async () => { throw new Error('Region is missing') },
		})).rejects.toThrow('region could not be resolved')

		await expect(resolveCodexConnection({
			explicitConnection: { type: 'bedrock', region: 'us-east-1', baseURL: 'http://remote.test/?secret=x' },
			authStore: createMemoryAuthStore(), selectedModelId: 'model', env: {},
		})).rejects.toThrow('query string or fragment')
	})
})
