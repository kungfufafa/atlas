# Publikasi melalui sesi AgentService — eksplorasi terpisah, 2026-09-08

Mode publikasi sekarang dapat dipasang melalui konfigurasi host tepercaya pada AgentService. HTTP menyiapkan principal dan pasangan guard/scope/lifecycle baru untuk setiap turn, kemudian memilih sesi dengan mode cache yang sesuai. Mode ini tidak berasal dari body permintaan. Pemanggil internal biasa tetap menggunakan jalurnya; konfigurasi baru belum dipasang pada bootstrap server produksi.

Host menyimpan pasangan hook dalam WeakMap privat. Sesi publikasi menolak hook yang hilang, null, dicampur, diganti, sudah dipakai, atau berasal dari host/sesi lain sebelum provider masuk. Pasangan yang sah dikonsumsi sekali per send/stream; satu turn tetap dapat memiliki beberapa invocation tool. Opsi disalin sebelum eksekusi tertunda, dan callback checkpoint mempertahankan receiver semula. Principal tetap memeriksa akses terkini pada setiap tool, termasuk sesudah provider mulai bekerja.

Cache kini membedakan mode publikasi dan, untuk mode tersebut, channel sesi. Konteks efek memakai pemilik sesi yang tersimpan; principal menyimpan invoker HTTP atau worker aslinya untuk pemeriksaan akses. Aturan kepemilikan sesi manusia yang sudah ada tidak diperluas. Workspace mode publikasi dikanonisasi oleh host sebelum masuk ke [scope invocation](../publication-host-scope/report.md), dan resolver Bash/Python menerima kebijakan yang mengambil scope aktif setiap pemanggilan.

Reproduksi tambahan menemukan bug integrasi: pembacaan pesan saat turn publikasi masih berjalan memilih mode biasa, mengganti cache, dan tidak menampilkan pesan pengguna yang masih aktif. Reproduksi gagal dan source sebelumnya dipertahankan. Jalur baca/context/compact sekarang mempertahankan mode cache organisasi yang sama. Compact memeriksa status sibuk sebelum resolusi dan memeriksa ulang setelah await. Reproduksi yang sama kemudian lulus.

| Gate | Hasil |
|---|---|
| Integrasi pertama, sebelum metadata fixture diperbaiki | 1 lulus / 9 gagal; dukungan tool model fixture masih unknown |
| Integrasi kedua | 5 lulus / 5 gagal; asumsi fixture tentang overwrite dan jumlah checkpoint keliru |
| Integrasi dengan metadata/ekspektasi yang benar dan penolakan lintas host/sesi | 11 tes / 130 assertion lulus |
| Reproduksi bug pembacaan sesi aktif | 1 gagal, source dan log disimpan |
| Regresi awal tujuh berkas | 83 tes / 459 assertion lulus |
| Gate akhir setelah perbaikan baca/compact | 52 tes / 319 assertion lulus, mencakup 12 tes integrasi baru dan 40 regresi yang diulang |
| TypeScript produksi/tes serta lint empat berkas | Lulus |

Gabungan pada increment ini adalah **95 tes unik, termasuk 12 tes baru**. Gate 52 tes tidak ditambahkan seluruhnya di atas 83 tes sebelumnya. Kesalahan typing fixture dan penolakan patch-context yang tidak mengubah source juga disimpan. Pemeriksaan kapabilitas produk tetap berlaku; fixture secara eksplisit menyatakan kemampuan tool yang memang diimplementasikan provider sintetisnya.

Tes menggunakan AgentService, build sesi, cache, resolver, persistence, auth dan handler Hono yang sebenarnya. Tidak ada mock `buildChatSession`. Empat kombinasi API/native-callback dan send/stream membuat publikasi byte, memakai ulang sesi yang sama, dan mempertahankan snapshot setelah setiap file sumber diganti. Versi artefak baru diperiksa melalui `sourcePath` yang benar-benar dikembalikan. Worker Discord mempertahankan identitas pemilik sesi, pencabutan membership saat provider berjalan mencegah write, dan kegagalan inventory mempertahankan path/bytesWritten receipt, file serta history tanpa replay. Satu runner Bash cached menulis dua efek nyata dengan dua pemeriksaan grant; Bash pada fixture ini tidak menerbitkan snapshot.

Provider seluruh tes bersifat lokal sintetis. “Native” berarti callback executor bersama, bukan proses subscription sebenarnya. Request menggunakan `app.fetch`, tanpa server TCP atau browser. DB berada di memori, sehingga pemulihan setelah restart tidak dibuktikan. Ini bukti integrasi backend dalam cakupan tersebut, bukan hasil kualitas jawaban model.

**Aktivasi global masih belum lengkap.** Callback inventory host bukan bukti bahwa seluruh authority runtime sudah diketahui. Fixture publikasi memakai producer `write_file` sederhana. Inventaris proses/temp sesungguhnya, kepemilikan output Bash/Python, dedicated document workers, custom/skill discovery, koneksi MCP persisten dan delegated child masih perlu diikat. Jalur task/automation/playground serta konsumen UI/kanal belum dimigrasikan seluruhnya. Tidak ada jaminan baru tentang semua authority OS, hardlink alias, perubahan host atomik, rollback efek atau pencabutan receipt yang sudah diserahkan.

Agent menulis integrasi AgentService/route dan meninjau helper/tes root; root meninjau perubahan agent dan menjalankan seluruh gate perilaku. Ini review timbal balik, tanpa rerun independen seluruh sistem atau reviewer arsip terpisah. [Delta empat berkas](../../../../outputs/hermes-evidence/2026-09-08/publication-session-integration/changes.patch), [patch gabungan dari C10](../../../../outputs/hermes-evidence/2026-09-08/publication-session-integration/combined-from-c10.patch), [verifikasi](../../../../outputs/hermes-evidence/2026-09-08/publication-session-integration/verification.json) dan [manifest](../../../../outputs/hermes-evidence/2026-09-08/publication-session-integration/manifest.json) disimpan. Kedua patch lolos `git apply --check`; 2.140 anggota baseline eksplorasi sebelumnya dan 2.129 anggota baseline salinan C10 tidak berubah. Roster tersebut tidak mengganti roster studi C10 sebanyak 2.126 berkas.

Salinan kerja: `/private/tmp/atlas-publication-session-integration-20260908/source`. Belum diadopsi, di-commit atau di-deploy. Tidak ada panggilan model, pembukaan bahan tugas/kalibrasi baru, pengulangan renderer yang dihentikan, atau perubahan admission studi. Hasil pembanding sah terakhir tetap [Atlas 44/54 dan Hermes 46/54](../hermes-native-files-v3-c9-confirmation/report.md); tujuan setara atau lebih baik belum tercapai.
