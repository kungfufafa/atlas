# Record proses dan publikasi — eksplorasi terpisah, 2026-09-08

Publikasi kini dapat memakai bukti izin proses yang tetap dapat diperiksa setelah direktori sementara dibersihkan. Store mengeluarkan keputusan privat untuk objek evidence yang benar-benar lolos pemeriksaannya. Record invocation mengikat keputusan itu ke receipt persiapan asli, observasi runner, dan identitas publikasi. Keputusan milik store lain, evidence hasil salinan, receipt tanpa keputusan yang sesuai, serta handle observasi palsu ditolak.

Runner Bash/Python menunggu registrasi sebelum spawn. Observasi memisahkan registrasi, percobaan spawn, event spawn, error, event close, settlement tubuh runner, dan cleanup. Pembaruan observasi berlangsung secara internal tanpa callback eksternal setelah efek. Kegagalan tracking membuat publikasi tidak memenuhi syarat; hasil tool yang sudah diperoleh tetap dipertahankan. Error cleanup yang sebenarnya tetap mengikuti precedence runner sebelumnya.

Finalisasi membutuhkan jumlah entry runner yang sesuai dengan launch terdaftar serta observasi terminal yang lengkap. Persiapan dan cleanup saja tidak memenuhi syarat. Penolakan record menghapus snapshot staging, menahan commit, dan menolak retry publikasi tanpa meminta eksekusi ulang tool. Identitas store diperiksa lagi; direktori sementara yang sudah dihapus tidak diperlakukan sebagai runtime aktif yang harus di-stat ulang.

Konfigurasi host sesi sekarang menyediakan dua kontrak inventory yang eksplisit dan eksklusif. Kontrak lama tetap mencakup seluruh root tool. Kontrak alternatif menyertakan record proses invocation serta callback untuk authority lain yang belum dicakup record tersebut. Kehadiran callback tidak membuktikan inventory lengkap. Mode host tetap opsional dan belum dipasang pada bootstrap produksi.

| Gate akhir yang tidak tumpang tindih | Tes | Assertion |
|---|---:|---:|
| Observasi proses baru | 14 | 118 |
| Regresi runner/admission | 37 | 142 |
| Regresi publikasi, scope, grant dan route | 77 | 441 |
| Record runtime dan integrasi sesi HTTP | 25 | 245 |
| **Gabungan** | **153** | **946** |

Terdapat **27 tes baru**: 14 observasi, 12 record, dan satu integrasi inventory sesi. TypeScript produksi dan tes terarah tanpa diagnostic; lint 14 berkas lulus. [Inventaris tes](../../../../outputs/hermes-evidence/2026-09-08/publication-runtime-record/test-inventory.json) mempertahankan kemunculan terpisah untuk kasus parameterized dengan judul reporter yang sama. Rerun sebelumnya tidak ditambahkan ke jumlah unik.

Uji nyata menjalankan dua Bash dan dua Python dalam satu invocation masing-masing, lalu memublikasikan byte stdout setelah cleanup. Fixture HTTP memakai AgentService, resolver dan runner Bash cached yang sebenarnya untuk dua turn, dengan record dan execution identity berbeda. Snapshot dapat dibaca melalui route setelah temp dihapus; hasil tool yang tersimpan tetap sama. Staging stdout dibuat oleh wrapper fixture tepercaya: ini belum menambahkan publikasi stdout otomatis pada runner produk.

Dua race finalisasi ditemukan dan diperbaiki. Reproduksi pertama menunjukkan dua validasi berjalan ketika seal pertama belum selesai; sekarang pemanggil menunggu satu promise dan state `sealing` terpisah. Review kemudian menemukan bahwa penutupan pada sela microtask setelah pemeriksaan terakhir masih dapat ditimpa menjadi `sealed`. Reproduksi aslinya gagal; pemeriksaan state tepat setelah await menutup celah itu dan tes yang sama lulus. Penutupan ketika validasi masih menunggu serta keputusan store salah yang ditangkap pemanggil juga tetap menolak seal.

Seluruh hasil gagal awal disimpan: empat fixture salah membandingkan referensi objek hasil yang dilindungi dengan salinan, dua reproduksi race, error typing parameter registrar, resolusi tipe Bun/formatter, dan dua penolakan parser inventaris metadata. Koreksi fixture tidak mengubah gate produk. Detail dan batas pengujian ada pada [verifikasi](../../../../outputs/hermes-evidence/2026-09-08/publication-runtime-record/verification.json).

Record hanya mencakup launch yang melalui runner berinstrumen. Record kosong bukan sertifikat inventory lengkap. Receipt dan keputusan bersifat process-local; ini bukan pemulihan record setelah restart. Close/settlement/cleanup tidak membuktikan seluruh descendant telah berhenti, kepemilikan semua byte output, perubahan host atomik, atau seluruh authority OS. Bootstrap Python, delegated child, discovery/custom tools, koneksi MCP persisten, task/automation/playground dan dedicated worker masih perlu ditangani sebelum aktivasi global.

Provider pada fixture HTTP sintetis, DB di memori, dan request memakai Hono `app.fetch`; tidak ada pengujian browser/TCP, subscription sebenarnya, atau kualitas model. Tidak ada renderer dokumen maupun panggilan model dijalankan. Root dan agent saling meninjau source; agent menemukan race lanjutan dan mengonfirmasi koreksinya tanpa rerun. Arsip dibaca ulang root, tanpa reviewer arsip terpisah.

[Delta 14 berkas](../../../../outputs/hermes-evidence/2026-09-08/publication-runtime-record/changes.patch) dan [patch gabungan dari C10](../../../../outputs/hermes-evidence/2026-09-08/publication-runtime-record/combined-from-c10.patch) lolos `git apply --check`. Sebanyak 2.142 anggota baseline eksplorasi sebelumnya dan 2.129 anggota baseline salinan C10 tetap byte-identical; inventaris salinan ini tidak mengganti roster studi C10 2.126 berkas. Source berada di `/private/tmp/atlas-publication-runtime-record-20260908/source`, belum diadopsi, di-commit atau di-deploy. [Manifest arsip](../../../../outputs/hermes-evidence/2026-09-08/publication-runtime-record/manifest.json) mengikat source, kegagalan, log dan laporan.

Hasil pembanding sah tetap [Atlas 44/54 dan Hermes 46/54](../hermes-native-files-v3-c9-confirmation/report.md). Admission studi, bahan fresh/kalibrasi dan penghentian renderer tidak berubah. Tujuan setara atau lebih baik masih aktif dan belum tercapai.
