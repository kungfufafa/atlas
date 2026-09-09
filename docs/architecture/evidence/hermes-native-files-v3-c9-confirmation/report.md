# Hasil konfirmasi Atlas C9 terhadap Hermes

**Atlas belum memenuhi target setara atau lebih baik.** Dalam seluruh 54 pasangan tugas yang dijadwalkan, skor utama asli adalah **Atlas 44/54 (81,5%) dan Hermes 46/54 (85,2%)**. Ambang yang ditetapkan sebelum pengujian adalah Atlas minimal 49/54, setiap jenis tugas minimal 5/6, dan jumlah kelulusan Atlas minimal sama dengan Hermes. Ketiganya belum terpenuhi.

Seluruh 108 eksekusi berjalan sekali, dengan dua pengulangan per varian dan sembilan jenis tugas. Proses asli selesai pada 7 September 2026, 10:04:50 UTC; analisis beku dijalankan sekali setelahnya. Audit independen mendukung validitas pencatatan dalam cakupan protokol, dengan semua kegagalan tetap disertakan. Tidak ada penggantian percobaan, perubahan skor, pemilihan jendela waktu yang menguntungkan, atau penghapusan jenis tugas yang buruk.

| Jenis tugas | Atlas | Hermes |
| --- | ---: | ---: |
| Perbaikan kode | 5/6 | 4/6 |
| Penggabungan CSV | 5/6 | 6/6 |
| Pembuatan laporan DOCX | 1/6 | 2/6 |
| Revisi DOCX | 5/6 | 5/6 |
| Pembuatan PDF | 6/6 | 6/6 |
| Ekstraksi PDF | 6/6 | 6/6 |
| Revisi PPTX | 5/6 | 5/6 |
| Rekonsiliasi XLSX | 5/6 | 6/6 |
| Perubahan terbatas XLSX | 6/6 | 6/6 |
| **Seluruh tugas** | **44/54** | **46/54** |

Ada 42 pasangan yang keduanya lulus, dua hanya Atlas lulus, empat hanya Hermes lulus, dan enam keduanya gagal. Angka tersebut adalah hasil kumpulan terbatas ini, bukan estimasi keunggulan pada populasi tugas lain. [Seluruh 108 baris asli](all-108-original-arms.md) dan [analisis asli](analysis-final.json) tersedia.

## Seluruh kegagalan dan batas pemeriksa

Ada 18 kegagalan utama: sepuluh Atlas dan delapan Hermes. [Laporan diagnosis lengkap](census-report.md) menjelaskan setiap kegagalan beserta bukti asli; [rincian terstruktur](all-eighteen-failure-diagnoses.json) mempertahankan identitas dan indikator aslinya.

- Enam dokumen DOCX memuat tindakan dan tenggat dengan benar di tabel, tetapi tidak di paragraf. Tugas secara eksplisit meminta seluruh fakta dalam paragraf sekaligus tabel terpisah. Ini kegagalan mengikuti penempatan isi yang diminta, bukan bukti bahwa seluruh dokumen kehilangan fakta tersebut.
- Satu dokumen Hermes memuat seluruh fakta dalam paragraf, tetapi huruf awal penyebab dan tindakan ditulis kecil. Pemeriksa asli membedakan kapitalisasi dan menolaknya. Kegagalan asli dipertahankan; menyebut kasus ini sebagai ketidakakuratan fakta akan keliru. [Inspeksi tujuh DOCX](../hermes-native-files-v3-c9-confirmation-docx-contract-review/report.md) memuat batas ini, serta satu pernyataan tambahan Atlas yang tidak didukung input dan tidak dinilai ulang.
- Tiga hasil lulus pemeriksa artefak/kode tetapi gagal pada kriteria utama karena penggunaan token akhir tidak pasti: satu kode Hermes, satu PPTX Atlas, dan satu CSV Atlas. Dua kasus Atlas terkait timeout permintaan judul sesi setelah berkas selesai. Protokol ini menunggu pekerjaan tambahan untuk pencatatan lengkap; HTTP Atlas biasa menjadwalkan judul di latar belakang. Temuan ini tidak membuktikan bahwa pengguna biasa harus menunggu judul sebelum menerima berkas.
- Tujuh kegagalan lain memiliki penggunaan tidak pasti serta kegagalan atau ketiadaan bukti penyelesaian native. Satu kegagalan Hermes melewati tenggat sebelum permintaan diteruskan ke penyedia; dua upaya masuk ditolak oleh batas anggaran, sehingga penggunaan upstream yang tercatat tetap nol dan diketahui.

Pemeriksa artefak asli secara diagnostik lulus pada 46/54 hasil Atlas dan 47/54 Hermes. Ini metrik terpisah yang memang tersimpan dalam analisis asli, bukan pengganti skor utama. Keluaran dan akuntansi harus dibaca bersama.

## Kondisi eksekusi dan penggunaan sumber daya

Model yang diuji adalah **mimo-v2.5 melalui OpenCode Go**, dengan versi [Hermes yang dibekukan](https://github.com/NousResearch/hermes-agent/tree/089bb32886c8c18f7fa20182c7bf8826d6935ac5). Hasil ini tidak membuktikan kesetaraan pada DeepSeek, provider lain, atau subscription ChatGPT/Claude. Pengujian dan kegagalan kompatibilitas terdahulu tetap dilaporkan terpisah di [catatan evaluasi](../../hermes-evaluation-progress.md).

Setiap eksekusi dibatasi 24 permintaan penyedia, 12.000 token keluaran yang dilaporkan, dan 4.096 per respons atau sisa anggaran; protokol memiliki tenggat pemanggilan 300 detik dan timeout upstream 90 detik. Angka ini anggaran eksperimen, bukan kapasitas model yang diasumsikan. Lima siklus sleep/wake macOS menyebabkan selisih besar antara waktu kalender dan penghitung monotonic. Semua durasi dan percobaan dipertahankan. Karena itu, pengujian ini tidak membuktikan batas keras 300 detik pada host yang tersuspensi atau perbandingan kecepatan pada mesin yang terus terjaga. [Bukti kondisi host](../hermes-native-files-v3-c9-confirmation-health-window/health-note.md) juga menjelaskan bahwa kedekatan waktu tidak membuktikan penyebab setiap gangguan transport.

| Catatan asli, seluruh 54 eksekusi per harness | Atlas | Hermes |
| --- | ---: | ---: |
| Permintaan upstream yang tercatat | 335 | 401 |
| Eksekusi dengan penggunaan diketahui / tidak pasti | 48 / 6 | 50 / 4 |
| Subtotal token input pada eksekusi yang diketahui | 1.949.084 | 2.550.712 |
| Subtotal token keluaran pada eksekusi yang diketahui | 135.396 | 87.525 |
| Token input teramati termasuk bagian hasil tidak pasti | 2.012.853 | 2.587.187 |
| Token keluaran teramati termasuk bagian hasil tidak pasti | 139.063 | 89.945 |

Total penggunaan lengkap dan biaya tagihan kedua harness tetap tidak diketahui. Token cache merupakan bagian input dan tidak ditambahkan lagi. Sebanyak 742 upaya masuk menghasilkan 736 catatan upstream dan enam penolakan sebelum diteruskan. Ada 716 respons HTTP 200 yang melaporkan model tepat dan 20 kesalahan transport tanpa status HTTP upstream; kode 502 dari perantara tidak membuktikan penyedia mengembalikan HTTP 502. Tidak ada klaim keunggulan biaya atau efisiensi dari subtotal ini.

## Status pengembangan dan bukti yang tersimpan

C9 sudah diadopsi ke working tree Atlas dan lolos validasi perubahan terkait: 183 pengujian, 867 asersi, pemeriksaan tipe produksi dan lint dalam cakupan yang tercatat. Pengujian tersebut bertumpang tindih dengan kandidat sebelumnya dan tidak dijumlahkan sebagai bukti tambahan. [Status produk C9](../hermes-candidate-v9-product-status/memo-id.md) menjelaskan perubahan serta bagian yang belum diaktifkan; [cakupan provider](../hermes-candidate-v9-provider-scope/memo.md) menjelaskan batas API dan subscription. Lulus pengujian kode tidak menggantikan hasil tugas nyata yang masih di bawah target.

Pilot C9 sebelumnya lulus empat dari empat eksekusi; pengembangan C9 menghasilkan 14/18 versus 14/18. Keduanya tetap terpisah dari konfirmasi 44/54 versus 46/54 dan tidak dipilih untuk mengklaim peningkatan. Konfirmasi ini sekarang dapat menjadi bahan diagnosis kandidat selanjutnya; bukti independen kandidat baru memerlukan studi dan tugas konfirmasi baru yang ditetapkan sebelumnya.

Audit mencocokkan seluruh 108 lifecycle, 972 referensi proses/pemanggilan, 2.643 berkas transport, 54 penetapan input bersama, 72 hash input, serta 9.655 anggota arsip sumber. Identitas native cocok pada 104 eksekusi; empat tetap tidak tersedia. Keberadaan 108 direktori runtime tidak mengisi bukti yang hilang. Pengamatan proses anak berakhir juga tidak membuktikan semua proses turunannya telah berhenti.

Arsip mentah mempertahankan 6.496 berkas terpilih (282.125.147 byte), ditambah manifest. Arsip pemeriksaan mempertahankan 661 berkas terpilih (15.964.544 byte), ditambah manifest. Penyalinan memverifikasi hash, mode, daftar anggota, dan melakukan pemindaian terbatas atas kredensial yang dikenal. [Audit independen](independent-review.md), [receipt arsip mentah](raw-archive-receipt.json), [kualifikasi identitas](raw-identity-scope-qualification.json), [receipt arsip pemeriksaan](review-archive-receipt.json), dan [referensi lengkap](reference.json) menyimpan pengikat bukti. Tidak ada perubahan produk, panggilan model, atau penilaian ulang saat menyusun laporan ini.
