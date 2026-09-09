from pathlib import Path
from datetime import datetime, timezone
import hashlib,json,difflib,subprocess,os,re
b=Path('/private/tmp/atlas-artifact-assembly-c5');r=b/'source';root=Path('/Users/apriansyahrs/Documents/Code/atlas')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p):return json.loads(p.read_text())
def write(p,v):p.write_text(json.dumps(v,indent=2)+'\n')
assembly=read(b/'assembly-baseline.json');consumer=Path('/private/tmp/atlas-artifact-consumer-v2');base=read(consumer/'source-inventory.json')
rootbase=read(Path('/private/tmp/atlas-artifact-publication-foundation/baseline.json'))
assert all(sha(root/p)==h for p,h in rootbase['files'].items())
input_checks=[]
for item in assembly['inputs']:
    folder=Path(item['root']);inventory=read(folder/'source-inventory.json')
    assert sha(folder/'source-inventory.json')==item['inventorySHA256']
    assert all(sha(folder/'source'/p)==h for p,h in inventory['files'].items())
    input_checks.append({'root':str(folder),'sourceHash':inventory['sourceHash'],'filesVerified':len(inventory['files'])})
for item in assembly['dependencyLinks']:
    link=r/item['path'];assert link.is_symlink() and os.readlink(link)==item['target'] and str(link.resolve())==item['resolved']
new=['apps/server/src/services/selected-artifact-publication.test.ts','packages/db/src/artifact-publication-evidence.ts']
files={p:sha(r/p) for p in sorted(set(assembly['files'])|set(new))}
owned=sorted(p for p,h in files.items() if h!=assembly['files'].get(p))
assert owned==sorted(['apps/server/src/services/artifact-publication-service.ts','apps/server/src/services/selected-artifact-publication.test.ts','packages/core/src/artifact-publication.ts','packages/db/src/artifact-publication-evidence.ts','packages/db/src/artifact-publication-identity.ts','packages/db/src/index.ts','packages/db/src/types.ts'])
all_delta=sorted(p for p,h in files.items() if h!=base['files'].get(p))
def patch(paths):
    out=[]
    for p in paths:
        old=(consumer/'source'/p).read_text().splitlines(keepends=True) if p in base['files'] else []
        new=(r/p).read_text().splitlines(keepends=True)
        out.extend(difflib.unified_diff(old,new,fromfile='a/'+p if old else '/dev/null',tofile='b/'+p))
    return ''.join(out)
for name,paths in [('component.patch',all_delta),('selected-publication.patch',owned),('production.patch',[p for p in all_delta if not p.endswith('.test.ts')])]:
    (b/name).write_text(patch(paths))
    result=subprocess.run(['git','apply','--check',str(b/name)],cwd=consumer/'source',text=True,capture_output=True)
    (b/(name+'.check.log')).write_text(result.stdout+result.stderr)
    assert result.returncode==0,(name,result.stderr)
for p in owned:
    if p in assembly['files']:assert assembly['files'][p]==base['files'][p],p
sourcehash=hashlib.sha256(json.dumps(files,separators=(',',':')).encode()).hexdigest()
record={'at':datetime.now(timezone.utc).isoformat(),'sourceHash':sourcehash,'sourceFiles':len(files),'assemblyBaselineSourceHash':assembly['sourceHash'],'consumerBaseSourceHash':base['sourceHash'],'integrationOwnedFiles':owned,'changedFromConsumerV2':all_delta,'files':files,'inputsVerified':input_checks,'rootC5FilesUnchanged':len(rootbase['files']),'dependencyLinksVerified':assembly['dependencyLinks'],'selectedOnlyPatchOldBytesEqualAssemblyBaseline':True,'validationFilesOutsideInheritedSourceInventory':[{'path':p,'sha256':sha(r/p)} for p in ['biome.jsonc','.gitignore','tsconfig.selected-publication.json']]}
write(b/'source-inventory.json',record)
gates=[read(b/f'{name}.json') for name in ['final-regressions','final-typecheck','final-lint']]
assert all(g['exitCode']==0 and sha(b/g['log'])==g['sha256'] for g in gates)
log=(b/'final-regressions.log').read_text()
assert len(re.findall(r'^\(pass\)',log,re.M))==92
assert '\n 92 pass\n 0 fail\n 594 expect() calls\nRan 92 tests across 4 files.' in log
evidence=[p for p in sorted(b.iterdir()) if p.is_file() and p.name not in ['readiness-before-review.json','evidence-manifest.json']]
private_literal=Path('/private/tmp/atlas-harness-private/opencode-key').read_bytes().strip()
assert private_literal and all(private_literal not in p.read_bytes() for p in evidence)
assert all(private_literal not in (r/p).read_bytes() for p in files)
manifest={'at':datetime.now(timezone.utc).isoformat(),'sourceHash':sourcehash,'files':[{'path':p.name,'sha256':sha(p),'sizeBytes':p.stat().st_size} for p in evidence],'credentialLiteralScan':'No provided literal in copied source or generated evidence; literal was not printed or copied.','earlierFailuresPreserved':True}
write(b/'evidence-manifest.json',manifest)
readiness={'at':datetime.now(timezone.utc).isoformat(),'status':'assembled and selected-evidence owner gates complete; awaiting independent review; unwired','sourceHash':sourcehash,'sourceFiles':len(files),'assemblyBaselineSourceHash':assembly['sourceHash'],'consumerBaseSourceHash':base['sourceHash'],'integrationOwnedFiles':owned,'changedFromConsumerV2':all_delta,'patches':{name:sha(b/name) for name in ['component.patch','selected-publication.patch','production.patch']},'sourceInventorySha256':sha(b/'source-inventory.json'),'evidenceManifestSha256':sha(b/'evidence-manifest.json'),'designBeforeEditsSha256':sha(b/'design-before-edits.md'),'implementationNotesSha256':sha(b/'implementation-notes.md'),'ownerGates':{'tests':92,'assertions':594,'files':4,'newIntegrationTests':27,'scopedTypecheckExitCode':0,'lintExitCode':0,'lintFiles':7,'patchCheckExitCodes':[0,0,0],'gates':gates},'allInputsVerified':input_checks,'rootC5FilesUnchanged':len(rootbase['files']),'dependencyLinksVerified':len(assembly['dependencyLinks']),'originalCaptureFilesUnchanged':3,'generatedFingerprintRepresentationUnchanged':True,'publicSelectedEvidenceClass':'selected_workspace_capture','privateCaptureEvidenceExposedInPublicRecords':False,'productionActivationReady':False,'providerCalls':0,'paidCalls':0,'inputSourceEdits':0,'rootSourceEdits':0,'independentReview':None,'limitations':['Configured profile root only; no arbitrary ToolContext/cwd/root selector.','Selected capture does not prove authorship or atomic filesystem snapshot.','Detailed capture metadata is private but not a hostile-host attestation.','Persistence retry never recaptures; a new explicit selection under same identity can conflict after metadata change.','Full actual runtime admission, per-turn invoker/effect principal, lease ownership and consumer cutover remain separate.','No Linux run, full suite, production activation or Hermes parity/live-gain claim.']}
write(b/'readiness-before-review.json',readiness)
assert private_literal not in (b/'readiness-before-review.json').read_bytes()
print(json.dumps({k:v for k,v in readiness.items() if k in ['sourceHash','sourceFiles','patches','sourceInventorySha256','ownerGates','rootC5FilesUnchanged','dependencyLinksVerified']},indent=2))
print('readinessSHA256 '+sha(b/'readiness-before-review.json'))
