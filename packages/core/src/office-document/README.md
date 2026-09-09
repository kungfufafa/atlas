# Office document editing

`office_document` reads and edits existing standard `.docx` and `.pptx`
packages. It loads a workspace path or an attachment reference using the shared
file asset boundary and saves each edit as a new artifact version. The source
file remains unchanged, including when any edit or final validation fails.

## Supported operations

- `inspect`: paginated units. Word unit 1 is the body; related headers,
  footers, footnotes, and endnotes follow. PowerPoint units follow presentation
  relationships, not slide filenames. Slide notes are a separate section.
- `read`: paginated paragraph text or table rows and physical cell columns.
  Coverage reports total, returned, and next start. Text is capped at 4,000
  characters per item and 24,000 characters per response, with truncation flags.
- `edit.replace_text`: case-sensitive literal replacement in a selected unit,
  optionally one paragraph. Matches may span styled runs within a paragraph.
  `expectedMatches` is required; replacements use the first matched run's
  formatting and retain surrounding run properties and XML structure.
- `edit.set_table_cell`: replace one unmerged cell's single plain paragraph,
  with required `expectedText`. Empty cells are supported. Complex cells can
  instead use a scoped text replacement when their paragraph is editable.
  PowerPoint merged anchors also support text-only changes: the span and grid
  stay unchanged. Continuation cells and Word merged cells are refused.

All indexes are 1-based. Edits are applied sequentially, so later expected text
and counts refer to the result of earlier edits in the same request. No output
is saved unless every edit succeeds. Only changed XML parts are serialized;
all unrelated parts, including images, styles, themes, relationships, and
masters, retain their original uncompressed bytes. ZIP compression metadata
may change. This preserves package structure, not byte-identical archives.

## Boundaries

This is structured text editing, not a layout editor. It does not rearrange
slides, regenerate tables, reflow text boxes, modify chart or SmartArt data,
perform OCR, or render pages. Text changes can overflow an existing slide box;
rendering review is still needed for a final presentation. Word text edits inside
existing insertions create new insertion/deletion revisions, with distinct IDs,
`revisionAuthor` (default `Atlas`), and timestamps. The previous author's
revision metadata and replaced text remain intact. `trackChanges: true` also
records replacements in ordinary text; reads exclude deleted and moved-from
text. A reviewer can accept or reject the new revisions in Word. This tool does
not accept/reject existing review history. Plain text runs are supported;
changes spanning different insertion histories, tracked moves, fields,
protected Word documents, and structural tabs/breaks are refused. Cell rewrites require a single line. Physical table
cell positions differ from a visual grid when merges are present.

The ZIP reader validates local/central headers and CRCs before parsing XML,
with bounded decompression even if the declared expanded size is forged. Limits
are 40 MB compressed input, 120 MB expanded total, 40 MB per ZIP part, 8 MB per
XML part, 5,000 entries, and 1,000:1 declared compression ratio. Shared artifact
storage caps output at 25 MB. Edits allow up to 100 operations per request;
each replacement is bounded to 4 MiB of inserted text.

Encrypted archives, ZIP64, unsafe paths, symbolic links, duplicate entries,
DTD/entity declarations, malformed XML, missing internal relationships,
macro-enabled formats, and signed packages are rejected. External relationships
are retained but never fetched. The tool does not remove embedded or external
content from an existing document and therefore does not certify it as safe
to open in a desktop Office application.

`readOfficeZipParts` exposes the bounded ZIP/XML preflight separately so XLSX
conversion can share these limits; it does not enforce a specific Office main
document type. `openOfficeArchive` additionally validates DOCX/PPTX root
relationships and content types.

## Markdown creation

`markdownToDocx` creates real hyperlink relationships for HTTP, HTTPS, and mailto
links. A `resolveImage` callback supplies workspace/attachment images; remote,
data, and file URLs are refused before resolving. PNG, JPEG, and GIF images
are embedded with alt text and proportional display sizing. Images are bounded
to 8 MB each, 24 MB total, 32 distinct references, 20,000 pixels per dimension,
and 40 megapixels. A missing or unsupported image fails rather than silently
producing only its alt text. This callback never fetches remote content.
