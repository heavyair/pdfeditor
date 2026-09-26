# Free PDF Editor

A free, privacy-first online PDF editor that runs entirely in the browser.

- **Edit** – replace existing text, add text, images, shapes, highlights, whiteout and freehand drawings
- **Sign** – draw, type or upload a signature (saved on the device for re-use) and place it anywhere
- **Merge** – combine PDFs and images, reorder by drag and drop, pick page ranges per file
- **Split** – extract selected pages, split by ranges, every N pages, or one file per page (ZIP)
- **Organise pages** – reorder, rotate, duplicate, delete, insert blank pages or pages from another PDF

No uploads, no account, no watermark: files are read and written locally.

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests (range parsing, merge/split, export geometry)
npm run build    # static site in dist/ — host it on any static host / CDN
```

## Design

### Architecture

```
            ┌──────────── Browser (no backend) ─────────────┐
 PDF file ─▶│ pdf.js  ──render──▶ canvas  (what you see)     │
            │   │                                           │
            │   └─text runs──▶ "Edit text" hit boxes         │
            │                                               │
            │ Editor state (React)                           │
            │   pages[]: { src, index, rotation, annots[] }  │
            │   undo / redo = snapshots of pages[]           │
            │                                               │
            │ pdf-lib ──copy pages + flatten annots──▶ PDF  │──▶ download
            └───────────────────────────────────────────────┘
```

| Concern | Choice | Why |
| --- | --- | --- |
| Rendering | `pdfjs-dist` (legacy build) | Faithful rendering and text extraction; the legacy build polyfills new JS APIs for older browsers |
| Writing | `pdf-lib` | Pure JS, copies pages between documents, draws text / images / vector shapes |
| UI | React + TypeScript + Vite | Each tool is lazy-loaded, so the landing page stays small |
| ZIP for split | `jszip` | |

Everything is client-side, so hosting costs are a static CDN, and there is no privacy
risk from storing user documents.

### Document model

The editor never mutates the original bytes. It keeps a list of **page models**:

```ts
PageModel { srcId, srcIndex, width, height, baseRotation, rotation, annots[] }
```

`srcId` points at one of several loaded source PDFs (so "Insert PDF" just adds a source),
or is `null` for a blank page. Reordering, rotating, duplicating and deleting pages
only edits this list. **Annotations** (`text`, `image`, `rect`/`ellipse`, `draw`) are stored in
*unrotated page units* (PDF points, y pointing down), so the same coordinates are used
for display, hit-testing and export.

Page rotation is applied with a CSS transform around the page, and pointer events are
rotated back into page space (`toLocal` in `PageView.tsx`), so every tool works on
rotated pages.

Undo/redo stores immutable snapshots of `pages[]` (cheap, since unchanged pages and
image data URLs are shared by reference). Drags push one snapshot on the first
movement, not one per mouse move.

### Export ("flattening")

`lib/exportPdf.ts` builds a new document: for each page model it copies the page from its
source with `copyPages`, sets `/Rotate`, then draws the annotations into the page content,
mapping editor coordinates through the page's crop box. Text uses the standard 14 fonts
(Helvetica / Times / Courier); the editor uses CSS font stacks and baseline offsets
matched to those fonts, so what you see is what you get. Text those fonts can't encode
(Chinese, Japanese, emoji…) is rasterised at 4× and embedded as an image.

### Editing existing text

PDF files don't store paragraphs; they store positioned glyph runs, often with subset
fonts that lack the glyphs you'd need to type something new. Rewriting the content stream
in place is fragile, so the editor uses the approach of most online PDF editors:

1. pdf.js extracts text runs with position, size and font name.
2. Clicking a run creates a **cover** rectangle filled with the background colour sampled
   from the rendered canvas, plus a **text box** with the same text, size, baseline,
   a matching font family / weight / style and the sampled ink colour.
3. The user retypes; on export both are flattened into the page.

The original glyphs remain underneath the cover (they're hidden, not deleted). For
true redaction you'd need a content-stream rewrite (e.g. MuPDF WASM) — see roadmap.

### Signatures

Draw (smoothed quadratic strokes on a canvas), type (script web fonts) or upload a photo
(with optional white-background removal). The result is auto-cropped to a transparent PNG
and placed like an image. Signatures can be saved to `localStorage` on the device.

These are visual signatures (like signing on paper), not cryptographic digital signatures.

### Project layout

```
src/
  App.tsx               routes (#/edit, #/sign, #/merge, #/split) and landing page
  editor/
    Editor.tsx          state, undo/redo, keyboard shortcuts, page operations, export
    PageView.tsx        one page: canvas, tools, annotation rendering, drag/resize, edit-text
    Sidebar.tsx         page thumbnails (drag to reorder, rotate, duplicate, delete)
    PropsPanel.tsx      properties of the selected item / current tool
    SignatureModal.tsx  draw / type / upload signatures
  tools/
    MergeTool.tsx, SplitTool.tsx
  components/           PdfCanvas (lazy page rendering), FileDrop, Icon, Toast
  lib/
    exportPdf.ts        flatten page models + annotations into a PDF (pdf-lib)
    pageOps.ts          merge / split
    pdfjs.ts            pdf.js setup, page info, text-run extraction
    ranges.ts           "1-3, 5, 8-" parsing
    fonts.ts, rasterize.ts, types.ts, util.ts
```

### Known limitations / roadmap

- Existing text is covered and retyped, not removed from the content stream (no true redaction yet).
- Encrypted PDFs can be viewed after entering a password, but saving them isn't supported.
- Form filling (AcroForm fields), links and outlines are not carried over when pages are copied.
- Possible next steps: MuPDF WASM for real text removal / redaction, form filling,
  embedded CJK font subsets instead of rasterising, OCR for scans, i18n (中文界面), PWA/offline install.
