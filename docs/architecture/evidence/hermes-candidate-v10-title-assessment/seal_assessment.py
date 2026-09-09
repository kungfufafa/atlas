from pathlib import Path
import datetime,hashlib,json,re
O=Path('/private/tmp/atlas-c10-title-ux-assessment');I=Path('/private/tmp/atlas-native-file-v3-c9-integration');S=I/'source'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def bind(p):return {'path':str(p),'bytes':p.stat().st_size,'sha256':sha(p)}
def write(n,j):
 p=O/n;assert not p.exists();p.write_text(json.dumps(j,indent=2)+'\n')
j=json.loads((I/'source-inventory.json').read_text());assert j['softwareSourceHash']=='e2daf1b902a087eb279724f17d61e50b9a27f7c1d64828f6958b61b22225eb98'
ranges={
'apps/server/src/services/session-title-service.ts':[[12,108],[112,180]],
'packages/agent/src/session-title.ts':[[4,41],[88,132]],
'apps/server/src/http/routes/sessions.ts':[[988,1039]],
'apps/server/src/http/shared.ts':[[988,1016]],
'apps/server/src/services/agent-service.ts':[[493,498],[5404,5430],[6549,6562]],
'apps/server/src/services/provider-instance-helpers.ts':[[634,726]],
'packages/db/src/adapters/sqlite.ts':[[886,888],[4701,4704]],
'packages/db/src/adapters/in-memory.ts':[[2624,2633]],
'apps/server/src/providers/subscription/chatgpt/provider.ts':[[29,45]],
'apps/server/src/providers/subscription/claude/provider.ts':[[25,45]],
'apps/server/src/providers/subscription/session-store.ts':[[72,104],[925,955]],
'packages/core/src/contract.ts':[[2625,2634]],
'packages/core/src/fetch-idle.ts':[[48,72]],
'apps/server/src/providers/openai/index.ts':[[137,151],[578,632]],
'apps/server/src/services/chat-capability-policy.ts':[[40,76]],
'apps/web/src/pages/history-page.shared.ts':[[1,5]],
'apps/server/src/services/session-title-service.test.ts':[[144,294]],
'packages/agent/src/session-title.test.ts':[[9,92]],
'scripts/harness-native-files-mimo-v3/file-atlas-runner.ts':[[656,681]]}
source=[]
for name,rs in ranges.items():
 p=S/name;assert sha(p)==j['files'][name];lines=p.read_text().splitlines(keepends=True);source.append({**bind(p),'relativePath':name,'sourceKind':'control' if name.startswith('scripts/') else 'product','inspectedRanges':[{'start':a,'end':min(b,len(lines)),'textSha256':hashlib.sha256(''.join(lines[a-1:b]).encode()).hexdigest()} for a,b in rs]})
write('source-bindings.json',{'sourceInventory':bind(I/'source-inventory.json'),'softwareSourceHash':j['softwareSourceHash'],'controlSourceHash':j['controlSourceHash'],'selectedSources':source,'scope':'Read/hash only; selected ranges and full-file hashes bound to frozen C9 inventory. No tests, runtime or source changes.'})
write('inspection-limitations.json',{'readOnlySearchMisses':['An rg path guessed packages/db/src/adapters/memory.ts; actual adapter is in-memory.ts.','Several shell globs for llm/sidebar files had no matches; subsequent direct paths/rg discovery were used.','Guessed openai/client.ts and core/constants.ts were absent; actual timeout helper is packages/core/src/fetch-idle.ts.'],'preservation':'These were read-only path/search errors in tool history, not behavioral tests or product counterexamples. No separate exact failed command script was captured, and none is claimed. No source/edit/test attempt failed because no implementation or test execution was performed.','evidenceScope':'Only fixed title-system marker, original scalar evaluation/usage/error elapsed fields and hashes of the two already-closed requests were selected. No request task text, hidden response reasoning or raw error text was emitted.'})
def link(label,name,line):return f'[{label}]({S/name}:{line})'
text=f'''Rekomendasi: pertahankan judul AI otomatis di background, tambahkan anggaran cancellation khusus judul dan fallback deterministik dari pesan pertama bila pembuatan gagal. Ini satu perbaikan umur pekerjaan tambahan dan kegunaan riwayat, bukan cara mengganti skor atau menonaktifkan AI agar benchmark membaik. Belum ada klaim peningkatan hasil live.

**Fakta C9.** HTTP nonstreaming menjadwalkan judul setelah balasan selesai tanpa menunggunya. Streaming memanggil scheduler setelah terminal/penutupan stream, termasuk terminal error; service tetap mensyaratkan pesan pengguna dan teks assistant. Jadi timeout judul bukan bukti file gagal diterima pengguna. Runner studi sengaja menunggu judul agar seluruh resource tercatat. Lihat {link('HTTP','apps/server/src/http/routes/sessions.ts',988)}, {link('terminal stream','apps/server/src/http/shared.ts',988)}, dan {link('runner','scripts/harness-native-files-mimo-v3/file-atlas-runner.ts',656)}.

Pada confirmation Atlas #52 dan #73, request terakhir cocok dengan instruksi sistem tetap pembuat judul. Evaluasi artefak asli lulus; request judul berakhir sebagai transport error setelah 95.229 dan 90.030 ms, sehingga total usage wajib tetap unknown dan primary tetap gagal. #52 beririsan dengan sleep/wake; penyebab tiap kegagalan tidak diisolasi. Bukti ini tidak mengukur latency judul HTTP biasa. [Proyeksi dan hash asli]({O}/closed-title-failure-projection.json).

Service mencegah pekerjaan serentak untuk session yang sama, menjaga session/profile/org aktif, memeriksa ulang sebelum commit, dan hanya mengisi title null. SQL serta adapter memori juga melakukan conditional update, sehingga judul manual tidak ditimpa. Provider dipilih dari konfigurasi profil, bukan otomatis dari modelOverride session. Fallback sekarang “Untitled”, yang tidak membantu membedakan percakapan di History. Lihat {link('service','apps/server/src/services/session-title-service.ts',43)}, {link('SQL','packages/db/src/adapters/sqlite.ts',886)}, {link('pemilihan eksplisit','apps/server/src/services/provider-instance-helpers.ts',634)}, dan {link('History','apps/web/src/pages/history-page.shared.ts',3)}.

Helper judul belum menerima signal/deadline tersendiri. API mempunyai timeout transport umum; subscription mempunyai lifecycle native sendiri. Karena itu jangan menyebut seluruh panggilan tanpa batas. Namun judul tidak memiliki kebijakan cancellation yang sesuai kepentingannya sebagai pekerjaan tambahan. Adapter generateText API/ChatGPT/Claude sudah menerima signal; pada subscription judul merupakan inferensi native tersendiri dengan provider lease. Lihat {link('helper','packages/agent/src/session-title.ts',105)}, {link('API','apps/server/src/providers/openai/index.ts',578)}, {link('timeout umum','packages/core/src/fetch-idle.ts',58)}, {link('ChatGPT','apps/server/src/providers/subscription/chatgpt/provider.ts',29)}, dan {link('Claude','apps/server/src/providers/subscription/claude/provider.ts',25)}.

| Opsi | Manfaat dan batas |
|---|---|
| Async sekarang | Balasan utama tidak menunggu; request tambahan dan “Untitled” setelah gagal tetap ada. |
| Fallback pesan pertama langsung | Judul tersedia tanpa inference; jika disimpan sebelum AI, conditional-update sekarang justru menghalangi hasil AI. Upgrade membutuhkan asal/version judul, bukan penggantian buta. |
| Deadline + fallback saat gagal | Mempertahankan judul AI normal, membatasi umur pekerjaan tambahan, memberi label lokal yang berguna; model lambat bisa lebih sering mendapat fallback. |
| AI configurable/on-demand | Kontrol pengguna lebih besar, tetapi menambah preferensi, API/UI dan alur izin; dua kejadian ini belum membenarkan perluasan tersebut. |

**Batas perubahan yang disarankan.** Gunakan satu signal khusus pekerjaan judul yang diteruskan ke generateText, dengan usulan anggaran cancellation 30 detik. Angka itu keputusan produk prospektif, bukan hasil optimasi dari dua kasus. Jangan hanya Promise.race lalu meninggalkan inferensi, melepaskan inFlight, atau memulai duplikat sebelum cleanup selesai. Signal bukan jaminan seluruh runtime berhenti tepat pada detik ke-30. Keberhasilan respons utama tidak boleh berubah karena judul.

Saat provider gagal, tidak tersedia, atau deadline tercapai, pilih satu baris singkat dari teks pengguna pertama, rapikan whitespace dan potong secara aman untuk Unicode; gunakan fallback netral untuk pesan kosong/lampiran saja. Simpan setelah pemeriksaan eligibility dan conditional update yang sama. Jangan menyimpan fallback dahulu lalu menghapus judul manual untuk memungkinkan upgrade. Tetap gunakan pemilihan provider/model profil yang eksplisit; jangan diam-diam berpindah ke model murah, akun API, atau subscription lain. Perbedaan modelOverride session adalah perilaku saat ini yang harus dijelaskan, bukan diubah diam-diam dalam perbaikan ini.

Helper kini hanya mengembalikan string/null; jalur title memakai provider capability langsung dan tidak otomatis melewati wrapper usage createHarness. Jangan menganggap angka utama produk sudah mencakup title. Outcome/counter request tambahan harus tetap dibedakan: fallback lokal bukan sukses provider dan bukan bukti nol token. Usage gagal yang belum dilaporkan tetap unknown; cancellation tidak membuktikan penghematan biaya. Lihat {link('injeksi provider','apps/server/src/services/agent-service.ts',493)} dan {link('wrapper harness','apps/server/src/services/agent-service.ts',5404)}.

**Tes perilaku yang dibutuhkan sebelum implementasi diterima:** HTTP send/stream selesai ketika title masih tertahan; signal benar-benar mencapai transport API dan fake runtime native; cancellation tidak membuat request lanjutan/duplikat atau kehilangan cleanup; sukses AI normal dan model eksplisit tetap dipertahankan; fallback Unicode/lampiran berguna; late completion tidak menimpa judul manual; session/org yang dihapus, dipindahkan, atau diarsipkan tidak menerima commit; unknown usage tidak menjadi nol. Gunakan SQLite nyata dan adapter memori, serta perluas {link('tes service','apps/server/src/services/session-title-service.test.ts',144)} dan {link('tes helper','packages/agent/src/session-title.test.ts',9)}. Tidak ada tes yang dijalankan dalam memo ini.

Sumber produk adalah C9 `e2daf1b902a087eb279724f17d61e50b9a27f7c1d64828f6958b61b22225eb98`; [binding sumber]({O}/source-bindings.json) mencatat hash lengkap. Penulis pernah mengerjakan guard HTTP, bukan SessionTitleService atau runner. Ini diagnosis/desain read-only; studi dan seluruh skor tetap dibekukan.
'''
p=O/'memo.md';assert not p.exists();p.write_text(text);count=len(re.findall(r'\S+',text));assert count<=900,count
write('assessment.json',{'closedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'closed','memo':bind(p),'whitespaceWordCount':count,'sourceBindings':bind(O/'source-bindings.json'),'closedTitleFailureProjection':bind(O/'closed-title-failure-projection.json'),'direction':'Retain background AI title generation; bounded title cancellation with deterministic fallback on failure, exact current provider selection/manual-title/tenant guards and explicit accounting uncertainty.','implementation':False,'newTestsOrModelCalls':0,'newEvaluationOrPreregistration':False,'liveGainEstablished':False,'sourceChanges':False,'scoreChanges':False,'limits':bind(O/'inspection-limitations.json')})
entries=[{'path':str(p.relative_to(O)),**{k:v for k,v in bind(p).items() if k!='path'}} for p in sorted(O.rglob('*')) if p.is_file()]
write('manifest.json',{'entries':entries,'fileCount':len(entries),'totalBytes':sum(x['bytes'] for x in entries),'scope':'All assessment files except manifest/seal themselves; no product source copied/changed.'})
for x in entries:assert sha(O/x['path'])==x['sha256']
for x in source:assert sha(Path(x['path']))==x['sha256']
write('seal.json',{'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'assessment':bind(O/'assessment.json'),'memo':bind(O/'memo.md'),'manifest':bind(O/'manifest.json'),'allMembersReverified':True,'allSelectedFrozenSourcesUnchanged':True})
print(json.dumps({'memo':bind(O/'memo.md'),'assessment':bind(O/'assessment.json'),'manifest':bind(O/'manifest.json'),'seal':bind(O/'seal.json'),'wordCount':count,'members':len(entries)},indent=2))
