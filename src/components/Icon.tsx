const PATHS: Record<string, string> = {
  select: 'M4 3l7 17 2.5-7.5L21 10z',
  editText: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  text: 'M5 5h14M12 5v14M9 19h6',
  sign: 'M3 17c3-6 5-9 6-9s-1 8 1 8 3-5 4-5 0 4 2 4 3-2 5-2M3 21h18',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5a1.5 1.5 0 1 0 0-.01',
  whiteout: 'M4 6h16v12H4zM8 10h8M8 14h5',
  highlight: 'M9 11l6-6 4 4-6 6M9 11l-3 3v4h4l3-3M4 21h16',
  rect: 'M4 6h16v12H4z',
  ellipse: 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z',
  draw: 'M3 18c4-1 5-11 9-11s2 9 5 9 3-4 4-5',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
  zoomIn: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5M11 8v6M8 11h6',
  zoomOut: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5M8 11h6',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  rotateL: 'M4 4v6h6M4.5 10A8 8 0 1 1 6 16.5',
  rotateR: 'M20 4v6h-6M19.5 10A8 8 0 1 0 18 16.5',
  plus: 'M12 5v14M5 12h14',
  merge: 'M6 4v5a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v3M18 4v5a4 4 0 0 1-4 4M6 20v-3',
  split: 'M12 4v16M4 8l4 4-4 4M20 8l-4 4 4 4',
  file: 'M6 3h9l4 4v14H6zM14 3v5h5',
  x: 'M6 6l12 12M18 6L6 18',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  check: 'M5 12l5 5 9-10',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
}

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name] ?? ''} />
    </svg>
  )
}
