from pathlib import Path
import json,hashlib,datetime
b=Path('/private/tmp/atlas-artifact-assembly-c5');o=Path('/private/tmp/atlas-artifact-assembly-c5-independent-review')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def write(p,v):p.write_text(json.dumps(v,indent=2)+'\n')
r={
 'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'status':'CLOSED: no blocking defect found within the explicitly unwired, trusted server-only component scope',
 'sourceRoot':str(b/'source'),'sourceHash':'092cddfec661d7e35a8061f16e52d4389c158a3b64a7c102523b8a4b31b9233c','sourceFiles':2103,
 'readinessSha256':sha(b/'readiness-before-review.json'),'bindingVerificationSha256':sha(o/'binding-verification.json'),
 'verification':{'allPass':True,'checks':90,'finalSourceFiles':2103,'inputSourceFiles':6272,'rootC5Files':2078,'consumerV2DeltaPaths':13,'integrationOwnedPaths':7,'evidenceFiles':37,'dependencyLinks':13,'readOnlyPatchChecks':3,'exactPatchReconstructions':3,'sourceHashVerifiedBeforeAndAfterProbes':True},
 'conclusions':[
  'Selected capture is reachable only on the server-owned execution object. Its producer/ToolContext capability remains generated-byte-only and fixed to tool_output_bytes. Model metadata is not selected-file authority.',
  'The selected ordinal and promise are recorded synchronously before selectedRecord executes. Finalization consumes all reserved promises. The retained old failure proves why the change was needed; independent pending-duplicate and reentrant-failure probes pass.',
  'Captured bytes and a structured clone of exact capture evidence are retained before post-capture authorization. The configured profile root is frozen as a path, then anchored by the unchanged actual capture worker; it is also included in the store disjointness check. Each worker receives the signal.',
  'Generated and selected outputs use the same atomic DB full-set commit. Invalid/conflicting input poisons the set, and asynchronous capture/storage errors remain publication failure. No automatic producer replay or recapture is introduced.',
  'Repeated selection in one execution reuses the same pending/captured record. retryPublication reuses recorded promises/snapshots; a new explicit controller is a distinct attempt and can conflict if file metadata changes. Actual commit-before-ack failure with subsequent source deletion recovered the original record in both adapters.',
  'Selected evidence has exact own enumerable schema keys, fixed version/reader/stability/link-count, bounded numeric strings and matching path/hash/size. Its canonical fingerprint is appended only for selected records. The prior generated record row representation remains byte-for-byte unchanged.',
  'Full captureEvidence and snapshotId stay private in finalization/list/read projections. A real second SQLite connection preserved private evidence through JSON persistence while the service returned exact original snapshot bytes after workspace overwrite.'
 ],
 'ownerGates':{'tests':92,'assertions':594,'files':4,'newIntegrationTests':27,'scopedTypecheckExitCode':0,'lintFiles':7,'lintExitCode':0,'rerunByReviewer':False,'note':'Owner logs, source and bindings inspected. Earlier component tests overlap; do not add counts to prior aggregate claims.'},
 'independentProbes':{'tests':9,'assertions':54,'files':1,'failures':0,'durationLog':'1.83s','logSha256':sha(o/'probe.log'),'sourceSha256':sha(o/'probe.test.ts'),'realCaptureWorker':True,'realSqlite':True,'providerCalls':0,'cases':['pending duplicate selection plus concurrent finalize, both DB adapters','reentrant finalize with failed selected capture does not commit an empty/partial set, both DB adapters','actual durable commit followed by synthetic lost acknowledgment and source deletion, both DB adapters','nested extra keys/wrong versions/stability/reader/oversize timestamp/nonfinite evidence rejection, both DB adapters','second SQLite connection reads private persisted evidence, public redaction, original bytes after workspace mutation']},
 'preservedFailuresReviewed':[
  'Initial evidence admission failure is a legitimate unsupported-class failure. Initial SQLite missing-user foreign-key failure is a fixture mistake, separated from the corrected-fixture intended rejection.',
  'Extra-brace parse error and missing Biome ignore configuration are setup/source-attempt failures; they do not count as behavioral regressions.',
  'Before-fix reentrant authorization finalized an empty successful set. Exact service and bound failure log are retained; focused fixed log and final 92-test owner gate pass.'
 ],
 'limitsAndCoverageGaps':[
  'This is review of a frozen unwired component, not approval to activate production publication. Runtime admission, principal binding, durable owner fencing and complete consumer cutover remain separate prerequisites.',
  'Integration test fixtures, including the reviewer fixture adapted from the owner, use a simple current-authorization callback. They do not recreate real membership/AgentService authorization, platform-admin demotion or channel worker admission. Earlier consumer authorizer evidence has separate scope and is not double-counted.',
  'Authorization before/after capture and before commit has asynchronous revocation windows; there is no globally atomic authorization lease. A trusted authorization callback must not await the finalize operation that itself is waiting for that callback.',
  'Evidence validation proves shape and consistency, not cryptographic attestation or authorship. A direct trusted DB caller can construct a structurally valid receipt. This review assumes model/tool code never receives DB, finalizer, selected-file capability or private-store authority.',
  'The capture integration retains the prior POSIX dirfd worker exactly. Metadata stability and exact captured bytes do not prove an atomic filesystem snapshot against arbitrary hostile host writes. No new Linux, Windows, hostile-host filesystem, descendant ownership or full process isolation proof is supplied.',
  'Failed/uncertain staging may retain private orphan snapshots by design. Retry after a stage failure remains failed and does not recapture; this is not durable crash reconciliation or orphan collection.',
  'Generated fingerprint preservation was checked by source comparison and owner canonical-byte test; no new whole-product suite, UI exercise, provider call, Hermes rescore or parity claim was made.'
 ],
 'inspectionNotes':['One broad combined metadata read was truncated; relevant metadata was then parsed in bounded summaries and all bytes independently hash-verified.','One guessed DB module filename search returned no files; the actual artifact-publication-memory.ts and artifact-publication-sqlite.ts modules were then found and read.','One no-match source search returned exit 1; this was not a product or test failure.'],
 'mutations':{'frozenComponent':0,'inputSources':0,'rootSource':0,'protocols':0,'paidCalls':0},
 'blockingChangesRequested':[],'productionActivationApproved':False
}
write(o/'review.json',r)
(o/'review.md').write_text('''No blocking defect found in the frozen **unwired, trusted server-only** selected-file publication component. This is not production activation approval.

All 2,103 final files, 6,272 input files, the exact 13-path consumer V2 delta, seven owned integration paths, 37 evidence files and three exact reconstructed patches match their bindings. Root C5 remains unchanged. The retained reentrant empty-set failure is real and the reservation fix addresses it.

Nine additional independent tests passed (54 assertions). They used real capture workers and both database adapters to exercise pending duplicate selection, concurrent/reentrant finalize, capture rejection, actual commit before lost acknowledgment, retry after source deletion, nested evidence validation and a second SQLite connection. The original private snapshot and evidence survive; public projections omit private evidence and snapshot identifiers.

Owner gates remain a separate 92 tests / 594 assertions, including 27 new integration tests. Earlier tests overlap and must not be added again. The reviewer fixture adapts the owner fixture and has a simple authorization callback, so these tests are not new membership or runtime-admission proof.

Selected evidence is shape-validated and bound to captured bytes; it is not authorship or hostile-host attestation. Asynchronous revocation windows, trusted callback discipline, runtime principal/ownership admission, uncertain staging orphans and full consumer cutover remain outside this component. No Linux/Windows/full-product/provider/Hermes claim follows from this review.
''')
files=[p for p in sorted(o.iterdir()) if p.is_file() and p.name not in ['evidence-manifest.json','seal.json']]
manifest={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHash':r['sourceHash'],'files':[{'path':p.name,'sizeBytes':p.stat().st_size,'sha256':sha(p)} for p in files]}
write(o/'evidence-manifest.json',manifest)
write(o/'seal.json',{'status':'CLOSED','sourceHash':r['sourceHash'],'reviewSha256':sha(o/'review.json'),'manifestSha256':sha(o/'evidence-manifest.json'),'files':len(files),'sourceEdits':0,'providerCalls':0})
print(json.dumps({'reviewSha256':sha(o/'review.json'),'manifestSha256':sha(o/'evidence-manifest.json'),'sealSha256':sha(o/'seal.json'),'files':len(files)}))
