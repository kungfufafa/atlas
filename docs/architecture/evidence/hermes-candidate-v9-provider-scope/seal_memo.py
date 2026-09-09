from pathlib import Path
import datetime,hashlib,json
O=Path('/private/tmp/atlas-c9-provider-experience-claim-scope');I=Path('/private/tmp/atlas-native-file-v3-c9-integration');S=I/'source'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def bind(p): return {'path':str(p),'bytes':p.stat().st_size,'sha256':sha(p)}
def write(n,x):
 p=O/n;assert not p.exists();p.write_text(json.dumps(x,indent=2)+'\n')
j=json.loads((I/'source-inventory.json').read_text());assert j['softwareSourceHash']=='e2daf1b902a087eb279724f17d61e50b9a27f7c1d64828f6958b61b22225eb98' and j['softwareFiles']==2121
ranges={
'packages/agent/src/chat.ts':[[357,446],[611,627],[965,1010]],
'apps/server/src/providers/subscription/chatgpt/provider.ts':[[18,58]],
'apps/server/src/providers/subscription/claude/provider.ts':[[16,57]],
'apps/server/src/providers/subscription/chatgpt/app-server.ts':[[320,355],[432,459],[1185,1231]],
'apps/server/src/providers/subscription/chatgpt/runtime.ts':[[310,351],[565,599],[763,817],[868,951]],
'apps/server/src/providers/subscription/claude/runtime.ts':[[475,488],[573,611],[762,775],[877,897],[1002,1042]],
'apps/server/src/providers/subscription/claude/metadata.ts':[[28,96]],
'apps/server/src/providers/compatible-models.ts':[[26,45],[239,256]],
'apps/server/src/providers/openai/model-metadata.ts':[[35,41],[85,92]],
'apps/server/src/providers/capabilities/builtin-adapters.ts':[[160,208]],
'apps/server/src/providers/capabilities/registry.ts':[[182,216]],
'apps/server/src/providers/capabilities/resolver.ts':[[15,77]],
'apps/server/src/services/chat-capability-policy.ts':[[41,104]],
'apps/server/src/providers/subscription/claude/structured-tool-bridge.ts':[[34,119]],
'apps/server/src/services/agent-service.ts':[[3259,3285]],
'apps/server/src/services/publication-turn-principal.ts':[[26,100]],
'apps/server/src/http/routes/sessions.ts':[[936,1023]],
'apps/server/src/http/shared.ts':[[801,838]],
'packages/core/src/tools/execution.ts':[[564,577]],
'apps/server/src/providers/subscription/env.ts':[[34,82]],
'apps/server/src/providers/usage-tracking.ts':[[209,279]],
'apps/server/src/providers/failure-evidence.ts':[[6,84]],
'apps/server/src/services/custom-tool-subprocess.ts':[[90,149]],
'apps/server/src/services/process-tool-admission.ts':[[1,30]],
'apps/server/src/services/restricted-process-admission.ts':[[187,210]]}
source=[]
for name,rr in ranges.items():
 p=S/name;assert sha(p)==j['files'][name],name
 lines=p.read_text().splitlines(keepends=True)
 source.append({**bind(p),'candidateRelativePath':name,'rangesInspected':[{'start':a,'end':min(b,len(lines)),'textSha256':hashlib.sha256(''.join(lines[a-1:b]).encode()).hexdigest()} for a,b in rr]})
write('source-bindings.json',{'sourceInventory':bind(I/'source-inventory.json'),'softwareSourceHash':j['softwareSourceHash'],'softwareFiles':2121,'selectedFiles':source,'scope':'Selected product files independently hashed against the closed C9 inventory; line ranges record inspected portions. No full recursive source re-review or runtime execution.'})
evidence=[
('/private/tmp/atlas-candidate9-integration-independent-review/review.json','Closed independent C9 integration source/evidence review; not a new real subscription run.'),
('/private/tmp/atlas-candidate9-integration-independent-review/review.md','Readable closed C9 integration limits and actual HTTP/scripted test scope.'),
('/private/tmp/atlas-native-file-v3-c9-development-independent-review/review.json','Closed C9 MiMo development instrumentation; original quality counts only.'),
('/private/tmp/atlas-native-file-v3-c9-live-pilot-independent-review/review.json','Closed C9 MiMo live pilot instrumentation, unscored pilot.'),
('/private/tmp/atlas-subscription-fidelity/README.md','Historical candidate2 fake native transports and explicit model/cancellation limitations; not current C9 live proof.'),
('/private/tmp/atlas-subscription-failure-usage/v2-readiness.json','Historical offline native failure accounting evidence; no new execution in this memo.'),
('/private/tmp/atlas-chatgpt-success-usage/v2-readiness.json','Historical offline native completion/occupancy accounting evidence; no new execution in this memo.'),
('/private/tmp/atlas-live-provider-proof/results.json','Historical 2026-09-06 actual ChatGPT probe has one FAIL; it is not attributed to frozen C9.'),
('/private/tmp/atlas-live-provider-proof/manifest.json','Historical planned live scope, not proof every planned case executed.')]
write('closed-evidence-bindings.json',{'selected':[{**bind(Path(p)),'qualification':q} for p,q in evidence],'scope':'Reports/readiness and scalar historical probe fields only; no raw native trace, hidden reasoning, confirmation, model/test/oracle execution or source changes.'})
def link(label,path,line):return f'[{label}]({S/path}:{line})'
text=f'''Atlas C9 sudah memiliki beberapa mekanisme untuk menjaga pengalaman lintas provider, tetapi belum ada dasar untuk mengatakan “API atau subscription apa pun pasti setara Hermes”. Klaim yang dapat dipertanggungjawabkan saat ini adalah konsistensi kontrak dan pelaporan pada jalur yang didukung; mutu hasil tetap perlu dibuktikan per model, endpoint, runtime, dan jenis tugas.

Memo ini membaca kode produk C9 yang dibekukan, hash `e2daf1b902a087eb279724f17d61e50b9a27f7c1d64828f6958b61b22225eb98` (2.121 file). Hash penuh 25 file yang dirujuk dan rentang baris tersedia di [source-bindings.json]({O}/source-bindings.json). Tidak ada kode, tes, model, atau oracle yang dijalankan; data confirmation tidak diakses.

1. **Konteks percakapan punya pemilik berbeda.** API mengikuti compaction Atlas jika dikonfigurasi. Adapter ChatGPT dan Claude menandai `managesContext: true`, sehingga compaction otomatis Atlas dilewati; compaction manual tetap tersedia. ChatGPT memakai occupancy dan context window yang dilaporkan runtime, terpisah dari token kumulatif. Ini mencegah Atlas menerapkan anggaran konteks kedua, tetapi tidak menjamin panjang percakapan, waktu compaction, atau ingatan yang identik antarprovider. Lihat {link('chat.ts','packages/agent/src/chat.ts',357)}, {link('ChatGPT provider','apps/server/src/providers/subscription/chatgpt/provider.ts',46)}, {link('Claude provider','apps/server/src/providers/subscription/claude/provider.ts',46)}, dan {link('native context','apps/server/src/providers/subscription/chatgpt/app-server.ts',1185)}.

2. **Dukungan transport berbeda dari kemampuan model.** Registry membedakan handler yang tersedia dari bukti kemampuan model; kemampuan `unknown` tidak dipromosikan hanya karena adapter mendukungnya. Metadata terikat instance/model, mempertahankan `false` dan daftar effort kosong. Enrichment OpenAI memakai daftar ID persis dan pemeriksaan endpoint resmi; memo ini memverifikasi pembatasan kode, bukan memperbarui kebenaran katalog eksternal. Subscription memeriksa katalog native dan menolak pilihan eksplisit yang tidak tersedia. Fallback capability tetap mungkin jika memang dikonfigurasi pengguna—jadi jangan menjanjikan bahwa seluruh routing selalu memakai satu model. Lihat {link('registry','apps/server/src/providers/capabilities/registry.ts',184)}, {link('metadata','apps/server/src/providers/compatible-models.ts',26)}, {link('endpoint','apps/server/src/providers/compatible-models.ts',239)}, {link('native selection','apps/server/src/providers/subscription/chatgpt/runtime.ts',798)}, dan {link('configured routing','apps/server/src/providers/capabilities/resolver.ts',35)}.

3. **Tool subscription masuk melalui eksekusi Atlas, dengan batas aktivasi yang jelas.** Codex memakai dynamic tools; Claude memakai MCP SDK bridge dengan skema dan katalog tool Atlas. Callback kembali ke executor Atlas yang menjalankan guard sebelum tool. Pada chat HTTP tersimpan, C9 membuat principal terautentikasi baru sebelum mengambil session dari cache, meneruskannya ke send/stream, dan memeriksa akses terkini termasuk konteks pengguna/worker. Namun pemeriksaan asinkron ini bukan lease atomik; task internal, delegasi, dan automation tidak otomatis mendapat principal HTTP tersebut. Kode itu juga tidak mengaktifkan publikasi artefak privat atau kebijakan admission runtime global. Lihat {link('Codex bridge','apps/server/src/providers/subscription/chatgpt/runtime.ts',868)}, {link('Claude bridge','apps/server/src/providers/subscription/claude/structured-tool-bridge.ts',34)}, {link('executor','packages/core/src/tools/execution.ts',569)}, {link('HTTP send/stream','apps/server/src/http/routes/sessions.ts',936)}, dan {link('guard scope','apps/server/src/services/agent-service.ts',3259)}. Isolasi konfigurasi subscription memakai home Atlas dan env terpilih; itu bukan bukti confinement seluruh host ({link('runtime env','apps/server/src/providers/subscription/env.ts',34)}).

4. **Cancel dan recovery menjaga batas tindakan, tetapi tidak seragam.** Send/stream menggabungkan sinyal request dan turn; Codex mengirim interrupt, sedangkan Claude meng-abort dan menutup handle. Ini tidak membatalkan efek tool yang sudah terjadi atau membuktikan seluruh proses turunan berhenti. Recovery output-limit Atlas hanya satu kesempatan dalam kondisi tertentu, dari riwayat yang sudah selesai; fragmen yang terpotong bukan tindakan valid. Jalur itu menolak recovery setelah keluaran terlihat, dispatch native, cancellation, atau ketika runtime mengelola konteks. Guidance C9 tidak menambah retry atau otoritas tool. Lihat {link('stream cancellation','apps/server/src/http/shared.ts',801)}, {link('Codex interrupt','apps/server/src/providers/subscription/chatgpt/app-server.ts',432)}, {link('Claude cleanup','apps/server/src/providers/subscription/claude/runtime.ts',762)}, dan {link('recovery','packages/agent/src/chat.ts',965)}.

5. **Usage dan identitas yang tidak diketahui harus tetap terlihat.** Wrapper membedakan reported, estimated, dan unknown; angka native yang tidak lengkap tidak diganti estimasi dari pesan luar. Bukti kegagalan bersifat diagnostik dan tidak menjadi tool call. Claude membedakan exact ID, resolusi alias yang benar-benar diiklankan, alias belum terverifikasi, dan konflik. ChatGPT memvalidasi ID katalog lalu mengirimnya; itu sendiri bukan pengukuran independen identitas backend atau tagihan. Mekanisme ini mendukung pelaporan jujur, bukan jaminan biaya/langganan setara atau cakupan seluruh request internal runtime. Lihat {link('usage tracking','apps/server/src/providers/usage-tracking.ts',209)}, {link('failure evidence','apps/server/src/providers/failure-evidence.ts',6)}, dan {link('Claude identity','apps/server/src/providers/subscription/claude/runtime.ts',1002)}.

6. **Bukti mutu belum mencakup semua provider/subscription.** Bukti live C9 yang ditinjau adalah MiMo `mimo-v2.5` melalui OpenCode Go, nonstreaming, dengan anggaran dan tugas file yang dibekukan. Development lengkap melaporkan Atlas 14/18 dan Hermes 14/18; itu bukan bukti kesetaraan, dan satu arm Hermes tetap mempunyai usage total tidak diketahui. Tes subscription historis menggunakan runtime palsu, bukan pembuktian mutu akun asli. Catatan probe ChatGPT lama 6 September bahkan berstatus FAIL pada pemeriksaan `write_file`; catatan itu tidak terikat sumber C9 dan tidak boleh dianggap hasil C9 maupun kelulusan seluruh matriks yang direncanakan. Tidak ada hasil confirmation yang digunakan. Sumber dan batas masing-masing ada di [closed-evidence-bindings.json]({O}/closed-evidence-bindings.json).

Rumusan yang layak dipakai: **“Atlas C9 menyediakan kontrol pemilihan model, akses tool, cancellation, dan provenance pada jalur yang didukung, sambil mempertahankan batas runtime native. Mutu setara atau lebih baik harus dibuktikan dalam konfigurasi dan tugas yang benar-benar diuji.”** Kehadiran adapter, tes offline, atau fondasi yang belum diaktifkan tidak cukup untuk memperluas klaim ke setiap API, paket subscription, OS, channel, atau model masa depan.

Batas independensi: penulis pernah mengerjakan fondasi principal/guard HTTP serta mengaudit instrumentasi C9. Memo ini adalah pemetaan kode dan bukti tertutup, bukan audit independen ulang atas rancangan yang ditulis sendiri. Tidak ada klaim aktivasi tambahan atau peningkatan live baru.
'''
assert len(source)==25
p=O/'memo.md';assert not p.exists();p.write_text(text)
write('review.json',{'closedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'closed','scope':'Bounded source/read-only cross-provider claim memo','memo':bind(p),'sourceBindings':bind(O/'source-bindings.json'),'closedEvidenceBindings':bind(O/'closed-evidence-bindings.json'),'sourceFilesIndependentlyBound':25,'newCallsOrTests':0,'confirmationAccess':False,'sourceChanges':False,'claim':'Scoped controls and explicit uncertainty; no universal quality/parity, billing, confinement or activation claim.','independenceQualification':'Author wrote underlying authenticated ordinary HTTP guard components; prior closed evidence authorship is disclosed.'})
entries=[{'path':str(p.relative_to(O)),**{k:v for k,v in bind(p).items() if k!='path'}} for p in sorted(O.rglob('*')) if p.is_file()]
write('manifest.json',{'entries':entries,'fileCount':len(entries),'totalBytes':sum(x['bytes'] for x in entries),'scope':'All closure files excluding manifest/seal themselves.'})
for x in entries:assert sha(O/x['path'])==x['sha256']
for x in source:assert sha(Path(x['path']))==x['sha256']
write('seal.json',{'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'review':bind(O/'review.json'),'memo':bind(O/'memo.md'),'manifest':bind(O/'manifest.json'),'allMembersReverified':True,'allSelectedProductSourcesUnchanged':True})
print(json.dumps({'memo':bind(O/'memo.md'),'review':bind(O/'review.json'),'manifest':bind(O/'manifest.json'),'seal':bind(O/'seal.json'),'files':len(entries),'bytes':sum(x['bytes'] for x in entries)},indent=2))
