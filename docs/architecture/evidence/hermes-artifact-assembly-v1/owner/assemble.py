from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, shutil, os, subprocess

b = Path('/private/tmp/atlas-artifact-assembly-c5')
root = Path('/Users/apriansyahrs/Documents/Code/atlas')
r = b/'source'
assert not r.exists(), 'New assembly destination required'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p): return json.loads(p.read_text())
def write(p,v): p.write_text(json.dumps(v,indent=2)+'\n')
inputs = {}
for name, expected in [('atlas-artifact-consumer-v2','abf870f82dc97c64deb0e51d4190e1bc2b674c563d583ca577d53486923ca068'),('atlas-artifact-producer-seam-v2','387f0723afe934f8a8ee36b1d6e74d17fa98295d5456d9e2ee3667ae0ef961e0'),('atlas-selected-artifact-capture-foundation','8942bd95dc70c06f260842a730b64919139341f2727ab79a000146743109c3ad')]:
    p=Path('/private/tmp')/name
    inv=read(p/'source-inventory.json')
    assert inv['sourceHash']==expected
    assert all(sha(p/'source'/k)==h for k,h in inv['files'].items()), name
    inputs[name]={'root':str(p),'sourceHash':expected,'files':inv['files'],'inventorySHA256':sha(p/'source-inventory.json')}
rb=read(Path('/private/tmp/atlas-artifact-publication-foundation/baseline.json'))
assert all(sha(root/k)==h for k,h in rb['files'].items())
base=inputs['atlas-artifact-consumer-v2']; producer=inputs['atlas-artifact-producer-seam-v2']; capture=inputs['atlas-selected-artifact-capture-foundation']
r.mkdir()
for k in base['files']:
    target=r/k;target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(Path(base['root'])/'source'/k,target)
patch=Path(producer['root'])/'component.patch'
assert sha(patch)=='eb2a885a4e0d51ec9c285fee71f965895ba76769d1fb3271f63c124994536fa4'
for mode in ['check','apply']:
    args=['git','apply']+(['--check'] if mode=='check' else [])+[str(patch)]
    result=subprocess.run(args,cwd=r,capture_output=True,text=True)
    (b/f'producer-patch-{mode}.log').write_text(result.stdout+result.stderr)
    assert result.returncode==0,(mode,result.stderr)
producer_paths=read(Path(producer['root'])/'source-inventory.json')['changedFiles']
assert len(producer_paths)==3
assert all(sha(r/k)==producer['files'][k] for k in producer_paths)
capture_paths=read(Path(capture['root'])/'source-inventory.json')['changedFiles']
assert len(capture_paths)==3
for k in capture_paths:
    assert k not in base['files'] and not (r/k).exists()
    shutil.copy2(Path(capture['root'])/'source'/k,r/k)
paths=sorted(set(base['files'])|set(capture_paths))
files={k:sha(r/k) for k in paths}
assert [k for k in paths if files[k]!=base['files'].get(k)]==sorted(producer_paths+capture_paths)
links=[]
for directory in ['', 'apps/server','apps/web','apps/cli','apps/mobile','apps/platform/automation','apps/platform/discord','apps/platform/telegram','apps/platform/whatsapp','packages/core','packages/agent','packages/db','packages/client']:
    target=root/directory/'node_modules'
    if target.exists():
        link=r/directory/'node_modules';link.parent.mkdir(parents=True,exist_ok=True)
        link.symlink_to(target,target_is_directory=True)
        assert link.is_symlink() and link.resolve()==target.resolve()
        links.append({'path':str(link.relative_to(r)),'target':os.readlink(link),'resolved':str(link.resolve())})
reviews=[Path('/private/tmp/atlas-artifact-consumer-v2-independent-review/review.json'),Path('/private/tmp/atlas-artifact-producer-seam-v2-independent-review/review.json'),Path('/private/tmp/atlas-selected-artifact-capture-independent-review/review.json')]
record={'at':datetime.now(timezone.utc).isoformat(),'sourceHash':hashlib.sha256(json.dumps(files,separators=(',',':')).encode()).hexdigest(),'sourceFiles':len(files),'consumerBaseSourceHash':base['sourceHash'],'changedFromConsumerV2':sorted(producer_paths+capture_paths),'files':files,'dependencyLinks':links,'inputs':[{k:v for k,v in x.items() if k!='files'} for x in inputs.values()],'independentReviews':[{'path':str(p),'sha256':sha(p)} for p in reviews],'rootC5FilesUnchanged':len(rb['files']),'integrationEditsApplied':False,'productionActivated':False}
write(b/'assembly-baseline.json',record)
print(json.dumps({k:v for k,v in record.items() if k not in ['files','dependencyLinks','inputs','independentReviews']},indent=2))
