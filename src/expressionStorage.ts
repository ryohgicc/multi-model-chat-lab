export function storageError(error: unknown): string {
  return error instanceof Error || error instanceof DOMException ? `${error.name}: ${error.message}` : String(error)
}

export function createExpressionStorage() {
  const values = new Map<string, string>()
  let database: Promise<IDBDatabase> | undefined
  let revision = 0
  let queue = Promise.resolve()
  function open() {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('model-studio-expression', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('values')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('表达评估存储被其他窗口阻塞，请关闭旧版窗口后重试'))
    }).catch((error) => { database = undefined; throw error })
    return database
  }
  return {
    getItem(key: string) {
      if (values.has(key)) return values.get(key)!
      try { return localStorage.getItem(key) } catch { return null }
    },
    async load(keys: string[]) {
      const version = revision
      const connection = await open()
      const loaded = await new Promise<Map<string, string>>((resolve, reject) => {
        const transaction = connection.transaction('values', 'readonly')
        const entries = new Map<string, string>()
        for (const key of keys) {
          const request = transaction.objectStore('values').get(key)
          request.onsuccess = () => { if (typeof request.result === 'string') entries.set(key, request.result) }
        }
        transaction.oncomplete = () => resolve(entries)
        transaction.onabort = () => reject(transaction.error)
        transaction.onerror = () => reject(transaction.error)
      })
      if (version === revision) for (const [key, value] of loaded) values.set(key, value)
    },
    setItem(key: string, value: string) {
      values.set(key, value)
      revision += 1
      const save = queue.then(async () => {
        try {
          const connection = await open()
          await new Promise<void>((resolve, reject) => {
            const transaction = connection.transaction('values', 'readwrite')
            transaction.objectStore('values').put(value, key)
            transaction.oncomplete = () => resolve()
            transaction.onabort = () => reject(transaction.error)
            transaction.onerror = () => reject(transaction.error)
          })
        } catch (databaseError) {
          try {
            localStorage.setItem(key, value)
            if (localStorage.getItem(key) !== value) throw new Error('写入校验失败')
          } catch (localError) {
            throw new Error(`IndexedDB ${storageError(databaseError)}；localStorage ${storageError(localError)}`)
          }
          throw new Error(`仅写入旧版存储，独立存储失败，请备份并重试：${storageError(databaseError)}`)
        }
      })
      queue = save.catch(() => {})
      return save
    },
  }
}
