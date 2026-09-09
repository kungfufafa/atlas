from pathlib import Path
import json,hashlib,difflib,subprocess,datetime
b=Path('/private/tmp/atlas-publication-turn-principal-c5');s=b/'source';base_root=Path('/private/tmp/atlas-artifact-consumer-v2/source');root=Path('/Users/apriansyahrs/Documents/Code/atlas')
base=json.loads((b/'baseline.json').read_text())['files'];sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
changed=['packages/agent/src/chat.ts','packages/agent/src/chat-turn-admission.test.ts','apps/server/src/services/publication-turn-principal.ts','apps/server/src/services/publication-turn-principal.test.ts']
for n,h in base.items():assert sha(base_root/n)==h,n
rootmap=json.loads(Path('/private/tmp/atlas-hermes-evaluation/memory-mimo-study-v1/batches/development-2026-09-06T22-55-00-233Z-d062ca06/candidate-source.json').read_text())['atlasHashes']
for n,h in rootmap.items():assert sha(root/n)==h,n
files=dict(base)
for n in changed:files[n]=sha(s/n)
for n,h in files.items():assert sha(s/n)==h,n
sourcehash=hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest();patches={}
for pname,names in [('component.patch',changed),('production.patch',[n for n in changed if not n.endswith('.test.ts')])]:
 patch=''
 for n in sorted(names):
  old=(base_root/n).read_text().splitlines(True) if n in base else []
  patch+='diff --git a/'+n+' b/'+n+'\n'
  if n not in base:patch+='new file mode 100644\n'
  patch+=''.join(difflib.unified_diff(old,(s/n).read_text().splitlines(True),fromfile='a/'+n if n in base else '/dev/null',tofile='b/'+n))
 (b/pname).write_text(patch)
 check=subprocess.run(['git','apply','--check',str(b/pname)],cwd=base_root,capture_output=True,text=True)
 (b/(pname+'.check.log')).write_text(check.stdout+check.stderr);assert check.returncode==0
 patches[pname]=sha(b/pname)
inv={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHash':sourcehash,'sourceFiles':len(files),'baselineSourceHash':'abf870f82dc97c64deb0e51d4190e1bc2b674c563d583ca577d53486923ca068','changedFiles':sorted(changed),'files':dict(sorted(files.items()))}
(b/'source-inventory.json').write_text(json.dumps(inv,indent=2)+'\n')
logs=['union-v4.log','production-typecheck-v4.log','scoped-typecheck-v4.log','lint-v4.log','chat-guard-before-fix.log','chat-before-fix-binding.json','principal-before-reentrancy-fix.log','principal-before-reentrancy-corrected-fixture.log','chat-before-guard-order-fix.log','chat-before-guard-order-corrected-fixture.log','chat-guard-order-corrected-binding.json','production-typecheck-initial.log','platform-dependency-links.json','implementation-notes.md','source-inventory.json']
readiness={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'ready-for-independent-review','sourceHash':sourcehash,'sourceFiles':len(files),'baselineSourceFilesUnchanged':len(base),'rootC5Unchanged':len(rootmap),'changedFiles':sorted(changed),'patches':patches,'tests':65,'assertions':322,'testFiles':5,'newTests':28,'gates':{'tests':0,'productionTypecheck':0,'scopedTypecheck':0,'lint':0,'readonlyPatchChecks':0},'evidence':{n:sha(b/n) for n in logs},'noPaidCalls':True,'productionActivated':False,'limits':['Host-owned per-turn identity and awaited effect guard only; no native subscription or real provider evaluation.','No loader, spawn, legacy pre-scan or private-root admission guarantee.','Current ACL checks are not an atomic lease or effect transaction.','No AgentService/routes/store/UI activation or non-chat identity mapping.','Original benchmark validity and outcomes unchanged.']}
(b/'readiness-before-review.json').write_text(json.dumps(readiness,indent=2)+'\n')
key=Path('/private/tmp/atlas-harness-private/opencode-key').read_bytes().strip();manifest={}
for p in b.iterdir():
 if p.is_file() and p.name!='manifest.json':
  data=p.read_bytes();assert not key or key not in data,str(p);manifest[p.name]=hashlib.sha256(data).hexdigest()
for n,h in files.items():manifest['source/'+n]=h
(b/'manifest.json').write_text(json.dumps({'sealedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'fileCount':len(manifest),'files':dict(sorted(manifest.items()))},indent=2)+'\n')
print(json.dumps({'sourceHash':sourcehash,'readiness':sha(b/'readiness-before-review.json'),'manifest':sha(b/'manifest.json'),'componentPatch':patches['component.patch'],'files':len(files)}))
