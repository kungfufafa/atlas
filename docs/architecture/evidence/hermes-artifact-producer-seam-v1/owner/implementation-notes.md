# Exact-byte producer seam — isolated component

Baseline: frozen publication foundation `6cf23f28cc6a9e7c0056c29e605850437e2175e93d63b80111e6f090d7df66dd`. This patch adds producer hooks; it does not activate the server execution lifecycle or replace legacy artifact consumers.

## Stable integration API

`packages/core/src/artifact-publication.ts` (existing `@atlas/core/artifact-publication` export):

```ts
interface ToolArtifactPublisher {
  stageBytes(input: { bytes: Uint8Array; sourcePath: string }): Promise<void>;
}
createToolArtifactPublisher(producer: ArtifactPublicationProducer): ToolArtifactPublisher;
stageToolArtifact(publisher: ToolArtifactPublisher | undefined,
  input: {bytes: Uint8Array; sourcePath: string}): Promise<void>;
```

`packages/core/src/contract.ts`: `ToolContext.artifactPublisher?: ToolArtifactPublisher`. No identity, ordinal, read, revoke, retry, or finalizer is exposed in ToolContext. Trusted execution creates a fresh publisher per actual invocation and retains the finalizer elsewhere. Nested helpers share that invocation capability; a second invocation gets a separate counter. Output ordinals are assigned synchronously before delegation. Model-supplied extra ordinal/ownership fields are ignored.

Input property reads are deferred through memoized getters to the trusted low-level producer. That producer must synchronously capture properties and bytes before its first await, inside its failure boundary. Foundation and the separately developed lazy runtime adapter implement that requirement. This matters when malformed tool input has a throwing getter: the rejection must poison the whole staged set, including earlier valid outputs.

`stageToolArtifact` catches staging rejections only. The trusted producer retains publication failure for its finalizer; this helper grants no success authority and does not rerun any file operation. Without a publisher, legacy tools return their usual effects. A directly injected publisher that throws but does not retain its own failure is a violated trusted-adapter contract, not a supported authority boundary.

## Producer inventory and hook placement

| Existing producer | Publication seam | Eligibility / exclusions |
|---|---|---|
| `write_file`, `edit_file` | Stage complete UTF-8 content after successful write; actual version path | New `deliverable: true` required. Validate canonical profile-root `artifacts/` destination before mutation. Hidden paths, metadata sidecars, `.sources`, root MEMORY and arbitrary workspace writes cannot opt in. Omitted/false still writes normally without new publication authority. |
| `save-artifact` bundled skill | Main write opts in; metadata/support writes omit/disable deliverable | Existing file/versioning/sidecar workflow retained. |
| `write_docx`, `write_pptx` | Stage generated buffer after successful file/lineage work | Dedicated deliverable tools; relative publication path resolves against canonical profile workspace, including symlinked configuration roots. |
| `saveFileArtifact` | One staging call at successful final-version byte save | Covers PDF create/merge/split/convert and Office edits without a second wrapper publication. `deliverable:false` file_asset materialization stays under `.sources` and never stages. |
| `spreadsheet` | Stage final serialized/calculated bytes after successful publish and lineage | Dedicated artifact output mutations only; reads never stage. Legacy source edits outside canonical `artifacts/` are not implicitly selected. Recalculation inputs/support files never stage. |
| `generate_image` | Stage captured bytes after existing file, metadata, attachment and usage work succeeds | Image only, not metadata or a duplicate attachment publication. |
| `ArtifactService.saveArtifact/createArtifact` | Save takes optional publisher; create delegates once | Current production callers are browser screenshots/downloads. No list/read/inspect publication or copied JSON authority. |
| `BrowserSessionService` and server registration bridge | Forward publisher to the existing save operation | Screenshot/download references in both result artifacts and snapshot do not produce duplicate publications. |
| `writeNewArtifactVersion`, `publishSpreadsheet` | Freeze caller byte arrays before first await | Pure file helpers do not publish on their own. Spreadsheet revision and written bytes use the same copy. |

Inventory was derived from repository searches for writeFile, saveArtifact, saveFileArtifact, writeNewArtifactVersion and publishSpreadsheet. Other writes are Bash helper scripts, profile/state/portability changes, PDF runtime inputs, extraction inputs, and spreadsheet recalculation support files. They are outside deliberate byte deliverable publication.

Mutable caller bytes are copied before the first await in saveFileArtifact, ArtifactService.saveArtifact, writeNewArtifactVersion, and publishSpreadsheet. Image generation captures its returned buffer before any subsequent await. The original owned byte sequence supplies the disk write, size/revision, and staging; no post-write directory scan or file reread supplies publication authority.

## Evidence and limits

Owner final gates: 70 tests, 325 assertions, 6 files, 2.13 s; 16 tests are newly added seam behaviors. Scoped TypeScript (changed files/new test plus imports), scoped lint (12 TS files), and additive patch check against the frozen foundation passed. Initial fixture-directory failure, initial test-only typing issues, and inspection path/display mistakes remain in raw logs. No provider calls or root/foundation edits occurred.

The browser test replaces Playwright page/session acquisition with deterministic in-process stubs while exercising real BrowserSessionService → ArtifactService → private storage/DB publication. It is not a real browser/OS integration test. Image generation uses an offline injected provider. These are functional evidence for this component, not native model performance or provider quality evidence.

The source intentionally leaves all legacy artifact list/session metadata/history/channel/HTTP consumers untouched. Existing generic writes do not obtain new authority without explicit deliverable intent or the future selected-file path. Bash/Python/custom-tool output, copied/moved existing files, and explicit selected-file capture remain separate work. Fresh invocation lifecycle, cancellation/completion ownership, current authentication checks, durable lookup integration and consumer cutover must be combined and tested before activation. The foundation's host confinement, authorization revocation window, retention/GC, and crash limitations still apply. There is no full race-fix, general host-code isolation, live gain, Hermes parity, or production-ready claim.
