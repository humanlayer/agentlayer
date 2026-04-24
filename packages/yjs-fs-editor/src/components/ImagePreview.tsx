import { useFilesystem } from '@humanlayer/yjs-fs-react'
import { useEffect, useState } from 'react'
import { guessMimeType } from '../lib/mime-types'

type ImagePreviewProps = {
	path: string
}

export function ImagePreview({ path }: ImagePreviewProps) {
	const filesystem = useFilesystem()
	const [blobUrl, setBlobUrl] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		try {
			const stat = filesystem.stat(path)
			if (stat.type !== 'file' || stat.encoding !== 'binary') {
				setError('Not a binary file')
				return
			}

			const bytes = filesystem.readBinaryFile(path)
			const arrayBuffer = new ArrayBuffer(bytes.length)
			new Uint8Array(arrayBuffer).set(bytes)
			const blob = new Blob([arrayBuffer], { type: guessMimeType(path) })
			const url = URL.createObjectURL(blob)
			setBlobUrl(url)
			setError(null)

			return () => URL.revokeObjectURL(url)
		} catch (err) {
			setError(String(err))
			setBlobUrl(null)
		}
	}, [filesystem, path])

	if (error) {
		return (
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					height: '100%',
					color: '#666',
				}}
			>
				<div style={{ textAlign: 'center' }}>
					<div style={{ fontSize: '48px', marginBottom: '16px' }}>🖼️</div>
					<div>Cannot preview image</div>
					<div style={{ fontSize: '12px', marginTop: '8px', color: '#999' }}>{error}</div>
				</div>
			</div>
		)
	}

	if (!blobUrl) {
		return (
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					height: '100%',
					color: '#666',
				}}
			>
				Loading image...
			</div>
		)
	}

	return (
		<div
			style={{
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				height: '100%',
				padding: '16px',
				backgroundColor: '#f5f5f5',
			}}
		>
			<img
				src={blobUrl}
				alt={path}
				style={{
					maxWidth: '100%',
					maxHeight: '100%',
					objectFit: 'contain',
					boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
				}}
			/>
		</div>
	)
}
