export type AwarenessUser = {
	id: string
	name: string
	color: string
}

export type CollaboratorPresence = {
	artifactPath?: string
}

export type Collaborator = {
	clientId: number
	isSelf: boolean
	user: AwarenessUser
	presence: CollaboratorPresence
}

const LOCAL_USER_STORAGE_KEY = 'yjs-rich-markdown-demo.local-user'

const COLORS = [
	'#958DF1',
	'#F98181',
	'#FBBC88',
	'#FAF594',
	'#70CFF8',
	'#94FADB',
	'#B9F18D',
	'#C3E2C2',
	'#EAECCC',
	'#AFC8AD',
	'#EEC759',
	'#9BB8CD',
	'#FF90BC',
	'#FFC0D9',
	'#DC8686',
	'#7ED7C1',
]

function colorFromId(id: string): string {
	let hash = 0
	for (let i = 0; i < id.length; i++) {
		hash = (hash << 5) - hash + id.charCodeAt(i)
		hash = hash & hash
	}
	return COLORS[Math.abs(hash) % COLORS.length] ?? COLORS[0] ?? '#958DF1'
}

export function getOrCreateLocalUser(): AwarenessUser {
	const storedUser = readStoredLocalUser()
	if (storedUser) {
		return storedUser
	}

	const id = crypto.randomUUID()
	const user: AwarenessUser = {
		id,
		name: `User ${id.slice(0, 4)}`,
		color: colorFromId(id),
	}

	try {
		window.localStorage.setItem(LOCAL_USER_STORAGE_KEY, JSON.stringify(user))
	} catch {}

	return user
}

export function updateLocalUserName(name: string): AwarenessUser {
	const user = getOrCreateLocalUser()
	user.name = name

	try {
		window.localStorage.setItem(LOCAL_USER_STORAGE_KEY, JSON.stringify(user))
	} catch {}

	return user
}

export function getCollaborators(
	states: Map<number, unknown>,
	localClientId: number,
	options: { includeSelf?: boolean; filterByArtifact?: string } = {},
): Collaborator[] {
	const collaborators: Collaborator[] = []

	states.forEach((state, clientId) => {
		const collaborator = getCollaboratorFromAwarenessState(state, clientId, localClientId)
		if (!collaborator) {
			return
		}

		if (!options.includeSelf && collaborator.isSelf) {
			return
		}

		if (options.filterByArtifact && collaborator.presence.artifactPath !== options.filterByArtifact) {
			return
		}

		collaborators.push(collaborator)
	})

	return collaborators.sort((left, right) => {
		if (left.isSelf !== right.isSelf) {
			return left.isSelf ? -1 : 1
		}
		return left.user.name.localeCompare(right.user.name)
	})
}

export function getCollaboratorFromAwarenessState(
	state: unknown,
	clientId: number,
	localClientId: number,
): Collaborator | null {
	if (!isRecord(state)) {
		return null
	}

	const user = readUser(state.user)
	if (!user) {
		return null
	}

	const presence = isRecord(state.presence) ? state.presence : null

	return {
		clientId,
		isSelf: clientId === localClientId,
		user,
		presence: {
			artifactPath: presence && typeof presence.artifactPath === 'string' ? presence.artifactPath : undefined,
		},
	}
}

function readUser(value: unknown): AwarenessUser | null {
	if (!isRecord(value)) {
		return null
	}

	if (typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.color !== 'string') {
		return null
	}

	return {
		id: value.id,
		name: value.name,
		color: value.color,
	}
}

function readStoredLocalUser(): AwarenessUser | null {
	try {
		const value = window.localStorage.getItem(LOCAL_USER_STORAGE_KEY)
		if (!value) {
			return null
		}
		return readUser(JSON.parse(value))
	} catch {
		return null
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
