const reset = '\x1b[0m'
// Use explicit 'ansi-256' to avoid Bun bug (oven-sh/bun#22161) where
// 'ansi' with FORCE_COLOR=1 produces broken escape sequences (e.g. \x1b[38;5;\nm)
const ansi = (color: string) => Bun.color(color, 'ansi-256') ?? ''

// Tailwind hex palette
export const green = (text: string) => `${ansi('#22c55e')}${text}${reset}`
export const purple = (text: string) => `${ansi('#a855f7')}${text}${reset}`
export const blue = (text: string) => `${ansi('#3b82f6')}${text}${reset}`
export const lightPurple = (text: string) => `${ansi('#c084fc')}${text}${reset}`
export const red = (text: string) => `${ansi('#ef4444')}${text}${reset}`
export const darkBlue = (text: string) => `${ansi('#1d4ed8')}${text}${reset}`
export const fuchsia = (text: string) => `${ansi('#d946ef')}${text}${reset}`
export const orange = (text: string) => `${ansi('#f97316')}${text}${reset}`
export const pink = (text: string) => `${ansi('#ec4899')}${text}${reset}`
export const amber = (text: string) => `${ansi('#f59e0b')}${text}${reset}`
export const teal = (text: string) => `${ansi('#06b6d4')}${text}${reset}`
export const yellow = (text: string) => `${ansi('#eab308')}${text}${reset}`

// Modifiers (Bun.color does not support intensity/style)
export const dim = (text: string) => `\x1b[2m${text}${reset}`
export const bold = (text: string) => `\x1b[1m${text}${reset}`
export const reset_ = reset
