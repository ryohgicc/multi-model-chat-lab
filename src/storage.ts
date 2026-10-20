export function persistBrowserValue(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string, value: unknown): boolean {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    // Avoid rewriting an unchanged (potentially large) value. Browsers can
    // reject a same-size write when the origin is at its quota limit.
    if (storage.getItem(key) === serialized) return true
    storage.setItem(key, serialized)
    return true
  } catch {
    return false
  }
}
