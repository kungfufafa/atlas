# File gap remediation

See the subsequent [actual execution follow-up](live-proof-2026-09-06.md) for
live provider results, native authentication probes and Docker/Linux attempts.
The results below retain their original snapshot and evidence classification.

Date: 2026-09-06. This follow-up retains the earlier failures in the
[deep validation ledger](deep-validation-run.md). Actual local engines, protocol
fixtures, mocked messenger transports, and blocked live checks remain distinct.

## Implemented and exercised

| Gap | Behavior and evidence | Remaining boundary |
| --- | --- | --- |
| Python/Bash filesystem | Required Seatbelt on macOS or Landlock ABI 3 on Linux; private HOME/temp, allowlisted environment and read-only runtime roots. Actual macOS children can use their profile and installed Office libraries; sibling tenant/config/home access, symlinks, hard links and inherited descriptors are denied. | Linux enforcement needs the Docker gate. Network access, escaped process sessions and resource quotas are separate guarantees. Missing sandbox never falls back to host execution. Host coding-agent login files are no longer available through these tools. |
| Scanned PDF OCR | Actual Tesseract reads `SCAN REVIEW 8642` at 96.31% mean confidence. Missing engine/language and low confidence retain incomplete coverage. | Automatic OCR targets pages without a text layer. Other languages require installed packs; reading order still needs visual review. |
| Word tracked edits | Fresh deletion/insertion revisions retain earlier author history; independent accept/reject checks and a valid inline-run fixture verify the change and rendered review markup. | Tracked moves, fields and complex structures remain guarded. Original D03 has an invalid body-level insertion that LibreOffice omits before and after; its structural pass alone is not visual evidence. |
| Workbook chart edits | Direct source XML edits retain charts, drawings and relationships; stale formula/chart caches are cleared and refresh-on-open is declared. Actual LibreOffice rendering changes Alpha from 4 to 12 while Beta remains 5. | Chart recalculation inside Atlas and chart layout edits remain unsupported. The source's two-page horizontal pagination is retained. |
| PDF merge navigation/attachments | pypdf remaps outlines, destinations, internal links and embedded Filespec/associated-file references. A repeated-source test verifies both exact attachment payloads and link destinations 1 and 3. | Forms/signatures, colliding named destinations and unsupported catalog structures are refused. Complex splitting remains guarded. |
| Large multilingual font | The 23,278,008-byte font becomes a 29,232-byte subset. HarfBuzz and Unicode bidi render readable Latin, connected Arabic and CJK; pypdf recovers the exact Unicode string. | TrueType outlines and bounded subset/output/worker time; not universal font or layout support. The rendered corpus case is one page. |

Both complete 21-case corpus attempts fulfilled all structural/content oracles:
**21 supported, 0 unsupported, 0 content failures**. Oracle v6 checks revision
semantics and chart preservation; earlier results remain intact. No original
input hashes changed. See [execution and oracle evidence](validation/gap-remediation/),
[Word/chart visual evidence](validation/daily-files-corpus/gap-remediation-office-visual/review.json),
and the [multilingual visual verdict](validation/gap-remediation/f05-visual.json).

## Channel and runtime checks

All WhatsApp, Telegram and Discord worker regressions plus the channel handler
harness passed: 503 tests, 1,770 assertions. Inbound attachments, output versions,
upload failures/retries, and exact transmitted/downloaded bytes remain covered.
These are **mock external transports with actual handlers and files**, not live
delivery evidence. The post-integration scripts target also passes 46 tests/130
assertions, including the same full-handler scenarios. Counts overlap with other
targets and must not be added as distinct tests.

The full repository target, TypeScript projects, server build and global lint
are recorded in [the final check summary](validation/gap-remediation/summary.json).
The bundled PDF worker executes real OCR/merge/font processing without a Python
source sidecar. The server build includes both Linux sandbox launcher assets.

## Live and deployment prerequisites

- **Claude: blocked.** The installed CLI reports `not_authenticated` (2.1.247).
  The live gate returns exit 2 and `inference: NOT_RUN`. After Atlas Claude login,
  an explicit `ATLAS_LIVE_CLAUDE_MODEL` runs native MCP → protected write → read
  of the exact returned path → independent file-byte checks, with no fallback.
- **Messenger delivery: not run.** No recipient and send authorization were
  supplied. The live-human script's hardcoded WhatsApp phone was removed;
  `ATLAS_LIVE_SEND_AUTHORIZED=1` and `ATLAS_LIVE_WHATSAPP_TARGET` are both required
  before its send journey or assignment of the send tool. Telegram/Discord still
  need designated live test chats.
- **Docker/Linux: blocked locally.** Docker CLI 28.5.1 is installed, but the daemon
  is unavailable. The verification script exits 2 with `BLOCKED`. A CI job now
  builds the production image, then checks actual Python/Bash isolation, Office
  roundtrips, OCR, PDF navigation/attachments and Arabic font layout as UID1000
  with no host mounts or network. Adding the job is not a remote CI pass.

## Reproduction

```bash
# Configure LibreOffice, OCR and managed Python first.
bun scripts/daily-files-corpus/run.ts /tmp/atlas-daily-files-corpus new-attempt
"$ATLAS_PYTHON_PATH" scripts/daily-files-corpus/verify.py \
  /tmp/atlas-daily-files-corpus \
  /tmp/atlas-daily-files-corpus/attempts/new-attempt/execution.json --revision v6
bun scripts/file-runtime/check-pdf.ts /absolute/path/to/covering.ttf --cjk

# Configure/login Atlas Claude first; choose an exact model.
ATLAS_LIVE_CLAUDE_MODEL=your-exact-model bun scripts/harness-channel-audit/live-claude.ts

# Never stops an existing Atlas container.
bash scripts/verify-docker-files.sh
```

Raw logs use `/private/tmp/atlas-gap-*.log`; durable evidence includes their
SHA-256 digests. Live Claude, messenger receipts and actual Linux/Docker execution
remain prerequisites for a broader deployment claim.
