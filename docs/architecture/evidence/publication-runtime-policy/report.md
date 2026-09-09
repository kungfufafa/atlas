# Izin runtime untuk publikasi — eksplorasi terpisah, 2026-09-08

Pemeriksaan private store sekarang membedakan izin subtree, file literal, executable, serta daftar entri direktori. Ancestor yang hanya boleh dibaca nama entrinya tidak lagi diperlakukan sebagai izin membaca seluruh snapshot. Akses pada atau di dalam direktori snapshot tetap ditolak. Perubahan ini berada dalam salinan pengembangan terpisah yang melanjutkan [client publikasi](../publication-client-exploration/report.md); source C10 yang dibekukan tetap utuh.

`ArtifactPublicationStore.assertRuntimeGrantsDisjoint` memeriksa mapping platform/policy yang diketahui, canonical path, device/inode/type grant dan selector peluncuran, serta identitas private store yang ditangkap saat dibuat. Bentuk yang tidak diketahui, perubahan identitas, dan pemeriksaan filesystem yang gagal menolak admission dengan error tanpa path privat. API lama `assertOutsideToolRoots` tetap memperlakukan inputnya sebagai root luas.

`withPublicationInvocationAdmission` menyediakan scope host untuk satu pemanggilan tool: identitas publikasi ditangkap sebelum operasi asinkron, principal terautentikasi diperiksa, workspace profil diikat pada path dan identitasnya, lalu grant rencana proses diperiksa sebelum preparer menyerahkan rencana tersebut. Akses diperiksa kembali setelah verifikasi. Callback yang masih disimpan ditutup ketika scope berhasil, gagal, atau dibatalkan. Scope ini tidak boleh disimpan pada tool cache sesi atau koneksi MCP yang berumur panjang.

## Validasi

| Gate | Bukti akhir |
|---|---|
| Metadata enam grant, relasi path, alias/identitas, policy, redaksi error | 12 tes baru, 92 assertion lulus; dijalankan agent penulis checker |
| Scope invocation melalui preparer aktual dan satu Bash nyata | 9 tes baru, 27 assertion lulus; dijalankan root |
| Regresi service, lifecycle, dan route publikasi | 46 tes, 281 assertion lulus; dijalankan root |
| TypeScript produksi dan dua berkas tes baru | Lulus |
| Lint empat berkas perubahan | Lulus |

Jumlah tersebut adalah **21 tes baru dan 46 tes regresi pada giliran ini**, bukan tambahan 67 tes independen di atas seluruh tes giliran sebelumnya. Beberapa tes regresi memang sudah dijalankan pada pekerjaan client sebelumnya.

Gate invocation awal menghasilkan delapan tes lulus dan satu kegagalan Bash exit 71. Pengulangan diagnostik menyimpan stderr `sandbox-exec: sandbox_apply: Operation not permitted`. Gate yang sama kemudian lulus di luar sandbox luar Codex, dengan sandbox Atlas tetap aktif; shell hanya menulis berkas fixture di workspace miliknya. Source/policy Atlas tidak dilonggarkan. Sumber awal dan kegagalan lint checker juga dipertahankan.

Root meninjau sumber checker, sedangkan agent penulis checker meninjau helper invocation root. Tidak ada temuan blocker dalam scope tersebut. Ini review timbal balik atas komponen, bukan satu reviewer yang secara independen menulis atau menjalankan ulang keseluruhan sistem.

## Yang belum terbukti

Checker melihat grant eksplisit pada rencana yang disiapkan; ia tidak mengautentikasi JSON evidence sendiri atau membuktikan seluruh authority implisit OS/bootstrap. Ancestor listing dapat mengungkap nama direktori. Tidak ada jaminan terhadap hardlink alias, perubahan host atomik setelah pemeriksaan, atau semua proses lain di mesin.

Evidence Linux/custom pada tes metadata bersifat sintetis dan tidak memasang policy platform tersebut. Preparasi standard/MCP aktual serta child positif Bash diuji pada macOS. Scope yang ditutup menolak otorisasi baru; rencana proses atau receipt yang sudah diserahkan tidak dicabut secara retroaktif. Pembatalan setelah spawn, rollback efek, dan atribusi artefak dari seluruh child belum dibuktikan.

Helper belum dipasang ke lifecycle/resolver AgentService yang memakai tool cache, discovery custom/skill, atau koneksi MCP persisten. Langkah berikutnya adalah mengikat scope ini dan lifecycle snapshot pada identitas pemanggilan yang sama di batas eksekusi host, tanpa mengandalkan metadata hasil tool. Aktivasi chat otomatis, UI/share/kanal, dan pemulihan seluruh alur tetap terbuka.

Tidak ada isi tugas/oracle/kalibrasi baru yang dibaca, renderer yang dihentikan diulang, panggilan model, atau perubahan admission studi. Hasil pembanding sah terakhir tetap [Atlas 44/54 versus Hermes 46/54](../hermes-native-files-v3-c9-confirmation/report.md); belum ada klaim setara atau lebih baik.

## Patch dan log

[Delta pekerjaan ini](../../../../outputs/hermes-evidence/2026-09-08/publication-runtime-policy/changes.patch), [patch gabungan dari C10](../../../../outputs/hermes-evidence/2026-09-08/publication-runtime-policy/combined-from-c10.patch), [verifikasi](../../../../outputs/hermes-evidence/2026-09-08/publication-runtime-policy/verification.json), dan [manifest sumber/log](../../../../outputs/hermes-evidence/2026-09-08/publication-runtime-policy/manifest.json) disimpan di repository. Pemeriksaan byte mengonfirmasi 2.131 berkas baseline salinan client sebelumnya dan 2.129 berkas baseline asal C10 tetap utuh; ini roster salinan kerja, bukan definisi baru hash studi.

Salinan kerja saat ini: `/private/tmp/atlas-publication-runtime-policy-20260908/source`. Belum diadopsi ke source C10 asal, di-commit, atau di-deploy.
