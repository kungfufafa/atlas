from pathlib import Path
import hashlib,json,subprocess,datetime,os
p=Path('/private/tmp/atlas-publication-turn-principal-c5');s=p/'source';out=Path('/private/tmp/atlas-publication-turn-principal-c5-independent-review');base=Path('/private/tmp/atlas-artifact-consumer-v2/source');root=Path('/Users/apriansyahrs/Documents/Code/atlas');sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(p/'readiness-before-review.json')=='b2b0275d85714d9ad0aa8003c1241f5a81ae64b182462179f2c2f42d4c3335b0'
assert sha(p/'manifest.json')=='489f3f31b7174ab9ef8e8d87e7aad60736a378b11e4785ecb261e9e7d9ab39a8'
assert sha(p/'component.patch')=='441d1dba8ccc0d6e3423070b2cde236b3cdfcbe250277956c1aef8ab71750443'
inv=json.loads((p/'source-inventory.json').read_text());b=json.loads((p/'baseline.json').read_text());r=json.loads(Path('/private/tmp/atlas-artifact-publication-foundation/baseline.json').read_text());m=json.loads((p/'manifest.json').read_text())
checks=[]
for label,d,files in [('candidate',s,inv['files']),('consumerV2',base,b['files']),('rootC5',root,r['files']),('allManifestBytes',p,m['files'])]:
 bad=[f for f,h in files.items() if not (d/f).is_file() or sha(d/f)!=h]
 assert not bad,(label,bad)
 checks.append({'label':label,'listedFilesVerified':len(files),'mismatches':bad})
assert hashlib.sha256(json.dumps(inv['files'],sort_keys=True,separators=(',',':')).encode()).hexdigest()==inv['sourceHash']
changed=sorted(f for f,h in inv['files'].items() if b['files'].get(f)!=h)
assert changed==inv['changedFiles']
results=[]
for name in ['component.patch','production.patch']:
 x=subprocess.run(['git','apply','--check',str(p/name)],cwd=base,capture_output=True,text=True)
 (out/(name+'.check.log')).write_text(x.stdout+x.stderr)
 results.append({'patch':name,'sha256':sha(p/name),'exitCode':x.returncode,'log':name+'.check.log'})
 assert x.returncode==0
links=[]
for x in json.loads((p/'platform-dependency-links.json').read_text()):
 target=s/x['path']; assert target.is_symlink() and str(target.resolve())==str(Path(x['target']).resolve())
 links.append({'path':x['path'],'target':os.readlink(target),'resolves':str(target.resolve())})
oldfiles={f.name:sha(f) for f in p.glob('*.txt')};byhash={h:name for name,h in oldfiles.items()}
cb=json.loads((p/'chat-before-fix-binding.json').read_text());assert sha(base/'packages/agent/src/chat.ts')==cb['baselineChat']
co=json.loads((p/'chat-guard-order-corrected-binding.json').read_text());assert co['testSha256'] in byhash;assert co['restoredSourceSha256']==sha(s/'packages/agent/src/chat.ts')
pb=json.loads((p/'principal-before-reentrancy-binding.json').read_text());assert pb['sourceSha256'] in byhash
log=(p/'union-v4.log').read_text();counts={};current=None
for line in log.splitlines():
 if line.endswith('.test.ts:'):current=line[:-1];counts[current]=0
 if line.startswith('(pass) '):counts[current]+=1
assert sum(counts.values())==65 and ' 322 expect() calls' in log and ' 0 fail' in log
for n in ['production-typecheck-v4.log','scoped-typecheck-v4.log']:assert (p/n).read_bytes()==b''
evidence={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'verification':checks,'computedSourceHash':inv['sourceHash'],'changedFiles':changed,'readonlyPatchChecks':results,'platformDependencyLinksVerified':links,'preservedCounterexampleBytes':oldfiles,'counterexampleTestBindings':{'initialFourArmTest':{'sha256':cb['test'],'matchingPreservedFile':byhash.get(cb['test'])},'guardOrderCorrected':{'sha256':co['testSha256'],'matchingPreservedFile':byhash.get(co['testSha256'])},'initialPrincipalTest':{'sha256':pb['testSha256'],'matchingPreservedFile':byhash.get(pb['testSha256'])}},'ownerPassingTestsByFile':counts,'ownerAssertions':322,'independentTestsRun':0,'ownerReadinessSha256':sha(p/'readiness-before-review.json'),'ownerManifestSha256':sha(p/'manifest.json'),'ownerInventorySha256':sha(p/'source-inventory.json')}
(out/'verification.json').write_text(json.dumps(evidence,indent=2)+'\n')
print(json.dumps({'checks':checks,'changed':changed,'counts':counts,'readonlyPatchChecks':results,'counterexampleBindings':evidence['counterexampleTestBindings']},indent=2))
