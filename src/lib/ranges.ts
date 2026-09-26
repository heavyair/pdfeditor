/**
 * Page-range parsing. Input is 1-based ("1-3, 5, 8-"), output is 0-based.
 * Throws RANGE_* error codes on bad input (translated by errorText in i18n.tsx).
 */
function parseSegment(seg: string, count: number): number[] {
  const s = seg.trim()
  if (!s) return []
  const m = s.match(/^(\d*)\s*-\s*(\d*)$/)
  let from: number, to: number
  if (m) {
    from = m[1] ? parseInt(m[1], 10) : 1
    to = m[2] ? parseInt(m[2], 10) : count
  } else if (/^\d+$/.test(s)) {
    from = to = parseInt(s, 10)
  } else {
    throw new Error(`RANGE_INVALID:${s}`)
  }
  if (from < 1 || to < 1 || from > count || to > count) {
    throw new Error(`RANGE_OUTSIDE:${s}:${count}`)
  }
  const out: number[] = []
  const step = from <= to ? 1 : -1
  for (let p = from; p !== to + step; p += step) out.push(p - 1)
  return out
}

/** "1-3,5" -> [0,1,2,4]. Empty string means all pages. */
export function parsePageList(input: string, count: number): number[] {
  if (!input.trim()) return Array.from({ length: count }, (_, i) => i)
  return input.split(',').flatMap((seg) => parseSegment(seg, count))
}

/** "1-3, 4-6" -> [[0,1,2],[3,4,5]]: every comma separated segment is one group. */
export function parseRangeGroups(input: string, count: number): number[][] {
  const groups = input
    .split(',')
    .map((seg) => parseSegment(seg, count))
    .filter((g) => g.length > 0)
  if (!groups.length) throw new Error('RANGE_EMPTY')
  return groups
}

export function chunkPages(count: number, size: number): number[][] {
  const out: number[][] = []
  for (let i = 0; i < count; i += size) {
    out.push(Array.from({ length: Math.min(size, count - i) }, (_, k) => i + k))
  }
  return out
}

export function describeGroup(g: number[]): string {
  if (!g.length) return ''
  const contiguous = g.every((p, i) => i === 0 || p === g[i - 1] + 1)
  if (contiguous) return g.length === 1 ? `${g[0] + 1}` : `${g[0] + 1}-${g[g.length - 1] + 1}`
  return g.map((p) => p + 1).join('_')
}
