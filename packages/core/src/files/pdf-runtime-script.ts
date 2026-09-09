// Bundled with the server: no filesystem sidecar or host tool configuration is loaded.
export const PDF_RUNTIME_SCRIPT = String.raw`
import csv
import io
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import unicodedata

# Bound parser/font expansion and every descendant (Poppler/Tesseract inherit limits).
if sys.platform == 'linux':
    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024**2, 768 * 1024**2))
else:
    # Darwin rejects RLIMIT_AS. Bound resident memory via a worker watchdog;
    # deadline, CPU and file limits apply on both platforms.
    import threading
    import time
    def watch_memory():
        while True:
            used = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            if used > 768 * 1024**2:
                os._exit(70)
            time.sleep(0.05)
    threading.Thread(target=watch_memory, daemon=True).start()
resource.setrlimit(resource.RLIMIT_CPU, (50, 50))
resource.setrlimit(resource.RLIMIT_FSIZE, (50 * 1024**2, 50 * 1024**2))
config = json.load(sys.stdin)

def merge():
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import ArrayObject, NameObject
    readers = [PdfReader(f'input-{i}', strict=True) for i in range(config['count'])]
    writer = PdfWriter()
    names = set()
    expected_attachments = []
    expected_navigation = []
    expected_annotations = []
    expected_outlines = []
    total_bytes = 0
    def navigation(reader, page):
        result = []
        for ref in page.get('/Annots', []):
            item = ref.get_object()
            destination = item.get('/Dest')
            action = item.get('/A')
            if action is not None:
                action = action.get_object()
            if action and action.get('/S') == '/GoTo':
                destination = action.get('/D')
            if destination is None:
                continue
            destination = destination.get_object() if hasattr(destination, 'get_object') else destination
            if isinstance(destination, str):
                resolved = reader.named_destinations.get(destination) or reader.named_destinations.get(destination.lstrip('/'))
                if resolved is None:
                    raise ValueError('PDF navigation contains an unresolved named destination.')
                target = reader.get_destination_page_number(resolved)
            elif isinstance(destination, list) and destination:
                target = reader.get_page_number(destination[0].get_object())
            else:
                raise ValueError('PDF navigation destination is unsupported.')
            if target is None or target < 0:
                raise ValueError('PDF navigation points outside its page tree.')
            result.append(target)
        return result
    def outline_targets(reader, entries):
        result = []
        for entry in entries:
            if isinstance(entry, list):
                result.extend(outline_targets(reader, entry))
            else:
                target = reader.get_destination_page_number(entry)
                if target is None or target < 0:
                    raise ValueError('PDF outline points outside its page tree.')
                result.append((entry.title, target))
        return result
    for source in readers:
        if '/AcroForm' in source.root_object:
            raise ValueError('Merging forms or signatures requires a flattened unsigned copy.')
        source_names = source.root_object.get('/Names', {})
        if hasattr(source_names, 'get_object'):
            source_names = source_names.get_object()
        if any(key not in ('/Dests', '/EmbeddedFiles') for key in source_names):
            raise ValueError('This PDF has unsupported document-level name trees.')
        duplicate = names.intersection(source.named_destinations)
        if duplicate:
            raise ValueError('Named destinations collide across sources; rename those destinations before merging.')
        names.update(source.named_destinations)
        offset = len(writer.pages)
        expected_navigation.extend([[target + offset for target in navigation(source, page)] for page in source.pages])
        expected_annotations.extend(len(page.get('/Annots', [])) for page in source.pages)
        expected_outlines.extend((title, target + offset) for title, target in outline_targets(source, source.outline))
        writer.append(source, import_outline=True)
        for attachment in source.attachment_list:
            value = attachment.content
            total_bytes += len(value)
            if total_bytes > 25 * 1024**2:
                raise ValueError('Expanded PDF attachments exceed 25 MiB.')
            added = writer.add_attachment(attachment.name, value)
            # Clone the full Filespec, preserving MIME, description, dates and AF relationship.
            cloned = attachment.pdf_object.clone(writer)
            added.pdf_object.clear()
            added.pdf_object.update(cloned)
            expected_attachments.append((attachment.name, value))
        if '/AF' in source.root_object:
            associated = writer.root_object.setdefault(NameObject('/AF'), ArrayObject())
            for ref in source.root_object['/AF']:
                associated.append(ref.clone(writer))
        if len(writer.pages) > 500:
            raise ValueError('Merged PDF exceeds 500 pages.')
    first = readers[0]
    if first.metadata:
        writer.add_metadata({key: str(value) for key, value in first.metadata.items() if value is not None})
    for key in ('/PageMode', '/PageLayout', '/ViewerPreferences', '/OpenAction'):
        if key in first.root_object:
            writer.root_object[NameObject(key)] = first.root_object.raw_get(key).clone(writer)
    writer.write('output.pdf')
    check = PdfReader('output.pdf', strict=True)
    attachments = list(check.attachment_list)
    if sorted((a.name, a.content) for a in attachments) != sorted(expected_attachments):
        raise ValueError('Merged PDF did not retain every attachment.')
    if [navigation(check, page) for page in check.pages] != expected_navigation:
        raise ValueError('Merged PDF did not retain every internal navigation target.')
    if [len(page.get('/Annots', [])) for page in check.pages] != expected_annotations:
        raise ValueError('Merged PDF did not retain every page annotation.')
    if outline_targets(check, check.outline) != expected_outlines:
        raise ValueError('Merged PDF did not retain every outline target.')
    return {'output': True, 'pageCount': len(check.pages), 'attachmentCount': len(attachments)}

def ocr():
    from PIL import Image
    output = []
    for number in config['pages']:
        subprocess.run([config['rasterizer'], '-f', str(number), '-l', str(number), '-r', '200', '-scale-to', '2400', '-singlefile', '-png', 'input-0', 'scan'], check=True, stdout=subprocess.DEVNULL, timeout=20)
        with Image.open('scan.png') as image:
            if image.width * image.height > 6_000_000:
                raise ValueError('OCR raster exceeds six million pixels.')
        subprocess.run([config['tesseract'], 'scan.png', 'recognized', '-l', config['language'], '--psm', '3', 'tsv'], check=True, stdout=subprocess.DEVNULL, timeout=20)
        rows = csv.DictReader(Path('recognized.tsv').open(encoding='utf8'), delimiter='\t', quoting=csv.QUOTE_NONE)
        lines = []
        words = []
        confidence = []
        previous = None
        for row in rows:
            if row.get('level') != '5' or not row.get('text', '').strip():
                continue
            key = (row['block_num'], row['par_num'], row['line_num'])
            if previous is not None and key != previous:
                lines.append(' '.join(words))
                words = []
            previous = key
            words.append(row['text'])
            confidence.append(float(row['conf']))
        if words:
            lines.append(' '.join(words))
        full = '\n'.join(lines)
        text = full.encode('utf8')[:8000].decode('utf8', errors='ignore')
        output.append({'page': number, 'text': text, 'truncated': text != full, 'needsOcr': not bool(text), 'method': 'ocr', 'ocrLanguage': config['language'], 'ocrConfidence': sum(confidence) / len(confidence) if confidence else 0, 'ocrReviewRequired': not confidence or sum(confidence) / len(confidence) < 70})
        Path('scan.png').unlink()
        Path('recognized.tsv').unlink()
    return {'pages': output}

def create():
    from bidi.algorithm import get_empty_storage, get_embedding_levels, explicit_embed_and_overrides, resolve_weak_types, resolve_neutral_types, resolve_implicit_levels, reorder_resolved_levels, apply_mirroring, get_base_level
    from fontTools import subset
    from fontTools.ttLib import TTFont
    import uharfbuzz as hb
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject, NumberObject, TextStringObject
    text = '\n'.join(config['pages'])
    source = TTFont('input-0', lazy=False)
    if 'glyf' not in source:
        raise ValueError('Complex or large-font PDF creation requires a TrueType-outline TTF/OTF font.')
    cmap = source.getBestCmap()
    for character in text:
        if character not in '\r\n\t' and ord(character) not in cmap:
            raise ValueError(f'The selected font cannot render {character!r}. Supply a font covering every language.')
    options = subset.Options()
    options.layout_features = ['*']
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=text.replace('\t', '    '))
    subsetter.subset(source)
    buffer = io.BytesIO()
    source.save(buffer)
    font_data = buffer.getvalue()
    if len(font_data) > 10 * 1024**2:
        raise ValueError('Prepared font exceeds 10 MiB; reduce the document character set.')
    hb_font = hb.Font(hb.Face(font_data))
    units = hb_font.face.upem
    writer = PdfWriter()
    writer.add_metadata({'/Creator': 'Atlas', '/Title': config.get('title') or ''})
    cids = {}
    glyphs = []
    mappings = []
    widths = []
    page_commands = []

    def shape(value, direction=None):
        b = hb.Buffer()
        b.cluster_level = hb.BufferClusterLevel.MONOTONE_CHARACTERS
        b.add_str(value)
        b.guess_segment_properties()
        if direction:
            b.direction = direction
        hb.shape(hb_font, b)
        return b.glyph_infos, b.glyph_positions

    def runs(value):
        if not value:
            return []
        storage = get_empty_storage()
        storage['base_level'] = get_base_level(value)
        storage['base_dir'] = 'R' if storage['base_level'] else 'L'
        get_embedding_levels(value, storage)
        for i, character in enumerate(storage['chars']):
            character['index'] = i
        explicit_embed_and_overrides(storage)
        resolve_weak_types(storage)
        resolve_neutral_types(storage, False)
        resolve_implicit_levels(storage, False)
        reorder_resolved_levels(storage, False)
        apply_mirroring(storage, False)
        groups = []
        for character in storage['chars']:
            if not groups or groups[-1][0]['level'] != character['level']:
                groups.append([])
            groups[-1].append(character)
        result = []
        for group in groups:
            logical = ''.join(c['ch'] for c in sorted(group, key=lambda c: c['index']))
            direction = 'rtl' if group[0]['level'] % 2 else 'ltr'
            # Separate neutral prefixes/suffixes: PDF readers otherwise discard them
            # when changing between Arabic and Latin within one text-show operation.
            left, right = 0, len(logical)
            neutral_types = {'WS', 'ON', 'B', 'S', 'BN'}
            while left < right and unicodedata.bidirectional(logical[left]) in neutral_types:
                left += 1
            while right > left and unicodedata.bidirectional(logical[right - 1]) in neutral_types:
                right -= 1
            pieces = [p for p in (logical[:left], logical[left:right], logical[right:]) if p]
            if direction == 'rtl':
                pieces.reverse()
            result.extend((p, direction) for p in pieces)
        return result

    def measure(value):
        return sum(sum(p.x_advance for p in shape(t, d)[1]) * 11 / units for t, d in runs(value))

    def lines(section):
        for paragraph in section.replace('\t', '    ').splitlines() or ['']:
            if not paragraph:
                yield ''
                continue
            remaining = paragraph
            while remaining:
                lo, hi = 1, len(remaining)
                fit = 0
                while lo <= hi:
                    middle = (lo + hi) // 2
                    if measure(remaining[:middle]) <= 495.28:
                        fit = middle
                        lo = middle + 1
                    else:
                        hi = middle - 1
                if not fit:
                    raise ValueError('A glyph is wider than the available PDF line width.')
                if fit < len(remaining):
                    space = remaining.rfind(' ', 0, fit + 1)
                    if space > 0:
                        fit = space + 1
                    # Do not separate combining marks from their base character.
                    while fit > 0 and fit < len(remaining) and unicodedata.combining(remaining[fit]):
                        fit -= 1
                    if not fit:
                        raise ValueError('A combining sequence exceeds the PDF line width.')
                yield remaining[:fit].rstrip()
                remaining = remaining[fit:].lstrip()

    def draw(value, y, commands):
        x = 50
        if get_base_level(value):
            x = 545.28 - measure(value)
        # Mark the logical line for readers that consume accessibility ActualText.
        commands.append('/Span << /ActualText <FEFF' + value.encode('utf-16-be').hex() + '> >> BDC')
        for run, direction in runs(value):
            infos, positions = shape(run, direction)
            clusters = sorted(set([i.cluster for i in infos] + [len(run)]))
            ends = dict(zip(clusters, clusters[1:]))
            commands.append(f'BT /F1 11 Tf 1 0 0 1 {x:.5f} {y:.5f} Tm')
            for info, pos in zip(infos, positions):
                original = run[info.cluster:ends[info.cluster]]
                width = pos.x_advance * 1000 / units
                key = (info.codepoint, original, width)
                if key not in cids:
                    if len(glyphs) >= 65534:
                        raise ValueError('PDF exceeds the 65,534 shaped glyph mapping limit.')
                    cids[key] = len(glyphs) + 1
                    glyphs.append(info.codepoint)
                    mappings.append(original)
                    widths.append(width)
                cid = cids[key]
                offset = pos.x_offset * 1000 / units
                commands.append(f'{pos.y_offset * 11 / units:.5f} Ts [{-offset:.5f} <{cid:04X}> {offset:.5f}] TJ')
                x += pos.x_advance * 11 / units
            commands.append('ET')
        commands.append('EMC')

    for section in config['pages']:
        commands = []
        page_commands.append(commands)
        y = 791.89
        for line in lines(section):
            if y < 50:
                commands = []
                page_commands.append(commands)
                y = 791.89
            if len(page_commands) > 500:
                raise ValueError('Generated PDF exceeds 500 pages.')
            draw(line, y, commands)
            y -= 16

    def dictionary(**values):
        return DictionaryObject({NameObject('/' + k): v for k, v in values.items()})
    def stream(data):
        result = DecodedStreamObject()
        result.set_data(data)
        return writer._add_object(result.flate_encode())
    descriptor = writer._add_object(dictionary(Type=NameObject('/FontDescriptor'), FontName=NameObject('/AtlasSubset'), Flags=NumberObject(4), FontBBox=ArrayObject([NumberObject(v) for v in [-2000, -2000, 4000, 4000]]), ItalicAngle=NumberObject(0), Ascent=NumberObject(1000), Descent=NumberObject(-300), CapHeight=NumberObject(700), StemV=NumberObject(80), FontFile2=stream(font_data)))
    descendant = writer._add_object(dictionary(Type=NameObject('/Font'), Subtype=NameObject('/CIDFontType2'), BaseFont=NameObject('/AtlasSubset'), CIDSystemInfo=dictionary(Registry=TextStringObject('Adobe'), Ordering=TextStringObject('Identity'), Supplement=NumberObject(0)), FontDescriptor=descriptor, CIDToGIDMap=stream(b'\0\0' + b''.join(g.to_bytes(2, 'big') for g in glyphs)), W=ArrayObject([NumberObject(1), ArrayObject([FloatObject(v) for v in widths])]), DW=NumberObject(1000)))
    cm = ['/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /AtlasUnicode def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange']
    for start in range(0, len(mappings), 100):
        group = mappings[start:start+100]
        cm.append(f'{len(group)} beginbfchar')
        cm.extend(f'<{start+i+1:04X}> <{s.encode("utf-16-be").hex()}>' for i, s in enumerate(group))
        cm.append('endbfchar')
    cm.append('endcmap CMapName currentdict /CMap defineresource pop end end')
    font = writer._add_object(dictionary(Type=NameObject('/Font'), Subtype=NameObject('/Type0'), BaseFont=NameObject('/AtlasSubset'), Encoding=NameObject('/Identity-H'), DescendantFonts=ArrayObject([descendant]), ToUnicode=stream('\n'.join(cm).encode())))
    for commands in page_commands:
        page = writer.add_blank_page(595.28, 841.89)
        page[NameObject('/Resources')] = dictionary(Font=dictionary(F1=font))
        page[NameObject('/Contents')] = stream('\n'.join(commands).encode())
    writer.write('output.pdf')
    PdfReader('output.pdf', strict=True)
    return {'output': True, 'pageCount': len(page_commands), 'preparedFontBytes': len(font_data), 'layout': 'Unicode bidi + HarfBuzz'}

print(json.dumps({'merge': merge, 'ocr': ocr, 'create': create}[config['operation']](), ensure_ascii=False))
`;
