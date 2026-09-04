import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'smol-toml'

export interface CodexBedrockConfig {
	modelProvider?: string
	model?: string
	profile?: string
	region?: string
	baseUrl?: string
}

export interface ReadCodexConfigOptions {
	codexHome?: string
	env?: NodeJS.ProcessEnv
	homeDirectory?: string
}

export function getCodexConfigPath(options: ReadCodexConfigOptions = {}): string {
	const codexHome = options.codexHome ?? (options.env ?? process.env).CODEX_HOME
	return path.join(codexHome ?? path.join(options.homeDirectory ?? os.homedir(), '.codex'), 'config.toml')
}

export async function readCodexBedrockConfig(
	options: ReadCodexConfigOptions = {},
): Promise<CodexBedrockConfig | undefined> {
	let source: string
	try {
		source = await fs.readFile(getCodexConfigPath(options), 'utf8')
	} catch (error) {
		if (isNotFoundError(error)) return undefined
		throw error
	}

	let document: unknown
	try {
		document = parse(source)
	} catch {
		throw new Error('Codex config.toml is malformed.')
	}
	if (!isRecord(document)) return {}
	const provider = isRecord(document.model_providers)
		? document.model_providers['amazon-bedrock']
		: undefined
	const aws = isRecord(provider) ? provider.aws : undefined

	return {
		...optionalString('modelProvider', document.model_provider),
		...optionalString('model', document.model),
		...(isRecord(aws) ? optionalString('profile', aws.profile) : {}),
		...(isRecord(aws) ? optionalString('region', aws.region) : {}),
		...(isRecord(provider) ? optionalString('baseUrl', provider.base_url) : {}),
	}
}

function optionalString(key: string, value: unknown): Record<string, string> {
	return typeof value === 'string' && value.length > 0 ? { [key]: value } : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFoundError(error: unknown): boolean {
	return isRecord(error) && error.code === 'ENOENT'
}
