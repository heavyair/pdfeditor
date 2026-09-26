import { CSS_FONT } from './fonts'
import type { LineRasterizer } from './textLayer'

const SCALE = 4

/** Draw one line of text to a transparent PNG, for glyphs no embeddable font has (emoji...). */
export const rasterizeLine: LineRasterizer = async (t) => {
  const font = t.font ?? 'Helvetica'
  const fontCss = `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${t.size}px ${CSS_FONT[font]}`
  const probe = document.createElement('canvas').getContext('2d')!
  probe.font = fontCss
  const m = probe.measureText(t.str)
  const ascent = Math.max(m.actualBoundingBoxAscent, t.size * 0.9)
  const descent = Math.max(m.actualBoundingBoxDescent, t.size * 0.25)
  const w = Math.max(1, m.width) + 2
  const h = ascent + descent
  const c = document.createElement('canvas')
  c.width = Math.ceil(w * SCALE)
  c.height = Math.ceil(h * SCALE)
  const ctx = c.getContext('2d')!
  ctx.scale(SCALE, SCALE)
  ctx.font = fontCss
  ctx.fillStyle = t.color
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(t.str, 0, ascent)
  return { src: c.toDataURL('image/png'), w, h, ascent }
}
