from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, re, tarfile

ROOT=Path('/Users/apriansyahrs/Documents/Code/atlas')
AUDIT=Path('/private/tmp/atlas-native-file-delivery-audit')
OUT=AUDIT/'v2-final-readiness'
GATES=AUDIT/'v2-candidate5-20260906T192749Z'
REVIEW=Path('/private/tmp/atlas-native-file-v2-independent-review')
PRIOR=AUDIT/'v2-readiness.json'
EXPECTED='1b44dd862ed3dac305c1ebe86dabda28c0de085c6a1d9fc1f6f1eb5eaa7dca2d'

def read(p): return json.loads(p.read_text())
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def datahash(d): return hashlib.sha256(json.dumps(d,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def ref(p): return {'path':str(p),'sha256':digest(p),'bytes':p.stat().st_size}
checks=[]
def check(name, passed, detail=None):
 checks.append({'name':name,'pass':bool(passed),**({'detail':detail} if detail is not None else {})})
def mismatches(actual,expected):
 return [{'path':k,'actual':actual.get(k),'expected':expected.get(k)} for k in sorted(set(actual)|set(expected)) if actual.get(k)!=expected.get(k)]

prior=read(PRIOR); before=read(GATES/'source-before.json'); after=read(GATES/'source-after.json'); current=read(OUT/'source-current.json')
pilotRef=read(GATES/'pilot-reference.json'); batch=Path(pilotRef['directory']); metadata=read(batch/'batch.json'); complete=read(batch/'completed.json'); details=read(GATES/'pilot-details.json'); audit=read(batch/'identity-pilot-audit.json')
check('prior-readiness-unchanged',digest(PRIOR)=='d86f5398f46a64771f7a0ce65e7a37dec9f92b923d952120e0f8ca4f42dd42b6')
check('all-source-identities-match-candidate5',all(d['candidateSourceHash']==EXPECTED for d in [before,after,current,metadata,details['analysis'],audit['analysis']]))
check('full-2078-source-map-before-after-current-pilot',len(current['productionFiles'])==2078 and before['productionFiles']==after['productionFiles']==current['productionFiles']==metadata['atlasHashes'])
controls={Path(k).name:v for k,v in current['controlFiles'].items() if k.startswith('scripts/harness-native-files-mimo-v2/')}
check('all-35-current-local-controls-match-prior-and-gates',len(controls)==35 and controls==prior['files']==before['controlFiles']==after['controlFiles'])
check('local-control-aggregate',datahash(controls)==prior['sourceFilesAggregateSha256'],datahash(controls))
check('full-39-control-map-including-prereg-and-shared-dependencies',len(current['controlFiles'])==39 and current['controlFiles']==metadata['controlHashes'])
check('preregistration-unchanged',digest(Path(prior['newProtocol']['path']))==prior['newProtocol']['sha256']==before['protocolSha256'])
check('all-7481-Hermes-source-files-match-pilot',len(current['hermesFiles'])==7481 and current['hermesFiles']==metadata['hermesHashes'])
archiveChecks=[]
archiveBindings=read(batch/'source-archives.json')
check('recorded-three-archive-bindings-agree',archiveBindings==details['archiveBindings'])
for name,key in [('atlas-source.tar.gz','atlasHashes'),('file-protocol-source.tar.gz','controlHashes'),('hermes-source.tar.gz','hermesHashes')]:
 p=batch/name; actual={}; nonfiles=[]; duplicates=[]
 with tarfile.open(p,'r:gz') as tf:
  for member in tf:
   if not member.isfile(): nonfiles.append(member.name); continue
   if member.name in actual: duplicates.append(member.name)
   actual[member.name]=hashlib.sha256(tf.extractfile(member).read()).hexdigest()
 delta=mismatches(actual,metadata[key]); valid=digest(p)==archiveBindings[name] and not delta and not duplicates and not nonfiles
 item={**ref(p),'members':len(actual),'mismatches':delta,'duplicates':duplicates,'nonfiles':nonfiles,'pass':valid};archiveChecks.append(item);check('archive-'+name,valid)
old=[]
for study,expected in [('memory-mimo-study-v1','76ea6c44820011fc8d70205c139322a5c8faf8975565206893f0abd3fe1a298c'),('native-files-mimo-study-v1','d7007a47777bc2a3495be3ce4682640b507112e77c6c17ac6cfd82d64b27b871')]:
 p=Path('/private/tmp/atlas-hermes-evaluation')/study/'frozen/manifest.json';m=read(p)
 actual={k:digest(ROOT/k) if (ROOT/k).is_file() else None for k in m['controlHashes']}
 delta=mismatches(actual,m['controlHashes']);valid=digest(p)==expected and not delta
 old.append({'study':study,'manifest':ref(p),'allManifestControlsChecked':len(actual),'mismatches':delta,'pass':valid});check('old-frozen-controls-'+study,valid)
review=read(REVIEW/'review.json'); addendum=read(REVIEW/'review-addendum-archive-tests.json')
check('original-independent-review-binding',digest(REVIEW/'review.json')=='9e9e141180c1c31266b666d8bb5e392134ee7cd4c002498e7f20e483c67c6a0a'==addendum['priorReview']['sha256'])
check('final-independent-addendum-binding',digest(REVIEW/'review-addendum-archive-tests.json')=='defc0848c45badd9284a2cea79d0ec6008fdcf33d5f9df2b66fd9febee0ea2a5')
check('independent-addendum-covers-exact-final-35-source-map',addendum['authorReadiness']['sha256']==digest(PRIOR) and addendum['checkedSourceFiles']==35 and addendum['sourceHashMismatches']==[])
check('independent-original-no-source-blockers',review['remainingSourceBlockers']==[])

counts={'control-tests':(54,423),'atlas-native-adapter-tests':(4,63),'oracle-tests':(19,None),'code-grader-tests':(12,None),'hermes-native-adapter-tests':(6,None)}
allgates=read(GATES/'control-gates.json')+read(GATES/'native-gates.json')
gateSummary=[]
for g in allgates:
 p=Path(g['log']); log=p.read_text(); name=g['name']; check('gate-exit-'+name,g['exitCode']==0)
 entry={**g,'logBinding':ref(p)}
 if name in counts:
  n,a=counts[name]
  if a is not None: valid=f'{n} pass' in log and '0 fail' in log and f'{a} expect() calls' in log
  else: valid=bool(re.search(r'Ran '+str(n)+r' tests in ',log)) and '\nOK\n' in log
  check('gate-raw-count-'+name,valid);entry.update({'tests':n,'assertions':a})
 if name=='typecheck': check('typecheck-no-diagnostics',not log.strip())
 if name=='lint': check('lint-all-16-no-fixes','Checked 16 files' in log and 'No fixes applied.' in log)
 gateSummary.append(entry)

rows=[json.loads(x) for x in (batch/'attempts.jsonl').read_text().splitlines() if x.strip()]
starts=[r for r in rows if r.get('event')=='start']; ends=[r for r in rows if r.get('event')=='end']
scheduled=[f"{metadata['batch']}-{pair['pairId']}-{h}" for pair in metadata['schedule'] for h in pair['order']]
check('pilot-unscored-offline-only',metadata['phase']=='pilot' and metadata['scored'] is False and metadata['transportMode']=='offline-scripted' and metadata['manifestSha256'] is None)
check('four-scheduled-arms-with-exact-start-end-order',len(scheduled)==4 and [x['id'] for x in starts]==scheduled and [x['id'] for x in ends]==scheduled and len(rows)==8)
check('pilot-completion',complete['scheduledAttempts']==4 and complete['pairedTasks']==2 and complete['sourceUnchanged'] is True and complete==details['completed'])
check('analysis-valid-and-complete',audit['analysis']==details['analysis'] and audit['analysis']['validity']['valid'] is True and audit['analysis']['validity']['issues']==[] and audit['analysis']['coverage']['scheduledArmsMissingOrAmbiguous']==0)
requests=read(batch.parent.parent/'offline-requests.json'); result=read(batch.parent.parent/'pilot-result.json')
check('exact-12-fake-requests',len(requests)==12 and result['requestCount']==12 and result['paidInference'] is False and pilotRef['requests']==12)
check('all-fake-effective-models',all(x['model']=='mimo-v2.5' for x in requests))
armSummary=[]; transport=set(); trialEvidence=[]
for row in ends:
 t=batch/'trials'/row['id']; obs=read(t/'observation.json'); mapping=read(t/'runtime-identity.json'); inp=read(t/'runner-input.json'); selection=read(t/'delivery-selection.json'); binding=read(t/'delivery-binding.json'); oracle=read(t/'artifact-oracle.json')
 valid=(row['status']=='completed' and row['success'] is True and row['boundaryValid'] is True and row['inputIdentical'] is True and row['exitCode']==0 and row['infrastructureError'] is None and row['usageEvidence']['finalized'] is True and row['usageEvidence']['inFlightRequests']==0 and row['usage']['mandatoryUsageKnown'] is True and row['usage']['providerRequests']==3 and row['providerStatuses']==[200]*3)
 check('arm-terminal-'+row['id'],valid)
 check('arm-identity-'+row['id'],mapping['attemptId']==row['id'] and mapping['transportId']==row['transportId']==obs['runId']==inp['runId'] and digest(t/'runtime-identity.json')==row['identitySha256'] and row['transportId'] not in transport)
 transport.add(row['transportId'])
 check('arm-empty-single-completed-session-'+row['id'],len(obs['sessions'])==1 and obs['sessions'][0]['initialHistoryCount']==0 and len(obs['sessions'][0]['turns'])==1 and obs['sessions'][0]['turns'][0]['status']=='completed')
 check('arm-selection-binding-oracle-'+row['id'],selection==row['evaluation']['selection'] and binding==row['evaluation']['binding'] and oracle==row['evaluation']['oracle'] and binding['pass'] is True and oracle['pass'] is True and selection['invalidCandidates']==[] and len(selection['candidates'])==1)
 # Inspect only the finished pilot's selected bytes, never confirmatory manifests.
 output=Path(obs['workspaceRoot'])/selection['path']; observed=[f for f in obs['workspaceFiles'] if f['path']==selection['path']]
 check('arm-selected-bytes-still-match-'+row['id'],output.is_file() and digest(output)==binding['actualSha256'] and len(observed)==1 and observed[0]['sha256']==binding['actualSha256'])
 if row['family']=='csv_join': check('csv-inline-fence-link-repeat-both-harnesses-'+row['id'],'```csv' in obs['finalText'] and obs['finalText'].count('artifacts/joined.csv')==3 and selection['candidates']==['artifacts/joined.csv'])
 cleanup=None
 if row['harness']=='hermes':
  e=obs['evidence'];cleanup={k:e[k] for k in ['nativeCleanup','supervisorCleanup','workerExitCode','workerHardKilled','artifactInspectionAllowed']};check('Hermes-cleanup-'+row['id'],e['nativeCleanup']['completed'] is True and e['supervisorCleanup']['completed'] is True and e['supervisorCleanup']['remainingPids']==[] and e['supervisorCleanup']['errors']==[] and e['workerExitCode']==0 and e['workerHardKilled'] is False and e['artifactInspectionAllowed'] is True)
 check('three-preserved-wire-requests-'+row['id'],len(list((t/'wire').glob('*-request.json')))==3)
 armSummary.append({'id':row['id'],'harness':row['harness'],'family':row['family'],'status':row['status'],'success':row['success'],'fakeProviderRequests':3,'delivery':selection,'binding':binding,'cleanup':cleanup})
 for p in sorted(t.iterdir()):
  if p.is_file(): trialEvidence.append(ref(p))
 for p in sorted((t/'wire').iterdir()):
  if p.is_file():trialEvidence.append(ref(p))

check('new-study-remains-unfrozen',not Path('/private/tmp/atlas-hermes-evaluation/native-files-mimo-study-v2/frozen/manifest.json').exists())
for name,expected in read(GATES/'private-pilot-bindings.json').items(): check('private-script-binding-'+name,digest(AUDIT/name)==expected)
# Bind all preserved gate/inspection files, earlier readiness/reviews and authoritative pilot metadata.
evidence=[ref(p) for p in sorted(GATES.iterdir()) if p.is_file()]
evidence += [ref(PRIOR),ref(REVIEW/'review.json'),ref(REVIEW/'review-addendum-archive-tests.json'),ref(OUT/'source-current.json'),ref(OUT/'snapshot-current.ts'),ref(OUT/'snapshot-current.log'),ref(OUT/'inspection-notes.json'),ref(OUT/'inspection-observation-shape-error.json')]
evidence += [ref(AUDIT/n) for n in read(GATES/'private-pilot-bindings.json')]
evidence += [ref(batch/n) for n in ['batch.json','completed.json','source-archives.json','attempts.jsonl','identity-pilot-audit.json','runtime-identities.json']]
evidence += [ref(batch.parent.parent/n) for n in ['offline-requests.json','pilot-result.json']]
verification={'at':datetime.now(timezone.utc).isoformat(),'checks':checks,'passed':sum(c['pass'] for c in checks),'failed':sum(not c['pass'] for c in checks),'archives':archiveChecks,'oldFrozenControls':old,'allEvidence':evidence,'trialEvidence':trialEvidence}
(OUT/'verification.json').write_text(json.dumps(verification,indent=2)+'\n')
ready={'schemaVersion':1,'at':datetime.now(timezone.utc).isoformat(),'reviewer':'/root/file_v2_finalize','status':'offline-gates-complete-ready-for-root-freeze-review' if verification['failed']==0 else 'offline-readiness-blocked-by-verification','freezeReady':verification['failed']==0,'meaningOfFreezeReady':'The previously deferred offline source, control, regression and actual-native scripted-pilot gates are satisfied for this exact current candidate and control map. Root must separately decide and perform prospective freeze/admission before any live file V2 run. This is not a live-quality, confirmatory-statistical, security-completeness or parity certificate.','priorReadiness':ref(PRIOR),'candidateSourceHash':EXPECTED,'sourceCurrent':ref(OUT/'source-current.json'),'sourceWindow':{'before':before['at'],'after':after['at'],'current':current['completedAt'],'productionFiles':len(current['productionFiles']),'controls':len(controls),'fullControlMap':len(current['controlFiles']),'hermesFiles':len(current['hermesFiles'])},'sourceFilesAggregateSha256':datahash(controls),'preregistration':ref(Path(prior['newProtocol']['path'])),'completedGates':gateSummary,'counts':{'bunTests':58,'bunAssertions':486,'pythonTests':37,'totalTests':95,'scriptedNativePilotArms':4,'scriptedNativePilotPairs':2,'fakeProviderCalls':12,'qualification':'Counts cover these completed full gates only. Earlier focused and independent overlapping tests are not added; fake calls and asserted synthetic usage are not real provider usage or quality evidence.'},'nativePilot':{'directory':str(batch),'completed':complete,'arms':armSummary,'analysisValidity':audit['analysis']['validity'],'coverage':audit['analysis']['coverage'],'archives':archiveChecks},'independentReview':{'original':ref(REVIEW/'review.json'),'finalSourceAddendum':ref(REVIEW/'review-addendum-archive-tests.json'),'scope':'Historical bounded source review plus additive exact-source refresh. Their pending full-gate/pilot items are now discharged by the subsequently completed logs inspected here; no new independent test execution is claimed.'},'verification':ref(OUT/'verification.json'),'failedChecks':[c for c in checks if not c['pass']],'remainingActions':['Root prospective freeze/admission decision; no freeze or paid inference performed by this work.','Any future live comparison retains all attempts and the declared statistical limitations; offline success supplies no parity claim.'],'limitations':['Only local injected scripted model responses drove the completed four-arm pilot. Actual Atlas AgentService, pinned Hermes terminal runtime, native file writes and semantic oracles were exercised.','The pilot covers XLSX reconciliation and CSV joining, including repeated inline paths surrounding fenced CSV and a repeated link; it does not establish all nine task families work live.','The structural/content oracles do not certify visual layout, accessibility, OCR, general software correctness or every public factual statement.','The known shared-workspace artifact-attribution race is outside these isolated workspaces and remains unresolved by this evaluator amendment. No concurrent multi-session artifact isolation claim is made.','Cleanup evidence is native close plus sampled descendants and the recorded canary/deadline regressions, not hostile double-fork or universal process-containment proof. Atlas successful process behavior and direct sandbox canaries are covered by its adapter test; no separate Atlas supervisor receipt is invented.','The inherited family-percentile bootstrap has no demonstrated nominal coverage or power for the five-percentage-point noninferiority claim with nine families; observed floors and informationAdequate are not population guarantees. Root must keep any future conclusion within its actual evidentiary scope.','MiMo and User-Agent differ from prior DeepSeek conditions; no pooling or model-only causal claim. The old MiMo file V1 pilot score remains unchanged.','Current source refresh does not certify future unmodified state; prospective freeze must rebind exact sources and admission guards.'],'paidCallsByThisWork':0,'testOrPilotRerunsByThisWork':0,'frozenByThisWork':False,'rootOrControlSourcesEditedByThisWork':False,'oldPilotScoresChanged':False,'priorReadinessAndInspectionErrorsPreserved':True}
(OUT/'readiness-final.json').write_text(json.dumps(ready,indent=2)+'\n')
print(json.dumps({'freezeReady':ready['freezeReady'],'checksPassed':verification['passed'],'checksFailed':verification['failed'],'failedChecks':ready['failedChecks'],'readiness':ref(OUT/'readiness-final.json'),'verification':ref(OUT/'verification.json')},indent=2))
