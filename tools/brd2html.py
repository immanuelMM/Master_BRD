"""Convert every BRD .docx in config.json -> brdPath to formatted HTML for brd.html (stdlib only).

Keeps headings, bold/italic/underline/strike, text colour and shading, lists, tables
(colspan, cell shading), hyperlinks and embedded PNG/JPG/GIF images.
Usage (from the project root): python tools/brd2html.py   -> writes data/brd-docs.js
"""
import html
import json
import os
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
V = "{urn:schemas-microsoft-com:vml}"
MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "bmp": "image/bmp", "svg": "image/svg+xml"}
BLANK = (None, "auto", "FFFFFF", "ffffff")


def convert(path, media_dir, media_url):
    z = zipfile.ZipFile(path)
    rels, styles = {}, {}
    if "word/_rels/document.xml.rels" in z.namelist():
        for rel in ET.fromstring(z.read("word/_rels/document.xml.rels")):
            rels[rel.get("Id")] = rel.get("Target")
    if "word/styles.xml" in z.namelist():
        for s in ET.fromstring(z.read("word/styles.xml")).iter(W + "style"):
            name = s.find(W + "name")
            styles[s.get(W + "styleId")] = (name.get(W + "val") if name is not None else "").lower()
    body = ET.fromstring(z.read("word/document.xml")).find(W + "body")

    def image(rid):
        target = rels.get(rid)
        if not target:
            return ""
        ext = target.rsplit(".", 1)[-1].lower()
        if ext not in MIME:  # EMF/WMF cannot be shown in a browser
            return ""
        name = target[1:] if target.startswith("/") else posixpath.normpath("word/" + target)
        if name not in z.namelist():
            return ""
        # Images go to their own files (lazy-loaded) so the page data stays small.
        os.makedirs(media_dir, exist_ok=True)
        fname = posixpath.basename(name)
        with open(os.path.join(media_dir, fname), "wb") as fh:
            fh.write(z.read(name))
        return f'<img src="{media_url}/{fname}" alt="BRD image" loading="lazy">'

    def flag(rp, tag):
        el = rp.find(W + tag)
        return el is not None and el.get(W + "val") not in ("0", "false", "none")

    def run(r):
        parts = []
        for c in r:
            if c.tag == W + "t":
                parts.append(html.escape(c.text or ""))
            elif c.tag == W + "tab":
                parts.append("&emsp;")
            elif c.tag in (W + "br", W + "cr"):
                parts.append("<br>")
            elif c.tag in (W + "drawing", W + "pict", W + "object"):
                parts += [image(b.get(R + "embed")) for b in c.iter(A + "blip")]
                parts += [image(im.get(R + "id")) for im in c.iter(V + "imagedata")]
        s = "".join(parts)
        rp = r.find(W + "rPr")
        if not s or rp is None:
            return s
        css = []
        col = rp.find(W + "color")
        if col is not None and col.get(W + "val") not in ("auto", "000000", None):
            css.append(f"color:#{col.get(W + 'val')}")
        hl = rp.find(W + "highlight")
        if hl is not None and hl.get(W + "val") != "none":
            css.append(f"background:{hl.get(W + 'val')}")
        sh = rp.find(W + "shd")
        if sh is not None and sh.get(W + "fill") not in BLANK:
            css.append(f"background:#{sh.get(W + 'fill')}")
        if flag(rp, "b"):
            s = f"<strong>{s}</strong>"
        if flag(rp, "i"):
            s = f"<em>{s}</em>"
        if flag(rp, "u"):
            s = f"<u>{s}</u>"
        if flag(rp, "strike"):
            s = f"<s>{s}</s>"
        return f'<span style="{";".join(css)}">{s}</span>' if css else s

    def inline(el):
        out = []
        for node in el:
            if node.tag == W + "r":
                out.append(run(node))
            elif node.tag == W + "hyperlink":
                inner, href = inline(node), rels.get(node.get(R + "id"), "")
                out.append(f'<a href="{html.escape(href)}" target="_blank" rel="noopener">{inner}</a>' if href else inner)
            elif node.tag in (W + "ins", W + "smartTag", W + "sdt", W + "sdtContent", W + "fldSimple", W + "customXml"):
                out.append(inline(node))
        return "".join(out)

    def para(p):
        pp, sid, lvl, align = p.find(W + "pPr"), "", None, ""
        if pp is not None:
            ps = pp.find(W + "pStyle")
            sid = ps.get(W + "val") if ps is not None else ""
            num = pp.find(W + "numPr")
            if num is not None:
                il = num.find(W + "ilvl")
                lvl = int(il.get(W + "val")) if il is not None else 0
            jc = pp.find(W + "jc")
            align = jc.get(W + "val") if jc is not None else ""
        name = styles.get(sid, sid.lower())
        m = re.search(r"heading\s*(\d)", name)
        tag = "h1" if name == "title" else f"h{min(int(m.group(1)) + 1, 6)}" if m else "p"
        if lvl is None and "list" in name and tag == "p":
            lvl = 0
        style = f' style="text-align:{align}"' if align in ("center", "right") else ""
        return tag, lvl, inline(p), style

    def table(t):
        rows = []
        for tr in t.findall(W + "tr"):
            cells = []
            for tc in tr.findall(W + "tc"):
                attrs, tcp = "", tc.find(W + "tcPr")
                if tcp is not None:
                    gs, vm, sh = tcp.find(W + "gridSpan"), tcp.find(W + "vMerge"), tcp.find(W + "shd")
                    if vm is not None and vm.get(W + "val") != "restart":
                        continue  # continuation of a vertically merged cell
                    if gs is not None:
                        attrs += f' colspan="{gs.get(W + "val")}"'
                    if sh is not None and sh.get(W + "fill") not in BLANK:
                        attrs += f' style="background:#{sh.get(W + "fill")}"'
                cells.append(f"<td{attrs}>{blocks(tc)}</td>")
            rows.append("<tr>" + "".join(cells) + "</tr>")
        return '<div class="tbl"><table>' + "".join(rows) + "</table></div>"

    def blocks(container):
        out, items = [], []

        def flush():
            if items:
                out.append("<ul>" + "".join(f'<li style="margin-left:{lv * 22}px">{h}</li>' for lv, h in items) + "</ul>")
                items.clear()

        for el in container:
            if el.tag == W + "p":
                tag, lvl, inner, style = para(el)
                if lvl is not None and inner.strip():
                    items.append((lvl, inner))
                    continue
                flush()
                if inner.strip():
                    out.append(f"<{tag}{style}>{inner}</{tag}>")
            elif el.tag == W + "tbl":
                flush()
                out.append(table(el))
            elif el.tag == W + "sdt" and el.find(W + "sdtContent") is not None:
                flush()
                out.append(blocks(el.find(W + "sdtContent")))
        flush()
        return "".join(out)

    return blocks(body)


def main():
    with open(os.path.join(ROOT, "config.json"), encoding="utf-8") as fh:
        cfg = json.load(fh)
    brd_dir = cfg.get("brdPath", "brd").rstrip("/")
    folder = os.path.join(ROOT, brd_dir)
    docs = []
    for f in sorted(os.listdir(folder)):
        if f.lower().endswith(".docx") and not f.startswith("~$"):
            slug = re.sub(r"[^A-Za-z0-9]+", "-", os.path.splitext(f)[0]).strip("-").lower()
            body = convert(os.path.join(folder, f), os.path.join(ROOT, "data", "brd-media", slug), f"data/brd-media/{slug}")
            docs.append({"file": f"{brd_dir}/{f}", "title": os.path.splitext(f)[0], "html": body})
            print(f"{f}: {len(body) // 1024} KB")
    out = os.path.join(ROOT, "data", "brd-docs.js")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("window.BRD_DOCS = " + json.dumps(docs) + ";\n")
    print(f"wrote {out} ({len(docs)} BRDs)")


if __name__ == "__main__":
    main()
