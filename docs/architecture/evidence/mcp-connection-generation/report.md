# Kepemilikan startup dan lifetime koneksi MCP

Tanggal: 2026-09-08. Status: increment terbatas pada salinan terpisah; belum diadopsi ke sumber produksi atau fixed C10.

Koneksi MCP kini memiliki pemilik sejak sebelum operasi startup pertama ditunggu. Pemanggilan `ensureConnected` dengan konfigurasi sama berbagi startup; penggantian eksplisit membuat generasi baru. Disconnect membatalkan generasi tertunda, sehingga hasil persiapan atau daftar tool yang datang terlambat tidak memasang kembali koneksi. Callback close generasi lama tidak menghapus penggantinya. Startup pengganti berikutnya juga menunggu cleanup pendahulu yang sudah diketahui, termasuk ketika generasi perantara belum sempat membuat transport.

Hasil perbandingan sah tetap **Atlas 44/54 versus Hermes 46/54** pada [konfirmasi C9](../hermes-native-files-v3-c9-confirmation/report.md). Gerbang klaim belum lolos. Pengujian di bawah adalah bukti perangkat lunak dengan client/transport tiruan, bukan sampel kualitas model tambahan atau bukti kesetaraan dengan Hermes. Tidak ada panggilan provider, subscription, atau renderer dokumen.

## Perubahan dan cakupan

Konfigurasi stdio dan HTTP, termasuk header serta scope, disalin sebelum menunggu operasi lain. Pemeriksaan identitas generasi dilakukan setelah persiapan, koneksi, dan pembacaan daftar tool. Konfigurasi yang identik dibandingkan secara privat; nilai environment/header tidak dimasukkan ke observasi atau hasil tool. Jalur endpoint HTTP langsung menggunakan kepemilikan startup dan cleanup yang sama, termasuk ketika startup gagal.

Shutdown memiliki satu promise yang dipasang sebelum callback transport dapat masuk kembali. Disconnect menginvalidasi semua generasi yang tertangkap sebelum menunggu salah satu cleanup. Persiapan yang belum menghasilkan transport dapat selesai sesudah disconnect; kelanjutannya tetap memiliki tanggung jawab cleanup dan tidak boleh memasang koneksi. Manager menahan catatan lifetime sampai startup dan cleanup yang diketahui selesai.

Handle observasi host yang opaque memberi snapshot scalar immutable. State koneksi, persiapan, keberhasilan startup, laporan error, close yang diamati, hasil permintaan close, dan cleanup dicatat terpisah. Handle yang telah diperoleh masih dapat membaca observasi setelah entri aktif dihapus. Handle ini bukan receipt izin atau otoritas eksekusi. **Actual process close dan descendant quiescence tetap unknown**, termasuk ketika close/cleanup tiruan berhasil. Error transport saja tidak berubah menjadi bukti close.

Receipt izin preparer nyata tetap terikat pada persiapan asli. Lookup koneksi aktif hilang saat generasi dihapus, sementara receipt yang sudah dipegang masih merupakan bukti historis tahap `prepared_not_executed`. Hal itu tidak menyatakan bahwa worker pernah berjalan atau sudah berhenti. Precedence lama dipertahankan: kegagalan close transport ditekan tetapi dicatat; kegagalan cleanup dapat mengambil precedence atas kegagalan startup. Pengamatan close ketika cleanup startup yang gagal berlangsung tidak mengganti error tersebut dengan pembatalan baru.

## Validasi

**99 tes unik / 524 assertion lulus**, mencakup **30 tes baru**. TypeScript dan Ultracite lulus untuk seluruh **3 berkas perubahan**: satu implementasi manager dan dua berkas tes baru. Jumlah unik berasal dari pasangan berkas/nama tes; pengulangan gerbang tidak menambah jumlah sampel.

| Kelompok | Tes | Assertion | Batas eksekusi |
| --- | ---: | ---: | --- |
| Lifecycle manager | 24 | 159 | SDK client, HTTP transport, dan preparer stdio tiruan |
| Integrasi receipt/observasi | 6 | 60 | Preparer izin dan filesystem sementara nyata; SDK/default environment serta client/transport tiruan |
| Regresi MCP, Composio, HTTP inventory | 69 | 305 | Satu kasus startup MCP nyata dikecualikan sebelum run; Bash biasa tetap bersandbox |

[Inventaris tes](../../../../outputs/hermes-evidence/2026-09-08/mcp-connection-generation/test-inventory.json), [gerbang akhir](../../../../outputs/hermes-evidence/2026-09-08/mcp-connection-generation/final-gates.json), dan [hasil perintah](../../../../outputs/hermes-evidence/2026-09-08/mcp-connection-generation/final-command-results.json) mengikat hitungan, exit code, scope, filter, dan log. Kasus McpService yang mencoba startup proses nyata tidak dijalankan dan tidak dihitung lulus; seluruh kasus lain pada enam berkas regresi pilihan tetap dijalankan. Bukti ini tidak menyatakan seluruh suite repositori lulus.

Pada salinan baseline yang diverifikasi seluruh 2.181 berkas regulernya, 18 tes perilaku awal menghasilkan **5 lulus / 13 gagal / 56 assertion**. Kegagalan mencakup startup ganda, disconnect saat prepare/connect/list, pemasangan hasil lama, close sebelum listing selesai, mutasi header selama menunggu, serta cleanup endpoint ketika startup gagal. Delapan belas kasus awal dipertahankan; suite akhir menambah lima kasus observasi dan satu kasus penggantian ketiga. [Handoff lifecycle](../../../../outputs/hermes-evidence/2026-09-08/mcp-connection-generation/agent-lifecycle-handoff.json) mengikat sumber dan log reproduksi.

Semua percobaan tetap ada dalam [catatan percobaan](../../../../outputs/hermes-evidence/2026-09-08/mcp-connection-generation/retained-attempt-notes.json), termasuk salah path copy sebelum tes pertama dan kegagalan lint fixture. Setelah gerbang pertama 99/524 lulus, review fixture memperbaiki penanganan rejection startup awal dan penantian admission ketika persiapan gagal lebih awal. Hanya fixture berubah; tes receipt 6/60 serta tipe/lint seluruh perubahan dijalankan ulang. Tidak ada assertion produk yang dilemahkan atau kegagalan eksekusi yang dibuang.

[Review manager](../../../../outputs/hermes-evidence/2026-09-08/mcp-connection-generation/agent-manager-review.json) dan [review fixture v2](../../../../outputs/hermes-evidence/2026-09-08/mcp-connection-generation/agent-root-receipt-review-v2.json) dilakukan oleh agen satu tim yang menulis tes lifecycle, bukan reviewer buta, reviewer arsip independen, atau kualifikasi studi Hermes. Review awal tetap dipertahankan. V2 membatasi klaim teardown: hanya kasus held-admission secara eksplisit menunggu startup tertahan dalam `finally`; tidak ada klaim bahwa seluruh jalur kegagalan assertion telah terbukti menunggu semua persiapan.

## Integritas dan pekerjaan tersisa

Salinan akhir memuat 2.183 berkas reguler dan 177 symlink; target symlink tidak berubah, tetapi bytes dependensi di baliknya tidak disertifikasi. [Input gerbang](../../../../outputs/hermes-evidence/2026-09-08/mcp-connection-generation/final-source-gate-input.json) dan [inventaris akhir](../../../../outputs/hermes-evidence/2026-09-08/mcp-connection-generation/final-source-inventory.json) mengikat sumber. [Verifikasi](../../../../outputs/hermes-evidence/2026-09-08/mcp-connection-generation/verification.json) mencatat `git apply --check` untuk [delta](../../../../outputs/hermes-evidence/2026-09-08/mcp-connection-generation/changes.patch) dan [patch gabungan dari salinan C10](../../../../outputs/hermes-evidence/2026-09-08/mcp-connection-generation/combined-from-c10.patch). Roster salinan tidak mengganti roster C10 terdaftar 2.126 berkas.

[Manifest](../../../../outputs/hermes-evidence/2026-09-08/mcp-connection-generation/manifest.json) dan [seal](../../../../outputs/hermes-evidence/2026-09-08/mcp-connection-generation/seal.json) mengikat payload yang dibaca ulang oleh root. Root readback bukan review arsip independen. Sumber utama, bootstrap host publikasi, fixed C10, study admission, dan reviewer yang ditahan tidak berubah. Inspector penerus belum diterima.

Tes tiruan tidak membuktikan perilaku protokol SDK nyata, metadata environment SDK nyata, penutupan worker fisik, atau semua keturunannya. Jika close/cleanup gagal, pencatatan kegagalannya tidak membuktikan bahwa proses lama telah berhenti atau bahwa efek OS generasi berikutnya tidak akan tumpang tindih. Jalur `testConnection` sekali pakai belum dilacak sebagai generasi persisten. Identitas generasi manager juga belum menjadi lease eksekusi tool.

Berikutnya adalah memperbaiki penulisan status/catalog MCP yang selesai terlambat setelah record diperbarui atau dihapus, lalu mengikat dispatch bridge ke generasi koneksi, otorisasi terkini, dan sinyal pemanggil setelah startup selesai. Membatalkan satu pemanggil tidak boleh menghentikan koneksi sehat yang masih dipakai pemanggil lain. Masalah tersebut tetap terbuka; increment ini tidak menyatakan seluruh lifetime/cancellation MCP atau target Atlas setara Hermes sudah selesai.
