const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024 // 50KB

export function truncateOutput(output: string, opts?: { maxLines?: number; maxBytes?: number }): string {
	const maxLines = opts?.maxLines ?? MAX_LINES
	const maxBytes = opts?.maxBytes ?? MAX_BYTES

	const byteLength = Buffer.byteLength(output, 'utf-8')
	const lines = output.split('\n')

	if (lines.length <= maxLines && byteLength <= maxBytes) {
		return output
	}

	let result = ''
	let lineCount = 0
	for (const line of lines) {
		if (lineCount >= maxLines) break
		const next = lineCount === 0 ? line : `\n${line}`
		if (Buffer.byteLength(result + next, 'utf-8') > maxBytes) break
		result += next
		lineCount++
	}

	return `${result}\n\n[output truncated — ${lines.length} lines / ${byteLength} bytes exceeded limit of ${maxLines} lines / ${maxBytes} bytes]`
}
