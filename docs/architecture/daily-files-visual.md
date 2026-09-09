# Daily-file visual validation

Date: 2026-09-06. Every Office/PDF path returned in the final corpus attempt was
rendered: **24 distinct file references, 30 pages**. This includes intermediate
workbooks and an unmodified chart workbook whose edit was refused. It is not
24 fulfilled editing requests. All source hashes remained unchanged.

The final [per-file verdicts](validation/daily-files-visual/visual-verdicts.json)
record inherited print-layout limitations separately from readable outputs.
The preceding 30 pages were inspected; after the import-layout correction,
24 PNGs were byte-identical and the six changed PNGs were inspected again.

## Findings and corrections

| Check | Initial observation | Final observation |
| --- | --- | --- |
| D01 Word, P04 PowerPoint multilingual text | Japanese glyphs disappeared with the default bundled fontconfig; cache-directory warnings were logged | Explicit font directories, the immutable corpus covering font and a writable temporary cache render Latin, Arabic and Japanese. Neither source document was edited to make the renderer pass |
| C01/C03 new CSV imports | Narrow columns clipped long IDs, headings and multiline text | New-workbook widths, wrapping and row heights make these fields readable. Original CSV bytes and literal exports remain intact |
| D02/D04 Word | Nested table and separate section headers | Requested inner-cell/header changes visible; surrounding layout retained |
| P01/P02/P03 PowerPoint | Native chart, grouped shapes, merged table anchor | Caption/group-member/merged-cell text visible; chart, image, sibling shapes and merge geometry retained |
| X01/X02 existing workbooks | Date cells display `###` in the original print layout | Still a print-readability limitation. Date types and values survive; no automatic column-width mutation was requested |
| X02 suspected new header clipping | First visual batch was misinterpreted | Individual reinspection and identical PNG hashes disprove a new header regression; the mistaken observation is retained in the corpus correction record |
| X03 chart workbook | Requested edit is unsupported | Only its unchanged source was rendered; the chart spans two print pages. Conversion does not turn the refused edit into success |
| X04 table workbook | Conditional formatting and structured total | Both color-scale cells, IDs and independently calculated total 17 visible |
| W01 mixed workflow | CSV → XLSX → existing Word/deck → PDF packet | Total 18 visible in workbook/report/deck; appendix is present as the second PDF page |

Examples retained without replacing failed evidence:

- [CJK missing initially](validation/daily-files-visual/fontconfig-initial/D01/page-1.png)
  and [configured final Word render](validation/daily-files-visual/final/D01/input-edited.docx/page-1.png).
- [CSV import before](validation/daily-files-visual/imports-before/C01/imported.xlsx/page-1.png)
  and [after](validation/daily-files-visual/final/C01/imported.xlsx/page-1.png).
- [Inherited date-width limitation](validation/daily-files-visual/final/X01/input-v2.xlsx/page-1.png).

## Reproduction and environment

Use [render.py](../../scripts/daily-files-corpus/render.py) with an attempt
directory, a new output directory, explicit `--soffice` and `--pdftoppm` paths,
and optional repeated `--font-dir` arguments. It discovers returned file paths,
records conversion failures and source hashes, and does not automatically assign
a passing visual verdict. The initial Word check also used the bundled
`render_docx.py` workflow before the fontconfig diagnosis.

This audit used the Codex bundled LibreOffice and Poppler, system font
directories, and the existing `F05/covering.ttf` fixture. The font hash is in the
visual ledger. No host font installation or document redesign was used.

The Docker configuration now adds
[Noto core](https://packages.debian.org/stable/fonts/fonts-noto-core) and
[Noto CJK](https://packages.debian.org/trixie/fonts-noto-cjk) alongside Liberation.
That addresses a packaging prerequisite; the image was not built or rendered
because the Docker daemon is unavailable. Configured local rendering is not
proof of deployment font availability, universal bidirectional layout, or
readability of arbitrarily large content.
