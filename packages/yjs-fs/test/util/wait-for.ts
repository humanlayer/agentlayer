import type { YjsProvider } from '@durable-streams/y-durable-streams'
import * as Y from 'yjs'
export async function waitFor(fn: () => boolean, timeout = 15000, interval = 50): Promise<void> {
	const start = Date.now()
	while (!fn()) {
		if (Date.now() - start > timeout) {
			throw new Error('waitFor timed out')
		}
		await new Promise((resolve) => setTimeout(resolve, interval))
	}
}

export const DEFAULT_TIMEOUT_MS = 5_000

export async function waitForCondition(
	condition: () => boolean | Promise<boolean>,
	label: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
	intervalMs: number = 50,
) {
	const start = Date.now()

	while (Date.now() - start < timeoutMs) {
		if (await condition()) return
		await Bun.sleep(intervalMs)
	}

	throw new Error(`Timeout waiting for ${label}`)
}

export async function waitForSync(provider: YjsProvider, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
	await waitForCondition(() => provider.synced, 'provider sync', timeoutMs)
}

export async function waitForDocText(doc: Y.Doc, name: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
	await waitForCondition(() => doc.getText(name).toJSON().length > 0, `doc text ${name}`, timeoutMs)
}

export async function waitForStateVectorSync(
	doc1: Y.Doc,
	doc2: Y.Doc,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
) {
	await waitForCondition(
		() => {
			const sv1 = Y.encodeStateVector(doc1)
			const sv2 = Y.encodeStateVector(doc2)
			return Buffer.from(sv1).equals(Buffer.from(sv2))
		},
		'state vector sync',
		timeoutMs,
	)
}
