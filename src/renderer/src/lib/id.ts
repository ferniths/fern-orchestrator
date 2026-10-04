let counter = 0

/** Renderer-side id generator (no crypto dependency in the sandboxed context). */
export function newIdToast(): string {
  counter = (counter + 1) % 1_000_000
  return `t${Date.now().toString(36)}${counter.toString(36)}`
}
