# Izin dan pembatalan delegasi — eksplorasi terpisah, 2026-09-08

Subagent pada mode publikasi opsional kini mendapat sesi tersimpan, identitas runtime, principal, dan record publikasi sendiri. Dua child dari parent yang sama tidak memakai ulang identitas sesi parent atau sibling. Host memeriksa kembali organisasi, profil, pemilik, keanggotaan dan invocation parent sebelum menjalankan child atau menerima publikasinya. Bukti channel worker tetap berasal dari parent asli.

Principal child hanya dapat dibuat dari pemanggilan `sub_agent` yang aktif pada host yang sama. Service tanpa host atau host lain tidak dapat meminjam scope parent. Resolver memakai tool subagent milik instance AgentService yang bersangkutan. Identitas parent disalin sebagai nilai sebelum await; perubahan objek sesi yang dikembalikan DB tidak dapat menulis ulang batas izin yang sudah ditangkap.

Pembatalan sebelum atau saat persiapan mencegah dispatch provider. Penantian yang dapat dibatalkan hanya membungkus persiapan; hasilnya berupa closure launch yang tidak dipanggil apabila persiapan kalah dari abort. Setelah launch dimulai, jalur hasil, checkpoint dan persistence tetap ditunggu. Tes menahan receipt setelah efek Bash nyata, membatalkan child, lalu memastikan child belum selesai sebelum receipt dilepas dan hasil exit/stdout yang tepat tersimpan tanpa replay.

SubagentService juga menangkap input dan signal asli sebelum validasi asynchronous. Pembatalan saat alokasi record atau checkpoint awal menghasilkan handle cancelled tanpa dispatch. Parent abort, pemanggilan cancel berulang dan penyelesaian child yang terlambat berbagi satu promise pembatalan, sehingga tidak saling berebut penyelesaian record eksekusi.

| Gate akhir yang tidak tumpang tindih | Tes | Assertion |
|---|---:|---:|
| Integrasi delegasi, SubagentService, tool dan resolver | 34 | 164 |
| Regresi sesi publikasi, record runtime, scope dan principal | 57 | 338 |
| **Gabungan** | **91** | **502** |

Terdapat **21 tes baru**: 15 integrasi delegasi dan enam SubagentService. Rerun sebelumnya tidak ditambahkan ke jumlah unik; kasus parameterized dengan judul yang sama mempertahankan nomor kemunculannya. [Inventaris tes](../../../../outputs/hermes-evidence/2026-09-08/publication-delegated-scope/test-inventory.json) mengikat kedua gate. [TypeScript produksi, tipe tes terarah dan lint delapan berkas](../../../../outputs/hermes-evidence/2026-09-08/publication-delegated-scope/final-static-gates.json) lulus. Perubahan terakhir setelah gate perilaku hanya import/annotation tipe principal; pemeriksaan statis akhir memakai source tersebut.

Fixture positif menjalankan Bash nyata untuk sibling API dan callback native, memeriksa sesi dan record terpisah, history child yang tersimpan, cleanup temp, serta pembacaan byte snapshot. Kasus negatif mencakup perubahan channel parent, pencabutan keanggotaan, parent yang sudah selesai, host yang salah dan kegagalan publikasi. Kegagalan publikasi mempertahankan satu efek file Bash dan hasil parent tanpa menjalankan tool lagi.

Reproduksi gagal asli tetap tersedia:

- [Pre-abort](../../../../outputs/hermes-evidence/2026-09-08/publication-delegated-scope/logs/agent-pre-abort-repro-v1.log) dan [tiga pembatalan saat persiapan](../../../../outputs/hermes-evidence/2026-09-08/publication-delegated-scope/logs/agent-cancel-start-repro-v1.log) masih mendispatch child sebelum koreksi.
- [Race pembatalan record](../../../../outputs/hermes-evidence/2026-09-08/publication-delegated-scope/logs/agent-behavior-v1.log) menghasilkan `ExecutionLeaseError` sebelum promise pembatalan disatukan.
- [Mutasi objek parent](../../../../outputs/hermes-evidence/2026-09-08/publication-delegated-scope/logs/root-parent-pin-v1.log) benar-benar mengizinkan efek Bash yang seharusnya ditolak sebelum nilai channel/createdAt ditangkap secara terpisah.
- [Metadata yang belum selesai](../../../../outputs/hermes-evidence/2026-09-08/publication-delegated-scope/logs/root-abort-wait-v1.log) menahan hasil pembatalan melewati penjaga fixture 500 ms sebelum pemisahan persiapan/launch.
- [Abort synchronous](../../../../outputs/hermes-evidence/2026-09-08/publication-delegated-scope/logs/root-abort-observer-v1.log) meninggalkan rejection persiapan yang tidak diamati sebelum promise tersebut diberi observer.

Kegagalan formatter, spy fixture dan tipe nullable/inference juga dipertahankan dalam [verifikasi lengkap](../../../../outputs/hermes-evidence/2026-09-08/publication-delegated-scope/verification.json). Root dan agent saling meninjau source; ini bukan rerun independen seluruh sistem. Review menemukan mutasi parent, rejection yang terlepas dan risiko mengembalikan parent sebelum receipt child selesai; koreksi terakhir menunggu launch secara langsung.

Hubungan izin parent–child masih berupa closure process-local. Sesi dan receipt child yang tersimpan belum membuktikan pemulihan hubungan itu setelah restart. Persiapan yang dibatalkan dapat meninggalkan baris metadata sesi child kosong. Penantian budget SubagentService yang sudah ada dapat kembali sebelum seluruh inner work selesai; pengujian ini tidak membuktikan quiescence proses atau semua descendant.

Fixture delegasi baru memakai AgentService, resolver, tool loop, Bash dan persistence sebenarnya dengan DB di memori serta respons provider sintetis. Callback native memakai jalur executor bersama, bukan subscription nyata. Fixture baru memanggil host langsung; gate regresi mencakup integrasi Hono `app.fetch` sebelumnya. Tidak ada browser/TCP atau perbandingan kualitas model baru. Staging stdout dilakukan wrapper fixture tepercaya, bukan perilaku default Bash. Pembacaan child oleh worker, agregasi artefak ke parent, discovery/MCP/custom tools dan aktivasi bootstrap tetap perlu dikerjakan.

[Delta delapan berkas](../../../../outputs/hermes-evidence/2026-09-08/publication-delegated-scope/changes.patch) dan [patch gabungan dari C10](../../../../outputs/hermes-evidence/2026-09-08/publication-delegated-scope/combined-from-c10.patch) lulus `git apply --check`. Sebanyak 2.146 anggota baseline eksplorasi sebelumnya dan 2.129 anggota baseline salinan C10 tetap byte-identical. Inventaris salinan tidak mengganti roster studi C10 2.126 berkas dan tidak menyatakan kesamaan seluruh topologi symlink/host. Source berada di `/private/tmp/atlas-publication-delegated-scope-20260908/source`, belum diadopsi, di-commit atau di-deploy. [Manifest](../../../../outputs/hermes-evidence/2026-09-08/publication-delegated-scope/manifest.json) dan [seal readback root](../../../../outputs/hermes-evidence/2026-09-08/publication-delegated-scope/seal.json) mengikat payload arsip.

Hasil pembanding sah tetap [Atlas 44/54 dan Hermes 46/54](../hermes-native-files-v3-c9-confirmation/report.md), yang gagal memenuhi gate klaim. Tidak ada renderer, panggilan model, admission studi atau pelepasan bahan fresh/kalibrasi pada increment ini. Tujuan setara atau lebih baik masih aktif dan belum tercapai. Langkah berikutnya adalah hubungan delegasi tersimpan yang mengikat child ke parent dan handle eksekusi, beserta tes akses, pencabutan, restart dan perubahan identitas parent sebelum konsumen artefak parent diaktifkan.
