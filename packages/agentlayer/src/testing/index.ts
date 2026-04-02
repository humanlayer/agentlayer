/**
 * Testing utilities re-exported for test convenience.
 */
export type { AgentEvent } from '../core/agent-run'
export {
	type AgentPath,
	type AgentState,
	type ApprovalDecision,
	type ApprovalHistoryEntry,
	getAgentState,
	getAllPendingApprovals,
	startState,
	withApprovals,
} from '../core/state'
