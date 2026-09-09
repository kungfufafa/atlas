from pathlib import Path
import datetime, hashlib, json, os, selectors, shutil, signal, subprocess, tempfile, time
BASE=Path('/private/tmp/atlas-restart-reproduction')
ROOT=Path('/Users/apriansyahrs/Documents/Code/atlas')
EXPECTED='1b44dd862ed3dac305c1ebe86dabda28c0de085c6a1d9fc1f6f1eb5eaa7dca2d'
INVENTORY=Path('/private/tmp/atlas-hermes-evaluation/candidate-v5/root-after.json')
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def write(path,data): path.write_text(json.dumps(data,indent=2)+'\n')
def bind():
    data=json.loads(INVENTORY.read_text()); actual={p:sha(ROOT/p) for p in data['files']}; mismatches=[p for p,v in actual.items() if v!=data['files'][p]]
    return {'at':now(),'expectedCandidateSourceHash':EXPECTED,'inventoryPath':str(INVENTORY),'inventorySha256':sha(INVENTORY),'fileCount':len(actual),'matches':not mismatches,'mismatches':mismatches,'files':actual}
run=Path(tempfile.mkdtemp(prefix='run-',dir=BASE)); start=time.monotonic()
write(run/'source-before.json',bind())
assert json.loads((run/'source-before.json').read_text())['matches']
write(run/'fixture-source.json',{'child':sha(BASE/'child.ts'),'orchestrator':sha(BASE/'run.py'),'startedAt':now(),'budget':'3 serial boundaries; 10 seconds child-start marker; 10 seconds cold reopen; no model/network calls; only owned child SIGKILL','phases':['approval_wait','before_effect','after_effect_before_receipt']})
results=[]
try:
  for phase in ['approval_wait','before_effect','after_effect_before_receipt']:
    folder=run/phase; folder.mkdir(); (folder/'workspace').mkdir(); (folder/'effects.ndjson').write_text('')
    stderr=open(folder/'child.stderr','wb'); proc=subprocess.Popen([shutil.which('bun'),str(BASE/'child.ts'),'start',str(folder),phase],cwd=ROOT,stdout=subprocess.PIPE,stderr=stderr)
    selector=selectors.DefaultSelector(); selector.register(proc.stdout,selectors.EVENT_READ); raw=[]; boundary=None; deadline=time.monotonic()+10
    try:
      while time.monotonic()<deadline:
        events=selector.select(min(0.2,deadline-time.monotonic()))
        if events:
          line=proc.stdout.readline(); raw.append(line)
          if not line: raise RuntimeError(f'{phase} exited before boundary with {proc.poll()}')
          try: item=json.loads(line)
          except json.JSONDecodeError: continue
          if item.get('event')=='boundary': boundary=item; break
        if proc.poll() is not None: raise RuntimeError(f'{phase} exited before boundary with {proc.returncode}')
      if boundary is None: raise TimeoutError(f'{phase} no boundary within 10 seconds')
      pid=proc.pid; observed_live=proc.poll() is None; assert observed_live
      os.kill(pid,signal.SIGKILL); code=proc.wait(timeout=5); assert code==-signal.SIGKILL
      raw.append(proc.stdout.read()); (folder/'child.stdout').write_bytes(b''.join(raw)); stderr.close()
      count_after_kill=len((folder/'effects.ndjson').read_text().splitlines()); bytes_after_kill=sha(folder/'effects.ndjson')
      write(folder/'exit.json',{'pid':pid,'liveBeforeKill':observed_live,'sentSignal':'SIGKILL','returnCode':code,'waitedForExitBeforeReopen':True,'counterAfterKill':count_after_kill,'counterSha256AfterKill':bytes_after_kill,'at':now()})
      resumed=subprocess.run([shutil.which('bun'),str(BASE/'child.ts'),'reopen',str(folder),phase],cwd=ROOT,capture_output=True,timeout=10)
      (folder/'reopen.stdout').write_bytes(resumed.stdout); (folder/'reopen.stderr').write_bytes(resumed.stderr)
      assert resumed.returncode==0, f'reopen failed {phase} see logs'
      observations=[json.loads(line) for line in resumed.stdout.splitlines() if line.startswith(b'{')]; reopened=next(x for x in observations if x.get('event')=='reopened')
      expected=1 if phase=='after_effect_before_receipt' else 0
      assert count_after_kill==expected==reopened['initial']['counter']==reopened['oldFinal']['counter']
      assert sha(folder/'effects.ndjson')==bytes_after_kill
      assert reopened['initial']['registry']=={'active':False}
      assert reopened['oldDecision']['rejected'] and reopened['oldDecision']['status']==409
      assert reopened['initial']['oldGrantInProcess'] is None
      for slot in ['initial','afterOldDecision','oldFinal']:
        state=reopened[slot]; assert len(state['steps'])==1 and state['steps'][0]['resultJson'] is None and not state['history']
        assert state['approval']['status']==('pending' if phase=='approval_wait' else 'approved')
        assert state['run']['status']==state['steps'][0]['status']==('awaiting_approval' if phase=='approval_wait' else 'running')
      assert reopened['freshBefore']['approval']['status']=='pending'
      assert reopened['freshDecision']=={'resumed':True,'status':'approved'}
      assert reopened['freshResolution']['decision']=='approved'
      assert reopened['freshAfter']['accessChecks']>=3
      assert reopened['freshAfter']['counter']==expected
      assert reopened['freshCleanup']['run']['status']=='cancelled'
      assert json.loads(reopened['freshCleanup']['steps'][0]['resultJson'])['errorCode']=='UNCONFIRMED_RESULT'
      result={'phase':phase,'boundary':boundary,'childExit':json.loads((folder/'exit.json').read_text()),'reopened':reopened,'checksPassed':True}; write(folder/'result.json',result); results.append(result)
    finally:
      selector.close()
      if proc.poll() is None:
        proc.kill(); proc.wait(timeout=5)
      stderr.close()
  before=next(x for x in results if x['phase']=='before_effect')['reopened']['initial']; after=next(x for x in results if x['phase']=='after_effect_before_receipt')['reopened']['initial']
  def operational(s): return {'runStatus':s['run']['status'],'checkpoint':json.loads(s['run']['checkpoint']),'approvalStatus':s['approval']['status'],'actionHash':s['approval']['actionHash'],'argsJson':s['approval']['argsJson'],'stepStatus':s['steps'][0]['status'],'resultJson':s['steps'][0]['resultJson'],'history':s['history'],'registry':s['registry'],'oldGrantInProcess':s['oldGrantInProcess']}
  assert operational(before)==operational(after)
  write(run/'comparison.json',{'beforeEffectOperationalState':operational(before),'afterEffectOperationalState':operational(after),'operationalStateEqual':True,'beforeEffectCounter':before['counter'],'afterEffectCounter':after['counter'],'observedDuplicateEffect':False,'automaticResumeSupported':False,'freshExplicitApprovalSupported':True,'elapsedSeconds':time.monotonic()-start})
  write(run/'source-after.json',bind()); assert json.loads((run/'source-after.json').read_text())['matches']
  write(run/'completion.json',{'status':'completed','at':now(),'cases':len(results),'providerCalls':0,'rootEdits':False,'elapsedSeconds':time.monotonic()-start})
except BaseException as e:
  write(run/'failure.json',{'type':type(e).__name__,'message':str(e),'at':now(),'completedCases':len(results)})
  raise
finally:
  write(run/'manifest.json',{'files':{str(p.relative_to(run)):sha(p) for p in sorted(run.rglob('*')) if p.is_file() and p.name!='manifest.json'}})
  print(json.dumps({'run':str(run),'elapsedSeconds':time.monotonic()-start,'completedCases':len(results)}))
