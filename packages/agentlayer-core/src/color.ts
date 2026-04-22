import chalk from 'chalk'

export const green = (text: string) => chalk.hex('#22c55e')(text)
export const purple = (text: string) => chalk.hex('#a855f7')(text)
export const blue = (text: string) => chalk.hex('#3b82f6')(text)
export const lightPurple = (text: string) => chalk.hex('#c084fc')(text)
export const red = (text: string) => chalk.hex('#ef4444')(text)
export const darkBlue = (text: string) => chalk.hex('#1d4ed8')(text)
export const fuchsia = (text: string) => chalk.hex('#d946ef')(text)
export const orange = (text: string) => chalk.hex('#f97316')(text)
export const pink = (text: string) => chalk.hex('#ec4899')(text)
export const amber = (text: string) => chalk.hex('#f59e0b')(text)
export const teal = (text: string) => chalk.hex('#06b6d4')(text)
export const yellow = (text: string) => chalk.hex('#eab308')(text)

export const dim = (text: string) => chalk.dim(text)
export const bold = (text: string) => chalk.bold(text)
export const reset_ = chalk.reset('')
