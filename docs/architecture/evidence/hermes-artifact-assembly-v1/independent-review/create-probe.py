from pathlib import Path
import json
b=Path('/private/tmp/atlas-artifact-assembly-c5/source');o=Path('/private/tmp/atlas-artifact-assembly-c5-independent-review')
s=(b/'apps/server/src/services/selected-artifact-publication.test.ts').read_text().split('for (const kind of ["memory", "sqlite"] as const) {')[0]
s=s.replace('"../../../../packages/db/src/artifact-publication-identity"',json.dumps(str(b/'packages/db/src/artifact-publication-identity.ts')))
for name in ['artifact-publication-service','artifact-publication-store','selected-artifact-capture']:
 s=s.replace('"./'+name+'"',json.dumps(str(b/'apps/server/src/services'/f'{name}.ts')))
(o/'probe.test.ts').write_text(s)
config=json.loads((b/'tsconfig.json').read_text());config['compilerOptions']['paths']={k:[str(b/p) for p in v] for k,v in config['compilerOptions']['paths'].items()}
(o/'tsconfig.json').write_text(json.dumps(config,indent=2)+'\n')
(o/'node_modules').symlink_to(b/'node_modules')
