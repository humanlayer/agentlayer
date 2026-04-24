import { useAwarenessStates, useYjsAwareness } from '@humanlayer/yjs-fs-react'

type User = {
	id: string
	name: string
	color: string
}

export function PresenceIndicator() {
	const awareness = useYjsAwareness()
	const states = useAwarenessStates<{ user?: User }>()
	const users: User[] = []

	states.forEach((state: { user?: User }, clientId: number) => {
		if (clientId === awareness.clientID) return
		if (state.user) {
			users.push(state.user)
		}
	})

	if (users.length === 0) {
		return <span style={{ fontSize: '12px', color: '#666' }}>Only you here</span>
	}

	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
			{users.slice(0, 5).map((user) => (
				<div
					key={user.id}
					title={user.name}
					style={{
						width: '24px',
						height: '24px',
						borderRadius: '50%',
						backgroundColor: user.color,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						fontSize: '11px',
						fontWeight: 600,
						color: 'white',
						border: '2px solid white',
						boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
					}}
				>
					{user.name.charAt(0).toUpperCase()}
				</div>
			))}
			{users.length > 5 && <span style={{ fontSize: '12px', color: '#666' }}>+{users.length - 5}</span>}
		</div>
	)
}
