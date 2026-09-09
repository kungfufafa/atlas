from pathlib import Path
import sys,subprocess,json,time,datetime,hashlib
b=Path(__file__).resolve().parent
plan=json.loads((b/'gate-plan-before-final-gates.json').read_text())
name=sys.argv[1]
gate=next(g for g in plan['gates'] if g['name']==name)
log=b/('final-'+name+'.log')
assert not log.exists(), 'Gate already has evidence; use a new explicit revision for justified rerun'
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
t0=time.monotonic()
with log.open('x') as output:
 result=subprocess.run(gate['command'],cwd=plan['cwd'],stdout=output,stderr=subprocess.STDOUT)
record={'name':name,'command':gate['command'],'cwd':plan['cwd'],'startedAt':started,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'elapsedSeconds':time.monotonic()-t0,'exitCode':result.returncode,'log':str(log),'logSha256':hashlib.sha256(log.read_bytes()).hexdigest()}
(b/('final-'+name+'.json')).write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record))
print('\n'.join(log.read_text().splitlines()[-8:]))
sys.exit(result.returncode)
