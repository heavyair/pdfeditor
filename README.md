# Free PDF Editor · 免费 PDF 编辑器

A free, privacy-first PDF editor that runs entirely in the browser — and offline once installed.
No uploads, no account, no watermark. English and 简体中文 UI.

## Features

**Edit & sign**
- **Edit PDF** – rewrite existing text (the original glyphs are *deleted*, not covered), add text in any
  language, images, signatures, stamps (Approved / 已批准 …, ✓ ✗ ●, date), highlights, whiteout,
  rectangles, ellipses, lines, arrows, freehand drawing, clickable links and sticky-note comments
- **Sign** – draw, type or upload a signature (white background removal, saved on the device)
- **Fill form** – fill AcroForm text fields, checkboxes, radio buttons and dropdowns; optional flattening
- **Redact** – true redaction: text, images and vector graphics under the box are removed from the file;
  search a word and redact every occurrence at once
- **OCR** – make scans searchable/selectable (12 languages incl. 简体/繁體中文, 日本語, 한국어); after OCR
  you can also rewrite text on scanned pages
- **Watermark** (text or image, centred or tiled) · **Page numbers / header & footer**

**Organize** – merge (PDFs + images, page ranges per file) · split (selection, ranges, every N, one per page) ·
visual page organizer (reorder, rotate, duplicate, delete, insert blank or from another PDF, reverse) ·
rotate · delete pages · crop · N-up (2/4/6/9 per sheet)

**Convert** – PDF → JPG/PNG · images → PDF · PDF → text · extract embedded images · Excel/Word ⇄ PDF (all local, no uploads)

**Optimize & secure** – compress (lossless / balanced / strong / extreme) · protect (AES-256 + permissions) ·
unlock · flatten · repair · edit or wipe metadata

**App** – installable PWA that works offline, English / Chinese UI (auto-detected, switchable),
keyboard shortcuts, undo/redo, paste images, responsive layout.

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests: export pipeline, redaction, forms, CJK, OCR layer, page tools, security…
npm run build    # static site in dist/ — deploy to any static host / CDN (works from a sub-folder)
```

## Architecture

```
                     ┌─────────────────────── browser only ───────────────────────┐
 PDF ──▶ pdf.js ─────┤ render pages, text runs, form fields, thumbnails           │
                     │                                                             │
         Editor state│ pages[]: { source, index, rotation, annots[], fields, ocr } │
                     │ undo/redo = snapshots · form values · search hits           │
                     │                                                             │
         export      │ 1 MuPDF   fill forms (+ flatten)                            │
                     │ 2 pdf-lib copy pages in order, rotate, rebuild AcroForm     │
                     │ 3 MuPDF   true redaction (delete content under boxes)       │
                     │ 4 pdf-lib shapes, images, links, notes, Latin text          │
                     │   MuPDF   CJK / Unicode text + OCR layer (embedded subset)  │──▶ download
                     │                                                             │
         OCR         │ Tesseract (WASM worker) ─▶ words/lines ─▶ invisible layer  │
                     └─────────────────────────────────────────────────────────────┘
```

| Engine | Used for | Loaded |
| --- | --- | --- |
| pdf.js (legacy build) | rendering, text runs, form field discovery | per tool, lazily |
| pdf-lib | page assembly, drawing, merge/split, watermark, page numbers, crop, N-up, metadata | per tool |
| MuPDF WASM (Web Worker) | redaction, CJK text embedding, forms, search, encrypt/decrypt, compress, repair, flatten, render to image, text/image extraction | on first use (10 MB, cached) |
| Tesseract WASM (Web Worker) | OCR | on first OCR run (engine ~4 MB + ~2 MB per language, cached) |

Everything, including pdf.js CMaps/fonts, the MuPDF WASM, the Tesseract engine and language data, is
self-hosted (`build/runtime-assets.ts`) — no CDN is needed at runtime.

### Key design decisions

- **Non-destructive model.** Sources are never mutated. The editor keeps a list of page models
  (source + page index or blank, rotation, annotations) in *unrotated page units*; one coordinate system
  is used for display, hit-testing and export. Rotated pages are rotated with CSS and pointer events are
  rotated back (`toLocal` in `PageView.tsx`).
- **Real text replacement.** "Edit text" creates a cover box marked `redact: 'text'` plus a text box
  pre-filled with the original string, size, font style and sampled colour. On export MuPDF deletes the
  glyphs under the box (only text, so backgrounds survive), then the new text is drawn.
  On scanned pages (after OCR) the text is pixels, so it is covered instead.
- **Unicode text.** WinAnsi text uses the standard 14 fonts via pdf-lib (tiny, WYSIWYG). Anything else
  (Chinese, Japanese, Korean, Cyrillic…) is laid out by MuPDF with its built-in Droid Sans Fallback font,
  subsetted, and stamped onto the page as a form XObject — selectable and searchable, typically a few KB.
  Glyphs no font has (emoji) fall back to a high-resolution image.
- **Forms survive page edits.** `copyPages` drops `/AcroForm`; the exporter collects the widgets' top-level
  fields and rebuilds it, so fields stay fillable after reordering, unless you choose to flatten.
- **OCR layer.** Recognised words are written as invisible text (alpha 0) stretched to the word's box;
  CJK lines are written whole so copying doesn't insert spaces. Words hidden by a cover are dropped.
- **Offline.** `build/pwa-plugin.ts` scans the build output and writes a service worker that precaches the
  app (including MuPDF). OCR engine/data are cached on first use because each browser needs only one of
  the three engine variants and one or two languages.

### Project layout

```
build/
  pwa-plugin.ts         generates sw.js (precache list) after the build
  runtime-assets.ts     self-hosts pdf.js data files and the Tesseract engine + languages
src/
  App.tsx               tool registry, routes, home page, language switch, install button
  i18n.tsx, i18n.zh.ts  translations (English strings are the keys)
  editor/               Editor (state, undo, search, OCR, export), PageView (tools, forms, hit layers),
                        Sidebar, PropsPanel, SignatureModal, OcrModal, Menu
  tools/                MergeTool, SplitTool, OcrTool, SimpleTool (generic file→options→download) + defs.tsx
  lib/
    exportPdf.ts        the export pipeline
    textLayer.ts        standard-font / MuPDF / raster text painter, rotation-aware placement
    mupdfOps.ts         MuPDF operations (pure, testable) · mupdf.worker.ts · mupdfClient.ts (RPC)
    pageTools.ts        watermark, page numbers, rotate, crop, N-up, metadata
    pageOps.ts          merge / split · ocr.ts · pdfjs.ts · stamps.ts · ranges.ts · fonts.ts
```

### Limitations

- Rewritten text uses Helvetica/Times/Courier for Latin text and Droid Sans Fallback for CJK; it doesn't
  reuse the document's embedded (usually subsetted) font.
- Redaction of a region inside an image blanks those pixels (MuPDF), other images are untouched.
- Signatures are visual (like ink on paper), not cryptographic (PAdES) digital signatures.
- PDF ↔ Word/Excel conversion runs fully locally in the browser (no uploads).

## License note

MuPDF is licensed under the **GNU AGPL v3** (commercial licences are available from Artifex). If you deploy
this app publicly, its source code must be made available under AGPL-compatible terms — hosting this
repository publicly satisfies that. pdf.js, Tesseract.js (Apache-2.0) and pdf-lib, JSZip (MIT) are permissive.
