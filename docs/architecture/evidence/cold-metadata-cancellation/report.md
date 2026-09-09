# Pembatalan saat metadata sesi dimuat

Tanggal: 2026-09-08. Status: increment terbatas pada salinan sumber terpisah; belum diadopsi ke sumber produksi atau fixed C10.

Permintaan pesan yang dibatalkan sekarang meneruskan sinyal pembatalan ke persiapan giliran dan pemuatan metadata JavaScript/skill. Pemeriksaan setelah operasi asinkron mencegah callback terlambat membuat klien provider, memasang cache sesi, atau memulai metadata berikutnya. Pemilik giliran dipasang sebelum hasil `beginSessionTurn` melewati batas asinkron; terminal dari giliran lama hanya boleh menutup giliran miliknya. Jalur sesi biasa dan mode publikasi sama-sama dicakup.

Hasil perbandingan model yang sah tetap **Atlas 44/54 versus Hermes 46/54** pada [konfirmasi C9](../hermes-native-files-v3-c9-confirmation/report.md). Gerbang klaim belum lolos. Pengujian di bawah adalah bukti perilaku perangkat lunak dengan provider dan child kustom tiruan, bukan tambahan sampel kualitas model atau bukti kesetaraan dengan Hermes. Tidak ada panggilan model, subscription, atau renderer dokumen pada increment ini.

## Perubahan perilaku

- Route pesan menggabungkan pembatalan permintaan dan pemilik giliran sejak awal. Pembacaan otorisasi dan resolusi sesi dapat berhenti ditunggu; callback yang selesai belakangan tetap diamati agar penolakannya tidak menjadi rejection tak tertangani atau membuat entri registry/cache terlambat.
- Admission metadata ditutup sekali saat batal. Pemeriksaan sebelum dan sesudah callback izin mencegah callback terlambat membuka kembali admission atau masuk ke loader lain. Pemuatan metadata biasa mendapat sinyal per-resolusi dan tidak mengubah pembatalan menjadi tool placeholder sukses.
- Sinyal metadata tidak menjadi otoritas pembatalan untuk eksekusi berikutnya. Admission yang berhasil disegel melepaskan listener; cache dan tool yang sah memakai sinyal giliran baru. Tes berikutnya berhasil setelah sinyal permintaan lama dibatalkan.
- Persiapan delegasi meneruskan sinyal yang sudah dibatasi ke resolusi tool. Pemeriksaan sebelum membuat harness mencegah konstruksi provider setelah pembacaan konteks atau riwayat selesai terlambat.
- Fixture kanal mengikat metode persiapan autentikasi milik `AgentService` nyata yang sebelumnya hilang dari facade tes. Ketiga assertion alur kuesioner tetap utuh; ini koreksi fixture, bukan pelonggaran kontrak produk.

## Validasi dan reproduksi

**404 tes unik, 2221 assertion, 33 tes baru** lulus pada 32 berkas tes. TypeScript dan Ultracite lulus untuk seluruh **16 berkas perubahan** (3 baru, 13 dimodifikasi). Kelompok yang memakai mock global child/stream/signal dijalankan dalam proses Bun terpisah. Regression Bash biasa tetap menggunakan sandbox proses Atlas.

| Kelompok | Tes lulus | Assertion |
| --- | ---: | ---: |
| existing-regression | 317 | 1698 |
| metadata | 4 | 30 |
| custom-spawner | 17 | 117 |
| witness | 9 | 46 |
| custom-host | 20 | 73 |
| http | 9 | 91 |
| admission-cancellation | 7 | 19 |
| skill-cancellation | 6 | 11 |
| http-cancellation | 15 | 136 |

Jumlah unik dihitung dari pasangan berkas dan nama tes pada [inventaris tes](../../../../outputs/hermes-evidence/2026-09-08/cold-metadata-cancellation/test-inventory.json), bukan jumlah pengulangan. [Gerbang akhir](../../../../outputs/hermes-evidence/2026-09-08/cold-metadata-cancellation/final-gates.json) dan [hasil perintah](../../../../outputs/hermes-evidence/2026-09-08/cold-metadata-cancellation/final-command-results.json) mengikat exit code dan log. Berkas sumber diverifikasi sama sebelum dan sesudah gerbang melalui [input sumber](../../../../outputs/hermes-evidence/2026-09-08/cold-metadata-cancellation/final-source-gate-input.json) serta [inventaris akhir](../../../../outputs/hermes-evidence/2026-09-08/cold-metadata-cancellation/final-source-inventory.json).

Kegagalan dipertahankan dalam [catatan percobaan](../../../../outputs/hermes-evidence/2026-09-08/cold-metadata-cancellation/retained-attempt-notes.json):

1. Tujuh tes admission baru pada salinan sumber sebelumnya menghasilkan **2 lulus/5 gagal**, lalu **7/0** setelah perbaikan. Baseline asli tidak diedit.
2. Reproduksi route awal menghasilkan **2/7**, tetapi memakai route lama bersama dependensi root yang sedang berkembang. Hasil ini secara eksplisit **bukan** reproduksi seluruh baseline murni.
3. Salinan diagnostik current source dengan satu penggantian `AgentService` dari snapshot tepat sebelum guard konstruksi provider menghasilkan **0/2**. Dalam kedua mode, factory provider tiruan terpanggil setelah pembatalan dan pelepasan pembacaan riwayat. Pada perbaikan, hitungan tetap nol; permintaan sehat berikutnya melakukan resolusi metadata baru dan membangun provider sekali. [Handoff route dan input diagnostik](../../../../outputs/hermes-evidence/2026-09-08/cold-metadata-cancellation/agent-cold-handoff.json) menyimpan hash dan batas reproduksinya.
4. Gerbang regresi tambahan pertama menghasilkan **314 lulus/3 gagal**. Ketiga kasus kuesioner gagal pula pada baseline sebelumnya: facade fixture tidak menyediakan `prepareAuthenticatedSessionTurnOptions`, sehingga menerima 500 sebelum memeriksa konflik 409. Diagnosis dan binding metode nyata dipertahankan; assertion produk tidak dihapus. Gerbang akhir memasukkan kembali seluruh kasus tersebut.
5. Kesalahan tipe helper Hono dan kegagalan setup snapshot/copy dicatat. Versi perantara yang sempat berlomba dengan mutasi konsumsi kuesioner juga disimpan; implementasi akhir tetap menunggu mutasi itu selesai.
6. Pembacaan ulang root menemukan satu referensi hash log penutupan yang sudah usang dari 44 referensi handoff: hash dicatat saat log masih kosong, kemudian ringkasan penutupan dicetak ke log yang sama. Referensi source dan gerbang tes/tipe/lint cocok. Catatan awal tidak diganti; [hasil pembacaan ulang](../../../../outputs/hermes-evidence/2026-09-08/cold-metadata-cancellation/handoff-reference-readback.json) mengikat bytes akhir dan menolak klaim bahwa seluruh referensi handoff awal cocok.

[Review sumber](../../../../outputs/hermes-evidence/2026-09-08/cold-metadata-cancellation/agent-cold-root-review.json) dilakukan oleh agen satu tim yang menulis route/tes, bukan reviewer buta atau kualifikasi independen studi Hermes. [Klarifikasi peran](../../../../outputs/hermes-evidence/2026-09-08/cold-metadata-cancellation/agent-cold-review-role-clarification.json) mempertahankan pembedaan itu tanpa mengganti catatan awal.

## Integritas dan batas

Salinan sebelumnya memuat 2.178 berkas reguler yang diverifikasi ulang; salinan akhir memuat 2.181 berkas dan 177 symlink dengan target tetap. Dependensi di balik symlink tidak disertifikasi. [Verifikasi patch](../../../../outputs/hermes-evidence/2026-09-08/cold-metadata-cancellation/verification.json) mencatat `git apply --check` terhadap baseline sebelumnya dan salinan C10 untuk [delta](../../../../outputs/hermes-evidence/2026-09-08/cold-metadata-cancellation/changes.patch) serta [patch gabungan](../../../../outputs/hermes-evidence/2026-09-08/cold-metadata-cancellation/combined-from-c10.patch). Roster salinan C10 tidak mengganti roster terdaftar 2.126 berkas. [Manifest](../../../../outputs/hermes-evidence/2026-09-08/cold-metadata-cancellation/manifest.json) dan [seal](../../../../outputs/hermes-evidence/2026-09-08/cold-metadata-cancellation/seal.json) mengikat payload arsip yang dibaca ulang oleh root; ini bukan review arsip independen.

Hono, AgentService, database, principal, pemilihan definisi dan persiapan admission digunakan nyata; custom child, stream dan signal sistem tetap tiruan. Permintaan HTTP boleh selesai dibatalkan saat observasi child yang sudah dimulai masih menunggu close/cleanup. Hasil tersebut tidak membuktikan penghentian fisik worker, penghentian descendant, atau ketiadaan semua efek terlambat.

Konsumsi kuesioner merupakan mutasi yang tetap ditunggu dengan pemeriksaan sinyal sebelum/sesudahnya; tidak ada klaim rollback. Efek MCP/Composio persisten yang sudah dimulai, seluruh setup/catalog/createSession/subscription, serta pinning atomik dependency/bytes berada di luar cakupan. Tenggat fixture dan jadwal promise terkontrol bukan benchmark latensi atau pembuktian seluruh kemungkinan penjadwalan.

Bootstrap host publikasi belum diaktifkan, sumber produksi utama belum diadopsi, fixed C10/studi tidak berubah, reviewer tetap ditahan, dan tidak ada inspector penerus yang diterima. Langkah berikutnya adalah menguji lalu memperbaiki startup koneksi MCP dengan kunci sama, generasi pengganti, disconnect selama startup, serta observasi lifetime yang tetap membedakan pembatalan logis dari cleanup nyata. Sasaran Atlas setara atau lebih baik dari Hermes tetap aktif dan belum tercapai.
