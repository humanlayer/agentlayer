import { useAwarenessStates, useConnectionStatus, useFilesystem } from '@humanlayer/yjs-fs-react'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { getCollaborators } from '../lib/collaboration'
import { CommentsPanel } from './CommentsPanel'
import { EditorPane } from './EditorPane'
import { FileTreePane } from './FileTreePane'
import { PresenceIndicator } from './PresenceIndicator'

type LayoutProps = {
	activePath: string
}

export function Layout({ activePath }: LayoutProps) {
	const filesystem = useFilesystem()
	const connectionStatus = useConnectionStatus()
	const awarenessStates = useAwarenessStates()
	const navigate = useNavigate()
	const [showComments, setShowComments] = useState(false)

	const activeEntryId = useMemo(() => {
		try {
			return filesystem.lookup(activePath)?.entryId
		} catch {
			return undefined
		}
	}, [filesystem, activePath])

	useEffect(() => {
		filesystem.updateLocalPresence({
			activePath,
			activeEntryId,
		})
	}, [filesystem, activePath, activeEntryId])

	const collaborators = useMemo(
		() => getCollaborators(awarenessStates as Map<number, unknown>, filesystem.awareness?.clientID ?? -1),
		[awarenessStates, filesystem.awareness],
	)

	const handleFileSelect = (path: string) => {
		const pathWithoutLeadingSlash = path.startsWith('/') ? path.slice(1) : path
		navigate({
			to: '/files/$',
			params: { _splat: pathWithoutLeadingSlash },
			search: (prev) => prev,
		})
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
			<header
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '8px 16px',
					borderBottom: '1px solid #e0e0e0',
					backgroundColor: '#fafafa',
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
					<h1 style={{ fontSize: '16px', fontWeight: 600, margin: 0 }}>yjs-fs-editor</h1>
					<span
						style={{
							fontSize: '12px',
							padding: '2px 8px',
							borderRadius: '4px',
							backgroundColor:
								connectionStatus === 'connected'
									? '#e8f5e9'
									: connectionStatus === 'connecting'
										? '#fff3e0'
										: '#ffebee',
							color:
								connectionStatus === 'connected'
									? '#2e7d32'
									: connectionStatus === 'connecting'
										? '#ef6c00'
										: '#c62828',
						}}
					>
						{connectionStatus === 'connected'
							? 'Connected'
							: connectionStatus === 'connecting'
								? 'Connecting'
								: 'Disconnected'}
					</span>
				</div>
				<div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
					<PresenceIndicator collaborators={collaborators} onNavigateToPath={handleFileSelect} />
					<button
						onClick={() => setShowComments(!showComments)}
						style={{
							padding: '4px 12px',
							fontSize: '13px',
							border: '1px solid #ccc',
							borderRadius: '4px',
							backgroundColor: showComments ? '#e3f2fd' : 'white',
							cursor: 'pointer',
						}}
					>
						Comments
					</button>
				</div>
			</header>

			<div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
				<div
					style={{
						width: '400px',
						borderRight: '1px solid #e0e0e0',
						display: 'flex',
						flexDirection: 'column',
						overflow: 'hidden',
					}}
				>
					<FileTreePane
						activePath={activePath}
						onFileSelect={handleFileSelect}
						collaborators={collaborators}
					/>
				</div>

				<div style={{ flex: 1, overflow: 'hidden' }}>
					<EditorPane path={activePath} key={activePath} />
				</div>

				{showComments && (
					<div
						style={{
							width: '300px',
							borderLeft: '1px solid #e0e0e0',
							overflow: 'auto',
						}}
					>
						<CommentsPanel path={activePath} />
					</div>
				)}
			</div>
		</div>
	)
}
