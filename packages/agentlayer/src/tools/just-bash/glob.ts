import type { Bash } from 'just-bash'
import { GlobTool } from '../interfaces/glob'

export function createGlobTool(bash: Bash) {
	return GlobTool.define(async (input) => {
		const searchPath = input.path ?? '.'
		// Use rg --files with glob filter — rg is typically available in just-bash environments
		const result = await bash.exec(`rg --files -g "${input.pattern}" "${searchPath}" 2>/dev/null`)

		if (result.exitCode !== 0 && result.exitCode !== 1) {
			// Non-zero / non-empty exit may mean rg not available — fall back to find
			const findResult = await bash.exec(
				`find "${searchPath}" -type f -name "${input.pattern}" 2>/dev/null | head -100`,
			)
			if (findResult.exitCode !== 0) {
				return []
			}
			return findResult.stdout
				.split('\n')
				.map((l) => l.trim())
				.filter(Boolean)
		}

		return result.stdout
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean)
	})
}
