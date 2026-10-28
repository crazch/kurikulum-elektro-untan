#!/usr/bin/env python3
"""Pra-render isi data/matkul.json ke index.html (HTML statis + JSON-LD).

Mengganti blok di antara penanda berikut pada index.html:
    <!-- STATIC:START ... --> ... <!-- STATIC:END -->
    <!-- JSONLD:START ... --> ... <!-- JSONLD:END -->

Hasilnya terbaca mesin pencari dan pengguna tanpa JavaScript. Saat JavaScript aktif,
app.js mengganti blok statis dengan tampilan interaktif.

Jalankan setiap kali data/matkul.json berubah:  python3 tools/build_static.py
"""
import json
import re
import sys
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://crazch.github.io/kurikulum-elektro-untan/"
PROVIDER = {
    "@type": "CollegeOrUniversity",
    "name": "Universitas Tanjungpura",
    "sameAs": "https://untan.ac.id/",
}


def fmt(n):
    return str(int(n)) if float(n).is_integer() else str(n).replace(".", ",")


def static_html(data):
    by_kode = {m["kode"]: m for m in data}
    out = []
    for sem in sorted({m["semester"] for m in data}):
        rows = [m for m in data if m["semester"] == sem]
        w = sum(m["sks"] for m in rows if m["jenis"] == "W")
        p = sum(m["sks"] for m in rows if m["jenis"] == "P")
        out.append(f'<section class="static-sem" aria-labelledby="st-sem-{sem}">')
        out.append(f'<h3 id="st-sem-{sem}">Semester {sem}</h3>')
        out.append(f"<p>Total SKS wajib: {fmt(w)} · Total SKS pilihan: {fmt(p)}</p>")
        out.append("<table>")
        out.append(f"<caption class=\"visually-hidden\">Mata kuliah semester {sem}</caption>")
        out.append("<thead><tr><th scope=\"col\">Kode</th><th scope=\"col\">Mata kuliah</th>"
                   "<th scope=\"col\">SKS</th><th scope=\"col\">Jenis</th><th scope=\"col\">Prasyarat</th></tr></thead>")
        out.append("<tbody>")
        for m in rows:
            pre = m.get("prasyarat") or []
            if pre:
                items = ", ".join(
                    f"{escape(k)} {escape(by_kode[k]['nama'])}" for k in pre if k in by_kode)
                status = "resmi" if m.get("prasyarat_status") == "resmi" else "perkiraan"
                pre_html = f"{items} <em>({status})</em>"
            else:
                pre_html = "—"
            jenis = "■ Wajib" if m["jenis"] == "W" else "◇ Pilihan"
            out.append(
                f"<tr><td>{escape(m['kode'])}</td><td>{escape(m['nama'])}</td>"
                f"<td>{fmt(m['sks'])}</td><td>{jenis}</td><td>{pre_html}</td></tr>")
        out.append("</tbody></table></section>")
    return "\n".join(out)


def jsonld(data):
    by_kode = {m["kode"]: m for m in data}
    items = []
    for i, m in enumerate(data, 1):
        jenis = "wajib" if m["jenis"] == "W" else "pilihan"
        course = {
            "@type": "Course",
            "name": m["nama"],
            "courseCode": m["kode"],
            "description": (f"Mata kuliah {jenis} {m['nama']} ({m['kode']}), {fmt(m['sks'])} SKS, "
                            f"semester {m['semester']}, Program Studi Teknik Elektro, "
                            f"Fakultas Teknik, Universitas Tanjungpura."),
            "numberOfCredits": m["sks"],
            "provider": PROVIDER,
            "inLanguage": "id",
        }
        pre = [by_kode[k]["nama"] for k in (m.get("prasyarat") or []) if k in by_kode]
        if pre:
            course["coursePrerequisites"] = pre
        items.append({"@type": "ListItem", "position": i, "item": course})
    doc = {
        "@context": "https://schema.org",
        "@type": "ItemList",
        "name": "Daftar Mata Kuliah Teknik Elektro UNTAN",
        "url": SITE,
        "numberOfItems": len(items),
        "itemListElement": items,
    }
    text = json.dumps(doc, ensure_ascii=False, indent=2)
    # Cegah penutupan <script> dini dan tabrakan dengan Liquid (Jekyll).
    text = text.replace("</", "<\\/").replace("{{", "{ {").replace("{%", "{ %")
    return text


def replace_block(html, name, body):
    pat = re.compile(rf"(<!-- {name}:START[^>]*-->)(.*?)(<!-- {name}:END -->)", re.S)
    if not pat.search(html):
        sys.exit(f"Penanda {name}:START/END tidak ditemukan di index.html")
    return pat.sub(lambda m: f"{m.group(1)}\n{body}\n{m.group(3)}", html, count=1)


def main():
    data = json.loads((ROOT / "data" / "matkul.json").read_text(encoding="utf-8"))
    path = ROOT / "index.html"
    html = path.read_text(encoding="utf-8")
    html = replace_block(html, "STATIC", static_html(data))
    html = replace_block(html, "JSONLD", '<script type="application/ld+json">\n' + jsonld(data) + "\n</script>")
    path.write_text(html, encoding="utf-8")
    print(f"index.html diperbarui: {len(data)} mata kuliah.")


if __name__ == "__main__":
    main()
