import { getExtension } from './file-types'

const MIME_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.bmp': 'image/bmp',
}

export function guessMimeType(path: string): string {
	const ext = getExtension(path)
	return MIME_TYPES[ext] || 'application/octet-stream'
}
