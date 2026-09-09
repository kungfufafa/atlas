# MCP: pembatalan diuji dengan SDK terpasang

Salinan sumber terpisah kini melepas hubungan sinyal pembatalan setelah satu panggilan MCP selesai. **258 tes unik / 920 assertion lulus**, termasuk **23 tes baru** dengan Client, Protocol, dan validator SDK MCP terpasang versi 1.29.0. Typecheck dan lint lulus untuk dua berkas TypeScript yang berubah. Hasil perbandingan model tetap **Atlas 44/54 dan Hermes 46/54**; klaim setara atau lebih baik belum terbukti. [Hasil C9](../hermes-native-files-v3-c9-confirmation/report.md).

Uji awal menemukan empat kegagalan dari 23 kasus: sinyal yang dibatalkan setelah request selesai masih mengirim notifikasi cancellation untuk request sukses, error remote, dan kegagalan pengiriman; menutup koneksi setelah satu request selesai dan satu masih aktif mengirim dua cancellation. SDK terpasang mempertahankan listener abort setelah request selesai. Atlas sekarang meneruskan sinyal melalui controller per panggilan, lalu melepas listener penerus dalam `finally`. Request yang aktif tetap menerima pembatalan dan alasan asalnya; panggilan tidak diulang.

Transport pengujian adalah peer JSON-RPC dalam memori yang dikendalikan fixture. SDK Client tidak ditiru. Tes memeriksa handshake, katalog/schema, pengiriman request sinkron, ID request untuk hasil yang datang tidak berurutan, isolasi pembatalan, startup bersama, penggantian koneksi, cleanup setelah kegagalan, error protokol, serta validasi output schema. Notifikasi cancellation diperiksa dari pesan yang benar-benar dikirim SDK. Batas waktu yang dibuktikan adalah **setelah hasil panggilan Atlas selesai**, bukan tepat ketika respons baru tiba sebelum kelanjutan Promise berjalan.

| Gate final | Tes | Assertion |
|---|---:|---:|
| SDK terpasang + peer dalam memori | 23 | 75 |
| Regresi binding koneksi | 23 | 103 |
| Regresi lifecycle manager | 24 | 159 |
| Regresi authorization DB dan bridge | 87 | 206 |
| Regresi layanan, tenancy, Composio, inventori sesi | 101 | 377 |

[Gate final](../../../../outputs/hermes-evidence/2026-09-08/mcp-sdk-contract/final-gates.json) dan [inventori tes](../../../../outputs/hermes-evidence/2026-09-08/mcp-sdk-contract/test-inventory.json) menghitung tiap tes sekali. Satu tes startup worker MCP nyata difilter sebelum berjalan dan tidak dihitung lulus. Regresi Bash biasa memakai sandbox Atlas. Tidak ada panggilan provider/model, worker MCP nyata, HTTP MCP nyata, atau renderer dokumen.

Semua kegagalan dipertahankan, termasuk tiga tahap koreksi tipe fixture: timestamp/org, metadata `lastError` dan `satisfies`, lalu import tipe yang sebelumnya dibuang formatter saat belum dipakai. Format dan typecheck eksplorasi pertama sempat tumpang tindih; gate final memakai sumber yang sudah stabil. Snapshot fixture awal dan final terikat hash; tidak setiap perubahan tipe perantara mempunyai snapshot tersendiri. [Catatan percobaan](../../../../outputs/hermes-evidence/2026-09-08/mcp-sdk-contract/retained-attempt-notes.json).

Sebanyak 677 berkas reguler paket SDK diinventori sebelum gate final dan diperiksa ulang sesudahnya. Ini tidak mengikat seluruh dependensi transitif atau menjamin byte yang dieksekusi secara atomik; snapshot dependensi juga tidak dibuat sebelum run gagal awal. [Readback SDK](../../../../outputs/hermes-evidence/2026-09-08/mcp-sdk-contract/installed-sdk-final-readback.json). Review rekan satu tim menilai implementasi dan fixture; ini bukan review buta atau bukti kualitas model. [Review](../../../../outputs/hermes-evidence/2026-09-08/mcp-sdk-contract/agent-sdk-review-v1.json).

Sumber berada di `/private/tmp/atlas-mcp-sdk-contract-20260908/source`: 2.193 berkas reguler dan 177 symlink; delta dua berkas, satu baru dan satu diubah. Sumber produksi utama, C10 tetap, bootstrap, kontrol Hermes, dan admission studi tidak diubah. [Patch increment](../../../../outputs/hermes-evidence/2026-09-08/mcp-sdk-contract/changes.patch), [patch kumulatif C10](../../../../outputs/hermes-evidence/2026-09-08/mcp-sdk-contract/combined-from-c10.patch), [identitas sumber](../../../../outputs/hermes-evidence/2026-09-08/mcp-sdk-contract/source-changes.json).

Audit source paralel menemukan jalur Composio masih memeriksa akses sebelum beberapa operasi tunggu, mengirim lewat kunci endpoint tanpa binding koneksi, dan belum membawa sinyal konteks ke dispatch tersebut. Cache konfigurasi dan fingerprint lintas manager juga perlu direproduksi. Enam rancangan uji sintetis sudah dicatat, belum dijalankan dalam increment ini. [Audit Composio](../../../../outputs/hermes-evidence/2026-09-08/mcp-sdk-contract/agent-composio-endpoint-source-audit.json). Itu pekerjaan berikutnya; pengujian kualitas model baru tetap menunggu persyaratan inspeksi yang diterima.
