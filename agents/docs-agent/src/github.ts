const GITHUB_API_BASE = 'https://api.github.com'

export interface GitHubRepoRef {
	token: string
	repo: string
}

export interface AgentCommentInput extends GitHubRepoRef {
	prNumber: number
	agentName: string
	sha: string
	body: string
}

interface IssueComment {
	id: number
	body: string
}

function parseRepo(repo: string) {
	const [owner, name] = repo.split('/')
	if (!owner || !name) {
		throw new Error(`Invalid repo ${repo}. Expected owner/repo.`)
	}
	return { owner, repo: name }
}

function buildMarker(agentName: string, sha: string) {
	return `<!-- ${agentName}:sha=${sha} -->`
}

function markerPrefix(agentName: string) {
	return `<!-- ${agentName}:sha=`
}

async function githubRequest<T>(
	repo: string,
	token: string,
	path: string,
	init?: RequestInit,
): Promise<T> {
	const { owner, repo: name } = parseRepo(repo)
	const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${name}${path}`, {
		...init,
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${token}`,
			'user-agent': 'agentlayer-docs-agent',
			...(init?.headers ?? {}),
		},
	})

	if (!response.ok) {
		throw new Error(`GitHub API ${init?.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`)
	}

	if (response.status === 204) {
		return undefined as T
	}

	return (await response.json()) as T
}

async function listIssueComments(repo: string, token: string, prNumber: number) {
	return githubRequest<IssueComment[]>(repo, token, `/issues/${prNumber}/comments?per_page=100`)
}

export async function loadAgentComment(input: Omit<AgentCommentInput, 'sha' | 'body'>) {
	const comments = await listIssueComments(input.repo, input.token, input.prNumber)
	const prefix = markerPrefix(input.agentName)
	return comments
		.filter((comment) => comment.body.startsWith(prefix))
		.sort((a, b) => b.id - a.id)[0]
}

export async function upsertAgentComment(input: AgentCommentInput) {
	const existing = await loadAgentComment(input)
	const body = `${buildMarker(input.agentName, input.sha)}\n${input.body}`

	if (existing) {
		return githubRequest<IssueComment>(input.repo, input.token, `/issues/comments/${existing.id}`, {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify({ body }),
		})
	}

	return githubRequest<IssueComment>(input.repo, input.token, `/issues/${input.prNumber}/comments`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
		},
		body: JSON.stringify({ body }),
	})
}
