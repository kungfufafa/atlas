from pathlib import Path
import hashlib,json,subprocess,os,datetime
b=Path('/private/tmp/atlas-artifact-assembly-c5'); out=Path('/private/tmp/atlas-artifact-assembly-c5-independent-review')
def read(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def aggregate(files):return hashlib.sha256(json.dumps(files,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
r=read(b/'readiness-before-review.json'); inv=read(b/'source-inventory.json'); assembly=read(b/'assembly-baseline.json'); assertions=[]
def check(label,value):
 assertions.append({'check':label,'pass':bool(value)});assert value,label
check('readiness supplied SHA',sha(b/'readiness-before-review.json')=='1190ff64aab9cb479fff21c508e394caafca945fd55c34f46a21e8df2ddb8b46')
check('source inventory binding',sha(b/'source-inventory.json')==r['sourceInventorySha256'])
checks=[]
for folder,inventory in [(b,inv)]+[(Path(i['root']),read(Path(i['root'])/'source-inventory.json')) for i in assembly['inputs']]:
 mismatches=[p for p,h in inventory['files'].items() if sha(folder/'source'/p)!=h]
 check(str(folder)+' source files',not mismatches)
 check(str(folder)+' aggregate',aggregate(inventory['files'])==inventory['sourceHash'])
 checks.append({'root':str(folder),'sourceHash':inventory['sourceHash'],'files':len(inventory['files']),'inventorySha256':sha(folder/'source-inventory.json')})
for i in assembly['inputs']:check(i['root']+' input inventory receipt',sha(Path(i['root'])/'source-inventory.json')==i['inventorySHA256'])
check('baseline aggregate',aggregate(assembly['files'])==assembly['sourceHash'])
base=read(Path(assembly['inputs'][0]['root'])/'source-inventory.json')['files']
delta=sorted(p for p,h in inv['files'].items() if h!=base.get(p))
check('exact 13-path delta',delta==r['changedFromConsumerV2'] and len(delta)==13 and set(base)<=set(inv['files']))
owned=sorted(p for p,h in inv['files'].items() if h!=assembly['files'].get(p))
check('exact 7-path selected integration',owned==r['integrationOwnedFiles'] and len(owned)==7)
producer=read(Path(assembly['inputs'][1]['root'])/'source-inventory.json')['files']
capture=read(Path(assembly['inputs'][2]['root'])/'source-inventory.json')['files']
for p in delta:
 if p not in owned:check(p+' exact inherited bytes',inv['files'][p]==(capture[p] if '/selected-artifact-capture' in p else producer[p]))
for item in inv['dependencyLinksVerified']:
 p=b/'source'/item['path'];check(item['path']+' dependency link',p.is_symlink() and os.readlink(p)==item['target'] and str(p.resolve())==item['resolved'])
for item in inv['validationFilesOutsideInheritedSourceInventory']:check(item['path']+' validation bytes',sha(b/'source'/item['path'])==item['sha256'])
for item in assembly['independentReviews']:check(item['path']+' review binding',sha(Path(item['path']))==item['sha256'])
check('manifest binding',sha(b/'evidence-manifest.json')==r['evidenceManifestSha256'])
for item in read(b/'evidence-manifest.json')['files']:
 p=b/item['path'];check(item['path']+' evidence bytes',sha(p)==item['sha256'] and p.stat().st_size==item['sizeBytes'])
for name,h in r['patches'].items():
 check(name+' bound',sha(b/name)==h)
 result=subprocess.run(['git','apply','--check',str(b/name)],cwd=Path(assembly['inputs'][0]['root'])/'source',capture_output=True,text=True)
 (out/(name+'.check.log')).write_text(result.stdout+result.stderr);check(name+' readonly apply',result.returncode==0)
rootbase=read(Path('/private/tmp/atlas-artifact-publication-foundation/baseline.json'))
check('all 2078 C5 bytes unchanged',all(sha(Path('/Users/apriansyahrs/Documents/Code/atlas')/p)==h for p,h in rootbase['files'].items()))
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHash':inv['sourceHash'],'sources':checks,'delta':delta,'assertions':assertions,'rootFilesVerified':len(rootbase['files']),'allPass':True}
(out/'binding-verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'allPass':True,'checks':len(assertions),'sourceFiles':len(inv['files']),'inputFiles':sum(i['files'] for i in checks[1:]),'delta':len(delta)}))
# Verify the patches describe exactly the reviewed final bytes, including additions.
import difflib
for name,paths in [('component.patch',delta),('selected-publication.patch',owned),('production.patch',[p for p in delta if not p.endswith('.test.ts')])]:
 patch=[]
 for p in paths:
  old=(Path(assembly['inputs'][0]['root'])/'source'/p).read_text().splitlines(keepends=True) if p in base else []
  new=(b/'source'/p).read_text().splitlines(keepends=True)
  patch.extend(difflib.unified_diff(old,new,fromfile='a/'+p if old else '/dev/null',tofile='b/'+p))
 check(name+' exact reconstructed delta',''.join(patch)==(b/name).read_text())
actual=set()
for folder,dirs,filenames in os.walk(b/'source'):
 dirs[:]=[d for d in dirs if d!='node_modules' and not (Path(folder)/d).is_symlink()]
 for f in filenames:
  p=Path(folder)/f
  if p.is_file():actual.add(str(p.relative_to(b/'source')))
check('complete source inventory plus three explicit validation inputs',actual==set(inv['files'])|{i['path'] for i in inv['validationFilesOutsideInheritedSourceInventory']})
result['assertions']=assertions;result['checks']=len(assertions)
(out/'binding-verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'finalChecks':len(assertions),'allPass':True}))
