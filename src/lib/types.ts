export type FontKey = 'Helvetica' | 'Times' | 'Courier'

export interface TextAnnot {
  id: string
  type: 'text'
  /** top-left corner, in unrotated page units (PDF points, y down) */
  x: number
  y: number
  text: string
  fontSize: number
  color: string
  font: FontKey
  bold: boolean
  italic: boolean
}

export interface BoxBase {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface ImageAnnot extends BoxBase {
  type: 'image'
  /** PNG or JPEG data URL */
  src: string
}

export interface ShapeAnnot extends BoxBase {
  type: 'rect' | 'ellipse'
  fill: string | null
  stroke: string | null
  strokeWidth: number
  opacity: number
  /** true for highlighter rectangles (multiply blend) */
  highlight?: boolean
}

export interface DrawAnnot extends BoxBase {
  type: 'draw'
  /** points normalised to 0..1 within the box */
  points: [number, number][]
  color: string
  strokeWidth: number
}

export type BoxAnnot = ImageAnnot | ShapeAnnot | DrawAnnot
export type Annot = TextAnnot | BoxAnnot

export interface PageModel {
  id: string
  /** source document id, or null for an inserted blank page */
  srcId: string | null
  srcIndex: number
  /** unrotated page size in PDF points */
  width: number
  height: number
  /** /Rotate already present in the source file */
  baseRotation: number
  /** extra rotation applied by the user */
  rotation: number
  annots: Annot[]
}

export type Tool =
  | 'select'
  | 'editText'
  | 'text'
  | 'whiteout'
  | 'highlight'
  | 'rect'
  | 'ellipse'
  | 'draw'
  | 'place'
