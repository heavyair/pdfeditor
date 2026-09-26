/// <reference lib="webworker" />
import * as ops from './mupdfOps'

type Ops = typeof ops
self.onmessage = (e: MessageEvent<{ id: number; op: keyof Ops; args: unknown[] }>) => {
  const { id, op, args } = e.data
  try {
    const fn = ops[op] as (...a: unknown[]) => unknown
    const result = fn(...args)
    const transfer: Transferable[] = []
    const collect = (v: unknown) => {
      if (v instanceof Uint8Array) transfer.push(v.buffer)
      else if (Array.isArray(v)) v.forEach(collect)
      else if (v && typeof v === 'object') Object.values(v).forEach(collect)
    }
    collect(result)
    self.postMessage({ id, result }, transfer)
  } catch (err) {
    self.postMessage({ id, error: (err as Error)?.message ?? String(err) })
  }
}
self.postMessage({ ready: true })
