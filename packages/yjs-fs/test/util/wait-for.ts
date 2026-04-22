export async function waitFor(fn: () => boolean, timeout = 15000, interval = 50): Promise<void> {
	const start = Date.now()
	while (!fn()) {
		if (Date.now() - start > timeout) {
			throw new Error('waitFor timed out')
		}
		await new Promise((resolve) => setTimeout(resolve, interval))
	}
}
