import { useEffect, useState } from 'react'
import {
	createTransportLabController,
	type LabSnapshot,
	type TransportLabController,
} from './lab'

export function App() {
	const [singleController] = useState(() => createTransportLabController('single-stream'))
	const [perDocController] = useState(() => createTransportLabController('per-document'))

	return (
		<div className="app-shell">
			<header className="hero">
				<p className="eyebrow">AgentLayer / Yjs FS</p>
				<h1>Transport Lab</h1>
				<p className="hero-copy">
					Compare the single-stream and per-document transport shapes side by side, then run the same UI behind plain HTTP or
					local HTTPS through Caddy to think about browser connection pressure.
				</p>
				<div className="hero-grid">
					<InfoCard
						title="Vite Dev"
						value="http://127.0.0.1:4173"
						detail="Useful while building the lab itself."
					/>
					<InfoCard
						title="Caddy HTTPS"
						value="https://localhost:3443"
						detail="Use this for the browser-friendly HTTP/2 path."
					/>
					<InfoCard
						title="Caddy HTTP"
						value="http://localhost:3080"
						detail="Use this when you want to reason about plain HTTP pressure."
					/>
				</div>
			</header>

			<main className="panel-grid">
				<TopologyPanel
					title="Single Stream"
					subtitle="One filesystem channel plus one awareness channel"
					controller={singleController}
				/>
				<TopologyPanel
					title="Per Document"
					subtitle="Root, awareness, and each content doc split apart"
					controller={perDocController}
				/>
			</main>
		</div>
	)
}

function TopologyPanel(props: {
	title: string
	subtitle: string
	controller: TransportLabController
}) {
	const { controller, title, subtitle } = props
	const [version, setVersion] = useState(0)
	const [snapshot, setSnapshot] = useState(() => controller.getSnapshot())
	const [draftA, setDraftA] = useState('')
	const [draftB, setDraftB] = useState('')

	useEffect(() => {
		setSnapshot(controller.getSnapshot())
	}, [controller, version])

	useEffect(() => {
		setDraftA(snapshot.replicaA.selectedText)
		setDraftB(snapshot.replicaB.selectedText || snapshot.replicaA.selectedText)
	}, [snapshot.selectedPath, snapshot.replicaA.selectedText, snapshot.replicaB.selectedText])

	const refresh = () => {
		setVersion((value) => value + 1)
	}

	return (
		<section className="panel">
			<div className="panel-header">
				<div>
					<p className="eyebrow">{controller.mode}</p>
					<h2>{title}</h2>
					<p className="panel-copy">{subtitle}</p>
				</div>
				<div className="button-row wrap">
					<button onClick={() => { controller.seedDocuments(1); refresh() }}>Add 1 Doc</button>
					<button onClick={() => { controller.seedDocuments(5); refresh() }}>Add 5 Docs</button>
					<button onClick={() => { controller.clearLogs(); refresh() }}>Clear Log</button>
				</div>
			</div>

			<div className="summary-grid">
				<MetricCard label="Replica A Streams" value={String(snapshot.replicaA.approximateHttpOneStreams)} />
				<MetricCard label="Replica B Streams" value={String(snapshot.replicaB.approximateHttpOneStreams)} />
				<MetricCard label="Selected File" value={snapshot.selectedPath ?? 'none'} />
				<MetricCard label="Published Messages" value={String(snapshot.logCount)} />
			</div>

			<div className="notes-card">
				{snapshot.notes.map((note) => (
					<p key={note}>{note}</p>
				))}
			</div>

			<div className="layout-grid">
				<div className="stack">
					<section className="card">
						<div className="card-header">
							<h3>Replica Control</h3>
							<p>Keep B disconnected for late-join tests, then connect it after a few edits.</p>
						</div>
						<div className="button-row wrap">
							<button onClick={() => { controller.connectReplica('B'); refresh() }} disabled={snapshot.replicaB.connected}>
								Connect B
							</button>
							<button onClick={() => { controller.disconnectReplica('B'); refresh() }} disabled={!snapshot.replicaB.connected}>
								Disconnect B
							</button>
							<button onClick={() => { controller.renameSelected(); refresh() }} disabled={!snapshot.selectedPath}>
								Rename Selected
							</button>
							<button onClick={() => { controller.deleteSelected(); refresh() }} disabled={!snapshot.selectedPath}>
								Delete Selected
							</button>
						</div>
						<div className="button-row wrap">
							<button onClick={() => { controller.addCommentFromReplicaA(); refresh() }} disabled={!snapshot.selectedPath}>
								Comment From A
							</button>
							<button
								onClick={() => { controller.resolveFirstCommentFromReplicaB(); refresh() }}
								disabled={!snapshot.selectedPath || !snapshot.replicaB.connected}
							>
								Resolve From B
							</button>
							<button onClick={() => { controller.setPresence('A'); refresh() }} disabled={!snapshot.selectedPath}>
								Presence A
							</button>
							<button onClick={() => { controller.setPresence('B'); refresh() }} disabled={!snapshot.selectedPath || !snapshot.replicaB.connected}>
								Presence B
							</button>
						</div>
					</section>

					<section className="card">
						<div className="card-header">
							<h3>Workspace Files</h3>
							<p>These are derived from Replica A, which stays connected as the reference side.</p>
						</div>
						<div className="file-list">
							{snapshot.files.length === 0 ? <p className="empty">Seed a few docs to start.</p> : null}
							{snapshot.files.map((path) => (
								<button
									key={path}
									type="button"
									className={path === snapshot.selectedPath ? 'file-pill active' : 'file-pill'}
									onClick={() => { controller.selectPath(path); refresh() }}
								>
									{path}
								</button>
							))}
						</div>
					</section>

					<section className="card">
						<div className="card-header">
							<h3>Connection Pressure</h3>
							<p>Approximate stream counts are based on unique channel ids per connected replica.</p>
						</div>
						<PressureList label="Replica A" channels={snapshot.replicaA.channelIds} />
						<PressureList label="Replica B" channels={snapshot.replicaB.channelIds} />
					</section>
				</div>

				<div className="stack">
					<section className="card two-up">
						<EditorCard
							title="Replica A"
							connected={snapshot.replicaA.connected}
							value={draftA}
							onChange={setDraftA}
							onApply={() => { controller.applyText('A', draftA); refresh() }}
							stat={snapshot.replicaA.selectedStat}
						/>
						<EditorCard
							title="Replica B"
							connected={snapshot.replicaB.connected}
							value={draftB}
							onChange={setDraftB}
							onApply={() => { controller.applyText('B', draftB); refresh() }}
							stat={snapshot.replicaB.selectedStat}
							disabled={!snapshot.replicaB.connected}
						/>
					</section>

					<section className="card two-up">
						<CommentCard title="Comments on A" comments={snapshot.replicaA.comments} />
						<CommentCard title="Comments on B" comments={snapshot.replicaB.comments} />
					</section>

					<section className="card two-up">
						<PresenceCard title="Presence Seen By A" peers={snapshot.replicaA.presencePeers} />
						<PresenceCard title="Presence Seen By B" peers={snapshot.replicaB.presencePeers} />
					</section>

					<section className="card">
						<div className="card-header">
							<h3>Transport Log</h3>
							<p>Recent published messages from the in-memory transport wrapper.</p>
						</div>
						<div className="log-list">
							{snapshot.logEntries.length === 0 ? <p className="empty">No messages yet.</p> : null}
							{snapshot.logEntries.slice(0, 14).map((entry) => (
								<div className="log-row" key={entry.id}>
									<span>{entry.timestamp}</span>
									<strong>{entry.channelId}</strong>
									<span>{entry.bindingKind}</span>
									<span>{entry.contentId ?? 'catalog'}</span>
								</div>
							))}
						</div>
					</section>
				</div>
			</div>
		</section>
	)
}

function InfoCard(props: { title: string; value: string; detail: string }) {
	return (
		<div className="info-card">
			<p>{props.title}</p>
			<strong>{props.value}</strong>
			<span>{props.detail}</span>
		</div>
	)
}

function MetricCard(props: { label: string; value: string }) {
	return (
		<div className="metric-card">
			<span>{props.label}</span>
			<strong>{props.value}</strong>
		</div>
	)
}

function PressureList(props: { label: string; channels: string[] }) {
	const pressure = props.channels.length > 6 ? 'above a classic HTTP/1.1 six-connection budget' : 'within a six-connection budget'

	return (
		<div className="pressure-block">
			<h4>{props.label}</h4>
			<p>
				{props.channels.length} channel{props.channels.length === 1 ? '' : 's'}; {pressure}.
			</p>
			<div className="channel-list">
				{props.channels.length === 0 ? <span className="empty">Disconnected</span> : null}
				{props.channels.map((channel) => (
					<span key={channel} className="channel-pill">
						{channel}
					</span>
				))}
			</div>
		</div>
	)
}

function EditorCard(props: {
	title: string
	connected: boolean
	value: string
	onChange: (value: string) => void
	onApply: () => void
	stat?: LabSnapshot['replicaA']['selectedStat']
	disabled?: boolean
}) {
	return (
		<div className="editor-card">
			<div className="card-header compact">
				<h3>{props.title}</h3>
				<p>{props.connected ? 'Connected' : 'Disconnected'}</p>
			</div>
			{props.stat ? (
				<div className="stat-strip">
					<span>entry {props.stat.entryId}</span>
					<span>content {props.stat.contentId}</span>
					<span>{props.stat.size ?? 0} chars</span>
				</div>
			) : (
				<p className="empty">No file selected.</p>
			)}
			<textarea value={props.value} onChange={(event) => props.onChange(event.target.value)} disabled={props.disabled} />
			<div className="button-row">
				<button onClick={props.onApply} disabled={props.disabled || !props.stat}>
					Apply
				</button>
			</div>
		</div>
	)
}

function CommentCard(props: { title: string; comments: LabSnapshot['replicaA']['comments'] }) {
	return (
		<div>
			<div className="card-header compact">
				<h3>{props.title}</h3>
				<p>{props.comments.length} thread(s)</p>
			</div>
			<div className="comment-list">
				{props.comments.length === 0 ? <p className="empty">No comments yet.</p> : null}
				{props.comments.map((comment) => (
					<div className="comment-card" key={comment.id}>
						<div className="comment-meta">
							<strong>{comment.author}</strong>
							<span>
								{comment.anchorIndex}-{comment.anchorIndex + comment.anchorLength}
							</span>
							<span>{comment.resolved ? 'resolved' : 'open'}</span>
						</div>
						<p>{comment.body}</p>
					</div>
				))}
			</div>
		</div>
	)
}

function PresenceCard(props: { title: string; peers: LabSnapshot['replicaA']['presencePeers'] }) {
	return (
		<div>
			<div className="card-header compact">
				<h3>{props.title}</h3>
				<p>{props.peers.length} client(s)</p>
			</div>
			<div className="presence-list">
				{props.peers.length === 0 ? <p className="empty">No awareness state yet.</p> : null}
				{props.peers.map((peer) => (
					<div className="presence-row" key={peer.clientId}>
						<strong>{peer.name ?? peer.userId ?? `client-${peer.clientId}`}</strong>
						<span>{peer.activePath ?? 'no active path'}</span>
						<span>{peer.hasSelection ? 'selection' : 'no selection'}</span>
					</div>
				))}
			</div>
		</div>
	)
}
