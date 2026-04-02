// Re-export from server implementation — the server/web-fetch.ts uses only
// native fetch() plus TurndownService, so it is runtime-agnostic in practice.
export { createWebFetchTool } from '../server/web-fetch'
