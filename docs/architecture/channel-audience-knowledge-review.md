# Arah KB WhatsApp: tetap memakai whitelist

11 September 2026. Catatan evaluasi; tidak mengubah kode produk atau melakukan deployment.

**Keputusan pemilik produk: gunakan whitelist saja dan jaga pengaturannya sederhana.** Daftar berisi tim internal, mitra, dan pelanggan. Rekomendasi sebelumnya untuk menambahkan kelompok audience dan koleksi dengan izin berbeda tidak menjadi arah implementasi.

Janji produk: nomor yang masuk whitelist dapat memakai KB melalui WhatsApp tanpa pairing akun dashboard. Semua nomor dalam whitelist mendapat hak KB yang sama. Grant ini tidak otomatis menambahkan memory, Bash, MCP, atau pengiriman pesan.

Alur admin cukup:

1. Pilih agent pada **Integrations → WhatsApp → Reply as**.
2. Unggah materi KB yang boleh dibaca seluruh whitelist.
3. Tambahkan nomor yang boleh memakai layanan.

KB layanan WhatsApp menjadi sumber bersama. Pemisahan dokumen per pelanggan atau mitra bukan kemampuan yang dijanjikan desain ini. Tidak diperlukan role baru, audience baru, atau izin per dokumen.

**Perbaikan teknis yang tetap diperlukan, tanpa pengaturan tambahan**

- Batasi grant KB dari whitelist pada agent WhatsApp yang dipilih admin. `/profile` tidak boleh memperluasnya ke seluruh agent internal. Ini masih perlu diperbaiki pada patch saat evaluasi ditulis.
- Pertahankan verifikasi nomor/alias, batas workspace, builtin KB yang sah, assignment, dan pemeriksaan sebelum pencarian otomatis maupun eksplisit.
- Pencabutan perlu menangani sumber lama di konteks model, selain menghentikan pencarian baru.
- File kerja perlu pemeriksaan kepemilikan; batas folder `artifacts/` belum mengisolasi pengguna satu profil.
- UI perlu memperlihatkan arti akses KB, termasuk ketika daftar nomor tersimpan setelah mode berubah.

Grup mengikuti sifat percakapan bersama: seluruh anggota dapat membaca balasan bot. Whitelist pengirim tidak membuat balasan privat. Evaluasi ini tidak mengubah perilaku grup atau menambahkan pengaturan grup.

**Bukti audit**

| Temuan | Bukti | Cakupan |
|---|---|---|
| Grant meluas melalui `/profile` | Helper nyata mengizinkan `internal_finance` meski konfigurasi menunjuk `customer_service`; pemilih menampilkan semua profil selain Super Agent. | Dampak baru pemberian KB kepada tamu. |
| Jawaban KB terkirim ke grup | Pengirim diperiksa; binding grup mengizinkan KB tanpa data peserta; balasan menuju JID grup. | Delivery lama kini dapat membawa KB. |
| Artifact pengguna lain terbaca | Guest B membaca path yang diketahui, bermetadata guest A, melalui wrapper dan protected executor. Tidak membuktikan listing semua file. | Celah lama, terpisah dari keputusan whitelist. |
| Materi lama tetap menjadi konteks | Setelah whitelist dicabut pada mode Open, tool KB hilang tetapi hasil tool lama masih masuk initial history provider. | Akses sumber baru ditutup; konteks lama belum disaring. Bukan permintaan menarik pesan WhatsApp yang sudah terkirim. |

Rujukan: `apps/platform/whatsapp/src/chat-handler.ts:409`, `:1186`, `:1716`, `:1921`; `apps/server/src/services/channel-guest-knowledge-base-policy.ts:34`; `apps/server/src/services/channel-work-file-tools.ts:49`; `apps/server/src/services/agent-service.ts:6056`; `apps/web/src/components/whatsapp-settings-card-content.tsx:53`.

Diagnostik sintetis, tanpa provider LLM: `/private/tmp/atlas-kb-audience-diagnostic.ts`, `/private/tmp/atlas-guest-artifact-diagnostic.ts`, `/private/tmp/atlas-kb-history-diagnostic.test.ts`. Konfigurasi sementara dibersihkan.

**Mutu jawaban tetap perlu diperiksa**

Uji fixture retrieval menemukan singkatan `SE`/`IT` dibuang dari query otomatis; pengecualian bisa terlewat akibat batas kandidat sebelum ranking; nominal pada baris berikutnya tidak ikut kutipan. Unggahan bernama sama dengan isi lama dan baru dapat sama-sama ready dan ditemukan.

Pemeriksaan kode juga menemukan flag ekstraksi PDF terpotong dibuang sebelum ready ditetapkan; ini belum direproduksi memakai PDF panjang pada evaluasi ini. Rujukan KB belum menjamin versi/halaman yang dikutip model. Temuan retrieval bukan bukti setiap jawaban model salah: model dapat mencari ulang, tetapi jawaban SE nyata belum diuji.

Rujukan: `apps/server/src/services/knowledge-base-grounding.ts:104`, `:139`; `packages/core/src/knowledge-base/extract.ts:70`; `packages/core/src/anydoc-text.ts:2`; `packages/core/src/knowledge-base/store.ts:336`; `packages/core/src/contract.ts:2568`.

Pertahankan antarmuka sederhana. Perbaiki kelengkapan ekstraksi, konteks pencarian, dokumen yang diganti, dan rujukan jawaban di baliknya. Tes izin yang lulus belum membuktikan akurasi jawaban operasional.

Rekomendasi akhir: **whitelist → KB bersama milik agent layanan WhatsApp**. Tidak perlu model audience/role baru. Temuan teknis ditangani sebagai perbaikan implementasi dengan pengujian profil, file antar pengguna, pencabutan pada sesi lama, dan pertanyaan SE/SOP nyata.
