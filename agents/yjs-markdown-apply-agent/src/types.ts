export type SecureApplyInput = {
	path: string
	oldString: string
	newString: string
	currentMarkdown: string
	currentXml: string
	snapshotBase64: string
	baseStateVectorBase64: string
	artifactFragmentName: string
	baseArtifactRevision: number
	systemInformation?: string
}

export type SecureApplyResult = {
	ok: boolean
	proposedUpdateBase64?: string
	beforeMarkdown?: string
	afterMarkdown?: string
	beforeXml?: string
	afterXml?: string
	changedArtifacts?: string[]
	validationErrors?: string[]
	operationLog?: string[]
}

export type ApplyRetryPolicy = {
	maxAttempts: number
	initialBackoffMs: number
	maxBackoffMs: number
	waitForQuietMs: number
	maxWaitForQuietMs: number
}

export type ApplyAttemptAbort = {
	reason: 'target-fragment-changed'
	path: string
	previousRevision: number
	currentRevision: number
	changeSummary: string[]
	updatedMarkdown: string
	updatedXml: string
	snapshotBase64: string
	baseStateVectorBase64: string
}
