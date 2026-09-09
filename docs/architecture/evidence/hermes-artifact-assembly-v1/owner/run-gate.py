from pathlib import Path
from datetime import datetime, timezone
import subprocess,sys,json,hashlib
b=Path('/private/tmp/atlas-artifact-assembly-c5')
name=sys.argv[1];command=sys.argv[2:]
started=datetime.now(timezone.utc).isoformat()
with (b/f'{name}.log').open('w') as output:
    result=subprocess.run(command,cwd=b/'source',stdout=output,stderr=subprocess.STDOUT)
record={'name':name,'command':command,'startedAt':started,'endedAt':datetime.now(timezone.utc).isoformat(),'exitCode':result.returncode,'log':f'{name}.log','sha256':hashlib.sha256((b/f'{name}.log').read_bytes()).hexdigest()}
(b/f'{name}.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record))
raise SystemExit(result.returncode)
