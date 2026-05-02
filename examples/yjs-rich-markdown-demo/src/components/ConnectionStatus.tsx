import { useArtifactSession } from '../providers/ArtifactProvider'

export function ConnectionStatus() {
	const { connectionStatus, isSynced, localUser } = useArtifactSession()

	const statusColor =
		connectionStatus === 'connected' ? '#4caf50' : connectionStatus === 'connecting' ? '#ff9800' : '#f44336'

	return (
		<div
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: 12,
				padding: '8px 16px',
				background: '#f5f5f5',
				borderBottom: '1px solid #e0e0e0',
				fontSize: 14,
			}}
		>
			<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
				<div
					style={{
						width: 8,
						height: 8,
						borderRadius: '50%',
						background: statusColor,
					}}
				/>
				<span>{connectionStatus}</span>
			</div>
			<div style={{ color: '#666' }}>synced: {isSynced ? 'yes' : 'no'}</div>
			<div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
				<div
					style={{
						width: 12,
						height: 12,
						borderRadius: '50%',
						background: localUser.color,
					}}
				/>
				<span>{localUser.name}</span>
			</div>
		</div>
	)
}
