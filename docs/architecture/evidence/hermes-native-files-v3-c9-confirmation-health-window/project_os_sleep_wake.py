from pathlib import Path
import subprocess,json,hashlib,re,datetime
r=Path('/private/tmp/atlas-native-file-v3-c9-confirmation-health-window')
command=['/usr/bin/log','show','--start','2026-09-07 08:20:00+0000','--end','2026-09-07 09:20:00+0000','--timezone','UTC','--style','ndjson','--info','--no-debug','--no-backtrace','--no-signpost','--predicate','(process == "powerd" OR process == "kernel") AND (eventMessage CONTAINS[c] "sleep" OR eventMessage CONTAINS[c] "wake")']
start=datetime.datetime.now(datetime.timezone.utc).isoformat();completed=subprocess.run(command,capture_output=True,timeout=45)
raw=completed.stdout
if len(raw)>32*1024*1024:raise RuntimeError('Bounded log capture exceeded; no raw log output emitted')
patterns=[('sleep_entry',re.compile(r'Entering Sleep state',re.I)),('system_sleep',re.compile(r'\bSystem Sleep\b',re.I)),('system_wake',re.compile(r'\bSystem Wake\b',re.I)),('wake_from_sleep',re.compile(r'\bWake from (?:Normal|Deep|Standby|Sleep)',re.I)),('darkwake_mention',re.compile(r'\bDarkWake\b',re.I)),('sleep_wake_uuid_mention',re.compile(r'Sleep/Wake UUID',re.I))]
rows=[];discarded=0
for line in raw.splitlines():
 try:x=json.loads(line)
 except json.JSONDecodeError:discarded+=1;continue
 if not isinstance(x,dict):continue
 message=x.get('eventMessage','');timestamp=x.get('timestamp')
 if not isinstance(message,str) or not isinstance(timestamp,str):continue
 category=next((label for label,pattern in patterns if pattern.search(message)),'unclassified_sleep_wake_mention')
 rows.append({'timestamp':timestamp,'category':category})
result={'queryStarted':start,'windowUTC':['2026-09-07T08:20:00Z','2026-09-07T09:20:00Z'],'command':command,'returnCode':completed.returncode,'capturedBytes':len(raw),'capturedSha256':hashlib.sha256(raw).hexdigest(),'stderrBytes':len(completed.stderr),'stderrSha256':hashlib.sha256(completed.stderr).hexdigest(),'nonJsonLines':discarded,'records':rows,'privacy':'Only timestamps and fixed category labels are emitted. Original selected event messages and process/app/device/reason strings are not retained. Raw capture is hash-bound only.','interpretation':'Mentions, including DarkWake or UUID mentions, are not by themselves certified sleep/wake transitions. No absence or system-health conclusion follows from an empty/failed query.'}
(r/'os-sleep-wake-projection.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'returnCode':completed.returncode,'capturedBytes':len(raw),'records':len(rows),'categories':{label:sum(x['category']==label for x in rows) for label in sorted({x['category'] for x in rows})},'classifiedTransitionRows':[x for x in rows if x['category'] in ['sleep_entry','system_sleep','system_wake','wake_from_sleep']]},indent=2))
