from pathlib import Path
import json,hashlib,collections,datetime
b=Path('/private/tmp/atlas-hermes-evaluation/native-files-mimo-study-v3-c9/batches/confirmatory-1788766021520-052b6932');r=Path('/private/tmp/atlas-native-file-v3-c9-confirmation-health-window');entries=[];bindings={};ordinal=0;offset=0
# Stream to ordinal60 only. No model/task/oracle fields are selected or emitted.
with (b/'attempts.jsonl').open('rb') as f:
 for line in f:
  here=offset;offset+=len(line);record=json.loads(line)
  if record.get('event')!='end':continue
  ordinal+=1
  if ordinal<51:continue
  allowed={k:record[k] for k in ['at','attemptStarted','deadline','elapsedMs','processObservationElapsedMs','totalAttemptElapsedMs','totalAttemptElapsedWallMs'] if k in record}
  statuses=record.get('providerStatuses',[]);usage=record.get('usage',{});accounting=record.get('usageEvidence',{})
  entries.append({'ordinal':ordinal,'idForMetadataLookup':record['id'],'lifecycle':allowed,'transportCounters':{'reportedProviderRequests':usage.get('providerRequests'),'httpStatusCounts':dict(collections.Counter('null' if x is None else str(x) for x in statuses)),'requestKindCounts':dict(collections.Counter(str(x.get('kind')) for x in accounting.get('requests',[]))),'requestStatusCounts':dict(collections.Counter('null' if x.get('status') is None else str(x.get('status')) for x in accounting.get('requests',[]))),'inFlightRequestsAtFinalization':accounting.get('inFlightRequests'),'observationError':accounting.get('observationError'),'finalized':accounting.get('finalized')},'originalLedgerLine':{'path':str(b/'attempts.jsonl'),'byteOffset':here,'bytes':len(line),'sha256':hashlib.sha256(line).hexdigest()}})
  if ordinal==60:break
assert len(entries)==10
for row in entries:
 trial=b/'trials'/row.pop('idForMetadataLookup');row['attemptIdSha256']=hashlib.sha256(trial.name.encode()).hexdigest()
 def read(rel):
  p=trial/rel;raw=p.read_bytes();h=hashlib.sha256(raw).hexdigest();bindings[str(p)]={'bytes':len(raw),'sha256':h};parsed=json.loads(raw);assert hashlib.sha256(p.read_bytes()).hexdigest()==h;return parsed
 caller=read('caller-return.json');row['callerTiming']={k:caller[k] for k in ['callerInvocationStarted','callerInvocationReturned','deadline','outerInvocationElapsedMs','outerInvocationElapsedWallMs'] if k in caller}
 invocation=read('invocation.json');row['helperTiming']={k:invocation[k] for k in ['invocationStarted','processHelperReturned','processHelperElapsedMs','processHelperElapsedWallMs','attemptStarted','deadline'] if k in invocation}
 process=read('process/process-outcome.json');row['processTiming']={k:process[k] for k in ['started','processObservedAt','elapsedMonotonicMs','elapsedWallMs','timedOut','closed','exit','signals'] if k in process}
 a=row['lifecycle'];row['derivedTimingDifferencesMs']={'totalWallMinusTotalMonotonic':a.get('totalAttemptElapsedWallMs',0)-a.get('totalAttemptElapsedMs',0),'callerWallMinusCallerMonotonic':caller.get('outerInvocationElapsedWallMs',0)-caller.get('outerInvocationElapsedMs',0),'processWallMinusProcessMonotonic':process.get('elapsedWallMs',0)-process.get('elapsedMonotonicMs',0),'totalMonotonicMinusCallerMonotonic':a.get('totalAttemptElapsedMs',0)-caller.get('outerInvocationElapsedMs',0),'totalWallMinusCallerWall':a.get('totalAttemptElapsedWallMs',0)-caller.get('outerInvocationElapsedWallMs',0)}
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Health-only released closed ordinals51–60; lifecycle timestamps, clock intervals and transport counters; no status/success/quality/task/tool/output/oracle fields','rows':entries,'metadataBindings':bindings,'ledgerBindingNote':'Active append-only ledger is bound by each selected original line byte offset, size and SHA; no claim of immutable full active ledger','derivedNote':'Differences subtract original recorded intervals; different interval boundaries remain explicit. No provider/network/sleep/validity conclusion is implied.'}
(r/'lifecycle-projection.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps([{'ordinal':x['ordinal'],'endAt':x['lifecycle']['at'],'lifecycle':x['lifecycle'],'difference':x['derivedTimingDifferencesMs'],'transport':x['transportCounters']} for x in entries],indent=2))
