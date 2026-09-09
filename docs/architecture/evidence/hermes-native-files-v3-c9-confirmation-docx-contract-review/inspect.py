"""Read closed artifacts and retain public XML projections; never execute an oracle."""
import hashlib
import io
import json
from datetime import datetime, timezone
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).parent
MAP = Path('/private/tmp/atlas-native-file-v3-c9-confirmation-census/seven-docx-reference-map.json')
BATCH = Path('/private/tmp/atlas-hermes-evaluation/native-files-mimo-study-v3-c9/batches/confirmatory-1788766021520-052b6932')
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
bindings = {}


def read(path):
    path = Path(path)
    assert path.is_file() and not path.is_symlink()
    raw = path.read_bytes()
    bindings[str(path)] = {'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
    return raw


def write(name, data):
    path = ROOT / name
    with path.open('x') as stream:
        json.dump(data, stream, indent=2, ensure_ascii=False)
        stream.write('\n')


write('registration.json', {
    'at': datetime.now(timezone.utc).isoformat(),
    'scope': 'All seven closed confirmation DOCX report oracle failures: original assigned public contract, input facts, artifact bytes and top-level paragraph/table XML. No oracle, analyzer, model, test or hidden-reasoning execution; no new score.',
    'priorInspection': 'Before registration root read the original confirmation analysis, full reference map, original ledger keys and native observation refs, and searched frozen fixture/oracle source lines. No native DOCX package body had been read by root in this confirmation inspection. This is post-result diagnosis, not prospective task selection.',
    'confirmationAccess': 'Entire confirmation batch closed and original analyzer completed once before this inspection',
})
analysis = json.loads(read(BATCH / 'analysis-final.json'))
assert bindings[str(BATCH / 'analysis-final.json')]['sha256'] == '180ceb12182c8febc7c13f3290f2140ea787784b2ddab94f8fbbbb4639920064'
mapping = json.loads(read(MAP))
assert bindings[str(MAP)]['sha256'] == 'caf5db793b9dd18b2827890ffcde21ef740cb1a5aa4e462f83f4ad3d79f34f00'
read('/private/tmp/atlas-native-file-v3-c9-integration/source/scripts/harness-native-files-mimo-v3/file-fixtures.py')
read('/private/tmp/atlas-native-file-v3-c9-integration/source/scripts/harness-native-files-mimo-v3/file-oracles.py')
ends = [json.loads(line) for line in read(BATCH / 'attempts.jsonl').splitlines() if line]
ends = {row['id']: row for row in ends if row.get('event') == 'end' and row.get('family') == 'docx_report'}
assert len(ends) == 12 and len(mapping) == 7
assert len({arm['id'] for arm in mapping}) == 7
rows = []
for arm in mapping:
    raw = read(arm['nativeArtifact'])
    assert bindings[arm['nativeArtifact']]['sha256'] == arm['artifactSha256']
    original = ends[arm['id']]
    assert original['success'] is False and original['status'] == 'completed'
    assert original['evaluation']['binding']['actualSha256'] == arm['artifactSha256']
    assigned = json.loads(read(arm['assignedTaskTurns']))
    facts = json.loads(read(arm['publicInput']))
    grade = json.loads(read(arm['originalOracle']))
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        info = archive.getinfo('word/document.xml')
        assert info.file_size < 1_000_000
        xml = archive.read(info)
    document = ET.fromstring(xml)
    body = document.find('w:body', NS)
    assert body is not None
    paragraphs = [''.join(t.text or '' for t in p.findall('.//w:t', NS)) for p in body.findall('w:p', NS)]
    tables = [
        [[''.join(t.text or '' for t in cell.findall('.//w:t', NS)) for cell in row.findall('w:tc', NS)] for row in table.findall('w:tr', NS)]
        for table in body.findall('w:tbl', NS)
    ]
    rows.append({
        'id': arm['id'],
        'artifactPath': arm['nativeArtifact'],
        'artifactSha256': arm['artifactSha256'],
        'documentXmlSha256': hashlib.sha256(xml).hexdigest(),
        'assignedPublicTaskTurns': assigned['taskTurns'],
        'suppliedPublicFacts': facts,
        'topLevelParagraphTexts': paragraphs,
        'topLevelTables': tables,
        'originalOracle': grade,
        'originalPrimarySuccess': original['success'],
        'scope': 'Read-only public package projection; original score retained, no alternative pass predicate.'
    })
write('public-package-projections.json', rows)
for path, binding in bindings.items():
    assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == binding['sha256']
write('source-bindings.json', bindings)
write('inspection-closure.json', {
    'at': datetime.now(timezone.utc).isoformat(),
    'allSevenArtifactsMatchOriginalRecordedBinding': True,
    'sourceBindingsUnchangedAfterInspection': True,
    'originalAnalyzerRerun': False,
    'oracleExecuted': False,
    'alternativeScoresProduced': False,
    'manifest': {path.name: {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size} for path in sorted(ROOT.iterdir()) if path.is_file()}
})
print(json.dumps({'output': str(ROOT), 'artifacts': len(rows), 'sourceBindings': len(bindings), 'originalScoresRetained': True}))
