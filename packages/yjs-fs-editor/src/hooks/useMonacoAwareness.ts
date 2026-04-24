import { useEffect } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'

export function useMonacoAwareness(awareness: Awareness, doc: Y.Doc) {
	useEffect(() => {
		const styleEl = document.createElement('style')
		styleEl.id = 'monaco-awareness-styles'
		document.head.appendChild(styleEl)

		const updateStyles = () => {
			let css = `
        .yRemoteSelection {
          background-color: rgba(250, 129, 0, 0.3);
        }
        .yRemoteSelectionHead {
          position: absolute;
          border-left: 2px solid orange;
          border-top: 2px solid orange;
          border-bottom: 2px solid orange;
          height: 100%;
          box-sizing: border-box;
        }
      `

			awareness.getStates().forEach((state, clientId) => {
				if (clientId === doc.clientID) return
				const user = state.user as { name?: string; color?: string } | undefined
				const color = user?.color ?? '#888888'
				const name = user?.name ?? 'Anonymous'

				css += `
          .yRemoteSelection-${clientId} {
            background-color: ${color}33;
          }
          .yRemoteSelectionHead-${clientId} {
            border-left: 2px solid ${color};
            border-top: 2px solid ${color};
            border-bottom: 2px solid ${color};
          }
          .yRemoteSelectionHead-${clientId}::after {
            content: '${name.replace(/'/g, "\\'")}';
            background: ${color};
            color: white;
            font-size: 11px;
            padding: 2px 4px;
            border-radius: 3px;
            position: absolute;
            top: -18px;
            left: -1px;
            white-space: nowrap;
            pointer-events: none;
          }
        `
			})

			styleEl.textContent = css
		}

		updateStyles()
		awareness.on('change', updateStyles)

		return () => {
			awareness.off('change', updateStyles)
			styleEl.remove()
		}
	}, [awareness, doc])
}
