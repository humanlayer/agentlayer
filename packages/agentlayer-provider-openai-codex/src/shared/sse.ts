export function parseSseEvents(buffer: string): { events: string[]; remainder: string } {
	const events: string[] = []
	let pos = 0
	while (true) {
		const boundary = buffer.indexOf('\n\n', pos)
		if (boundary === -1) break
		const block = buffer.slice(pos, boundary)
		pos = boundary + 2
		const dataLines: string[] = []
		for (const line of block.split('\n')) {
			if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
		}
		const data = dataLines.join('\n')
		if (data && data !== '[DONE]') events.push(data)
	}
	return { events, remainder: buffer.slice(pos) }
}

export function wrapSSE(res: Response, timeoutMs: number, abortCtl: AbortController): Response {
	if (typeof timeoutMs !== 'number' || timeoutMs <= 0) return res
	if (!res.body) return res
	if (!res.headers.get('content-type')?.includes('text/event-stream')) return res

	const reader = res.body.getReader()
	const body = new ReadableStream<Uint8Array>({
		async pull(ctrl) {
			const part = await new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
				const id = setTimeout(() => {
					const err = new Error(`SSE stream read timed out after ${timeoutMs}ms - no data received`)
					abortCtl.abort(err)
					void reader.cancel(err)
					reject(err)
				}, timeoutMs)
				reader.read().then(
					(result) => {
						clearTimeout(id)
						resolve(result)
					},
					(err) => {
						clearTimeout(id)
						reject(err)
					},
				)
			})
			if (part.done) {
				ctrl.close()
				return
			}
			ctrl.enqueue(part.value)
		},
		async cancel(reason) {
			abortCtl.abort(reason)
			await reader.cancel(reason)
		},
	})

	return new Response(body, {
		headers: new Headers(res.headers),
		status: res.status,
		statusText: res.statusText,
	})
}
