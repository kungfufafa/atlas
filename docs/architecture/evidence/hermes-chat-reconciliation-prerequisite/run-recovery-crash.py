from pathlib import Path
import json,hashlib,subprocess,shutil,selectors,os,signal
b=Path('/private/tmp/atlas-chat-reconciliation-design-c5');d=b/'recovery-crash-v2';d.mkdir();source=Path('/private/tmp/atlas-restart-reproduction/run-jtpo6wnm/after_effect_before_receipt/restart.sqlite');target=d/'state.sqlite';hashes={}
for suffix in ['','-wal','-shm']:
 old=Path(str(source)+suffix);new=Path(str(target)+suffix);shutil.copyfile(old,new);v=hashlib.sha256(old.read_bytes()).hexdigest();assert hashlib.sha256(new.read_bytes()).hexdigest()==v;hashes[str(old)]=v
(d/'source-reference.json').write_text(json.dumps({'sourceFiles':hashes,'source':'Actual prior SIGKILL after fsynced counter1; approved/running, no receipt. Copy complete closed DB main+WAL+SHM set; no original open/mutation. This process executes hypothetical CAS-only recovery, not another external mutation.','priorSetupFailure':'recovery-crash copied main without WAL, so run was absent; preserved startup failure. This revised fixture copies the complete SQLite file set.'},indent=2)+'\n')
e=open(d/'child.stderr','wb');p=subprocess.Popen([shutil.which('bun'),str(b/'recovery-crash.ts'),str(target),'mutate'],cwd=b/'source',stdout=subprocess.PIPE,stderr=e);sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ)
try:
 assert sel.select(5),'child boundary timeout';line=p.stdout.readline();(d/'child.stdout').write_bytes(line);item=json.loads(line);assert item['event']=='after-run-cas-before-steps';assert p.poll() is None;os.kill(p.pid,signal.SIGKILL);code=p.wait(timeout=5);assert code==-9
 (d/'exit.json').write_text(json.dumps({'pid':p.pid,'signal':'SIGKILL','returnCode':code,'waitedBeforeReopen':True},indent=2)+'\n')
finally:
 if p.poll() is None:p.kill();p.wait(timeout=5)
 e.close();sel.close()
r=subprocess.run([shutil.which('bun'),str(b/'recovery-crash.ts'),str(target),'inspect'],cwd=b/'source',capture_output=True,timeout=5);(d/'reopen.stdout').write_bytes(r.stdout);(d/'reopen.stderr').write_bytes(r.stderr);assert r.returncode==0
a=json.loads(r.stdout);assert a['retryClaim'] is False and a['run']['status']=='cancelled' and a['steps'][0]['status']=='running' and a['steps'][0]['resultJson'] is None
for path,v in hashes.items():assert hashlib.sha256(Path(path).read_bytes()).hexdigest()==v
(d/'result.json').write_text(json.dumps(a,indent=2)+'\n');print(json.dumps({'hypotheticalRecoveryCrashedBetweenWrites':True,'reopenedRun':a['run']['status'],'reopenedStep':a['steps'][0]['status'],'receipt':a['steps'][0]['resultJson'],'retryClaim':a['retryClaim'],'originalSourceDbSetUnchanged':True}))
