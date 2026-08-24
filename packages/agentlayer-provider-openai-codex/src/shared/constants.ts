export const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
export const CODEX_PROVIDER = 'openai.codex'
export const CODEX_PROVIDER_ID = 'codex'
export const CODEX_FAST_SERVICE_TIER = 'priority'
export const CODEX_FLEX_SERVICE_TIER = 'flex'
export const CODEX_DEFAULT_VERSION = '1.15.7'
export const CODEX_FIRST_EVENT_TIMEOUT_MS = 60_000
export const CODEX_FIRST_EVENT_TIMEOUT_RETRIES = 5
export const CODEX_FIRST_EVENT_RETRY_BASE_DELAY_MS = 1_000
export const CODEX_FIRST_EVENT_RETRY_MAX_DELAY_MS = 10_000
export const CODEX_EVENT_IDLE_TIMEOUT_MS = 120_000
export const CODEX_PRODUCTIVE_FIRST_EVENT_TIMEOUT_MS = 60_000
export const CODEX_PRODUCTIVE_EVENT_IDLE_WARNING_MS = 60_000
export const CODEX_HEADER_TIMEOUT_MS = 10_000
// Absolute wall-clock ceiling for a single stream. Bumped 300s->600s (CORE-1446):
// observed caps were productive throughout (large GPT-5.5 tool-call arg streams).
export const CODEX_MAX_STREAM_DURATION_MS = 600_000
export const CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000
