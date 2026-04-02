// Visually distinct colors that work well on dark backgrounds.
// Spread across the hue wheel so no two neighbors look alike.
const PALETTE = [
	'hsl(210, 80%, 60%)', // blue
	'hsl(35, 90%, 60%)', // orange
	'hsl(150, 70%, 55%)', // green
	'hsl(330, 80%, 65%)', // pink
	'hsl(55, 85%, 55%)', // yellow
	'hsl(275, 70%, 65%)', // purple
	'hsl(180, 70%, 55%)', // teal
	'hsl(0, 80%, 65%)', // red
	'hsl(240, 70%, 70%)', // indigo
	'hsl(15, 85%, 60%)', // vermilion
	'hsl(120, 60%, 50%)', // emerald
	'hsl(300, 65%, 60%)', // magenta
	'hsl(75, 75%, 50%)', // lime
	'hsl(195, 85%, 55%)', // sky
	'hsl(345, 75%, 60%)', // crimson
	'hsl(255, 60%, 70%)', // lavender
]

/**
 * Derive a deterministic color from a user ID string.
 * Picks from a palette of visually distinct colors.
 */
export function colorFromId(id: string): string {
	let hash = 0
	for (let i = 0; i < id.length; i++) {
		hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
	}
	const index = ((hash % PALETTE.length) + PALETTE.length) % PALETTE.length
	return PALETTE[index]!
}
