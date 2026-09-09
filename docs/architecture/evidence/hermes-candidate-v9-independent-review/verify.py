from pathlib import Path
import json,hashlib,subprocess,re,datetime,difflib
r=Path(__file__).parent;c=Path('/private/tmp/atlas-candidate9-integration');b=Path('/private/tmp/atlas-candidate8-integration')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
readiness=json.loads((c/'readiness.json').read_text());inventory=json.loads((c/'source-inventory.json').read_text());base=json.loads((b/'source-inventory.json').read_text())['files'];files=inventory['files']
delta=sorted(n for n in set(base)|set(files) if base.get(n)!=files.get(n));assert delta==sorted(readiness['changedFromC8']) and len(delta)==8
combined=dict(base);inputProof=[]
for inp in readiness['inputComponents']:
 d=Path(inp['directory']);assert sha(d/'manifest.json')==inp['manifestSha256'];iv=json.loads((d/'source-inventory.json').read_text());assert iv['sourceHash']==inp['sourceHash'];owned=[n for n in delta if n in iv['files'] and iv['files'][n]!=base.get(n)];assert owned
 for n in owned:assert sha(d/'source'/n)==iv['files'][n]==sha(c/'source'/n)==files[n];combined[n]=iv['files'][n]
 inputProof.append({'directory':str(d),'sourceHash':iv['sourceHash'],'manifestSha256':sha(d/'manifest.json'),'selectedFilesVerified':owned})
assert combined==files
support=['apps/server/src/services/publication-turn-principal.ts','apps/server/src/services/artifact-publication-access.ts','apps/server/src/services/session-persistence.ts','apps/server/src/http/session-actor.ts','packages/agent/src/tool-loop.ts','packages/core/src/tools/execution.ts']
for n in support:assert sha(c/'source'/n)==base[n]
patchChecks=[]
for n,info in readiness['patches'].items():
 assert sha(c/n)==info['sha256'];patch=(c/n).read_text();wanted=sorted(re.findall(r'^\+\+\+ b/(.+)$',patch,re.M));assert len(wanted)==info['paths'];regen=''
 for path in wanted:
  old=(b/'source'/path).read_text().splitlines(keepends=True) if (b/'source'/path).exists() else []
  new=(c/'source'/path).read_text().splitlines(keepends=True)
  regen+=''.join(difflib.unified_diff(old,new,fromfile='a/'+path if old else '/dev/null',tofile='b/'+path))
 assert regen==patch
 cmd=['git','apply','--check',str(c/n)];p=subprocess.run(cmd,cwd=b/'source',capture_output=True,timeout=30);(r/(n+'.check.log')).write_bytes(p.stdout+p.stderr);assert p.returncode==0
 patchChecks.append({'patch':n,'sha256':info['sha256'],'paths':wanted,'independentReadOnlyApplyCheck':p.returncode})
results=json.loads((c/'grouped-test-results.json').read_text());passTotal=assertTotal=0;testFiles=[]
for entry in results:
 log=c/(entry['name']+'.log');assert sha(log)==entry['logSha256'];data=log.read_text();passes=int(re.findall(r'^\s*(\d+) pass$',data,re.M)[-1]);failures=int(re.findall(r'^\s*(\d+) fail$',data,re.M)[-1]);assertions=int(re.findall(r'^\s*(\d+) expect\(\) calls$',data,re.M)[-1]);assert passes==entry['tests'] and failures==0 and assertions==entry['assertions'] and entry['exitCode']==0 and not entry['deadlineExpired'];assert len(re.findall(r'^\(pass\)',data,re.M))==passes
 passTotal+=passes;assertTotal+=assertions;testFiles +=[a for a in entry['command'] if a.endswith('.test.ts')]
assert(passTotal,assertTotal,len(testFiles),len(set(testFiles)))==(183,867,11,11)
gates=json.loads((c/'validation-gates.json').read_text())
for gate in gates:assert gate['exitCode']==0 and sha(c/(gate['name']+'.log'))==gate['logSha256']
links=inventory['reboundAtlasLinks']
for link in links:assert (c/'source'/link['path']).is_symlink() and str((c/'source'/link['path']).resolve())==link['target']
app=Path('/private/tmp/atlas-candidate9-application');application=json.loads((app/'application.json').read_text());post=json.loads((app/'post-adoption-validation.json').read_text());assert application['sourceAfter']==post['sourceHash']==inventory['sourceHash'];assert sha(app/'production-typecheck.log')==post['productionTypecheck']['logSha256'] and post['productionTypecheck']['exitCode']==0
root=Path('/Users/apriansyahrs/Documents/Code/atlas');assert all(sha(root/n)==files[n] for n in delta)
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHash':inventory['sourceHash'],'canonicalFiles':len(files),'scope':'Map composition plus actual eight delta files and six cited inherited support files; no full C8 recursive file rehash','exactDisjointComposition':True,'inputs':inputProof,'delta':{n:files[n] for n in delta},'supportFiles':{n:base[n] for n in support},'patches':patchChecks,'ownerTests':{'tests':passTotal,'assertions':assertTotal,'uniqueFiles':len(set(testFiles)),'allRawLogsMatch':True,'newIndependentTests':0},'ownerStaticGates':gates,'atlasLinks':len(links),'rootEightDeltaFilesMatch':True,'rootApplicationReferences':{p.name:sha(p) for p in [app/'application.json',app/'post-adoption-validation.json',app/'canonical-root-source.json']}}
(r/'binding-check.json').write_text(json.dumps(result,indent=2)+'\n')
print('Exact disjoint eight-file assembly; four production paths; both patches independently match and apply-check; owner 183/867 across11 verified, no rerun; root8 match')
