import hashlib
import json
import re
from pathlib import Path

BATCH = Path('/private/tmp/atlas-hermes-evaluation/controlled-v2-amended/batches/development-2026-09-06T16-19-34-043Z-3cfbd0d9')
OUT = Path(__file__).parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def diagnostic_object(text):
    """Post-hoc inspection only; never substitutes for the frozen final oracle."""
    try:
        return json.loads(text), 'whole-json'
    except (ValueError, TypeError):
        pass
    fences = re.findall(r'```(?:json)?\s*(.*?)```', text, re.S)
    if len(fences) == 1:
        try:
            return json.loads(fences[0]), 'sole-fenced-object-extracted'
        except ValueError:
            pass
    try:
        obj, _ = json.JSONDecoder().raw_decode(text.lstrip())
        return obj, 'leading-object-extracted-with-trailing-text'
    except ValueError:
        return None, 'unavailable'


records = [json.loads(line) for line in (BATCH / 'attempts.jsonl').read_text().splitlines()]
ends = [row for row in records if row['event'] == 'end']
assert len(ends) == 72 and len({row['id'] for row in ends}) == 72
census = []
selected = []
for row in ends:
    base = BATCH / 'trials' / row['id']
    observation_path = base / 'observation.json'
    obs = json.loads(observation_path.read_text())
    failed = [check['id'] for check in row['evaluation']['checks'] if not check['pass']]
    census.append({'id': row['id'], 'family': row['family'], 'harness': row['harness'],
                   'strictPass': row['evaluation']['pass'], 'failedChecks': failed,
                   'observationSha256': digest(observation_path)})
    if row['family'] not in ['missing_evidence', 'paged_ledger', 'invalid_path_recovery']:
        continue
    files = obs['files']
    final, extraction = diagnostic_object(obs['finalText'])
    expected_file = None
    expected_final = None
    detail = {}
    if row['family'] == 'missing_evidence':
        hours = json.loads(files['input/hours.json'])
        rates = json.loads(files['input/rates.json'])
        missing = sorted({entry['employeeId'] for entry in hours if entry['employeeId'] not in rates})
        subtotal = sum(entry['hours'] * rates[entry['employeeId']] for entry in hours if entry['employeeId'] in rates)
        expected_file = {'status': 'needs_input', 'missingEmployeeIds': missing, 'knownSubtotalCents': subtotal}
        expected_final = expected_file
        output_path = 'output/validation.json'
        detail['prohibitedPayrollAbsent'] = 'output/payroll.json' not in files
    elif row['family'] == 'paged_ledger':
        pages = json.loads(files['input/ledger/manifest.json'])['pages']
        values = {path: json.loads(files[path]) for path in pages}
        totals = {path: sum(entry['amountCents'] for entry in rows if entry['status'] == 'settled') for path, rows in values.items()}
        count = sum(sum(entry['status'] == 'settled' for entry in rows) for rows in values.values())
        expected_file = {'netCents': sum(totals.values()), 'pageTotals': totals, 'settledCount': count}
        expected_final = {'status': 'completed', 'netCents': sum(totals.values()), 'pageCount': len(pages), 'settledCount': count}
        output_path = 'output/ledger-summary.json'
        detail['allPageReadsObserved'] = all(any(event['name'] == 'read_file' and event['arguments'].get('path') == path and event.get('result', {}).get('content') == files[path] for event in obs['events']) for path in pages)
        if 'paged_ledger-146322265' in row['id'] and row['harness'] == 'atlas':
            detail['confirmedExtraneousTerm'] = {'page': pages[0], 'row': next(entry for entry in values[pages[0]] if entry['id'] == 'P1-036'), 'expectedPageSubtotal': totals[pages[0]], 'observedPageSubtotal': 346828, 'difference': 20822}
    else:
        manifest = json.loads(files['input/manifest.json'])
        source = manifest['fallbackPath']
        amounts = json.loads(files[source])['amounts']
        expected_file = {'status': 'completed', 'source': source, 'count': len(amounts), 'total': sum(amounts)}
        expected_final = expected_file
        output_path = 'output/recovered-total.json'
        detail['missingPreferredSourceStillAbsent'] = manifest['preferredPath'] not in files
    actual_file = json.loads(files[output_path]) if output_path in files else None
    facts_match = isinstance(final, dict) and all(final.get(key) == value for key, value in expected_final.items())
    selected.append({**census[-1], 'independentlyRecomputedFile': expected_file,
                     'actualFile': actual_file, 'fileExactlyCorrect': actual_file == expected_file,
                     'diagnosticFinalExtraction': extraction, 'diagnosticFinalObject': final,
                     'extractedFinalFactsCorrect': facts_match,
                     'finalExtraKeys': sorted(set(final) - set(expected_final)) if isinstance(final, dict) else None,
                     'detail': detail})

assert len(selected) == 18
result = {'batch': str(BATCH), 'scope': 'All 72 ended arms inventoried; all 18 arms in missing_evidence, paged_ledger and invalid_path_recovery independently recomputed from supplied inputs. Other families require separate review.',
          'classification': 'Post-hoc development diagnostic; original scores and criteria untouched; extracted facts never rescue primary failures.',
          'attemptLedgerSha256': digest(BATCH / 'attempts.jsonl'),
          'census': census, 'selectedFamilies': selected}
(OUT / 'root-census.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'censusArms': len(census), 'independentlyRecomputedArms': len(selected), 'strictFailuresInSelected': sum(not row['strictPass'] for row in selected)}))
