"""Read-only census of the fixed completed-development checkpoint, never scores."""
import collections
import hashlib
import json
import pathlib
import re
import sqlite3

ROOT = pathlib.Path('/private/tmp/atlas-memory-independent-review')
checkpoint = json.loads((ROOT / 'intermediate-process-audit-checkpoint.json').read_text())
batch = pathlib.Path(checkpoint['batchPath'])
schedule = json.loads((batch.parent.parent / 'frozen/development-schedule.json').read_text())
CLAIM = re.compile(r'\b(saved|stored|recorded|updated|removed|deleted|remembered|retained|noted|persisted|committed|archived|erased|remember)\b', re.I)
MUTATIONS = {'memory_write', 'memory_update', 'memory_delete', 'edit_file', 'write_file', 'propose_org_memory', 'update_profile_memory'}


def parse_result(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return value
    return value


def failed(result):
    result = parse_result(result)
    return isinstance(result, dict) and (
        bool(result.get('error')) or result.get('success') is False
        or result.get('ok') is False or result.get('isError') is True
    )


def mutation(event):
    if event.get('name') in MUTATIONS:
        return True
    if event.get('name') == 'memory':
        arguments = parse_result(event.get('arguments', {}))
        if not isinstance(arguments, dict):
            return False
        operations = arguments.get('operations')
        if isinstance(operations, list):
            return any(isinstance(op, dict) and op.get('action') in {'add', 'replace', 'remove'} for op in operations)
        return arguments.get('action') in {'add', 'replace', 'remove'}
    return False


def state_snapshot(snapshot):
    state = snapshot.get('state', {})
    files = state.get('files', {})
    return {
        'label': snapshot.get('label'),
        'nativeStateRoot': snapshot.get('nativeStateRoot'),
        'memories': state.get('memories'),
        'memoryFiles': {k: v for k, v in files.items() if 'memory' in k.lower() or 'user.md' in k.lower()} if isinstance(files, dict) else files,
    }


arms = []
for row in checkpoint['warmRows']:
    trial = batch / 'trials' / row['id']
    inp = json.loads((trial / 'runner-input.json').read_text())
    obs = json.loads((trial / 'observation.json').read_text())
    events = obs.get('nativeEvents', [])
    training_events = [e for e in events if e.get('phase') == 'training']
    completed_events = [e for e in training_events if e.get('result') is not None]
    turns = []
    for session in obs.get('sessions', []):
        if session.get('phase') != 'training':
            continue
        for turn in session.get('turns', []):
            turn_events = [e for e in completed_events if e.get('turnIndex') == turn.get('index')]
            text = turn.get('finalText') or ''
            turns.append({
                'index': turn.get('index'), 'input': turn.get('input'),
                'status': turn.get('status'), 'finalText': text,
                'completedEventCount': len(turn_events),
                'mutationEvents': [e for e in turn_events if mutation(e)],
                'failedToolEvents': [e for e in turn_events if failed(e['result'])],
                'heuristicPersistenceWording': bool(CLAIM.search(text)),
                'heuristicClaimSentences': [s for s in text.splitlines() if CLAIM.search(s)],
                'review': turn.get('review'),
            })
    approval_rows = []
    db_state = None
    if row['harness'] == 'atlas':
        files = list(pathlib.Path(row['nativeStateParent']).rglob('memory-study.sqlite'))
        if len(files) == 1:
            db = sqlite3.connect(f'file:{files[0]}?mode=ro', uri=True)
            db.row_factory = sqlite3.Row
            approval_rows = [dict(v) for v in db.execute('SELECT * FROM action_approvals')]
            db_state = {
                'database': str(files[0]),
                'memories': [dict(v) for v in db.execute('SELECT * FROM memories')],
                'sessions': [dict(v) for v in db.execute('SELECT id,title FROM sessions')],
                'executionRuns': [dict(v) for v in db.execute('SELECT * FROM execution_runs')],
            }
            db.close()
    mutations = [e for e in completed_events if mutation(e)]
    failed_tools = [e for e in completed_events if failed(e['result'])]
    claims_without_mutation = [t['index'] for t in turns if t['heuristicPersistenceWording'] and not any(not failed(e['result']) for e in t['mutationEvents'])]
    native_events_observed = bool(turns) or bool(training_events)
    write_ids = collections.defaultdict(list)
    for event in mutations:
        result = parse_result(event['result'])
        if event['name'] == 'memory_write' and isinstance(result, dict) and result.get('id'):
            write_ids[result['id']].append(event)
    reused_ids = {key: values for key, values in write_ids.items() if len({e['arguments'].get('content') for e in values}) > 1}
    reused_distinct_subjects = {key: values for key, values in reused_ids.items() if len({e['arguments'].get('subject') for e in values if e['arguments'].get('subject')}) > 1}
    wire_summary = []
    for response_path in sorted((trial / 'wire').glob('*-response.json')):
        response = json.loads(response_path.read_text())
        body = response.get('response') or {}
        message = ((body.get('choices') or [{}])[0].get('message') or {})
        wire_summary.append({
            'file': str(response_path), 'at': response.get('at'), 'status': response.get('status'),
            'sha256': hashlib.sha256(response_path.read_bytes()).hexdigest(),
            'requestSha256': hashlib.sha256(response_path.with_name(response_path.name.replace('-response', '-request')).read_bytes()).hexdigest(),
            'elapsedMs': response.get('elapsedMs'), 'toolCalls': message.get('tool_calls'),
            'assistantText': message.get('content'),
        })
    arms.append({
        **{k: row.get(k) for k in ['id', 'pairId', 'family', 'seed', 'harness', 'condition', 'status', 'elapsedMs', 'at', 'candidateSourceHash', 'usage', 'evaluation']},
        'trialPath': str(trial), 'observationStatus': obs.get('status'),
        'trainingInputs': inp['trainingTurns'], 'trainingTurns': turns,
        'sessionBoundaries': [{k: s.get(k) for k in ['id', 'phase', 'initialHistoryCount']} for s in obs.get('sessions', [])],
        'trainingNativeEvents': training_events,
        'reusedWriteIdEvidence': reused_ids,
        'memorySnapshots': [state_snapshot(s) for s in obs.get('snapshots', []) if 'first-' not in str(s.get('label'))],
        'atlasDatabaseState': db_state, 'approvalRecords': approval_rows,
        'wireAssistantRecords': wire_summary,
        'machineFlags': {
            'noStructuredTrainingTurns': not turns,
            'nonCompletedTrainingTurn': any(t['status'] != 'completed' for t in turns) if turns else None,
            'zeroCompletedTrainingMutationEvents': not mutations if native_events_observed else None,
            'failedTrainingToolEvent': bool(failed_tools) if native_events_observed else None,
            'failedTrainingMutationEvent': any(failed(e['result']) for e in mutations) if native_events_observed else None,
            'writeIdReusedWithDifferentContent': bool(reused_ids) if native_events_observed else None,
            'writeIdReusedAcrossExplicitSubjects': bool(reused_distinct_subjects) if native_events_observed else None,
            'pendingApprovalRecord': any(a['status'] == 'pending' for a in approval_rows) if row['harness'] == 'atlas' else None,
            'heuristicPersistenceWordingWithoutSuccessfulSameTurnMutation': bool(claims_without_mutation) if turns else None,
            'heuristicFlaggedTurnIndices': claims_without_mutation,
            'finalPrimaryPassDespiteFailedTrainingToolEvent': bool(row['evaluation']['success'] and failed_tools),
        },
        'evidenceHashes': {name: hashlib.sha256((trial / name).read_bytes()).hexdigest() for name in ['runner-input.json', 'observation.json', 'result.json']},
    })

groups = []
for harness in ['atlas', 'hermes']:
    for condition in ['native-default', 'explicit-memory']:
        rows = [a for a in arms if a['harness'] == harness and a['condition'] == condition]
        groups.append({
            'harness': harness, 'condition': condition, 'endedWarmArms': len(rows),
            'scheduledWarmArms': sum(p['stratum'] == 'warm' and p['condition'] == condition for p in schedule),
            'frozenPrimaryPass': sum(bool(r['evaluation']['success']) for r in rows),
            'frozenStrictSuccess': sum(bool(r['evaluation']['strictSuccess']) for r in rows),
            'frozenFinalFactsCorrect': sum(bool(r['evaluation']['finalFactsCorrect']) for r in rows),
            'frozenFinalContract': sum(bool(r['evaluation']['finalContract']) for r in rows),
            'accountingUncertainArms': sum(bool(r['usage']['accountingUncertain']) for r in rows),
            'machineFlagCounts': {key: sum(bool(r['machineFlags'][key]) for r in rows) for key in arms[0]['machineFlags'] if key != 'heuristicFlaggedTurnIndices'},
            'machineUnknownCounts': {key: sum(r['machineFlags'][key] is None for r in rows) for key in arms[0]['machineFlags'] if key != 'heuristicFlaggedTurnIndices'},
        })
report = {
    'checkpoint': {k: v for k, v in checkpoint.items() if k != 'warmRows'},
    'scope': 'Every event=end warm arm at the fixed checkpoint, regardless of pass, failure, timeout or accounting status. Warm controls only; no cold/identity arms or confirmatory content. No scoring changes.',
    'scheduledWarmArms': sum(p['stratum'] == 'warm' for p in schedule) * 2,
    'scheduledTotalArms': len(schedule) * 2,
    'flagLimitations': [
        'Persistence wording is a recall-sensitive English regex heuristic, not a truth classifier. No mutation is not proof that a save failed: native history persists, prior valid state may suffice, and auxiliary/background events may differ by harness.',
        'Mutation-event counters include observed file writes, not necessarily MEMORY.md writes. Failed-tool detection recognizes structured error/false result fields, not every plain-text or nested failure.',
        'Ledger status and certified success can fail from accounting uncertainty even when native turns completed and the final factual check passed. These dimensions remain separate.',
        'Frozen finalContract already includes finalFactsCorrect plus strict envelope/exact fields. It is not a pure independent JSON-syntax metric; frozen strictSuccess additionally includes completed status and lifecycle boundary validity.',
        'No structured training turns is missing serialized evidence, not zero activity; preserved wire and native DB state are the fallback.',
        'Repeated write IDs with changed content/subjects are mechanical observations, not proof of erroneous overwrite: an intended correction can correctly reuse an ID. Manual intent and surviving-state inspection determine loss.',
        'Approval rows are inspected only for Atlas. Absence of a database approval row is not a cross-harness universal approval-policy claim.',
    ],
    'groups': groups, 'arms': arms,
}
(ROOT / 'intermediate-process-audit-census.json').write_text(json.dumps(report, indent=2) + '\n')
compact = []
for arm in arms:
    if arm['harness'] != 'atlas':
        continue
    compact.append({
        'id': arm['id'], 'family': arm['family'], 'seed': arm['seed'], 'condition': arm['condition'],
        'evaluation': arm['evaluation'], 'flags': arm['machineFlags'],
        'trainingInputs': arm['trainingInputs'],
        'turns': [{k: t[k] for k in ['index', 'status', 'heuristicClaimSentences', 'mutationEvents', 'failedToolEvents']} for t in arm['trainingTurns']],
        'afterMemories': arm['atlasDatabaseState']['memories'] if arm['atlasDatabaseState'] else None,
        'afterProfileMemory': next((s['memoryFiles'].get('MEMORY.md') for s in arm['memorySnapshots'] if s['label'] == 'training:after'), None),
        'approvalRecords': arm['approvalRecords'],
    })
(ROOT / 'intermediate-process-audit-atlas-review-input.json').write_text(json.dumps(compact, indent=2) + '\n')
print(json.dumps({'groups': groups, 'arms': len(arms)}))
