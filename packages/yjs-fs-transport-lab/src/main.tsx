import { Buffer } from 'buffer'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

if (!('Buffer' in globalThis)) {
	Object.assign(globalThis, { Buffer })
}

const container = document.getElementById('root')

if (!container) {
	throw new Error('Root container not found')
}

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
