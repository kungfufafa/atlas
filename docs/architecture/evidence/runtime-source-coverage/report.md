# Runtime sumber tool kustom — increment terpisah

Tanggal: 8 September 2026. Status: implementasi dan regresi increment selesai; tujuan kesetaraan Hermes masih aktif dan belum tercapai.

Atlas kini memiliki jalur opsional untuk mengikat inspeksi metadata tool JavaScript/skill dan eksekusinya ke bukti runtime yang berbeda. Pemeriksaan metadata memakai otoritas pengguna atau worker yang meminta sesi. Eksekusi memakai identitas definisi tool yang dipilih dan principal giliran yang masih berlaku. Perubahan berada di `/private/tmp/atlas-runtime-source-coverage-20260908/source`; bootstrap dan sumber produksi utama belum mengaktifkannya.

Hasil pembanding terakhir tetap **Atlas 44/54, Hermes 46/54** dan gagal melewati gerbang klaim. Increment ini tidak menjalankan provider, model berbayar, subscription native, atau renderer dokumen. [Hasil C9 lengkap](../hermes-native-files-v3-c9-confirmation/report.md) tetap menjadi bukti kualitas model yang berlaku.

## Perubahan dan alasan

- Spawner `custom_json` menunggu registrasi receipt dan observation sebelum memulai child. Hook wajib yang hilang, receipt tidak sesuai, dan pembatalan saat menunggu menolak startup. Jalur lama tanpa observation tetap tersedia sesuai kontraknya.
- Inspeksi metadata mendapat ledger tersendiri per sumber dan resolusi sesi. Host menolak definisi kustom yang tidak memiliki metadata dengan registrasi, startup, close, hasil runner, dan cleanup yang teramati berhasil. Ledger metadata tidak disamarkan sebagai tool call atau publikasi artefak.
- Resolver JavaScript membuat loader beserta cache metadata sendiri untuk setiap sumber yang diikat host. Runtime skill juga mengikuti sumber yang benar-benar ditetapkan. Invokasi memakai token definisi yang persis sama dengan anggota inventaris, bukan hanya kesamaan nama.
- Sumber masuk modul diperiksa melalui path canonical, device/inode, ukuran, SHA-256, dan waktu perubahan. Pemeriksaan berkas memakai descriptor dengan `O_NOFOLLOW` dan `O_NONBLOCK`, batas 8 MiB, serta pemeriksaan sebelum/sesudah pembacaan. Perubahan terdeteksi menolak penggunaan sesi tersimpan dan meminta reload.
- Principal asli diperiksa kembali setelah callback konfigurasi, kemudian berkas masuk modul diperiksa lagi tanpa callback konfigurasi atau otoritas tambahan. Kedua pemeriksaan itu tetap merupakan revalidasi terpisah, bukan transaksi atau jaminan atomik sampai spawn.
- Metadata dan run melewati pemeriksaan grant terhadap store publikasi yang nyata. Riwayat observation tetap dapat dibaca setelah temporary directory dibersihkan; close dan cleanup tidak diartikan sebagai kepastian semua descendant sudah berhenti.

[Delta sumber dari increment sebelumnya](../../../../outputs/hermes-evidence/2026-09-08/runtime-source-coverage/changes.patch) dan [patch gabungan dari salinan C10](../../../../outputs/hermes-evidence/2026-09-08/runtime-source-coverage/combined-from-c10.patch) tersedia untuk ditinjau. Keduanya diperiksa dengan `git apply --check` pada basis masing-masing; tidak diaplikasikan ke produksi atau C10 yang terdaftar.

## Bukti pengujian

**245 kasus unik, 1.433 assertion, 0 gagal; 50 kasus baru dan 195 regresi yang sudah ada.** Iterasi ulang tidak dihitung sebagai kasus tambahan. TypeScript dan Ultracite lulus pada seluruh 17 berkas yang berubah. Roster sumber memuat 2.178 berkas reguler dan 177 symlink; seluruh 2.172 berkas basis sebelumnya diverifikasi kembali.

| Kelompok pada proses Bun terpisah | Kasus | Assertion | Batas pengujian |
| --- | ---: | ---: | --- |
| Regresi sesi, principal, inventaris, delegasi, publikasi dan tool loop | 191 | 1.092 | Bash biasa memakai sandbox Atlas; provider sintetis |
| Observation metadata yang sudah ada | 4 | 30 | Filter metadata saja; kasus runner nyata tidak dijalankan |
| Spawner kustom | 17 | 117 | Preparation/receipt nyata; child, stream dan signal tiruan |
| Saksi berkas masuk modul | 9 | 46 | Berkas, direktori dan symlink fixture; tanpa eksekusi modul |
| Metadata/runtime/inventaris langsung | 15 | 57 | Grant store nyata, JavaScript dan skill; child tiruan |
| AgentService dan Hono | 9 | 91 | Sesi baru/tersimpan, API/native tiruan, worker dan sub-agent; child tiruan |

Uji HTTP memakai AgentService, database, authorizer, resolver, tool loop dan Hono yang nyata. Fixture mengamati registrasi ledger asli tanpa menggantinya. Respons custom dalam uji ini berupa teks/JSON; tidak dibuat klaim baru tentang publikasi artefak dari custom worker. Uji publikasi berkas tetap ada dalam kelompok regresi.

[Roster kasus dan kelompok](../../../../outputs/hermes-evidence/2026-09-08/runtime-source-coverage/test-inventory.json), [hasil gate](../../../../outputs/hermes-evidence/2026-09-08/runtime-source-coverage/final-gates.json), [roster perubahan sumber](../../../../outputs/hermes-evidence/2026-09-08/runtime-source-coverage/source-changes.json), dan [input hash gate akhir](../../../../outputs/hermes-evidence/2026-09-08/runtime-source-coverage/final-source-gate-input.json) menyimpan rincian yang dapat diperiksa.

## Kegagalan dan koreksi yang dipertahankan

1. Spawner awal mengabaikan registrar: gate awal 1 lulus/13 gagal. Implementasi observation kemudian menutup perilaku tersebut; gate akhirnya berisi 17 kasus.
2. Perubahan modul selama callback izin metadata semula masih dapat dieksekusi. Kasus negatif disimpan dan pemeriksaan sumber diulang setelah callback sebelum startup.
3. Review tim menemukan celah urutan principal dan konfigurasi pada akhir registrasi. Fixture pertama mencabut otoritas terlalu awal sehingga sudah ditangkap pemeriksaan lama; hasil hijau itu tidak dianggap reproduksi. Fixture yang diperbaiki pada salinan diagnostik kode sebelum perbaikan menghasilkan 0 lulus/1 gagal. Kode akhir menolaknya sebelum child dimulai.
4. Fixture `close` kedua semula keliru mengharapkan listener `once` mengamati event itu. Fixture diganti dengan error child yang benar-benar dicatat, dan cache kini juga memeriksa keberhasilan observation metadata terkini. Kedua hasil lama tetap disimpan.
5. Tiga kegagalan awal fixture HTTP mengharapkan callback root publikasi untuk hasil teks yang tidak menyiapkan artefak. Assertion diganti dengan bukti registrasi runtime asli, tanpa mengarang artefak. Kesalahan sintaks/tipe fixture, lint, dan readback hash saat formatter mengubah berkas juga tetap diarsipkan.

[Catatan seluruh jenis percobaan](../../../../outputs/hermes-evidence/2026-09-08/runtime-source-coverage/retained-attempt-notes.json), [reproduksi izin pada kode lama](../../../../outputs/hermes-evidence/2026-09-08/runtime-source-coverage/logs/root-final-authority-original-v1.log), dan [review sumber dari agen tim yang sama](../../../../outputs/hermes-evidence/2026-09-08/runtime-source-coverage/agent-root-runtime-review.json) menjelaskan koreksi tersebut. Review ini berasal dari anggota tim yang juga menulis komponen dan tes; bukan reviewer buta atau penerimaan studi pembanding.

## Batas penerimaan dan pekerjaan berikutnya

- Belum ada pengujian child kustom nyata atau bukti enforcement sandbox baru. Jalur evidence wajib kustom ini saat ini khusus macOS; dukungan platform lain tidak disimpulkan dari transport yang tersedia.
- Hash hanya memeriksa berkas masuk modul. Dependency tree, closure eksternal, executable/runtime bytes, dan bytes yang benar-benar dieksekusi tidak dipin. Tidak ada lease atomik lintas filesystem, ACL, konfigurasi dan spawn; pergantian di sela pemeriksaan tetap merupakan batas.
- Cold `resolveSession` belum menerima signal pembatalan permintaan HTTP. Putusnya koneksi pada fase metadata awal belum termasuk bukti pembatalan increment ini. Ini prioritas increment berikutnya, termasuk penghentian tunggu dan pencegahan callback terlambat memulai proses.
- MCP dengan koneksi persisten memerlukan ledger lifetime dan registri koneksi tersendiri; cache berdasarkan key saja serta startup bersamaan belum dijadikan bukti proses yang lengkap. [Temuan lifetime MCP](../../../../outputs/hermes-evidence/2026-09-08/runtime-source-coverage/agent-mcp-lifetime-followup.json) dipertahankan untuk tindak lanjut. Coverage Composio, tool eksternal dan topology host juga belum lengkap.
- Bootstrap tetap mati. Tidak ada adopsi sumber produksi, commit, deployment, aktivasi provider, rilis reviewer yang ditahan, atau admission studi baru.
- Inspector dokumen penerus belum diterima. Renderer yang dihentikan tidak dicoba ulang, dialihkan, atau dirumuskan ulang. Paket fresh/kalibrasi dan fixed C10 tidak disentuh.

[Verifikasi arsip](../../../../outputs/hermes-evidence/2026-09-08/runtime-source-coverage/verification.json) dan [manifest payload](../../../../outputs/hermes-evidence/2026-09-08/runtime-source-coverage/manifest.json) mencatat sumber, patch dan log yang disegel. Roster salinan kerja tidak menggantikan roster C10 terdaftar sebanyak 2.126 berkas. Bukti increment ini mendukung kontrol runtime yang teruji dalam ruang lingkup di atas, belum klaim Atlas setara atau lebih baik daripada Hermes.
