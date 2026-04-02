import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelPricing } from '../core/token-usage'

// ── Types for models.dev api.json ────────────────────────────────────────────

interface ModelsDevModel {
	id?: string
	name?: string
	cost?: {
		input?: number
		output?: number
		cache_read?: number
		cache_write?: number
	}
	limit?: {
		context?: number
		output?: number
		input?: number
	}
}

interface ModelsDevProvider {
	id?: string
	name?: string
	models?: Record<string, ModelsDevModel>
}

export interface ModelLimits {
	context: number
	output: number
	input?: number
}

// ── Internal state ───────────────────────────────────────────────────────────

const CACHE_DIR = join(homedir(), '.cache', 'agent-sdk')
const CACHE_FILE = join(CACHE_DIR, 'models.json')
const API_URL = 'https://models.dev/api.json'

let modelsData: Record<string, ModelsDevProvider> | undefined
let refreshTimer: ReturnType<typeof setInterval> | undefined

// ── Resolution ───────────────────────────────────────────────────────────────

function loadFromDisk(): Record<string, ModelsDevProvider> | undefined {
	try {
		if (!existsSync(CACHE_FILE)) return undefined
		const json = readFileSync(CACHE_FILE, 'utf-8')
		return JSON.parse(json)
	} catch {
		return undefined
	}
}

async function loadFromSnapshot(): Promise<Record<string, ModelsDevProvider> | undefined> {
	try {
		// Use a variable to prevent TypeScript from resolving this at compile time.
		// The snapshot file is gitignored (generated locally) and may not exist in CI.
		const snapshotPath = './models-snapshot'
		const mod = await import(snapshotPath)
		return mod.snapshot
	} catch {
		return undefined
	}
}

async function fetchFromApi(): Promise<Record<string, ModelsDevProvider> | undefined> {
	try {
		const response = await fetch(API_URL)
		if (!response.ok) return undefined
		const json = await response.text()
		const data = JSON.parse(json)
		// Write to disk cache
		try {
			mkdirSync(CACHE_DIR, { recursive: true })
			writeFileSync(CACHE_FILE, json, 'utf-8')
		} catch {
			// cache write failure is non-fatal
		}
		return data
	} catch {
		return undefined
	}
}

/** Initialize the models cache. Called once at agent construction or lazily on first lookup. */
export async function initModelsCache(): Promise<void> {
	if (modelsData) return

	// Tier 1: disk cache
	modelsData = loadFromDisk()
	if (modelsData) {
		// Background refresh (non-blocking)
		scheduleRefresh()
		return
	}

	// Tier 2: bundled snapshot
	modelsData = await loadFromSnapshot()
	if (modelsData) {
		scheduleRefresh()
		return
	}

	// Tier 3: live fetch
	modelsData = await fetchFromApi()
	if (modelsData) {
		scheduleRefresh()
	}
}

function scheduleRefresh(): void {
	if (refreshTimer) return
	refreshTimer = setInterval(
		async () => {
			const fresh = await fetchFromApi()
			if (fresh) modelsData = fresh
		},
		60 * 60 * 1000,
	) // hourly
	refreshTimer.unref()
}

// ── Lookup helpers ───────────────────────────────────────────────────────────

/**
 * Find a model entry by key (e.g. "anthropic/claude-sonnet-4-20250514").
 * Data is nested: { providerKey: { models: { modelId: { cost, limit, ... } } } }
 * Tries direct provider[modelId] first, then substring match on model IDs.
 */
function findModel(modelKey: string): ModelsDevModel | undefined {
	if (!modelsData) return undefined
	const [rawProviderKey, modelId] = modelKey.split('/', 2)
	if (!rawProviderKey || !modelId) return undefined

	// AI SDK provider keys include a suffix (e.g. "anthropic.messages", "openai.chat")
	// but models.dev uses the base provider name (e.g. "anthropic", "openai")
	const providerKey = rawProviderKey.split('.')[0]!

	const provider = modelsData[providerKey]
	if (!provider?.models) return undefined

	// Direct lookup
	if (provider.models[modelId]) return provider.models[modelId]

	// Substring match — e.g. "claude-sonnet-4-20250514" matches key containing that string
	for (const [key, model] of Object.entries(provider.models)) {
		if (key.includes(modelId) || modelId.includes(key)) {
			return model
		}
	}
	return undefined
}

export function getModelPricing(modelKey: string): ModelPricing | undefined {
	const entry = findModel(modelKey)
	if (!entry?.cost) return undefined
	return {
		input: entry.cost.input ?? 0,
		output: entry.cost.output ?? 0,
		cacheRead: entry.cost.cache_read,
		cacheWrite: entry.cost.cache_write,
	}
}

export function getModelLimits(modelKey: string): ModelLimits | undefined {
	const entry = findModel(modelKey)
	if (!entry?.limit?.context || !entry?.limit?.output) return undefined
	return {
		context: entry.limit.context,
		output: entry.limit.output,
		input: entry.limit.input,
	}
}
