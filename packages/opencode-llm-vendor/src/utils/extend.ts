/**
 * Attach static helpers to a schema. Effect 4 exposes `make`/`is` as prototype
 * getters without setters, so `Object.assign` throws; define own properties instead.
 */
export const extend = <S extends object, P extends object>(schema: S, props: P): Omit<S, keyof P> & P =>
	Object.defineProperties(schema, Object.getOwnPropertyDescriptors(props)) as unknown as Omit<S, keyof P> & P
