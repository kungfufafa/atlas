# Development FILE V3 C9 — hasil lengkap

Development selesai dengan **36 dari 36 arm** pada 18 pasangan, tanpa arm hilang, duplikat atau pengganti. Analisis asli valid dengan nol masalah struktural: **Atlas 14/18 (77,8%) dan Hermes 14/18 (77,8%)**. Ada 12 pasangan sama-sama berhasil, dua hanya Atlas, dua hanya Hermes, dan dua sama-sama gagal. Ini hasil development eksploratif; persamaan hitungan belum membuktikan kesetaraan umum, efisiensi, atau peningkatan yang disebabkan C9. Semua kegagalan tetap dalam penyebut.

| Keluarga tugas | Atlas | Hermes |
| --- | ---: | ---: |
| `code_fix` | 2/2 | 1/2 |
| `csv_join` | 2/2 | 2/2 |
| `docx_report` | 0/2 | 0/2 |
| `docx_revision` | 2/2 | 2/2 |
| `pdf_create` | 2/2 | 2/2 |
| `pdf_extract` | 2/2 | 2/2 |
| `pptx_revision` | 2/2 | 1/2 |
| `xlsx_reconciliation` | 1/2 | 2/2 |
| `xlsx_surgical_edit` | 1/2 | 2/2 |
| **Total** | **14/18** | **14/18** |

## Seluruh delapan arm yang gagal

| Arm asli | Jumlah | Temuan dan batas kesimpulan |
| --- | ---: | --- |
| `docx_report` v0 dan v1, kedua harness | 4 | Keenam fakta ada dalam masing-masing DOCX. Action dan tenggat ada di tabel, tetapi tugas juga meminta seluruh fakta dalam paragraf. Dua pemeriksaan lokasi fakta gagal; tabelnya lulus. Kegagalan asli tetap berlaku tanpa menyebut fakta hilang atau direkayasa. [Review empat dokumen](docx-contract-report.md). |
| Atlas `xlsx_reconciliation` v0 | 1 | Eksekusi berakhir dengan `IncompleteCompletionError` setelah keluaran terpotong; 10 request mencatat tepat 12.000 token generated. Flag asli `budgetExceeded` tetap false. Tool sempat melaporkan penyimpanan file, tetapi kegagalan proses membuat inspeksi, oracle dan pengiriman akhir tidak tersertifikasi. |
| Atlas `xlsx_surgical_edit` v0 | 1 | Jawaban memuat satu path valid serta tautan `sandbox:` yang ditolak aturan pemilihan file; seleksi akhir menjadi kosong dan oracle tidak dijalankan. File nyata tetap terikat hash. Inspeksi ZIP/XML mendukung nilai target C2=482 dan sumber C2=271, **bukan** pelestarian seluruh isi, format dan properti workbook. |
| Hermes `code_fix` v0 | 1 | Kode akhir memakai `.ljust`, yang tidak termasuk daftar member yang diizinkan kontrak. Catatan 0/19 berasal dari penolakan penerimaan kandidat, **bukan 19 kesalahan jawaban aritmetika yang dibuktikan**. Keberhasilan tes publik didukung hasil tool, tetapi klaim memenuhi seluruh kontrak tidak didukung. |
| Hermes `pptx_revision` v0 | 1 | Deadline sekitar 300 detik menghentikan proses; receipt parent lengkap, tetapi keluaran/identitas native tidak tersedia. Tujuh request tercatat: enam memiliki counter respons dan satu berakhir dengan transport timeout. Pemakaian wajib tetap tidak diketahui dan arm tetap gagal. Riwayat publik memperlihatkan masalah interpreter dan akses warna sebelum save, tetapi tidak mengisolasi penyebab timeout. |

[Diagnosis lengkap dengan semua ID asli](census-report.md), [census 36 arm](census.json), dan [delapan diagnosis terstruktur](all-eight-failure-diagnoses.json) mempertahankan durasi, receipt, counter serta keterbatasan setiap arm. Tidak ada model, tes, oracle atau analyzer yang dijalankan ulang untuk laporan ini; tidak ada skor alternatif. Pemeriksaan paket DOCX/XLSX tidak mensertifikasi rendering atau kualitas visual.

## Sumber daya: seluruh 18 arm per harness

| Ukuran tercatat | Atlas | Hermes |
| --- | ---: | ---: |
| Request provider | 120 | 149 |
| Arm dengan pemakaian wajib lengkap | 18/18 | 17/18 |
| Total prompt tokens lengkap | 749.653 | Tidak diketahui |
| Total generated tokens lengkap | 57.924 | Tidak diketahui |
| Biaya | Tidak diketahui | Tidak diketahui |

Untuk Hermes, subtotal 17 arm dengan counter lengkap adalah **949.185 prompt / 34.503 generated**. Counter yang teramati di seluruh 18 arm, termasuk arm tidak pasti, berjumlah **976.791 prompt / 35.533 generated**; ini tetap subtotal, bukan total lengkap. Arm timeout menyumbang counter teramati 27.606 prompt / 1.030 generated. Seluruh **268 respons HTTP yang tercatat berstatus 200**; satu request tambahan memiliki transport error tanpa status HTTP. Counter yang hilang tidak diisi nol, dan angka ini tidak mendukung klaim biaya atau efisiensi komparatif.

## Cakupan dan bukti

Sumber produk adalah C9 `e2daf1b902a087eb279724f17d61e50b9a27f7c1d64828f6958b61b22225eb98`; kontrol `b3673405fab43fdd268aa286d4f6f0164ea00c2332ba43d00e28abd3d538fde5`. Model yang diminta dan efektif adalah `mimo-v2.5` di `https://opencode.ai/zen/go/v1`, nonstreaming, temperature 0,2, dengan User-Agent `Atlas-Hermes-Compatibility-Probe/1.0 (nonstreaming)`. Identitas model cocok pada 268 respons yang tersedia; request tanpa respons tetap tidak dapat diverifikasi. Batas per arm: **24 request, 12.000 generated tokens, maksimal 4.096 token per respons atau sisa anggaran yang lebih kecil, dan deadline 300 detik**. Deadline caller bukan jaminan watchdog keras untuk seluruh penulisan receipt, finalisasi broker dan grading sesudahnya.

[Review independen](independent-review.json) memeriksa seluruh 36 arm dan tidak menemukan blocker struktural, otorisasi, atau endpoint tidak berfungsi. Kegagalan tugas dan satu arm dengan akuntansi tidak pasti tetap hasil gagal yang sah. Review ini tidak melakukan regrading. Penutupan child yang teramati tidak membuktikan semua proses turunan sudah berhenti; salinan runtime juga bukan snapshot SQLite/filesystem atomik.

[Referensi sumber dan arsip](reference.json) mengikat analisis asli, seluruh review, raw archive dan paket review tambahan. Semua kontrol dan hasil historis tetap utuh. Receipt terpisah [admission confirmation](confirmatory-admission.json) mengizinkan seluruh 54 pasangan/108 arm dengan sumber yang sama, sesuai aturan sebelum hasil development. Laporan ini tidak membaca atau melaporkan input maupun hasil confirmation yang berjalan; nilai development tidak digunakan untuk memilih subset confirmation atau kandidat baru.
