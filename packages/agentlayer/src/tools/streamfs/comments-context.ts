import type { Comment } from '@humanlayer/agentlayer-stream-fs'

/**
 * Context required by comment tools. Provides access to the comments
 * durable stream and a function to read current comments from state.
 */
export interface CommentsContext {
	stream: { append(data: string): Promise<unknown> }
	readComments: () => Comment[]
}
