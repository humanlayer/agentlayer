import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CodexDiagnosticRecord, CodexDiagnosticsContext } from '@humanlayer/agentlayer-provider-openai-codex'

const DEFAULT_DIAGNOSTICS_PATH = '~/.humanlayer/riptide/logs/codex-provider-logs.jsonl'

/**
 * Expand a leading `~` / `~/` to the user's home directory. CodeLayer cannot
 * import synclayer's `normalizePath`, so this mirrors `lib/utils.ts:16`. Without
 * this, a quoted/un-expanded `~` env value would create a literal `./~/...`
 * directory.
 */
export function expandHome(filePath: string): string {
	if (filePath === '~') return homedir()
	if (filePath.startsWith('~/')) return join(homedir(), filePath.slice(2))
	return filePath
}

export interface CreateCliCodexDiagnosticsOptions {
	model: string
	verbose?: boolean
	sessionId?: string
}

/**
 * Build a lightweight, CLI-owned diagnostics context — the agentlayer-side
 * analogue of the Riptide daemon sink. Stays generic (no Sentry): appends each
 * record as a JSONL line to `CODEX_DIAGNOSTICS_LOG` (default
 * `~/.humanlayer/riptide/logs/codex-provider-logs.jsonl`) after expanding `~`
 * and ensuring the parent directory exists. When `verbose`, each record is also
 * mirrored to stderr. All I/O is wrapped so sink failures never break the
 * model stream.
 */
export function createCliCodexDiagnostics(options: CreateCliCodexDiagnosticsOptions): CodexDiagnosticsContext {
	const rawPath = process.env.CODEX_DIAGNOSTICS_LOG ?? DEFAULT_DIAGNOSTICS_PATH
	const filePath = expandHome(rawPath)

	const annotations: Record<string, unknown> = {
		model: options.model,
		provider: 'codex',
		source: 'codex-provider-diagnostics',
	}
	if (options.sessionId) annotations.sessionId = options.sessionId

	const onEvent = (record: CodexDiagnosticRecord) => {
		try {
			mkdirSync(dirname(filePath), { recursive: true })
			appendFileSync(filePath, `${JSON.stringify({ source: 'codex-provider-diagnostics', ...record })}\n`)
		} catch {
			// Diagnostics must never break the model stream.
		}
		if (options.verbose) {
			try {
				console.error('[codex-diag]', record.severity, record.event, JSON.stringify(record.metadata))
			} catch {
				// ignore stderr mirroring failures
			}
		}
	}

	return { annotations, onEvent }
}
