# Perbaikan inspeksi keluaran DOCX/PDF — 2026-09-09

Inspector penerus memperbaiki hambatan teknis yang menggagalkan review sebelumnya: renderer dapat memuat gambar dari luar dokumen yang sudah ditangkap. Sumber penerus berada di [inspect_output.py](../../../../scripts/harness-output-inspection/inspect_output.py); komponen lama dan review kegagalannya dipertahankan. Penerimaan ini terbatas pada inspector dan runtime macOS yang diuji. Kualifikasi metode penilaian dan studi C10 masih harus diselesaikan.

Renderer sekarang memakai kebijakan `deny default`: pembacaan isi dibatasi pada input yang ditangkap, paket renderer serta kebutuhan sistem/font yang dicatat; penulisan dibatasi pada direktori render privat. Jaringan tetap ditolak. Wrapper shell tidak dijalankan: inspector menyelesaikan lokasi executable Mach-O yang sebenarnya dan mencatat hash paket runtime, font, executable sandbox serta kebijakan dyld sebelum/sesudah proses. Tidak ada fallback ke proses tanpa pembatasan. Kebutuhan startup LibreOffice berupa pembacaan direktori `.app` diberikan sebagai satu direktori literal, bukan seluruh pohon induknya.

Konfigurasi font privat memasukkan font dalam paket Poppler dan menyimpan cache dalam direktori render. Ini juga memperbaiki regresi yang ditemukan lewat pemeriksaan visual: versi antara menghasilkan PNG valid tetapi menghilangkan teks PDF. Regresi tersebut sekarang diuji pada area teks gambar yang diketahui; hasil awal tetap disimpan sebagai kegagalan pemeriksaan visual, meskipun tes otomatis lama melaporkan lulus.

## Bukti pengujian akhir

Semua pengujian akhir mengikat inspector SHA-256 `5fdad2dacecf0a0aa09f95aca2eace4815d36ad58835e66a34f1e9d8aa300370`.

| Rangkaian | Hasil | Yang diperiksa |
| --- | --- | --- |
| Fixture historis asli (`final-legacy-015`) | 13/13 lulus | Kasus eksternal yang menggagalkan inspector lama, DOCX embedded, PDF/DOCX dua halaman, hash/context, batas, keluaran parsial dan kegagalan |
| Fixture yang dibuat ulang (`final-portable-016`) | 13/13 lulus | Perilaku yang sama tanpa ketergantungan pada lokasi fixture historis |
| Kebijakan filesystem (`final-policy-017`) | 7/7 lulus | Input dapat dibaca, hasil privat dapat ditulis, berkas saudara/luar ditolak; redirect runtime ditolak |
| Kegagalan proses (`final-failure-018`) | 4/4 lulus | Timeout nyata, raster parsial nyata, penolakan bind loopback, command tidak terdaftar tidak dimulai |

Totalnya **24 kasus unik, 37 eksekusi tes akhir**. Dua rangkaian dokumen menjalankan 13 kasus yang sama pada asal fixture berbeda. Lima berkas Python juga lulus pemeriksaan sintaks. Tes kebijakan menggunakan shell builtin tepercaya dengan kebijakan renderer yang sama; tes jaringan menggunakan bind lokal tanpa mengirim paket. Kasus gambar eksternal dan kontrol dokumen benar-benar menjalankan LibreOffice/Poppler, bukan renderer tiruan.

Pada kasus eksternal yang sama, review lama menemukan **70.023 piksel merah** dari gambar luar. Hasil penerus memiliki **0 piksel merah**, dengan halaman tetap dihasilkan dan teks publik tetap terlihat. Kontrol gambar embedded mempertahankan **70.895 piksel biru**. Hash seluruh input historis dan fixture baru tidak berubah setelah pengujian. Dokumen yang kehilangan resource eksternal tetap berstatus pengukuran tidak tersedia; ketiadaan gambar bukan kelulusan semantik.

Pada PDF positif, area teks yang hilang sebelumnya memiliki **0 piksel gelap**; setelah konfigurasi font diperbaiki menjadi **846**, melewati batas tes yang ditetapkan sebelum rerun, yaitu lebih dari 300. Root memeriksa enam halaman penuh: dua DOCX, dua PDF, kontrol embedded dan kasus eksternal. Enam PNG pada rangkaian fixture baru identik byte demi byte dengan padanannya pada rangkaian historis. Pemeriksaan ini merupakan QA sintetis oleh penulis inspector, bukan penilaian buta terhadap keluaran model.

## Riwayat kegagalan dan batas bukti

Arsip mempertahankan percobaan awal yang gagal karena symlink font sistem, sandbox luar yang tidak dapat memasang sandbox bersarang, kebutuhan startup dyld/LibreOffice, dua percobaan debugger yang tidak menghasilkan diagnosis, kesalahan awal generator fixture, dan regresi teks PDF. Eksekusi tes native berikutnya mendapat persetujuan tool untuk konteks host yang diperlukan; kebijakan pembatas renderer sendiri tetap dipasang. Tidak ada bypass atau pelonggaran ke kebijakan `allow default`.

`visual.state=complete` berarti seluruh gambar halaman tersedia. Field `coversExtractionInvisibleText` sekarang tetap `null`: ketersediaan PNG tidak membuktikan seluruh glyph atau isi sudah benar. Penilai harus benar-benar memeriksa halaman; `semanticPass` tetap `null`. Font yang tidak embedded dapat memakai substitusi font yang tersedia, sehingga hasil ini tidak menjamin kesetiaan semua font atau semua dokumen.

Binding runtime sebelum/sesudah bukan snapshot atomik terhadap host yang bermusuhan. Pengecualian sistem mencakup direktori sistem eksplisit dan grant dalam `dyld-support.sb` yang hash-nya dicatat, termasuk Cryptex serta pembacaan direktori leluhur. Metadata filesystem boleh ditanyakan. Timeout memakai sinyal process group dan tidak membuktikan seluruh descendant berhenti; batas memori/disk keras juga tidak diklaim. Implementasi ini khusus layout runtime macOS yang dicatat, bukan bukti isolasi lintas OS.

Receipt penerimaan, hasil tes, review sumber terpisah, pemeriksaan visual dan manifest seluruh percobaan disimpan di arsip perbaikan (arsip lokal). Petunjuk pemakaian dan reproduksi ada di [README inspector](../../../../scripts/harness-output-inspection/README.md).

Penilai teknis terpisah membaca sumber akhir, memeriksa ulang 894 referensi tanpa ketidakcocokan, dan melihat sendiri keenam halaman penuh. Ia adalah penulis tes dalam tim yang sama; review tersebut bukan kalibrasi semantik buta. Root juga memverifikasi seluruh 18.711 anggota reguler arsip mentah, total 489.175.591 byte. Arsip terkompresi tidak mengeksekusi isinya dan menyertakan komponen/review asli serta seluruh percobaan gagal.

Salinan inspector dengan hash identik sudah dipasang di `semantic/method/output-inspection/` pada root persiapan studi C10. Receipt staging (arsip lokal) mengikat keadaan metadata sebelum/sesudah. Referensi persiapan sebelumnya dipertahankan, status hambatan lama disimpan sebagai riwayat, dan skor serta kandidat produk tetap sama. Metode belum dibekukan atau dikalibrasi; pemasangan komponen tidak menyatakan admission studi.

## Dampak terhadap perbandingan Hermes

Hambatan inspector lama dapat ditutup berdasarkan perbaikan dan kontrol di atas. Langkah berikutnya adalah binding metode/config yang sebenarnya, kalibrasi penilai dengan kontrol yang sudah ditetapkan, preflight gabungan, lalu seluruh jadwal studi dan analisisnya. Tes sintetis ini tidak mengizinkan penggantian hasil model, pemilihan kasus menguntungkan, atau klaim kualitas baru.

Hasil sah terakhir tetap C9: Atlas 44/54, Hermes 46/54, dengan gate klaim gagal. Tidak ada panggilan provider baru pada perbaikan ini. Kesetaraan DeepSeek, provider lain maupun subscription belum dibuktikan.

## Paket dalam Git

Commit ini menyertakan sumber inspector, fixture yang dapat dibuat ulang, tes dan [ringkasan verifikasi](verification.json). Arsip mentah `outputs/hermes-evidence/2026-09-09/output-inspection-fix/` serta metadata studi di `/private/tmp/` tetap merupakan bukti lokal; keduanya tidak disertakan dalam Git. Hash arsip tercantum dalam ringkasan. Seluruh pengujian yang dilaporkan dijalankan sebelum commit; sumber Python yang dipublikasikan identik dengan sumber yang diuji.
