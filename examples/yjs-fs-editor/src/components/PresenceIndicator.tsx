import type { Collaborator } from '../lib/collaboration'
import { getActivePathLabel } from '../lib/collaboration'

type PresenceIndicatorProps = {
	collaborators: Collaborator[]
	onNavigateToPath: (path: string) => void
}

export function PresenceIndicator({ collaborators, onNavigateToPath }: PresenceIndicatorProps) {
	if (collaborators.length === 0) {
		return <span style={{ fontSize: '12px', color: '#666' }}>Only you here</span>
	}

	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
			{collaborators.slice(0, 4).map((collaborator) => {
				const activePath = collaborator.presence.activePath
				const label = getActivePathLabel(activePath)

				return (
					<button
						key={`${collaborator.clientId}-${collaborator.user.id}`}
						onClick={() => {
							if (activePath) {
								onNavigateToPath(activePath)
							}
						}}
						disabled={!activePath}
						title={
							activePath
								? `${collaborator.user.name} is on ${activePath}`
								: `${collaborator.user.name} is in the workspace`
						}
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: '8px',
							padding: '4px 8px 4px 4px',
							border: '1px solid #d9d9d9',
							borderRadius: '999px',
							backgroundColor: 'white',
							cursor: activePath ? 'pointer' : 'default',
							opacity: activePath ? 1 : 0.85,
						}}
					>
						<div
							style={{
								width: '24px',
								height: '24px',
								borderRadius: '50%',
								backgroundColor: collaborator.user.color,
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								fontSize: '11px',
								fontWeight: 700,
								color: 'white',
							}}
						>
							{collaborator.user.name.charAt(0).toUpperCase()}
						</div>
						<div
							style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}
						>
							<span style={{ fontSize: '12px', fontWeight: 600, color: '#1f1f1f' }}>
								{collaborator.user.name}
							</span>
							<span
								style={{
									fontSize: '11px',
									color: '#666',
									maxWidth: '160px',
									overflow: 'hidden',
									textOverflow: 'ellipsis',
								}}
							>
								{label}
							</span>
						</div>
					</button>
				)
			})}
			{collaborators.length > 4 && (
				<span style={{ fontSize: '12px', color: '#666' }}>+{collaborators.length - 4}</span>
			)}
		</div>
	)
}
