import { CSS_FONT, LINE_HEIGHT } from './fonts'
import type { TextAnnot } from './types'

const SCALE = 4

/** Draw a text annotation to a transparent PNG, for scripts the standard PDF fonts can't encode. */
export async function rasterizeText(a: TextAnnot): Promise<{ src: string; w: number; h: number }> {
  const fontCss = `${a.italic ? 'italic ' : ''}${a.bold ? 'bold ' : ''}${a.fontSize}px ${CSS_FONT[a.font]}`
  const lines = a.text.split('\n')
  const probe = document.createElement('canvas').getContext('2d')!
  probe.font = fontCss
  const w = Math.max(1, ...lines.map((l) => probe.measureText(l).width)) + 2
  const h = lines.length * a.fontSize * LINE_HEIGHT
  const c = document.createElement('canvas')
  c.width = Math.ceil(w * SCALE)
  c.height = Math.ceil(h * SCALE)
  const ctx = c.getContext('2d')!
  ctx.scale(SCALE, SCALE)
  ctx.font = fontCss
  ctx.fillStyle = a.color
  ctx.textBaseline = 'middle'
  lines.forEach((l, i) => ctx.fillText(l, 0, (i + 0.5) * a.fontSize * LINE_HEIGHT))
  return { src: c.toDataURL('image/png'), w, h }
}
