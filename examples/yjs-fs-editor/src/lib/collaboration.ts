import { colorFromId } from '@humanlayer/yjs-fs'

type AwarenessUser = {
	id: string
	name: string
	color: string
}

type CollaboratorPresence = {
	activePath?: string
	activeEntryId?: string
}

export type Collaborator = {
	clientId: number
	isSelf: boolean
	user: AwarenessUser
	presence: CollaboratorPresence
}

const LOCAL_USER_STORAGE_KEY = 'yjs-fs-editor.local-user'

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

export function getCollaborators(
	states: Map<number, unknown>,
	localClientId: number,
	options: { includeSelf?: boolean } = {},
): Collaborator[] {
	const localCollaborator = getCollaboratorFromAwarenessState(states.get(localClientId), localClientId, localClientId)
	const localUserId = localCollaborator?.user.id
	const collaboratorsByUserId = new Map<string, Collaborator>()

	states.forEach((state, clientId) => {
		const collaborator = getCollaboratorFromAwarenessState(state, clientId, localClientId)
		if (!collaborator) {
			return
		}

		if (!options.includeSelf && collaborator.isSelf) {
			return
		}

		if (!options.includeSelf && localUserId && collaborator.user.id === localUserId) {
			return
		}

		const existing = collaboratorsByUserId.get(collaborator.user.id)
		if (!existing) {
			collaboratorsByUserId.set(collaborator.user.id, collaborator)
			return
		}

		collaboratorsByUserId.set(collaborator.user.id, preferCollaborator(existing, collaborator))
	})

	const collaborators = Array.from(collaboratorsByUserId.values())

	return collaborators.sort((left, right) => {
		if (left.isSelf !== right.isSelf) {
			return left.isSelf ? -1 : 1
		}

		return left.user.name.localeCompare(right.user.name)
	})
}

export function getActivePathLabel(path: string | undefined): string {
	if (!path || path === '/') {
		return 'Workspace'
	}

	const segments = path.split('/').filter(Boolean)
	return segments.at(-1) ?? path
}

export function getTreePresenceCounts(collaborators: Collaborator[]): {
	exact: Map<string, number>
	descendants: Map<string, number>
} {
	const exact = new Map<string, number>()
	const descendants = new Map<string, number>()

	for (const collaborator of collaborators) {
		const activePath = collaborator.presence.activePath
		if (!activePath || activePath === '/') {
			continue
		}

		const treePath = toTreePath(activePath)
		if (!treePath) {
			continue
		}

		exact.set(treePath, (exact.get(treePath) ?? 0) + 1)

		const segments = treePath.split('/').filter(Boolean)
		let current = ''
		for (let index = 0; index < segments.length - 1; index += 1) {
			current = current ? `${current}/${segments[index]}` : (segments[index] ?? '')
			descendants.set(current, (descendants.get(current) ?? 0) + 1)
		}
	}

	return { exact, descendants }
}

export function getCollaboratorFromAwarenessState(
	state: unknown,
	clientId: number,
	localClientId: number,
): Collaborator | null {
	if (!isRecord(state)) {
		return null
	}

	const topLevelUser = readUser(state.user)
	const presence = isRecord(state.presence) ? state.presence : null
	const presenceUser = presence ? readUser(presence.user) : null
	const user = topLevelUser ?? presenceUser

	if (!user) {
		return null
	}

	return {
		clientId,
		isSelf: clientId === localClientId,
		user,
		presence: {
			activePath: presence && typeof presence.activePath === 'string' ? presence.activePath : undefined,
			activeEntryId: presence && typeof presence.activeEntryId === 'string' ? presence.activeEntryId : undefined,
		},
	}
}

function preferCollaborator(current: Collaborator, candidate: Collaborator): Collaborator {
	if (candidate.isSelf && !current.isSelf) {
		return candidate
	}

	if (hasActiveLocation(candidate) && !hasActiveLocation(current)) {
		return candidate
	}

	if (candidate.clientId > current.clientId) {
		return candidate
	}

	return current
}

function hasActiveLocation(collaborator: Collaborator): boolean {
	return Boolean(collaborator.presence.activeEntryId || collaborator.presence.activePath)
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

function toTreePath(filesystemPath: string): string {
	return filesystemPath.startsWith('/') ? filesystemPath.slice(1) : filesystemPath
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
