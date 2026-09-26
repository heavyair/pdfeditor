import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../components/Icon'

/** Toolbar button with a small popover menu. */
export function Menu({ label, icon, active, children, title }: { label: string; icon: string; active?: boolean; title?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={`tool ${active ? 'active' : ''}`} onClick={() => setOpen((o) => !o)} title={title ?? label} aria-haspopup="menu" aria-expanded={open}>
        <Icon name={icon} />
        <span>
          {label} <Icon name="chevronDown" size={10} />
        </span>
      </button>
      {open && (
        <div className="menu" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
