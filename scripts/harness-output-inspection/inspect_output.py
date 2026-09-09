"""Immutable, generic artifact inspection; never semantic grading or repair."""
import argparse,base64,contextlib,hashlib,io,json,os,re,signal,stat,subprocess,sys,time,zipfile
from pathlib import Path
from lxml import etree as ET
from pypdf import PdfReader
from pypdf.generic import ContentStream,IndirectObject,StreamObject

CAP=20*1024*1024; EXPANDED=128*1024*1024; XML=16*1024*1024
ENTRIES=4096; TEXT=2_000_000; OBJECTS=100_000; PAGES=32
BIN=os.environ.get('ATLAS_INSPECTION_BIN',str(Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override'))
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'

class LimitReached(Exception): pass
class InvalidContainer(Exception): pass

def digest(data):return hashlib.sha256(data).hexdigest()
def reference(path):
    hashed=hashlib.sha256();count=0
    with path.open('rb') as f:
        while True:
            block=f.read(1024*1024)
            if not block:break
            hashed.update(block);count+=len(block)
    return {'path':str(path),'sha256':hashed.hexdigest(),'bytes':count}
def write_json(path,value):path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def capture(binding,destination):
    fd=os.open(binding['path'],os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):raise OSError('bound path is not a regular file')
        if info.st_size>CAP:raise LimitReached('capture size '+str(info.st_size)+' exceeds '+str(CAP))
        chunks=[];count=0
        while True:
            chunk=os.read(fd,1024*1024)
            if not chunk:break
            count+=len(chunk)
            if count>CAP:raise LimitReached('capture grew beyond byte limit')
            chunks.append(chunk)
        raw=b''.join(chunks)
    finally:os.close(fd)
    if len(raw)!=binding['bytes'] or digest(raw)!=binding['sha256']:raise OSError('captured byte commitment mismatch')
    with destination.open('xb') as f:f.write(raw)
    destination.chmod(0o444)
    return raw

class Inventory:
    def __init__(self,root):self.root=root;self.objects=[];self.text=0;self.expanded=0;self.gaps=[];self.parts=[]
    def add(self,kind,anchor,**fields):
        if len(self.objects)>=OBJECTS:raise LimitReached('object/operator limit exceeded')
        text=fields.get('text','')
        if self.text+len(text)>TEXT:raise LimitReached('extracted text character limit exceeded')
        self.text+=len(text)
        obj={'id':'object-'+str(len(self.objects)+1).zfill(6),'kind':kind,'anchor':anchor,**fields};self.objects.append(obj);return obj['id']
    def retain(self,data,label):
        self.expanded+=len(data)
        if self.expanded>EXPANDED:raise LimitReached('expanded inventory byte limit exceeded')
        path=self.root/'extracted'/('part-'+str(len(self.parts)+1).zfill(5)+'.bin');path.parent.mkdir(exist_ok=True)
        path.write_bytes(data);item={'label':label,'reference':reference(path)};self.parts.append(item);return item['reference']

def inspect_docx(raw,inv):
    try:z=zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as error:raise InvalidContainer('invalid ZIP container: '+str(error))
    names=z.namelist()
    if '[Content_Types].xml' not in names or 'word/document.xml' not in names:raise InvalidContainer('required DOCX package members absent')
    if len(names)!=len(set(names)):raise InvalidContainer('duplicate package member names')
    if len(names)>ENTRIES:raise LimitReached('ZIP entry count exceeds '+str(ENTRIES))
    if sum(x.file_size for x in z.infolist())>EXPANDED:raise LimitReached('declared expanded ZIP size exceeds limit')
    parser=ET.XMLParser(resolve_entities=False,no_network=True,load_dtd=False)
    text_tags={'t','delText','instrText'};struct_tags={'p','tbl','tr','tc','numPr','drawing','pict','shape','txbxContent','object','OLEObject','altChunk','hyperlink','footnote','endnote','comment','br','tab','sdt','sectPr'}
    for info in z.infolist():
        with z.open(info) as f:data=f.read(EXPANDED-inv.expanded+1)
        partref=inv.retain(data,info.filename)
        inv.add('package_member',{'part':info.filename},reference=partref,declaredBytes=info.file_size)
        if info.filename.endswith(('.xml','.rels')):
            if len(data)>XML:raise LimitReached('XML part exceeds byte limit: '+info.filename)
            try:tree=ET.fromstring(data,parser=parser)
            except ET.XMLSyntaxError as error:
                inv.gaps.append({'kind':'xml_parse_unavailable','part':info.filename,'errorType':type(error).__name__,'detail':str(error)});continue
            for node in tree.iter():
                if not isinstance(node.tag,str):continue
                local=ET.QName(node).localname;anchor={'part':info.filename,'xpath':node.getroottree().getpath(node)}
                if local in text_tags and info.filename.startswith('word/'):
                    inv.add('text',anchor,text=node.text or '',nativeTag=node.tag,visibility='unresolved: may be hidden or non-rendered; inspect full-page images')
                elif local in struct_tags and info.filename.startswith('word/'):
                    inv.add('structure',anchor,nativeTag=node.tag,attributes=dict(node.attrib),childTags=[ET.QName(c).localname for c in node if isinstance(c.tag,str)])
                    if local in ['OLEObject','altChunk','object']:inv.gaps.append({'kind':'unsupported_embedded_content','anchor':anchor,'detail':'Original bytes retained; no complete semantic/text extraction claim for embedded content.'})
                if local=='Relationship':
                    inv.add('relationship',anchor,attributes=dict(node.attrib))
                    if node.attrib.get('TargetMode')=='External' and not node.attrib.get('Type','').endswith('/hyperlink'):inv.gaps.append({'kind':'external_content_not_fetched','anchor':anchor})
                if local in ['vanish','webHidden']:inv.add('visibility_marker',anchor,nativeTag=node.tag,attributes=dict(node.attrib))
        elif '/media/' in info.filename:
            inv.add('image_or_media',{'part':info.filename},reference=partref,visualCoverage='requires inspection of every full-page render')
        elif info.filename.startswith('word/embeddings/'):
            inv.gaps.append({'kind':'unsupported_embedded_part','part':info.filename,'reference':partref})
    return {'packageMembers':len(names),'objectCount':len(inv.objects),'textCharacters':inv.text,'expandedBytes':inv.expanded}

def pdf_value(value,depth=0):
    if isinstance(value,IndirectObject):return {'indirectObject':value.idnum,'generation':value.generation}
    if isinstance(value,bytes):return {'bytes':len(value),'sha256':digest(value),'base64':base64.b64encode(value).decode()}
    if isinstance(value,(str,int,float,bool)) or value is None:return value
    if isinstance(value,(list,tuple)):return [pdf_value(x,depth+1) for x in value]
    if isinstance(value,dict):return {str(k):pdf_value(v,depth+1) for k,v in value.items() if k not in ['/Length','/Filter']}
    return str(value)

def inspect_pdf(raw,inv):
    if b'%PDF-' not in raw[:1024]:raise InvalidContainer('PDF header absent from first 1024 bytes')
    reader=PdfReader(io.BytesIO(raw),strict=False)
    if reader.is_encrypted:raise LimitReached('encrypted PDF cannot be inspected without an authorized password')
    count=len(reader.pages)
    if count>PAGES:raise LimitReached('observed PDF pages '+str(count)+' exceeds '+str(PAGES))
    visited=set()
    def resources(res,page,prefix):
        if res is None:return
        res=res.get_object();xobjects=res.get('/XObject',{}).get_object() if res.get('/XObject') is not None else {}
        for name,ref in xobjects.items():
            key=(ref.idnum,ref.generation) if isinstance(ref,IndirectObject) else id(ref)
            anchor={'page':page,'resource':prefix+'/'+str(name)};obj=ref.get_object()
            inv.add('pdf_resource_reference',anchor,subtype=str(obj.get('/Subtype')),objectReference=pdf_value(ref))
            if key in visited:continue
            visited.add(key)
            if isinstance(obj,StreamObject):
                try:data=obj.get_data();stream=inv.retain(data,str(anchor))
                except Exception as error:
                    if isinstance(error,LimitReached):raise
                    inv.gaps.append({'kind':'resource_decode_unavailable','anchor':anchor,'errorType':type(error).__name__,'detail':str(error)});continue
                inv.add('pdf_image' if obj.get('/Subtype')=='/Image' else 'pdf_form_or_stream',anchor,reference=stream,properties=pdf_value({k:v for k,v in obj.items() if k!='/Resources'}),visibility='full-page render required')
                if obj.get('/Subtype')=='/Form':resources(obj.get('/Resources'),page,prefix+'/'+str(name))
    for number,page in enumerate(reader.pages,1):
        inv.add('pdf_page',{'page':number},mediaBox=[float(x) for x in page.mediabox],cropBox=[float(x) for x in page.cropbox],rotation=page.rotation)
        try:text=page.extract_text() or '';inv.add('page_text',{'page':number},text=text,coverage='text extraction does not include all visual text or image content')
        except Exception as error:
            if isinstance(error,LimitReached):raise
            inv.gaps.append({'kind':'page_text_unavailable','page':number,'errorType':type(error).__name__,'detail':str(error)})
        try:
            stream=page.get_contents()
            if stream is not None:
                rawstream=stream.get_data();ref=inv.retain(rawstream,'page '+str(number)+' content');inv.add('page_content_stream',{'page':number},reference=ref)
                operations=ContentStream(stream,reader).operations
                for oi,(operands,operator) in enumerate(operations,1):inv.add('pdf_operator',{'page':number,'operatorIndex':oi},operator=operator.decode('latin1'),operands=pdf_value(operands))
            resources(page.get('/Resources'),number,'/Resources')
            annotations=page.get('/Annots',[])
            if hasattr(annotations,'get_object'):annotations=annotations.get_object()
            for ai,annotation in enumerate(annotations,1):inv.add('pdf_annotation',{'page':number,'annotationIndex':ai},properties=pdf_value(annotation.get_object()))
        except Exception as error:
            if isinstance(error,LimitReached):raise
            inv.gaps.append({'kind':'page_structure_unavailable','page':number,'errorType':type(error).__name__,'detail':str(error)})
    root=reader.trailer['/Root'];forms=root.get('/AcroForm')
    if forms is not None:inv.add('pdf_form_catalog',{'catalog':'/AcroForm'},properties=pdf_value(forms.get_object()))
    return {'observedPages':count,'objectCount':len(inv.objects),'textCharacters':inv.text,'expandedBytes':inv.expanded}

def runtime_tree(root):
    """Bind the actual bundled runtime, including directory and symlink members."""
    if root.absolute() != root.resolve(strict=True):
        raise OSError('runtime root must not redirect through a symlink: ' + str(root))
    root = root.resolve(strict=True)
    members = []
    for path in sorted(root.rglob('*')):
        info = path.lstat()
        member = {'path': str(path.relative_to(root)), 'mode': stat.S_IMODE(info.st_mode)}
        if path.is_symlink():
            target = path.resolve(strict=True)
            if not target.is_relative_to(root):
                if root == Path('/Library/Fonts') and target.is_file() and target.is_relative_to('/System/Library/Fonts'):
                    member['systemFontTarget'] = reference(target)
                else:
                    raise OSError('runtime symlink leaves its verified package: ' + str(path))
            member.update(kind='symlink', target=os.readlink(path))
        elif path.is_dir():
            member['kind'] = 'directory'
        elif path.is_file():
            member.update(kind='file', **reference(path))
            member['path'] = str(path.relative_to(root))
            after = path.stat()
            if (info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise OSError('runtime member changed while binding: ' + str(path))
        else:
            raise OSError('unsupported runtime member: ' + str(path))
        members.append(member)
    return {'root': str(root), 'members': members}


def renderer_launch(command, root):
    """Resolve the bundled wrapper layout without executing a shell wrapper."""
    if sys.platform != 'darwin' or not Path('/usr/bin/sandbox-exec').is_file():
        raise OSError('this renderer requires the macOS filesystem sandbox; no fallback')
    wrapper = Path(command[0])
    wrappers = Path(BIN).resolve(strict=True)
    if wrapper.parent.resolve(strict=True) != wrappers or wrapper.name not in {'soffice', 'pdfinfo', 'pdftoppm'}:
        raise OSError('unregistered renderer command')
    wrapper_ref = reference(wrapper)
    dependencies = wrappers.parent.parent
    if wrapper.name == 'soffice':
        runtime = dependencies / 'native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents'
        executable = runtime / 'MacOS/soffice'
        intermediary = []
    else:
        package = dependencies / 'native/poppler'
        runtime = package / 'poppler'
        executable = runtime / 'bin' / wrapper.name
        intermediary = [reference(package / 'bin' / wrapper.name)]
    if runtime.absolute() != runtime.resolve(strict=True):
        raise OSError('registered renderer package must not be redirected')
    runtime = runtime.resolve(strict=True)
    executable = executable.resolve(strict=True)
    if not executable.is_relative_to(runtime):
        raise OSError('renderer executable leaves its package')
    with executable.open('rb') as stream:
        if stream.read(4) not in {b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xca\xfe\xba\xbe'}:
            raise OSError('resolved renderer is not a native Mach-O executable')
    root = root.resolve(strict=True)
    originals = [path.resolve(strict=True) for path in root.parent.glob('original.*') if path.is_file() and not path.is_symlink()]
    if len(originals) != 1:
        raise OSError('exact captured original is required for renderer admission')
    # System read exceptions are sealed OS libraries/resources, not user data roots.
    system_roots = ['/System/Library', '/usr/lib', '/usr/share/icu', '/usr/share/locale']
    runtime_binding = runtime_tree(runtime)
    font_root = Path('/Library/Fonts')
    fonts = runtime_tree(font_root) if font_root.is_dir() else None
    read_roots = [str(runtime), *system_roots]
    if fonts:
        read_roots.append(str(font_root.resolve()))
    # sandbox parameters keep paths out of policy source (including quotes/newlines).
    parameters = ['-D', 'WORK=' + str(root), '-D', 'INPUT=' + str(originals[0]),
                  '-D', 'RUNTIME_PARENT=' + str(runtime.parent)]
    for index, path in enumerate(read_roots):
        parameters.extend(['-D', 'READ_' + str(index) + '=' + path])
    rules = ' '.join('(subpath (param "READ_' + str(index) + '"))' for index in range(len(read_roots)))
    policy = '\n'.join([
        '(version 1)', '(deny default)', '(import "dyld-support.sb")',
        '(allow process-exec)', '(allow process-fork)',
        '(allow mach-bootstrap)', '(allow syscall*)',
        '(allow signal (target same-sandbox))',
        '(allow file-read-metadata)', '(allow file-test-existence)',
        '(allow file-read-data ' + rules + ' (literal (param "INPUT")))',
        '(allow file-read-data (literal (param "RUNTIME_PARENT")))',
        '(allow file-map-executable ' + rules + ')',
        '(allow file-read* file-write* (subpath (param "WORK")))',
        '(allow file-read* file-write* (literal "/dev/null"))',
        '(allow file-read-data (literal "/dev/urandom") (literal "/dev/random"))',
        '(allow sysctl-read)',
        '(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))',
        '(allow mach-lookup (global-name "com.apple.secinitd") (global-name "com.apple.logd") (global-name "com.apple.system.logger"))',
        '(deny network*)',
    ])
    env = {
        'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'en_US.UTF-8',
        'TMPDIR': str(root), 'TMP': str(root), 'TEMP': str(root),
        'XDG_CACHE_HOME': str(root), 'XDG_CONFIG_HOME': str(root),
        'DYLD_FALLBACK_LIBRARY_PATH': str(runtime / 'lib'),
    }
    for name in ('HOME', 'USER', 'LOGNAME'):
        if name in os.environ:
            env[name] = os.environ[name]
    generated_configuration = []
    if wrapper.name != 'soffice':
        # Include the bundled aliases, but keep font discovery and caches explicit.
        # The relocated upstream config omits the runtime's own fallback fonts.
        config = ET.Element('fontconfig')
        for directory in (runtime / 'fonts', Path('/System/Library/Fonts'), font_root):
            if directory.is_dir():
                ET.SubElement(config, 'dir').text = str(directory)
        ET.SubElement(config, 'include').text = str(runtime / 'etc/fonts/conf.d')
        ET.SubElement(config, 'cachedir').text = str(root / 'font-cache')
        config_bytes = ET.tostring(config, encoding='UTF-8', xml_declaration=True)
        config_path = root / 'inspection-fonts.conf'
        try:
            with config_path.open('xb') as stream:
                stream.write(config_bytes)
        except FileExistsError:
            if config_path.is_symlink() or config_path.read_bytes() != config_bytes:
                raise OSError('private font configuration changed')
        generated_configuration.append(reference(config_path))
        env['FONTCONFIG_PATH'] = str(root)
        env['FONTCONFIG_FILE'] = str(config_path)
    evidence = {
        'requestedWrapper': wrapper_ref, 'intermediaryWrappersNotExecuted': intermediary,
        'executable': reference(executable), 'runtime': runtime_binding, 'fonts': fonts,
        'generatedConfiguration': generated_configuration,
        'systemPrerequisites': {'readRoots': system_roots, 'readRootsAreExhaustive': False,
                                'additionalGrants': 'The hash-bound imported dyld-support.sb also grants platform Cryptex roots, executable mapping and exact ancestor directory reads.',
                                'os': list(os.uname()),
                                'bindingScope': 'OS version and standard system roots; no immutable full OS snapshot'},
        'sandboxExecutable': reference(Path('/usr/bin/sandbox-exec')),
        'systemPolicyInputs': [reference(Path('/System/Library/Sandbox/Profiles/dyld-support.sb'))],
        'policy': policy, 'parameters': parameters,
        'input': reference(originals[0]), 'privateWriteRoot': str(root),
        'runtimeParentDirectoryListingOnly': str(runtime.parent),
        'limitations': ['Runtime trees are checked before and after execution, not atomically pinned against a hostile host.',
                        'File metadata queries are permitted; unrelated file contents and writes are denied.',
                        'Process-group timeout does not certify descendant quiescence.'],
    }
    return ['/usr/bin/sandbox-exec', *parameters, '-p', policy, str(executable), *command[1:]], env, evidence


def run_process(command,root,label,seconds):
    stdout=root/(label+'.stdout.log');stderr=root/(label+'.stderr.log');receipt={'command':command,'secondsLimit':seconds,'started':False,'timedOut':False,'exitCode':None}
    start=time.monotonic()
    try:
        launch, env, evidence = renderer_launch(command, root)
        write_json(root/(label+'.runtime-before.json'), evidence)
        receipt['runtimeBefore'] = reference(root/(label+'.runtime-before.json'))
        with stdout.open('wb') as out,stderr.open('wb') as err:
            process=subprocess.Popen(launch,cwd=root,env=env,stdout=out,stderr=err,start_new_session=True);receipt['started']=True
            try:receipt['exitCode']=process.wait(timeout=seconds)
            except subprocess.TimeoutExpired:
                receipt['timedOut']=True
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                receipt['exitCode']=process.wait(timeout=5)
        receipt['observedProcessExitCode'] = receipt['exitCode']
        runtime_after = runtime_tree(Path(evidence['runtime']['root']))
        fonts_after = runtime_tree(Path(evidence['fonts']['root'])) if evidence['fonts'] else None
        policy_after = [reference(Path(item['path'])) for item in evidence['systemPolicyInputs']]
        sandbox_after = reference(Path(evidence['sandboxExecutable']['path']))
        configuration_after = [reference(Path(item['path'])) for item in evidence['generatedConfiguration']]
        stable = runtime_after == evidence['runtime'] and fonts_after == evidence['fonts'] and reference(Path(evidence['input']['path'])) == evidence['input'] and policy_after == evidence['systemPolicyInputs'] and sandbox_after == evidence['sandboxExecutable'] and configuration_after == evidence['generatedConfiguration']
        write_json(root/(label+'.runtime-after.json'), {'runtime': runtime_after, 'fonts': fonts_after, 'systemPolicyInputs': policy_after, 'sandboxExecutable': sandbox_after, 'generatedConfiguration': configuration_after, 'bindingsUnchanged': stable})
        receipt['runtimeAfter'] = reference(root/(label+'.runtime-after.json'))
        receipt['bindingsUnchanged'] = stable
        if not stable:
            receipt['exitCode'] = None
            raise OSError('renderer dependencies or captured input changed during execution')
    except Exception as error:receipt.update(errorType=type(error).__name__,detail=str(error),exitCode=None)
    receipt.update(elapsedSeconds=time.monotonic()-start,networkPolicy='sandbox-exec deny network*; no plain-process fallback',filesystemPolicy='deny default; exact captured input, verified runtime/system/fonts, private render writes')
    receipt['logs']=[reference(p) for p in [stdout,stderr] if p.exists()];write_json(root/(label+'.process.json'),receipt);return receipt

def render(original,family,root,result):
    derived=root/'rendered';derived.mkdir();pdf=original
    if family=='docx_report':
        profile=derived/'lo-profile';conversion=run_process([BIN+'/soffice','-env:UserInstallation='+profile.as_uri(),'--headless','--convert-to','pdf','--outdir',str(derived),str(original)],derived,'conversion',60);result['outcomes'].append({'stage':'conversion',**conversion});pdf=derived/(original.stem+'.pdf')
        if conversion.get('exitCode')!=0 or conversion['timedOut'] or not pdf.is_file():
            result['coverage']['visual']={'state':'unavailable','reason':'conversion did not provide complete PDF evidence'};return
        result['derivedPdf']=reference(pdf)
    info=run_process([BIN+'/pdfinfo',str(pdf)],derived,'page-count',60);result['outcomes'].append({'stage':'page-count',**info})
    output=(derived/'page-count.stdout.log').read_text(errors='replace') if (derived/'page-count.stdout.log').exists() else ''
    match=re.search(r'^Pages:\s+(\d+)\s*$',output,re.M)
    if info.get('exitCode')!=0 or info['timedOut'] or not match:
        result['coverage']['visual']={'state':'unavailable','reason':'independent renderer page count unavailable'};return
    observed=int(match.group(1));result['observedRenderPages']=observed
    if observed>PAGES:
        result['coverage']['visual']={'state':'unavailable','reason':'observed pages exceed prospective measurement limit','observedPages':observed,'pageLimit':PAGES,'pagesNotRasterized':observed};return
    raster=run_process([BIN+'/pdftoppm','-r','110','-png',str(pdf),str(derived/'page')],derived,'raster',60);result['outcomes'].append({'stage':'raster',**raster})
    images=[]
    for path in derived.glob('page-*.png'):
        match=re.fullmatch(r'page-(\d+)\.png',path.name)
        if match:images.append((int(match.group(1)),path))
    for page,path in sorted(images):
        item={'id':'render-page-'+str(page).zfill(3),'page':page,'reference':reference(path),'citation':{'kind':'full_page_image','page':page,'path':str(path)},'actualReviewerInspectionRequired':True}
        try:
            from PIL import Image
            with Image.open(path) as image:image.verify()
            with Image.open(path) as image:item['pixels']=[image.width,image.height]
        except Exception as error:item['imageAvailable']=False;item['errorType']=type(error).__name__
        else:item['imageAvailable']=True
        result['pages'].append(item)
    complete=raster.get('exitCode')==0 and not raster['timedOut'] and [p['page'] for p in result['pages']]==list(range(1,observed+1)) and all(p['imageAvailable'] for p in result['pages'])
    result['coverage']['visual']={'state':'complete' if complete else 'unavailable','observedPages':observed,'retainedActualImages':len(result['pages']),'reason':None if complete else 'raster failure/timeout/missing or invalid pages; every produced image retained','stateScope':'Full-page image availability only; glyph fidelity and content coverage require actual review.','coversExtractionInvisibleText':None,'reviewerInspectionPerformed':False}

def inspect(request):
    root=Path(request['outputRoot']);root.mkdir(parents=True,exist_ok=False)
    write_json(root/'request.json',request)
    result={'schemaVersion':1,'inspectionId':request['inspectionId'],'family':request['family'],'artifactState':'unavailable','inspectionMeasurementAvailable':False,'allSourcesCertified':False,'semanticPass':None,'original':None,'sourceContext':{'state':'not_provided'},'coverage':{'original':{'state':'unavailable'},'parser':{'state':'unavailable'},'text':{'state':'unavailable'},'structure':{'state':'unavailable'},'visual':{'state':'unavailable'},'context':{'state':'not_provided'}},'objects':[],'pages':[],'outcomes':[],'limitations':['Full-page images must actually be inspected by the blinded reviewers. Parsed text and object inventory never certify all assertions or semantic correctness.','Formatting, hidden text, image text, vector text and visually implied associations are not inferred from a green parser.','Missing optional source context does not certify allSources; root owns complete source packets and custody.','Explicit measurement limits do not relax task page limits. No original is repaired, rewritten or rescored.','PDF decoding may allocate before decoded-size checks; no hard-memory guarantee.']}
    if request['family'] not in ['docx_report','pdf_create']:raise ValueError('unsupported family')
    original=root/('original.docx' if request['family']=='docx_report' else 'original.pdf')
    try:raw=capture(request['artifact'],original)
    except FileNotFoundError as error:
        result['coverage']['original']={'state':'unavailable','reason':'captured artifact binding is missing; original native absence is not established','errorType':type(error).__name__,'suppliedBinding':request['artifact']};result['outcomes'].append({'stage':'capture','errorType':type(error).__name__,'detail':str(error)})
    except Exception as error:
        result['coverage']['original']={'state':'unavailable','reason':str(error),'errorType':type(error).__name__,'suppliedBinding':request['artifact'],'originalPathUntouched':True};result['outcomes'].append({'stage':'capture','errorType':type(error).__name__,'detail':str(error)})
    else:
        result['artifactState']='captured';result['original']=reference(original);result['coverage']['original']={'state':'complete','exactBindingVerified':True}
        if request.get('sourceContext'):
            try:
                contextpath=root/'source-context.json';context=capture(request['sourceContext'],contextpath);json.loads(context)
                result['sourceContext']={'state':'captured','reference':reference(contextpath)};result['coverage']['context']={'state':'provided_unchanged','allSourcesCertified':False}
            except Exception as error:
                result['sourceContext']={'state':'unavailable','errorType':type(error).__name__,'detail':str(error)};result['coverage']['context']={'state':'unavailable','reason':'bound context capture or JSON parse failed'}
        inv=Inventory(root);parserlog=root/'parser.log'
        with parserlog.open('w') as log,contextlib.redirect_stdout(log),contextlib.redirect_stderr(log):
            try:summary=inspect_docx(raw,inv) if request['family']=='docx_report' else inspect_pdf(raw,inv)
            except InvalidContainer as error:
                result['artifactState']='malformed';state={'state':'unavailable','reason':'objective invalid-container evidence','evidence':str(error)};result['outcomes'].append({'stage':'parser','status':'invalid_container','detail':str(error)})
            except Exception as error:
                state={'state':'unavailable','reason':'parser/environment/coverage failure, not inferred malformed','errorType':type(error).__name__,'detail':str(error)};result['outcomes'].append({'stage':'parser','status':'unavailable','errorType':type(error).__name__,'detail':str(error)})
            else:
                state={'state':'complete' if not inv.gaps else 'unavailable','summary':summary,'gaps':inv.gaps};result['outcomes'].append({'stage':'parser','status':state['state'],'summary':summary,'gaps':inv.gaps})
        result['objects']=inv.objects;result['extractedParts']=inv.parts;result['parserLog']=reference(parserlog)
        result['coverage']['parser']=state;result['coverage']['structure']=dict(state);result['coverage']['text']={**state,'charactersRetained':inv.text,'visualOrImageTextNotCertified':True}
        # Renderer always runs independently after a captured original, even on parser failure.
        try:render(original,request['family'],root,result)
        except Exception as error:result['coverage']['visual']={'state':'unavailable','reason':'renderer environment or coverage exception','errorType':type(error).__name__,'detail':str(error)};result['outcomes'].append({'stage':'renderer','errorType':type(error).__name__,'detail':str(error)})
        after=reference(original);result['originalAfterInspection']=after
        if after!=result['original']:result['coverage']['original']={'state':'unavailable','reason':'retained original changed during inspection'}
        result['inspectionMeasurementAvailable']=result['artifactState']=='captured' and all(result['coverage'][k]['state']=='complete' for k in ['original','parser','structure','text','visual']) and result['coverage']['context']['state']!='unavailable'
    # Retain and bind every produced file, including partial renders and process logs.
    result['retainedFiles']=[reference(p) for p in sorted(root.rglob('*')) if p.is_file() and not p.is_symlink() and p.name!='receipt.json']
    write_json(root/'receipt.json',result);return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--request',required=True);parser.add_argument('--output',required=True);args=parser.parse_args();request=json.loads(Path(args.request).read_text());result=inspect(request);output=Path(args.output)
    if output.resolve()!=(Path(request['outputRoot'])/'receipt.json').resolve():
        with output.open('x') as f:f.write(json.dumps(result,ensure_ascii=False,indent=2)+'\n')

if __name__=='__main__':main()
