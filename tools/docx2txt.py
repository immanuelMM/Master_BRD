"""Print the plain text of a .docx file (stdlib only). Usage: python tools/docx2txt.py <file.docx>"""
import re
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as z:
    xml = z.read("word/document.xml").decode("utf8")

xml = re.sub(r"</w:p>", "\n", xml)
xml = re.sub(r"<w:tab/>", "\t", xml)
text = re.sub(r"<[^>]+>", "", xml)
for ent, ch in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&apos;", "'")):
    text = text.replace(ent, ch)
sys.stdout.reconfigure(encoding="utf-8")
print(text)
