# Client publikasi artefak — eksplorasi terpisah, 2026-09-08

Client sekarang dapat mendaftar, membaca, dan mencabut snapshot publikasi berdasarkan ID sesi dan ID publikasi dalam salinan pengembangan terpisah. Unduhan memakai transport autentikasi dan scope organisasi yang sama dengan permintaan client lain. Membaca snapshot tidak bergantung pada isi terbaru path workspace.

Perubahan ini **belum diadopsi ke source produk C10 yang dibekukan** dan bukan kandidat pengganti untuk panel FILE V4. Permintaan pengembangan produk dari pengguna tetap dapat dilanjutkan secara terpisah; pembekuan kandidat studi tidak melarang semua pekerjaan produk. Tidak ada isi tugas, sumber, oracle, atau kalibrasi baru yang dibaca untuk perubahan ini; tidak ada panggilan model atau perubahan skor.

## Perubahan dan bukti

- `listSessionArtifactPublications` menerima limit dan cursor, serta mengembalikan metadata publikasi dan cursor berikutnya.
- `readSessionArtifactPublicationContent` mengembalikan byte biner snapshot beserta MIME type. Respons HTTP gagal menjadi error API, bukan berkas unduhan.
- `revokeSessionArtifactPublication` memakai DELETE terautentikasi. Ketiga operasi meneruskan signal pembatalan, mengodekan identifier, dan memakai organisasi client yang aktif.
- Tes integrasi menjalankan `executeToolCall(writeFileTool)` dengan lifecycle publikasi nyata, menimpa berkas workspace, lalu membaca snapshot melalui client dan route Hono. Tes juga memeriksa pagination, penolakan sesi/pengguna lain, pencabutan publikasi, dan keanggotaan yang dihapus.

Validasi: **67 tes unik/280 assertion lulus**, mencakup suite client, lifecycle publikasi, dan route publikasi. Setelah pembungkus mock fetch diperbaiki untuk tipe Bun, sembilan tes terkait/107 assertion lulus lagi; ini bukan tambahan sembilan tes unik. TypeScript produksi, TypeScript dua berkas tes terkait, dan lint empat berkas perubahan lulus. Perubahan terakhir hanya merapikan bentuk arrow function tes; gate perilaku tidak diulang untuk perubahan mekanis tersebut.

Gate awal dan semua kegagalannya disimpan. Dua assertion awal keliru mengasumsikan default redirect dan kode penolakan setelah keanggotaan dihapus; fixture diperbaiki agar mengonfigurasi redirect secara eksplisit dan mengikuti kontrak ACL 404 yang sudah ada. Pemeriksaan tipe awal menemukan empat mock fetch tanpa properti `preconnect` yang diwajibkan tipe Bun; pembungkus tes diperbaiki tanpa mengubah transport produksi. Satu temuan lint arrow-return kemudian dirapikan.

Review sumber oleh agent terpisah tidak menemukan blocker dalam cakupan consumer ini; reviewer membaca sumber dan log tanpa menjalankan ulang tes. Integrasi baru memakai DB in-memory, filesystem snapshot nyata, dan Hono `app.fetch`; lifecycle serta root workspace dipasang manual. Bukti tersebut belum mencakup restart SQLite, socket HTTP/browser, aktivasi otomatis AgentService, atau pembatalan server/rollback setelah request berjalan.

## Batas berikutnya

Aktivasi chat utama masih memerlukan kebijakan izin runtime yang memahami jenis grant dan mengikatnya pada invocation/koneksi yang benar. Daftar path saja tidak cukup untuk menyamakan izin melihat entri direktori dengan izin membaca seluruh subtree. Producer Bash/Python, custom/skill, MCP, worker khusus, serta jalur UI/share/kanal belum semuanya dipindahkan ke satu sumber publikasi otoritatif.

Hasil ini merupakan kemajuan implementasi consumer, bukan bukti mutu model, jaminan efek tepat satu kali, atau kesetaraan lintas provider/subscription. Hasil pembanding sah terakhir tetap [Atlas 44/54, Hermes 46/54](../hermes-native-files-v3-c9-confirmation/report.md), dengan gate klaim gagal. Studi C10 tetap tertahan pada prasyarat inspeksi yang belum diterima.

## Berkas yang dapat ditinjau

[Patch](../../../../outputs/hermes-evidence/2026-09-08/publication-client-exploration/changes.patch), [verifikasi dan batas bukti](../../../../outputs/hermes-evidence/2026-09-08/publication-client-exploration/verification.json), serta [manifest sumber/log](../../../../outputs/hermes-evidence/2026-09-08/publication-client-exploration/manifest.json) disimpan di repository. Pemeriksaan byte mengonfirmasi seluruh 2.129 berkas regular baseline yang disalin tetap sama pada sumber asal; angka ini adalah roster salinan kerja, bukan pengganti definisi hash source studi C10.

Salinan kerja: `/private/tmp/atlas-publication-client-exploration-20260908/source`. Dependensi workspace lokal menunjuk kembali ke salinan eksplorasi tersebut; dependensi pihak ketiga menggunakan instalasi yang sudah ada. Tidak ada commit, deploy, perubahan source C10 asal, atau admission studi baru.
