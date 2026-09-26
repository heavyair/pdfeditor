import { useEffect, useRef, useState, type RefObject } from 'react'
import type { PDFDocumentProxy } from '../lib/pdfjs'

interface Props {
  pdf: PDFDocumentProxy | null
  /** 0-based */
  index: number
  width: number
  height: number
  scale: number
  canvasRef?: RefObject<HTMLCanvasElement | null>
  className?: string
}

/** Lazily renders one PDF page (unrotated) when it scrolls into view. Blank pages render white. */
export function PdfCanvas({ pdf, index, width, height, scale, canvasRef, className }: Props) {
  const localRef = useRef<HTMLCanvasElement>(null)
  const ref = canvasRef ?? localRef
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '600px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !visible) return
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    if (!pdf) {
      canvas.width = Math.max(1, Math.round(width * scale * dpr))
      canvas.height = Math.max(1, Math.round(height * scale * dpr))
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      return
    }
    let cancelled = false
    let task: { cancel: () => void; promise: Promise<void> } | null = null
    pdf.getPage(index + 1).then((page) => {
      if (cancelled) return
      const vp = page.getViewport({ scale: scale * dpr, rotation: 0 })
      // render off-screen first to avoid a white flash while zooming
      const off = document.createElement('canvas')
      off.width = Math.round(vp.width)
      off.height = Math.round(vp.height)
      task = page.render({ canvas: off, viewport: vp, background: '#ffffff' })
      task.promise
        .then(() => {
          if (cancelled) return
          canvas.width = off.width
          canvas.height = off.height
          canvas.getContext('2d')!.drawImage(off, 0, 0)
        })
        .catch((e) => console.warn("render failed", e))
    })
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [pdf, index, scale, visible, width, height, ref])

  return (
    <canvas
      ref={ref}
      className={className}
      style={{ width: width * scale, height: height * scale, display: 'block', background: '#fff' }}
    />
  )
}
