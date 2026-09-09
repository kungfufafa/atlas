# MCP: hasil lama tidak menimpa konfigurasi baru

Perbaikan dalam salinan sumber terpisah menolak hasil connect/sync yang sudah kedaluwarsa setelah perubahan konfigurasi, disable, delete, atau refresh yang lebih baru. **249 tes unik / 1.405 assertion lulus**, termasuk 78 tes baru; typecheck dan lint mencakup delapan berkas TypeScript yang berubah. Ada satu tambahan perubahan skema SQL. Bukti ini tidak mengubah hasil perbandingan terakhir: **Atlas 44/54, Hermes 46/54**, sehingga klaim setara/lebih baik belum terbukti. [Hasil C9](../hermes-native-files-v3-c9-confirmation/report.md).

Database menyimpan revisi privat dan identitas operasi refresh. Penyelesaian hanya boleh memperbarui status, katalog, error, dan timestamp jika identitasnya masih berlaku. Penulisan lama tidak menggunakan upsert. Update/delete administratif melakukan pemeriksaan dan penulisan bersyarat sebelum menunggu disconnect; delete juga memeriksa assignment pada saat penulisan. Revisi berubah walaupun timestamp dan konfigurasi berulang. SQLite memakai transaksi untuk snapshot dan penulisan dengan pembacaan hasil; delete adalah satu pernyataan bersyarat. Trigger mencakup penulisan adapter lama. Adapter memori menyalin nilai agar mutasi objek hasil baca tidak mengubah penyimpanan.

Perubahan konfigurasi mengosongkan katalog lama dan menandai disconnected. Disable memutus koneksi. Respons update mempertahankan jumlah profil terpasang; connect/sync kini mengembalikan jumlah tersebut juga. Error listener atau disconnect setelah commit tetap bisa membuat permintaan gagal, tetapi tidak memicu penulisan ulang dari record lama atau pengulangan operasi manager.

| Kelompok final | Tes | Assertion |
|---|---:|---:|
| Layanan baru: stale completion, assignment count, disconnect/listener | 56 | 486 |
| Kontrak database baru | 22 | 96 |
| Regresi migrasi, seed, reopen, org/profile | 72 | 299 |
| Regresi layanan, bridge, Composio, inventori sesi | 69 | 305 |
| Regresi lifecycle manager | 24 | 159 |
| Regresi observasi persiapan koneksi | 6 | 60 |

Hitungan memakai pasangan berkas/nama tes; pengulangan tidak menambah tes unik. Satu tes lama yang benar-benar memulai worker MCP difilter sebelum eksekusi dan tidak dihitung lulus. [Gate final](../../../../outputs/hermes-evidence/2026-09-08/mcp-service-stale-writes/final-gates.json), [inventori tes](../../../../outputs/hermes-evidence/2026-09-08/mcp-service-stale-writes/test-inventory.json).

Kegagalan tidak dibuang: baseline 44 kasus menghasilkan 2 lulus/42 gagal; implementasi pertama 26 lulus/18 gagal; uji database pertama 11 lulus/11 gagal. Probe Bun 1.3.1 menunjukkan `.changes` menghitung perubahan trigger juga: satu update utama menghasilkan 2. Pemeriksaan sukses kini memakai `RETURNING id`. Hasil refresh memori yang bertipe lebih luas sempat dapat menimpa konfigurasi; assignment field eksplisit memperbaikinya. Enam uji jumlah profil gagal pada implementasi pertama: dua memulihkan regresi update, empat memperluas konsistensi connect/sync karena baseline juga belum memberikan jumlah tersebut. Dua belas kasus tambahan dan penguatan assertion status 409 dinyatakan sebagai perluasan cakupan, bukan reproduksi baseline baru. [Catatan seluruh percobaan](../../../../outputs/hermes-evidence/2026-09-08/mcp-service-stale-writes/retained-attempt-notes.json).

Review dilakukan oleh rekan satu tim yang menulis tes layanan; bukan review buta atau kualifikasi studi perbandingan. Root memeriksa ulang referensi hash dan meninjau fixture. Tidak ditemukan blocker tersisa dalam batas perubahan DB/service ini. [Review](../../../../outputs/hermes-evidence/2026-09-08/mcp-service-stale-writes/agent-stale-root-review.json), [pembacaan ulang referensi](../../../../outputs/hermes-evidence/2026-09-08/mcp-service-stale-writes/handoff-reference-readback.json).

Batas bukti: manager/SDK/transport MCP tiruan; SQLite nyata, termasuk dua koneksi dan reopen dalam proses yang sama. Ini bukan bukti restart proses penuh atau worker MCP nyata. Hanya regresi Bash biasa menggunakan proses nyata dengan sandbox Atlas; kelompok receipt memakai persiapan nyata dengan SDK tiruan. Identitas DB tidak mengikat secara atomik lifetime manager, penghentian proses, atau izin pemanggil. Status connected adalah observasi tersimpan. Create/test MCP, pembatalan per pemanggil, dan pemeriksaan ulang izin/generasi setelah startup masih memerlukan pekerjaan berikutnya.

Sumber berada di `/private/tmp/atlas-mcp-service-stale-writes-20260908/source`: 2.187 berkas reguler, 177 symlink; delta 9 berkas (4 baru, 5 diubah) dari checkpoint sebelumnya. Sumber produksi utama, C10 tetap, bootstrap, kontrol Hermes, dan admission studi tidak diubah. Tidak ada panggilan model/provider, renderer dokumen, atau pelepasan reviewer studi. [Patch increment](../../../../outputs/hermes-evidence/2026-09-08/mcp-service-stale-writes/changes.patch), [patch kumulatif dari C10](../../../../outputs/hermes-evidence/2026-09-08/mcp-service-stale-writes/combined-from-c10.patch), [identitas sumber](../../../../outputs/hermes-evidence/2026-09-08/mcp-service-stale-writes/source-changes.json).

Lanjutan yang diperlukan: ikat dispatch bridge ke izin, sinyal pembatalan, dan generasi koneksi yang masih berlaku setelah startup. Satu pemanggil yang membatalkan tidak boleh memutus koneksi sehat milik pemanggil lain. Studi kualitas baru tetap menunggu bukti inspeksi yang diterima; hasil uji kode ini tidak memenuhi persyaratan tersebut.
