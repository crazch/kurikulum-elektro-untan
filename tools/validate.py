#!/usr/bin/env python3
"""Validasi data/matkul.json.

Pemeriksaan:
  - skema field (kode, nama, sks, semester 1-8, jenis W/P, prasyarat, prasyarat_status)
  - kode unik, tanpa duplikat di dalam daftar prasyarat
  - semua kode prasyarat ada di data dan bukan dirinya sendiri
  - semester prasyarat < semester tujuan
  - tanpa siklus
  - maksimal 3 prasyarat per mata kuliah
  - tanpa prasyarat transitif yang redundan (A -> B -> C, lalu A -> C)
  - mata kuliah umum tidak punya prasyarat dan bukan prasyarat siapa pun

Pemakaian:  python3 tools/validate.py [path/ke/matkul.json]
Keluar dengan kode 1 bila ada galat (ERROR); peringatan (WARN) tidak menggagalkan.
"""
import json
import sys
from pathlib import Path

MAKS_PRASYARAT = 3
STATUS_VALID = {"perkiraan", "resmi"}
# Mata kuliah umum / mandiri: tidak boleh punya atau menjadi prasyarat.
UMUM = {"MKWU1", "MKWU2", "MKWU3", "MKWU4", "UMG-105", "UMG-106",
        "TKE-201", "TK-450"}


def main(path):
    errors, warns = [], []
    err = errors.append
    warn = warns.append

    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"ERROR: tidak bisa membaca {path}: {e}")
        return 1
    if not isinstance(data, list):
        print("ERROR: isi berkas harus berupa array.")
        return 1

    by_kode = {}
    for i, mk in enumerate(data):
        kode = mk.get("kode") if isinstance(mk, dict) else None
        if not isinstance(kode, str) or not kode:
            err(f"entri #{i}: 'kode' wajib berupa string tak kosong")
            continue
        if kode in by_kode:
            err(f"{kode}: kode duplikat")
            continue
        by_kode[kode] = mk
        if not isinstance(mk.get("nama"), str) or not mk["nama"].strip():
            err(f"{kode}: 'nama' wajib string")
        if not isinstance(mk.get("sks"), (int, float)) or isinstance(mk.get("sks"), bool) or mk["sks"] <= 0:
            err(f"{kode}: 'sks' wajib angka positif")
        if not isinstance(mk.get("semester"), int) or not 1 <= mk["semester"] <= 8:
            err(f"{kode}: 'semester' wajib bilangan bulat 1-8")
        if mk.get("jenis") not in ("W", "P"):
            err(f"{kode}: 'jenis' harus \"W\" atau \"P\"")
        if not isinstance(mk.get("prasyarat", []), list):
            err(f"{kode}: 'prasyarat' harus array")
        if mk.get("prasyarat") and mk.get("prasyarat_status") not in STATUS_VALID:
            err(f"{kode}: 'prasyarat_status' harus 'perkiraan' atau 'resmi'")
        if not isinstance(mk.get("konsentrasi", ""), str):
            err(f"{kode}: 'konsentrasi' harus string")

    prasyarat = {}
    for kode, mk in by_kode.items():
        daftar = mk.get("prasyarat") or []
        if not isinstance(daftar, list):
            continue
        if len(daftar) != len(set(daftar)):
            err(f"{kode}: prasyarat berisi duplikat {daftar}")
        if len(daftar) > MAKS_PRASYARAT:
            err(f"{kode}: {len(daftar)} prasyarat (maks {MAKS_PRASYARAT})")
        valid = []
        for p in daftar:
            if p == kode:
                err(f"{kode}: merujuk dirinya sendiri")
            elif p not in by_kode:
                err(f"{kode}: prasyarat '{p}' tidak ada di data")
            else:
                valid.append(p)
                if isinstance(by_kode[p].get("semester"), int) and isinstance(mk.get("semester"), int) \
                        and by_kode[p]["semester"] >= mk["semester"]:
                    err(f"{kode} (sem {mk['semester']}): prasyarat {p} berada di sem "
                        f"{by_kode[p]['semester']} (harus lebih awal)")
        prasyarat[kode] = valid
        if kode in UMUM and daftar:
            err(f"{kode}: mata kuliah umum tidak boleh punya prasyarat")
        if kode not in UMUM and any(p in UMUM for p in daftar):
            err(f"{kode}: mata kuliah umum tidak boleh menjadi prasyarat")

    # Siklus (DFS tiga warna)
    warna = {}

    def dfs(u, jejak):
        warna[u] = 1
        for v in prasyarat.get(u, []):
            if warna.get(v) == 1:
                err("siklus: " + " -> ".join(jejak + [u, v]))
            elif warna.get(v) is None:
                dfs(v, jejak + [u])
        warna[u] = 2

    for k in by_kode:
        if warna.get(k) is None:
            dfs(k, [])

    # Prasyarat transitif redundan
    def leluhur(k, cache={}):
        if k in cache:
            return cache[k]
        cache[k] = set()  # pelindung bila ada siklus
        hasil = set()
        for p in prasyarat.get(k, []):
            hasil.add(p)
            hasil |= leluhur(p)
        cache[k] = hasil
        return hasil

    for kode, daftar in prasyarat.items():
        for p in daftar:
            for q in daftar:
                if q != p and p in leluhur(q):
                    err(f"{kode}: prasyarat {p} redundan (sudah tercakup lewat {q})")

    # Peringatan non-fatal: nama ganda lintas kode (bisa sah, mis. beda konsentrasi)
    nama = {}
    for kode, mk in by_kode.items():
        nama.setdefault(str(mk.get("nama", "")).strip().lower(), []).append(kode)
    for n, ks in nama.items():
        if len(ks) > 1:
            warn(f"nama sama pada beberapa kode: {', '.join(ks)} ('{n}')")

    n_edge = sum(len(v) for v in prasyarat.values())
    print(f"{len(by_kode)} mata kuliah, {n_edge} hubungan prasyarat.")
    for w in warns:
        print("WARN:", w)
    for e in errors:
        print("ERROR:", e)
    print("OK: data valid." if not errors else f"GAGAL: {len(errors)} galat.")
    return 1 if errors else 0


if __name__ == "__main__":
    default = Path(__file__).resolve().parent.parent / "data" / "matkul.json"
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else default))
