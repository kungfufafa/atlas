"""Read-only request census; never opens response bodies, evaluator tasks or secrets."""
import collections
import datetime
import hashlib
import json
import pathlib
import re
import statistics
import tarfile

BATCH = pathlib.Path('/private/tmp/atlas-hermes-evaluation/memory-mimo-study-v1/batches/development-2026-09-06T17-27-51-437Z-645527a9')
ROOT = pathlib.Path('/Users/apriansyahrs/Documents/Code/atlas')
OUT = pathlib.Path('/private/tmp/atlas-prompt-overhead-audit')
C5 = pathlib.Path('/private/tmp/atlas-hermes-evaluation/candidate-v5')

def digest(data):
    return hashlib.sha256(data).hexdigest()

def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()

def read(path):
    return json.loads(path.read_text())

def save(name, data):
    path = OUT / name
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    return {'path': str(path), 'sha256': digest(path.read_bytes())}

def stats(values):
    known = [value for value in values if isinstance(value, (int, float))]
    return {'n': len(values), 'known': len(known), 'unknown': len(values)-len(known), 'sumKnown': sum(known), 'minKnown': min(known) if known else None, 'medianKnown': statistics.median(known) if known else None, 'meanKnown': statistics.mean(known) if known else None, 'maxKnown': max(known) if known else None}

def summarize(rows):
    names = ['promptTokens', 'cachedTokens', 'generatedTokens', 'systemTextBytes', 'messagesJsonBytes', 'toolSchemaJsonBytes', 'responseFormatJsonBytes', 'effectiveBodyJsonBytes', 'activeSkillBytes']
    return {'requests': len(rows), 'arms': len(set(row['arm'] for row in rows)), 'status': dict(collections.Counter(str(row['usageStatus']) for row in rows)), **{name: stats([row[name] for row in rows]) for name in names}}

schedule = read(BATCH/'schedule.json')
completed = read(BATCH/'completed.json')
candidate = read(BATCH/'candidate-source.json')
expected = {}
for pair in schedule['schedule']:
    for harness in ['atlas', 'hermes']:
        expected[f"{schedule['batch']}-{pair['pairId']}-{harness}"] = {**pair, 'harness': harness}
actual = {path.name for path in (BATCH/'trials').iterdir() if path.is_dir()}
assert actual == set(expected), (actual-set(expected), set(expected)-actual)
assert completed['scheduledAttempts'] == len(expected) == 96 and completed['sourceUnchanged']

markers = ['# Identity (SOUL.md)', '# Voice & Style (STYLE.md)', '# Operating Instructions (INSTRUCTIONS.md)', '# Continuity (MEMORY.md)', '# Profile Instructions', '# Available Agent Skills', '# Atlas documentation', '## Work quality (mandatory)', '# Presence', '# Active Skills', '# Active Skill: update-profile-memory', '# Active Skill: archive-profile-memory', '## Active Scoped Memories']
section_rows = collections.defaultdict(list)
paragraphs = {}
within_main = collections.Counter()
same_fields = collections.Counter()
exact_skill_copies = collections.defaultdict(collections.Counter)
skill_source = {}
with tarfile.open(BATCH/'atlas-source.tar.gz') as archive:
    for name in ['update-profile-memory', 'archive-profile-memory']:
        path = f'packages/core/src/skills/bundled/{name}/SKILL.md'
        raw = archive.extractfile(path).read().decode()
        frontmatter, body = raw.split('\n---\n', 1)
        description = next(line.removeprefix('description: ') for line in frontmatter.splitlines() if line.startswith('description: '))
        skill_source[name] = {'body': body.strip(), 'description': description}
rows = []
arms = []
for arm, pair in expected.items():
    trial = BATCH/'trials'/arm
    usage_path = trial/'wire/native-usage-final.json'
    usage = read(usage_path)
    assert usage['finalized'] and usage['inFlightRequests'] == 0
    by_index = {entry['index']: entry for entry in usage['requests']}
    arm_rows = []
    first_main = True
    for path in sorted((trial/'wire').glob('*-request.json')):
        index = int(path.name.split('-')[0])
        envelope = read(path)
        body = envelope['effective']
        messages = body.get('messages', [])
        systems = [message.get('content', '') for message in messages if message['role'] in ['system', 'developer']]
        assert all(isinstance(system, str) for system in systems)
        system = '\n'.join(systems)
        tools = body.get('tools', [])
        starts = system.split('\n')[0]
        if starts.startswith('You write short titles for chat conversations.') or starts.startswith('You name chat sessions.'):
            kind = 'auxiliary-title'
        elif starts.startswith('You embody the identity defined below.') or starts.startswith('You are Hermes Agent, built by Nous Research.'):
            kind = 'main'
        else:
            raise ValueError(f'Unclassified request: {path}')
        no_history = kind == 'main' and [message['role'] for message in messages if message['role'] not in ['system', 'developer']] == ['user']
        observation = by_index.get(index, {})
        row = {'arm': arm, 'pairId': pair['pairId'], 'harness': pair['harness'], 'family': pair['family'], 'condition': pair['condition'], 'stratum': pair['stratum'], 'kind': kind, 'initialMainForArm': kind == 'main' and first_main, 'initialMainConversationShape': no_history, 'index': index, 'at': envelope.get('at'), 'requestPath': str(path), 'requestSha256': digest(path.read_bytes()), 'usagePath': str(usage_path), 'usageIndex': index, 'usageStatus': observation.get('status'), 'usageKind': observation.get('kind'), 'promptTokens': observation.get('promptTokens'), 'generatedTokens': observation.get('generatedTokens'), 'cachedTokens': observation.get('cachedTokens'), 'systemTextBytes': len(system.encode()), 'messagesJsonBytes': len(encoded(messages)), 'toolSchemaJsonBytes': len(encoded(tools)) if tools else 0, 'responseFormatJsonBytes': len(encoded(body['response_format'])) if 'response_format' in body else 0, 'effectiveBodyJsonBytes': len(encoded(body)), 'toolCount': len(tools), 'toolNames': [tool.get('function', {}).get('name') for tool in tools], 'messageRoles': [message['role'] for message in messages], 'systemSha256': digest(system.encode()), 'activeSkillBytes': 0}
        for field in ['messages','tools']:
            same_fields[f'{pair["harness"]}:{field}:same'] += envelope.get('request', {}).get(field) == body.get(field)
            same_fields[f'{pair["harness"]}:{field}:different'] += envelope.get('request', {}).get(field) != body.get(field)
        if kind == 'main':
            first_main = False
            assert len(row['toolNames']) == len(set(row['toolNames']))
            assert len(systems) == 1, 'Unexpected system-message multiplicity requires manual inspection'
            if pair['harness'] == 'atlas':
                for name, skill in skill_source.items():
                    body_copies = system.count(skill['body'])
                    description_copies = system.count(skill['description'])
                    exact_skill_copies[name][f'bodyCopies:{body_copies}'] += 1
                    exact_skill_copies[name][f'descriptionCopies:{description_copies}'] += 1
                    assert body_copies <= 1
            positions = []
            for marker in markers:
                matches = list(re.finditer(r'(?m)^'+re.escape(marker)+r'$', system))
                within_main[f'{pair["harness"]}:{marker}:maxCopies'] = max(within_main[f'{pair["harness"]}:{marker}:maxCopies'], len(matches))
                positions.extend((match.start(), marker) for match in matches)
            positions.sort()
            for offset, (start, marker) in enumerate(positions):
                end = positions[offset+1][0] if offset+1 < len(positions) else len(system)
                part = system[start:end]
                # The final skill's per-turn local clock is not part of the skill body.
                if marker.startswith('# Active Skill:'):
                    part = part.split('\nCurrent local time:')[0]
                    row['activeSkillBytes'] += len(part.encode())
                section_rows[(pair['harness'], marker)].append({'bytes': len(part.encode()), 'sha256': digest(part.encode()), 'requestPath': str(path)})
            counts = collections.Counter(part.strip() for part in system.split('\n\n') if len(part.strip().encode()) >= 80)
            for part, count in counts.items():
                if count < 2:
                    continue
                key = (pair['harness'], digest(part.encode()))
                item = paragraphs.setdefault(key, {'harness': pair['harness'], 'sha256': key[1], 'text': part, 'bytesPerCopy': len(part.encode()), 'maxCopies': 0, 'requests': []})
                item['maxCopies'] = max(item['maxCopies'], count)
                item['requests'].append({'requestPath': str(path), 'copies': count})
        rows.append(row)
        arm_rows.append(row)
    assert set(by_index) == {row['index'] for row in arm_rows}
    arms.append({'arm': arm, 'harness': pair['harness'], 'condition': pair['condition'], 'stratum': pair['stratum'], 'usagePath': str(usage_path), 'usageSha256': digest(usage_path.read_bytes()), 'mandatoryUsageKnown': usage['mandatoryUsageKnown'], 'all': summarize(arm_rows), 'main': summarize([row for row in arm_rows if row['kind']=='main']), 'auxiliary': summarize([row for row in arm_rows if row['kind']!='main'])})

aggregate = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'batch': str(BATCH), 'candidateSourceHash': candidate['candidateSourceHash'], 'completed': completed, 'totalRequests': len(rows), 'countedOnlyEffectiveBody': True, 'byteDefinition': 'UTF-8 compact JSON reconstructed with ensure_ascii=False for messages/tools/body; systemTextBytes is raw concatenated system/developer text. These are component sizes, not token estimates, literal HTTP transfer bytes, or additive disjoint fields.', 'initialMainDefinitions': {'initialMainForArm': 'First request with recognized main-agent system prefix in each scheduled arm.', 'initialMainConversationShape': 'Main request with exactly one user message and no assistant/tool history, excluding system/developer messages. This detects conversation-opening shape, not a causal phase label.'}, 'requestVersusEffective': dict(same_fields), 'harnesses': {}}
for harness in ['atlas','hermes']:
    selected = [row for row in rows if row['harness']==harness]
    aggregate['harnesses'][harness] = {'all': summarize(selected), 'main': summarize([row for row in selected if row['kind']=='main']), 'auxiliary': summarize([row for row in selected if row['kind']!='main']), 'initialMainForArm': summarize([row for row in selected if row['initialMainForArm']]), 'initialMainConversationShape': summarize([row for row in selected if row['initialMainConversationShape']]), 'initialMainForArmByStratum': {stratum: summarize([row for row in selected if row['initialMainForArm'] and row['stratum']==stratum]) for stratum in sorted({row['stratum'] for row in selected})}, 'mainByCondition': {condition: summarize([row for row in selected if row['kind']=='main' and row['condition']==condition]) for condition in sorted({row['condition'] for row in selected})}, 'toolSchemas': [{'names': list(names), 'requests': count} for names,count in collections.Counter(tuple(row['toolNames']) for row in selected if row['kind']=='main').items()], 'armsWithMandatoryUsageUnknown': [arm['arm'] for arm in arms if arm['harness']==harness and not arm['mandatoryUsageKnown']]}
sections = [{'harness': key[0], 'marker': key[1], 'occurrences': len(values), 'bytes': stats([value['bytes'] for value in values]), 'uniqueExactVariants': len(set(value['sha256'] for value in values)), 'example': values[0]} for key,values in section_rows.items()]

source_paths = ['apps/server/src/services/agent-service.ts', 'apps/server/src/services/skills-service.ts', 'packages/agent/src/chat.ts', 'packages/agent/src/chat-prompt.ts', 'packages/agent/src/session-title.ts', 'packages/core/src/skills/compose.ts', 'packages/core/src/skills/bundled/update-profile-memory/SKILL.md', 'packages/core/src/skills/bundled/archive-profile-memory/SKILL.md', 'packages/core/src/soul/compose.ts', 'packages/db/src/constants.ts', 'apps/server/src/tools/conversation-tools.ts', 'apps/server/src/tools/memory-tools.ts']
current = read(C5/'root-after.json')
bindings = []
with tarfile.open(BATCH/'atlas-source.tar.gz') as archive:
    for path in source_paths:
        historic = archive.extractfile(path).read()
        present = (ROOT/path).read_bytes()
        assert digest(historic) == candidate['atlasHashes'][path]
        assert digest(present) == current['files'][path]
        item = {'path': path, 'historicalC3Sha256': digest(historic), 'currentC5Sha256': digest(present), 'entireFileUnchanged': historic==present}
        if path == 'apps/server/src/services/agent-service.ts':
            blocks = [('resolveProfileSystemPrompt', '  private async resolveProfileSystemPrompt(', '\n  getMemoryService()'), ('matchedSkillAppend', '          const skillContext =', '\n        return parts.join("\\n\\n");')]
            item['relevantBlocks'] = []
            for label,start,end in blocks:
                old = historic.decode().split(start,1)[1].split(end,1)[0]
                new = present.decode().split(start,1)[1].split(end,1)[0]
                item['relevantBlocks'].append({'label': label, 'historicalSha256': digest(old.encode()), 'currentSha256': digest(new.encode()), 'unchanged': old==new})
        bindings.append(item)
hermes_bindings = []
with tarfile.open(BATCH/'hermes-source.tar.gz') as archive:
    for path in ['agent/title_generator.py', 'agent/system_prompt.py', 'tools/tool_search.py']:
        old = archive.extractfile(path).read()
        present = (pathlib.Path('/private/tmp/atlas-hermes-evaluation/source')/path).read_bytes()
        assert digest(old) == candidate['hermesHashes'][path]
        hermes_bindings.append({'path': path, 'archivedSha256': digest(old), 'currentCheckoutSha256': digest(present), 'unchanged': old==present})
source = {'historicalC3SourceHash': candidate['candidateSourceHash'], 'currentC5SourceHash': current['candidateSourceHash'], 'atlasFiles': bindings, 'hermesFiles': hermes_bindings, 'inputReferences': [{'path': str(path), 'sha256': digest(path.read_bytes())} for path in [BATCH/'candidate-source.json',BATCH/'completed.json', BATCH/'schedule.json', BATCH/'source-archives.json', BATCH/'atlas-source.tar.gz', BATCH/'hermes-source.tar.gz', C5/'root-after.json', C5/'application.json']]}
refs = [save('aggregate.json', aggregate), save('requests.json', rows), save('arms.json', arms), save('sections.json', {'sectionByteScope': 'Intervals between listed exact markers, including intervening unlabelled text; descriptive partition, not token attribution. Final active-skill local clock excluded.', 'sections': sections, 'markerMaxCopies': dict(within_main), 'exactArchivedSkillCopiesAcrossAll346AtlasMainRequests': {name: dict(counts) for name,counts in exact_skill_copies.items()}, 'duplicateParagraphsAtLeast80Bytes': list(paragraphs.values())}), save('source-bindings.json', source)]
save('reference.json', {'at': aggregate['at'], 'outputs': refs, 'auditScript': {'path':str(OUT/'audit.py'), 'sha256':digest((OUT/'audit.py').read_bytes())}, 'scope': 'All 96 arms, all recorded effective model requests and finalized usage ledgers from completed C3 batch. No response bodies, hidden response reasoning, holdout tasks, live C5 observations or credentials read.'})
print(json.dumps({'arms': len(arms), 'requests': len(rows), 'harnesses': {h: {name: {'n': aggregate['harnesses'][h][name]['requests'], 'prompt':aggregate['harnesses'][h][name]['promptTokens'], 'systemBytes':aggregate['harnesses'][h][name]['systemTextBytes'], 'toolsBytes':aggregate['harnesses'][h][name]['toolSchemaJsonBytes']} for name in ['all','main','auxiliary','initialMainForArm','initialMainConversationShape']} for h in ['atlas','hermes']}, 'outputReference': str(OUT/'reference.json')}, indent=2))
