import { useRef, useState } from 'react'
import { Icon } from './Icon'

interface Props {
  accept: string
  multiple?: boolean
  title: string
  hint?: string
  onFiles: (files: File[]) => void
  compact?: boolean
}

export function FileDrop({ accept, multiple, title, hint, onFiles, compact }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div
      className={`drop ${over ? 'over' : ''} ${compact ? 'compact' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length) onFiles(multiple ? files : files.slice(0, 1))
      }}
      onClick={() => input.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
    >
      <Icon name="upload" size={compact ? 22 : 36} />
      <div className="drop-title">{title}</div>
      {hint && <div className="drop-hint">{hint}</div>}
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length) onFiles(files)
        }}
      />
    </div>
  )
}
