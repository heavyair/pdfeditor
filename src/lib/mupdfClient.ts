import type * as Ops from './mupdfOps'

type OpsT = typeof Ops
type AsyncOps = { [K in keyof OpsT]: OpsT[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<R> : never }

let worker: Worker | null = null
let ready: Promise<void> | null = null
let seq = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function start(): Promise<void> {
  if (ready) return ready
  ready = new Promise((resolve, reject) => {
    worker = new Worker(new URL('./mupdf.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e) => {
      const d = e.data
      if (d.ready) return resolve()
      const p = pending.get(d.id)
      if (!p) return
      pending.delete(d.id)
      if ('error' in d) p.reject(new Error(d.error))
      else p.resolve(d.result)
    }
    worker.onerror = (e) => {
      const err = new Error(e.message || 'PDF engine failed to load')
      reject(err)
      pending.forEach((p) => p.reject(err))
      pending.clear()
      worker = null
      ready = null
    }
  })
  return ready
}

/**
 * MuPDF runs in a Web Worker: the 10 MB WASM engine is only downloaded when a feature
 * needs it (true redaction, CJK text, forms, OCR layer, security, compression...).
 */
export const mu = new Proxy({} as AsyncOps, {
  get:
    (_t, op: string) =>
    async (...args: unknown[]) => {
      await start()
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        // copy byte arrays so callers keep their own buffers
        worker!.postMessage({ id, op, args })
      })
    },
})

export const preloadEngine = () => start().catch(() => {})
