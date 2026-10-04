import { readJson, writeJson } from '../db'

export const bool = (v: unknown): boolean => v === 1 || v === true
export const flag = (v: boolean | undefined | null): number => (v ? 1 : 0)
export const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0))
export const nullableNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
export const str = (v: unknown): string => (v == null ? '' : String(v))
export const nullableStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

export const j = readJson
export const w = writeJson

/** Rows arrive as unknown; domain objects are validated once at the mapping boundary. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>
