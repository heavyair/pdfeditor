import type { ToolDef } from './SimpleTool'
import { SimpleTool } from './SimpleTool'
import * as defs from './defs'

const ALL = Object.values(defs) as ToolDef<unknown>[]

export default function SimpleToolPage({ id }: { id: string }) {
  const def = ALL.find((d) => d.id === id)
  if (!def) return null
  return <SimpleTool key={id} def={def} />
}
