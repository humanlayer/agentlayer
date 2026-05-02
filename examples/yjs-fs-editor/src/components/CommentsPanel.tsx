import type { FileComment } from '@humanlayer/yjs-fs'
import { useFileSelector, useFilesystem, useYjsAwareness } from '@humanlayer/yjs-fs-react'
import { useCallback, useState } from 'react'

type CommentsPanelProps = {
	path: string
}

export function CommentsPanel({ path }: CommentsPanelProps) {
	const filesystem = useFilesystem()
	const awareness = useYjsAwareness()
	const [newCommentText, setNewCommentText] = useState('')
	const [replyingTo, setReplyingTo] = useState<string | null>(null)
	const [replyText, setReplyText] = useState('')

	const localUser = awareness.getLocalState()?.user as { name: string } | undefined
	const authorName = localUser?.name || 'Anonymous'

	const comments = useFileSelector(
		path,
		useCallback(
			(currentFilesystem: typeof filesystem): FileComment[] => {
				try {
					const stat = currentFilesystem.stat(path)
					if (stat.isFile && stat.encoding === 'text') {
						return currentFilesystem.getComments(path)
					}
				} catch {
					return []
				}

				return []
			},
			[path],
		),
	)

	const handleAddComment = useCallback(() => {
		if (!newCommentText.trim()) return

		try {
			filesystem.addComment(path, { index: 0, length: 0 }, newCommentText.trim(), authorName)
			setNewCommentText('')
		} catch (err) {
			console.error('Failed to add comment:', err)
		}
	}, [filesystem, path, newCommentText, authorName])

	const handleReply = useCallback(
		(commentId: string) => {
			if (!replyText.trim()) return

			try {
				filesystem.replyToComment(path, commentId, replyText.trim(), authorName)
				setReplyingTo(null)
				setReplyText('')
			} catch (err) {
				console.error('Failed to reply:', err)
			}
		},
		[filesystem, path, replyText, authorName],
	)

	const handleResolve = useCallback(
		(commentId: string) => {
			try {
				filesystem.resolveComment(path, commentId, authorName)
			} catch (err) {
				console.error('Failed to resolve:', err)
			}
		},
		[filesystem, path, authorName],
	)

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
			<div
				style={{
					padding: '12px',
					borderBottom: '1px solid #e0e0e0',
					fontWeight: 600,
				}}
			>
				Comments
			</div>

			<div style={{ flex: 1, overflow: 'auto', padding: '12px' }}>
				{comments.length === 0 ? (
					<div style={{ color: '#666', fontSize: '13px' }}>No comments yet. Add one below.</div>
				) : (
					<div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
						{comments.map((comment: FileComment) => (
							<div
								key={comment.id}
								style={{
									padding: '12px',
									backgroundColor: comment.resolved ? '#f5f5f5' : '#fff',
									border: '1px solid #e0e0e0',
									borderRadius: '8px',
									opacity: comment.resolved ? 0.7 : 1,
								}}
							>
								<div
									style={{
										display: 'flex',
										justifyContent: 'space-between',
										marginBottom: '8px',
									}}
								>
									<span style={{ fontWeight: 500, fontSize: '13px' }}>{comment.author}</span>
									<span style={{ fontSize: '11px', color: '#666' }}>
										{new Date(comment.createdAt).toLocaleDateString()}
									</span>
								</div>

								<div style={{ fontSize: '13px', marginBottom: '8px' }}>{comment.body}</div>

								{comment.replies.length > 0 && (
									<div
										style={{
											marginLeft: '12px',
											paddingLeft: '12px',
											borderLeft: '2px solid #e0e0e0',
											marginBottom: '8px',
										}}
									>
										{comment.replies.map((reply: FileComment['replies'][number]) => (
											<div key={reply.id} style={{ marginBottom: '8px' }}>
												<div
													style={{
														fontWeight: 500,
														fontSize: '12px',
														marginBottom: '2px',
													}}
												>
													{reply.author}
												</div>
												<div style={{ fontSize: '12px' }}>{reply.body}</div>
											</div>
										))}
									</div>
								)}

								{!comment.resolved && (
									<div style={{ display: 'flex', gap: '8px' }}>
										{replyingTo === comment.id ? (
											<div style={{ flex: 1 }}>
												<input
													type="text"
													value={replyText}
													onChange={(e) => setReplyText(e.target.value)}
													onKeyDown={(e) => {
														if (e.key === 'Enter') handleReply(comment.id)
														if (e.key === 'Escape') setReplyingTo(null)
													}}
													placeholder="Write a reply..."
													autoFocus
													style={{
														width: '100%',
														padding: '6px 8px',
														fontSize: '12px',
														border: '1px solid #ccc',
														borderRadius: '4px',
														marginBottom: '4px',
													}}
												/>
												<div style={{ display: 'flex', gap: '4px' }}>
													<button
														onClick={() => handleReply(comment.id)}
														style={{
															padding: '4px 8px',
															fontSize: '11px',
															border: 'none',
															borderRadius: '4px',
															backgroundColor: '#1976d2',
															color: 'white',
															cursor: 'pointer',
														}}
													>
														Reply
													</button>
													<button
														onClick={() => setReplyingTo(null)}
														style={{
															padding: '4px 8px',
															fontSize: '11px',
															border: '1px solid #ccc',
															borderRadius: '4px',
															backgroundColor: 'white',
															cursor: 'pointer',
														}}
													>
														Cancel
													</button>
												</div>
											</div>
										) : (
											<>
												<button
													onClick={() => setReplyingTo(comment.id)}
													style={{
														padding: '4px 8px',
														fontSize: '11px',
														border: '1px solid #ccc',
														borderRadius: '4px',
														backgroundColor: 'white',
														cursor: 'pointer',
													}}
												>
													Reply
												</button>
												<button
													onClick={() => handleResolve(comment.id)}
													style={{
														padding: '4px 8px',
														fontSize: '11px',
														border: '1px solid #ccc',
														borderRadius: '4px',
														backgroundColor: 'white',
														cursor: 'pointer',
													}}
												>
													Resolve
												</button>
											</>
										)}
									</div>
								)}

								{comment.resolved && (
									<div style={{ fontSize: '11px', color: '#4caf50' }}>
										✓ Resolved by {comment.resolvedBy}
									</div>
								)}
							</div>
						))}
					</div>
				)}
			</div>

			<div style={{ padding: '12px', borderTop: '1px solid #e0e0e0' }}>
				<textarea
					value={newCommentText}
					onChange={(e) => setNewCommentText(e.target.value)}
					placeholder="Add a comment..."
					style={{
						width: '100%',
						padding: '8px',
						fontSize: '13px',
						border: '1px solid #ccc',
						borderRadius: '4px',
						resize: 'vertical',
						minHeight: '60px',
						marginBottom: '8px',
					}}
				/>
				<button
					onClick={handleAddComment}
					disabled={!newCommentText.trim()}
					style={{
						width: '100%',
						padding: '8px',
						fontSize: '13px',
						border: 'none',
						borderRadius: '4px',
						backgroundColor: newCommentText.trim() ? '#1976d2' : '#ccc',
						color: 'white',
						cursor: newCommentText.trim() ? 'pointer' : 'not-allowed',
					}}
				>
					Add Comment
				</button>
			</div>
		</div>
	)
}
