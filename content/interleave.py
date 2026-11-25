# Verso — 逐段对照 (paragraph-interleaved bilingual PDF).
#
# The original is never re-typeset: every paragraph, figure, table and display formula is cropped
# from the source PDF as vector content, and the Chinese translation is placed right below each
# paragraph. Inline formulas inside a translation are crops of the original formula, so math and
# unmapped glyphs can never turn into garbage. Text inside figures/tables (vector text or, for raster
# images, macOS Vision OCR) is translated and drawn over a copy of the figure.
#
# Usage: <pdf2zh_next python> interleave.py <input.pdf> <output.pdf> [--pages 1-3,5]
# Env:   CLITRANS_TRANSLATE_URL, CLITRANS_TOKEN, CLITRANS_ENGINE, CLITRANS_CACHE_KEY
import hashlib
import html
import io
import json
import os
import collections
import re
import statistics
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import pymupdf

R = pymupdf.Rect
TEXT_LABELS = {"title", "plain text", "figure_caption", "table_caption", "table_footnote"}
VISUAL_LABELS = {"figure", "table"}


def _cache_dir():
    """Translation cache: ~/Library/Caches (macOS), %LOCALAPPDATA% (Windows), ~/.cache (Linux)."""
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Caches/clitrans")
    if os.name == "nt":
        return os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~\\AppData\\Local"), "clitrans", "Cache")
    return os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "clitrans")


CACHE_DIR = _cache_dir()
FONT_DIR = os.path.join(os.path.expanduser("~"), ".cache", "babeldoc", "fonts")  # BabelDOC's own font cache
FONT_FILE = "SourceHanSerifCN-Regular.ttf"


def ensure_font():
    """The Chinese font Story typesets with; BabelDOC downloads it on first use (any OS)."""
    if os.path.exists(os.path.join(FONT_DIR, FONT_FILE)):
        return True
    try:
        emit({"stage": "Download font"})
        from babeldoc.assets.assets import get_font_and_metadata

        path, _ = get_font_and_metadata(FONT_FILE)
        return os.path.exists(str(path))
    except Exception as e:  # noqa: BLE001
        emit({"warn": "中文字体下载失败：" + str(e)[:200]})
        return False
TR_COLOR = "#1f3b73"
FORMULA_COLOR = TR_COLOR  # formulas in a translation share its blue, so the whole translation stands apart

MATH_FONT = re.compile(
    r"CMMI|CMSY|CMEX|CMBSY|MSAM|MSBM|EUFM|EUSM|EUEX|RSFS|LMMath|LatinModernMath|Math|Symbol|MTSY|MTMI|MTEX|"
    r"MT ?Extra|STIX|Euclid|esint|wasy|stmary|txsy|txmi|txex|pxsy|pxmi|pxex|NewTX(MI|SY)|NewPX(MI|SY)|"
    r"XITS|Asana|MathJax|Mathematica|TeXGyre\w*Math|Fira ?Math|LucidaMath|MTPro|AdvP|TT[0-9A-F]{3,}o00",
    re.I,
)


def is_math_char(c):
    o = ord(c)
    return (
        0x0370 <= o <= 0x03FF or 0x2190 <= o <= 0x22FF or 0x2A00 <= o <= 0x2AFF or 0x27C0 <= o <= 0x27EF
        or 0x2980 <= o <= 0x29FF or 0x1D400 <= o <= 0x1D7FF or 0xE000 <= o <= 0xF8FF or o == 0xFFFD
        or c in "∗′″‴⋆∘·×÷±∓∑∏∫√∞∂∇≤≥≠≈≡∼≺≻⊂⊃∈∉∀∃¯ˆ˜˙"
    )


def emit(d):
    sys.stdout.write("@@P " + json.dumps(d, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_pages(spec, n):
    if not spec:
        return list(range(n))
    out = set()
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            a = int(a) if a.strip() else 1
            b = int(b) if b.strip() else n
            out.update(range(a - 1, min(b, n)))
        else:
            out.add(int(part) - 1)
    return sorted(p for p in out if 0 <= p < n)


# ----------------------------------------------------------------------------------- layout
class Region:
    __slots__ = ("label", "rect", "conf", "lines", "pno")

    def __init__(self, label, rect, conf, pno):
        self.label, self.rect, self.conf, self.pno = label, R(rect), conf, pno
        self.lines = []


def area(r):
    return max(0.0, r.width) * max(0.0, r.height)


def overlap(a, b):
    return area(R(a) & R(b))


class LayoutModel:
    def __init__(self):
        from babeldoc.docvision.doclayout import OnnxModel
        from babeldoc.format.pdf.document_il.utils.raster_geometry import with_target_long_edge

        self.model = OnnxModel.from_pretrained()
        self.geom = with_target_long_edge

    def detect(self, page):
        g = self.geom(page, 72, 1024, normalize_rotation=True)
        res = self.model.predict(g.image[:, :, ::-1], geometry=g)[0]
        out = []
        for b in res.boxes:
            x0, y0, x1, y1 = (float(v) for v in b.xyxy)
            rect = R(x0, y0, x1, y1) & page.rect
            if rect.is_empty:
                continue
            out.append(Region(res.names[int(b.cls)], rect, float(b.conf), page.number))
        return out


def dedup_regions(regs):
    regs = sorted(regs, key=lambda r: -r.conf)
    kept = []
    for r in regs:
        a = area(r.rect) or 1
        drop = False
        for k in kept:
            ov = overlap(r.rect, k.rect)
            if r.label in TEXT_LABELS and k.label in VISUAL_LABELS and ov > 0.5 * a:
                drop = True  # labels inside a figure/table belong to the figure
            elif ov > 0.6 * a and (r.label == k.label or {r.label, k.label} <= TEXT_LABELS | {"abandon"}):
                drop = True
            if drop:
                break
        if not drop:
            kept.append(r)
    # equation numbers ("(3)") are separate boxes next to their formula: fold them in
    formulas = [r for r in kept if r.label == "isolate_formula"]
    rest = []
    for r in kept:
        if r.label == "formula_caption":
            host = next((f for f in formulas if min(f.rect.y1, r.rect.y1) - max(f.rect.y0, r.rect.y0) > 0.3 * r.rect.height), None)
            if host:
                host.rect |= r.rect
                continue
            r.label = "plain text"
        rest.append(r)
    return rest


def page_lines(page):
    """Text lines with their spans (char level), in PDF space."""
    d = page.get_text("rawdict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_MEDIABOX_CLIP)
    lines = []
    for bno, b in enumerate(d["blocks"]):
        if b.get("type") != 0:
            continue
        for l in b["lines"]:
            if abs(l["dir"][1]) > 0.2:  # skip rotated text (margins, watermarks)
                continue
            spans = [s for s in l["spans"] if s["chars"]]
            if not spans or not "".join(c["c"] for s in spans for c in s["chars"]).strip():
                continue
            lines.append({"bbox": R(l["bbox"]), "spans": spans, "block": bno})
    return lines


def assign_lines(regions, lines, page):
    stray = []
    for ln in lines:
        lb = ln["bbox"]
        la = area(lb) or 1
        best, bo = None, 0.0
        for r in regions:
            ov = overlap(lb, r.rect)
            if ov > bo:
                best, bo = r, ov
        if best is not None and bo >= 0.45 * la:
            best.lines.append(ln)
        else:
            stray.append(ln)
    # a stray piece of a formula (a tall bracket, a script) belongs to the region it touches
    keep = []
    for ln in stray:
        txt = "".join(c["c"] for s_ in ln["spans"] for c in s_["chars"]).strip()
        near = [r for r in regions if r.label in TEXT_LABELS | {"isolate_formula"} and
                (ln["bbox"] + (-3, -6, 3, 6)).intersects(r.rect)]
        if near and (len(txt) <= 3 or not re.search(r"[A-Za-z]{3,}", txt)):
            max(near, key=lambda r: overlap(ln["bbox"] + (-3, -6, 3, 6), r.rect)).lines.append(ln)
        else:
            keep.append(ln)
    stray = keep
    # text the layout model missed must not get lost: group it by PDF block
    by_block = {}
    for ln in stray:
        by_block.setdefault(ln["block"], []).append(ln)
    for blk in by_block.values():
        rect = R(blk[0]["bbox"])
        for ln in blk[1:]:
            rect |= ln["bbox"]
        if rect.y1 < page.rect.height * 0.06 or rect.y0 > page.rect.height * 0.94:
            continue  # running header / footer
        if not re.search(r"[A-Za-z0-9]", "".join(c["c"] for ln in blk for s_ in ln["spans"] for c in s_["chars"])):
            continue  # lone brackets / rules that belong to nothing
        reg = Region("plain text", rect, 0.0, page.number)
        reg.lines = blk
        regions.append(reg)
    for r in regions:
        r.lines.sort(key=lambda ln: (round(ln["bbox"].y1 / 3), ln["bbox"].x0))
        if r.label in TEXT_LABELS and r.lines:
            # crop exactly the region's own lines, so no sliver of a neighbouring line shows up
            u = R(r.lines[0]["bbox"])
            for ln in r.lines[1:]:
                u |= ln["bbox"]
            r.rect = u + (-1.0, -0.4, 1.0, 0.4)
    regions = [r for r in regions if r.label not in TEXT_LABELS or r.lines]
    out = []
    for r in sorted(regions, key=lambda r: -area(r.rect)):
        if any(overlap(r.rect, o.rect) > 0.6 * (area(r.rect) or 1) for o in out):
            continue  # a box (almost) inside an already kept one: the same content twice
        out.append(r)
    return out


def order_regions(regs, page):
    w = page.rect.width
    mid = w / 2

    def wide(r):
        return r.rect.width > 0.55 * w or (r.rect.x0 < mid - 0.06 * w and r.rect.x1 > mid + 0.06 * w)

    out, band = [], []

    def flush():
        band.sort(key=lambda r: (0 if r.rect.x0 + r.rect.width / 2 < mid else 1, r.rect.y0))
        out.extend(band)
        band.clear()

    # captions travel with their figure/table (above or below it), not with the column they sit in
    visuals = [r for r in regs if r.label in VISUAL_LABELS]
    attached = {}  # id(visual) -> ([captions above], [captions below])
    loose = []
    for r in regs:
        if r.label in ("figure_caption", "table_caption", "table_footnote") and visuals:
            def dist(v):
                if r.rect.y1 <= v.rect.y0 + 2:
                    return v.rect.y0 - r.rect.y1
                if r.rect.y0 >= v.rect.y1 - 2:
                    return r.rect.y0 - v.rect.y1
                return 0.0
            v = min(visuals, key=dist)
            hx = min(r.rect.x1, v.rect.x1) - max(r.rect.x0, v.rect.x0)
            if dist(v) < 40 and hx > -20:
                above = r.rect.y1 <= v.rect.y0 + 2
                attached.setdefault(id(v), ([], []))[0 if above else 1].append(r)
                continue
        loose.append(r)

    for r in sorted(loose, key=lambda r: r.rect.y0):
        if wide(r):
            flush()
            out.append(r)
        else:
            band.append(r)
    flush()
    final = []
    for r in out:
        caps = attached.get(id(r))
        if caps:
            final += sorted(caps[0], key=lambda c: c.rect.y0)
            final.append(r)
            final += sorted(caps[1], key=lambda c: c.rect.y0)
        else:
            final.append(r)
    return final


# ------------------------------------------------------------------------- text + formulas
DISPLAY = "\x00DISPLAY\x00"  # placeholder markup: a displayed equation inside a sentence (shown as a block)


class Placeholders:
    def __init__(self):
        self.items = []  # (pno, rect, html)

    def add(self, pno, rect, markup=None, masks=()):
        self.items.append((pno, R(rect), markup, list(masks)))
        return "{v%d}" % len(self.items)


# ------------------------------------------------------------- formulas as text (sub/sup/frac)
def fmt_char(t):
    ch = t[0]
    o = ord(ch) if ch else 0
    if ch == "\ufffd" or 0xE000 <= o <= 0xF8FF:
        r = t[1]  # no Unicode for this glyph: show the glyph itself, cropped tightly
        return "\x00G:%.2f:%.2f:%.2f:%.2f\x00" % (r.x0, r.y0, r.x1, r.y1)
    e = html.escape(ch)
    if t[4] and ch.isalpha() and (ch.isascii() or 0x0370 <= o <= 0x03FF):
        return "<i>" + e + "</i>"
    return e


def segments(ts, em):
    ts = sorted(ts, key=lambda t: t[1].x0)
    out = []
    for t in ts:
        if out and t[1].x0 - max(x[1].x1 for x in out[-1]) < 0.3 * em:
            out[-1].append(t)
        else:
            out.append([t])
    return out


def linearize_ex(tokens, em):
    flag = []
    out = linearize(tokens, em, 0, flag)
    return out, bool(flag)


def linearize(tokens, em, depth=0, frac_flag=None):
    """Rebuild a formula from glyph positions: scripts → <sub>/<sup>, stacked parts → (a)/(b)."""
    toks = [t for t in tokens if t[0].strip()]
    if not toks:
        return ""
    if depth > 2 or len(toks) == 1:
        return "".join(fmt_char(t) for t in sorted(toks, key=lambda t: t[1].x0))
    top = em if depth == 0 else max(t[3] for t in toks)
    big = [t for t in toks if 0.86 * top <= t[3] <= 1.15 * top] or [t for t in toks if t[3] >= 0.86 * top] or toks
    cy = statistics.median([(t[1].y0 + t[1].y1) / 2 for t in big])
    mh = statistics.median([t[1].height for t in big]) or em
    main, up, down = [], [], []
    for t in toks:
        c = (t[1].y0 + t[1].y1) / 2
        if t[3] > 1.15 * top or (t[3] >= 0.86 * top and abs(c - cy) < 0.45 * mh):
            main.append(t)  # body glyphs and tall delimiters
        elif t[3] >= 0.86 * top and abs(c - cy) < 0.6 * mh:
            main.append(t)
        elif c < cy:
            up.append(t)  # small glyphs are always scripts or fraction parts
        else:
            down.append(t)
    items = [(t[1].x0, 0, fmt_char(t)) for t in main]
    U, D = segments(up, em), segments(down, em)
    used = set()

    def ext(seg):
        return seg[0][1].x0, max(t[1].x1 for t in seg)

    def has_base(x0):
        """A glyph a script can hang on sits right before x0: q_i^FG, β_i, (…)², x′."""
        left = [t for t in main if t[1].x1 <= x0 + 0.15 * em and x0 - t[1].x1 < 0.3 * em]
        if not left:
            return False
        b = max(left, key=lambda t: t[1].x1)[0]
        return b.isalnum() or b in ")]}′″*∗|" or 0x0370 <= ord(b) <= 0x03FF

    for u in U:
        ux0, ux1 = ext(u)
        hit = None
        for k, d in enumerate(D):
            if k in used:
                continue
            dx0, dx1 = ext(d)
            if min(ux1, dx1) - max(ux0, dx0) > 0.4 * min(ux1 - ux0, dx1 - dx0):
                if not has_base(min(ux0, dx0)):  # sub+superscript of one base is not a fraction
                    hit = k
                break
        if hit is not None:
            used.add(hit)
            if frac_flag is not None:
                frac_flag.append(1)
            num = linearize(u, em, depth + 1, frac_flag)
            den = linearize(D[hit], em, depth + 1, frac_flag)
            wrap = lambda x, seg: "(" + x + ")" if len([t for t in seg if t[0].strip()]) > 1 and not (x.startswith("(") and x.endswith(")")) else x
            items.append((min(ux0, ext(D[hit])[0]), 1, wrap(num, u) + "/" + wrap(den, D[hit])))
        else:
            # a script hanging off nothing is a lone part: keep it on the line
            items.append((ux0, 3, "<sup>" + linearize(u, em, depth + 1, frac_flag) + "</sup>"))
    for k, d in enumerate(D):
        if k not in used:
            items.append((ext(d)[0], 2, "<sub>" + linearize(d, em, depth + 1, frac_flag) + "</sub>"))
    items.sort(key=lambda x: (round(x[0], 1), x[1]))
    out = "".join(x[2] for x in items)
    return re.sub(r"\s*(=|≤|≥|≠|≈|∈|∉|⊂|⊆|≡|→|&lt;|&gt;)\s*", r" \1 ", out)


VISION_ENGINES = ("codex", "claude", "gemini", "deepseek")
VISION_NAME = {"codex": "GPT", "claude": "Claude", "gemini": "Gemini", "deepseek": "DeepSeek"}  # the plugin sets CLITRANS_VISION only when the channel can see
TEXT_FONTS = set()  # fonts that carry the running text of this document: never "math" by name
BROKEN_FONTS = set()  # math fonts whose text layer lies ("(" extracted as "b", ")" as "#"): use the picture
BAD_TOKS = set()  # (x0, y0) of glyphs from BROKEN_FONTS (tokens get copied, so not by id)


def tok_key(t):
    return (round(t[1].x0, 2), round(t[1].y0, 2))
BROKEN_MARK = re.compile(r'["#$&@`~\ufffd]')
REAL_WORD = re.compile(r"(?<![A-Za-z])[A-Za-z]?[a-z]*[aeiouy][a-z]*(?![A-Za-z])")  # "Figure", "viewed"


def real_words(t):
    return [w for w in REAL_WORD.findall(t) if len(w) >= 4]


STRICT_MATH_FONT = re.compile(r"CMMI|CMSY|CMEX|MSAM|MSBM|Math|Symbol|MTSY|MTMI|MTEX|STIX.*(?:Math|Sym)", re.I)


def is_math_font(font):
    font = font or ""
    if not MATH_FONT.search(font):
        return False
    return bool(STRICT_MATH_FONT.search(font)) or font_family(font) not in TEXT_FONTS


def font_family(font):
    """'ABCDEF+AdvPSPAL-I' -> 'advpspal': the italic/bold cuts of a text font are text too."""
    return re.split(r"[-,]", (font or "").split("+")[-1])[0].lower()


# "Times-Italic", "PalatinoIt", Advent's "…TTd8ef4e6f.I" / "AdvPSPAL-I", "…-BI"
ITALIC_NAME = re.compile(r"Italic|Oblique|[-.,_](?:I|It|BI|BoldIt|SemiboldIt)$|[a-z]It$")


def span_is_math(span, body_size):
    t = "".join(c["c"] for c in span["chars"]).strip()
    if not t:
        return False
    if font_family(span["font"]) in BROKEN_FONTS:
        return True
    if all(c in "’‘'\"“”,.;:!?–—-" for c in t.replace(" ", "")):
        return False  # a lone apostrophe or comma, even in a math font (Elsevier sets ’ in STIX)
    if is_math_font(span["font"]) and (STRICT_MATH_FONT.search(span["font"] or "") or not real_words(t)):
        return True  # an ambiguous family (AdvP…, TT…) spelling a real word is a text font
    if len(t) <= 3 and any(is_math_char(c) for c in t):
        return True  # longer spans: only the math characters themselves count (per glyph)
    italic = bool(span["flags"] & 2) or bool(ITALIC_NAME.search(span["font"] or ""))
    if italic and len(t) == 1 and t.isalpha() and t not in "aAI":
        return True  # single-letter variable in Times/Palatino-style papers
    if span["size"] < 0.78 * body_size and len(t) <= 4:
        return True  # sub/superscript
    return False


CONNECT = set("()[]{}=+-−,.:;|/0123456789'^_ ")


def line_tokens(ln, body_size):
    """[(char, bbox, is_math, size)] for one line, with short connectors between math bridged."""
    toks = []
    for s in ln["spans"]:
        m = span_is_math(s, body_size)
        f = s["font"] or ""
        it = bool(s["flags"] & 2) or bool(ITALIC_NAME.search(f)) or bool(re.search(r"CMMI|MI\d|Math", f))
        bad = font_family(f) in BROKEN_FONTS
        for c in s["chars"]:
            ch = c["c"]
            toks.append([ch, R(c["bbox"]), m or is_math_char(ch), s["size"], it])
            if bad:
                BAD_TOKS.add(tok_key(toks[-1]))
    n = len(toks)
    em = body_size
    for i in range(n):  # "1 − β", "(w, G)", "= 0" — only when they are really next to each other
        if toks[i][2]:
            j = i + 1
            while j < n and not toks[j][2] and toks[j][0] in CONNECT and j - i < 5:
                j += 1
            if j < n and toks[j][2] and j > i + 1 and toks[j][1].x0 - toks[i][1].x1 < 1.0 * em:
                for k in range(i + 1, j):
                    toks[k][2] = True
    # a math run swallows the brackets/punctuation that hug it: "(", ")", "²", ","
    for i in range(n):
        if not toks[i][2] and toks[i][0] in "()[]{}|" and (
                (i + 1 < n and toks[i + 1][2]) or (i > 0 and toks[i - 1][2])):
            toks[i][2] = True
    return toks


def region_text(reg, body_size, ph):
    """Paragraph text with every formula replaced by one {vN} placeholder.

    PDFs often store a formula line as several "lines": the main glyphs, a line of superscripts, a
    line of numerators, one of denominators. So first rebuild the visual text lines (baseline bands)
    from full-size lines, find formulas along each band, then hang every small glyph (script,
    numerator, denominator) on the formula it sits over."""
    # the region's own text size (captions, affiliations, footnotes are smaller than body text)
    sizes = [s_["size"] for ln in reg.lines for s_ in ln["spans"] for c in s_["chars"] if c["c"].strip()]
    em = statistics.median(sizes) if sizes else body_size
    body_size = em
    plines = [line_tokens(ln, body_size) for ln in reg.lines]
    toks = [t + [li] for li, tl in enumerate(plines) for t in tl if t[0].strip()]  # [ch, rect, math, size, it, line, seq]
    for q, t in enumerate(toks):
        t.append(q)
    if not toks:
        return ""

    # 1. baseline bands from full-size glyphs (PDF "lines" mix scripts and neighbouring rows)
    # tall delimiters (big parentheses) are not row glyphs: they would open bands of their own
    big = sorted((t for t in toks if 0.86 * em <= t[3] <= 1.15 * em), key=lambda t: (t[1].y0 + t[1].y1) / 2)
    bands = []  # [y0, y1, [tokens], [centers]]
    for t in big:
        c = (t[1].y0 + t[1].y1) / 2
        if bands and c - statistics.median(bands[-1][3]) < 0.5 * em:
            b = bands[-1]
            b[2].append(t)
            b[3].append(c)
        else:
            bands.append([0, 0, [t], [c]])
    for b in bands:
        b[0] = statistics.median(t[1].y0 for t in b[2])
        b[1] = statistics.median(t[1].y1 for t in b[2])
    if not bands:  # no row glyphs at all: one band per PDF line
        for li in sorted(by_line_ := {t[5] for t in toks}):
            g = [t for t in toks if t[5] == li]
            bands.append([min(t[1].y0 for t in g), max(t[1].y1 for t in g), g, [0]])
    in_band = {id(t) for b in bands for t in b[2]}
    loose = [t for t in toks if id(t) not in in_band]  # scripts, numerators, denominators

    def band_of(t):
        c = (t[1].y0 + t[1].y1) / 2
        return min(range(len(bands)), key=lambda k: abs(c - (bands[k][0] + bands[k][1]) / 2))

    # 2. a loose glyph right after a text letter makes that letter a math base: q + "FG/i"
    for t in loose:
        b = bands[band_of(t)][2]
        left = [u for u in b if u[1].x1 <= t[1].x0 + 0.15 * em and t[1].x0 - u[1].x1 < 0.3 * em]
        if left:
            u = max(left, key=lambda u: u[1].x1)
            if not u[2] and u[0].isalnum():
                # walk left over the whole word: only 1–2 letter words are variables ("q", "Rt")
                row = sorted((v for v in b if not v[2] and v[0].strip()), key=lambda v: v[1].x0)
                k = row.index(u) if u in row else -1
                word = [u]
                while k > 0 and row[k - 1][0].isalnum() and word[0][1].x0 - row[k - 1][1].x1 < 0.12 * em:
                    k -= 1
                    word.insert(0, row[k])
                if len(word) <= 2:
                    for v in word:
                        v[2] = True

    # loose glyphs (scripts, numerators, denominators) take part in their band's formula runs
    leftovers = []
    for t in loose:
        bi = band_of(t)
        c = (t[1].y0 + t[1].y1) / 2
        if abs(c - (bands[bi][0] + bands[bi][1]) / 2) < 1.3 * em:
            t[2] = True
            bands[bi][2].append(t)
        else:
            leftovers.append(t)
    loose = leftovers
    in_rows = {id(t) for b in bands for t in b[2]}
    # 3. formulas along each band: math glyphs joined through operators/brackets/digits
    NEUTRAL = set("=+-−–×·/<>≤≥≠≈∈,;:()[]{}|0123456789.′'*∗^_!\ufffd")
    formulas = []  # dict(band, toks, x0, x1)
    for bi, b in enumerate(bands):
        row = sorted(b[2], key=lambda t: t[1].x0)
        k = 0
        while k < len(row):
            if not row[k][2]:
                k += 1
                continue
            run = [row[k]]
            # pull in an opening bracket / operator glued to the left
            back = k - 1
            while back >= 0 and row[back][0] in NEUTRAL and run[0][1].x0 - row[back][1].x1 < 0.4 * em and row[back][0] not in ",;:.":
                run.insert(0, row[back])
                back -= 1
            m = k + 1
            pend = []
            while m < len(row):
                t = row[m]
                gap = t[1].x0 - max(u[1].x1 for u in run + pend)
                if gap >= 1.0 * em:
                    break
                if t[2]:
                    run += pend + [t]
                    pend = []
                elif t[0] in NEUTRAL:
                    pend.append(t)
                else:
                    break
                m += 1
            # keep closing brackets / scripts-like digits that end the formula, drop dangling punctuation
            while pend and pend[0][0] in ")]}|′'0123456789" and pend[0][1].x0 - run[-1][1].x1 < 0.4 * em:
                run.append(pend.pop(0))
            for t in run:
                t[2] = True
            formulas.append({"band": bi, "toks": run, "x0": min(u[1].x0 for u in run), "x1": max(u[1].x1 for u in run)})
            k = m - len(pend) if pend else m
            k = max(k, row.index(run[-1]) + 1)
    # 4. hang loose glyphs on the formula they sit over (nearest band first)
    for t in loose:
        cx = (t[1].x0 + t[1].x1) / 2
        cy = (t[1].y0 + t[1].y1) / 2
        cands = [f for f in formulas if f["x0"] - 0.5 * em <= cx <= f["x1"] + 0.6 * em]
        if cands:
            f = min(cands, key=lambda f: abs(cy - (bands[f["band"]][0] + bands[f["band"]][1]) / 2))
            f["toks"].append(t)
            f["x1"] = max(f["x1"], t[1].x1)
        else:  # nothing to hang on: a formula of its own in the nearest band
            formulas.append({"band": band_of(t), "toks": [t], "x0": t[1].x0, "x1": t[1].x1})
    first = {}
    for k, f in enumerate(formulas):
        first[id(min(f["toks"], key=lambda t: (0 if id(t) in in_band else 1, t[1].x0)))] = k
    owned = {id(t): k for k, f in enumerate(formulas) for t in f["toks"]}

    # 5. placeholders: one-line formulas with scripts become text; anything stacked is cropped
    names = {}
    for k, f in enumerate(formulas):
        rr = R(f["toks"][0][1])
        for t in f["toks"][1:]:
            rr |= t[1]
        markup, frac = linearize_ex(f["toks"], em)
        bad = any(tok_key(t) in BAD_TOKS for t in f["toks"])
        if bad and not frac:
            # broken fonts also misreport glyph boxes: keep the crop on the formula's own text line
            # (operators such as "=" report boxes twice the line height): use the normal-height glyphs
            sane = [t[1] for t in f["toks"] if t[1].height <= 1.25 * em] or [t[1] for t in f["toks"]]
            rr = R(rr.x0, max(rr.y0, min(r_.y0 for r_ in sane) - 0.03 * em), rr.x1,
                   min(rr.y1, max(r_.y1 for r_ in sane) + 0.08 * em))
        # crops blank out every other glyph's box, then paint the formula's own glyph boxes back
        masks = [("x", R(t[1])) for t in toks if owned.get(id(t)) != k and t[1].intersects(rr)]
        # tall delimiters' boxes reach into the next row: restore only their middle
        masks += [("k", R(t[1]) if t[3] <= 1.15 * em else R(t[1].x0, t[1].y0 + 0.12 * t[1].height, t[1].x1, t[1].y1 - 0.22 * t[1].height))
                  for t in f["toks"]]
        if markup and not frac and not any(tok_key(t) in BAD_TOKS for t in f["toks"]):
            names[k] = ph.add(reg.pno, rr, markup.strip(), masks)
        else:
            names[k] = ph.add(reg.pno, rr, None, masks)

    def reading_order(row):
        """Keep each PDF line's own glyph order (ligatures!), interleave lines by x."""
        groups = {}
        for t in row:
            groups.setdefault(t[5], []).append(t)
        heads = [sorted(g, key=lambda t: t[6]) for g in groups.values()]
        out = []
        while heads:
            g = min(heads, key=lambda g: g[0][1].x0)
            out.append(g.pop(0))
            if not g:
                heads.remove(g)
        return out

    parts = []
    for bi, b in enumerate(bands):
        out = []
        prev = None
        for t in reading_order(b[2]):
            k = owned.get(id(t))
            if k is None:
                if prev is not None and t[1].x0 - prev[1].x1 > 0.15 * em:
                    out.append(" ")
                out.append(t[0])
            elif id(t) in first:
                out.append(" " + names[k] + " ")
            prev = t
        for k, f in enumerate(formulas):  # formulas made only of loose glyphs
            if f["band"] == bi and all(id(t) not in in_rows for t in f["toks"]):
                out.append(" " + names[k] + " ")
        t = re.sub(r"\s+", " ", "".join(out)).strip()
        if not t:
            continue
        if parts and parts[-1].endswith("-") and t[:1].islower():
            parts[-1] = parts[-1][:-1] + t
        else:
            parts.append(t)
    text = " ".join(parts).strip()
    return re.sub(r"\s+([,.;:)])", r"\1", re.sub(r"\(\s+", "(", text))


# ------------------------------------------------------------------------------ translation
class Translator:
    def __init__(self):
        self.url = os.environ["CLITRANS_TRANSLATE_URL"]
        self.token = os.environ.get("CLITRANS_TOKEN", "")
        self.engine = os.environ.get("CLITRANS_ENGINE", "google")
        self.key = os.environ.get("CLITRANS_CACHE_KEY", self.engine)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        os.makedirs(CACHE_DIR, exist_ok=True)
        self.cache_path = os.path.join(CACHE_DIR, "interleave-cache.jsonl")
        self.cache = {}
        try:
            with open(self.cache_path, encoding="utf-8") as f:
                for line in f:
                    try:
                        k, v = json.loads(line)
                        self.cache[k] = v
                    except Exception:  # noqa: BLE001
                        pass
        except FileNotFoundError:
            pass
        self.lock = threading.Lock()
        self.errors = []
        self.images = {}  # (text, "vision") -> png path
        self.fail_streak = 0
        self.dead = None  # set once the service looks down: stop hammering it

    def _k(self, text, kind):
        extra = ""
        if kind in ("vision", "figvision"):  # the picture is what gets translated: key on its pixels
            try:
                extra = hashlib.sha1(open(self.images[(text, kind)], "rb").read()).hexdigest()
            except Exception:  # noqa: BLE001
                extra = "?"
        return hashlib.sha1((self.key + "\x00" + kind + "\x00" + text + extra).encode()).hexdigest()

    def _call(self, text, kind):
        if self.dead:
            raise RuntimeError(self.dead)
        req = {"text": text, "engine": self.engine, "mode": "interleave", "kind": kind}
        if kind in ("vision", "figvision"):
            req["mode"] = "vision" if kind == "vision" else "figure"
            req["image"] = self.images[(text, kind)]
        body = json.dumps(req).encode()
        last = None
        for attempt in range(3):
            try:
                req = urllib.request.Request(self.url, data=body, headers={
                    "Content-Type": "application/json", "Authorization": "Bearer " + self.token})
                with self.opener.open(req, timeout=900) as r:
                    return json.loads(r.read())["translation"]
            except urllib.error.HTTPError as e:
                try:
                    last = json.loads(e.read()).get("error") or e
                except Exception:  # noqa: BLE001
                    last = e
                if e.code in (401, 502):  # 502: Zotero already retried the engine itself
                    break
            except Exception as e:  # noqa: BLE001
                last = e
            time.sleep(1 + attempt * 2)
        raise RuntimeError(str(last))

    def translate_all(self, jobs, progress):
        """jobs: list of (text, kind). Returns {text: translation or None}."""
        todo, out = [], {}
        for text, kind in jobs:
            k = self._k(text, kind)
            if k in self.cache:
                out[(text, kind)] = self.cache[k]
            elif (text, kind) not in out:
                out[(text, kind)] = None
                todo.append((text, kind))
        total, done = len(todo), [0]
        if not total:
            return out
        fh = open(self.cache_path, "a", encoding="utf-8")

        def work(job):
            text, kind = job
            try:
                tr = self._call(text, kind)
                with self.lock:
                    self.fail_streak = 0
            except Exception as e:  # noqa: BLE001
                with self.lock:
                    self.errors.append(str(e))
                    self.fail_streak += 1
                    if self.fail_streak >= 6 and not self.dead and kind not in ("vision", "figvision"):
                        self.dead = "翻译服务连续失败，已停止：" + str(e)[:200]
                tr = None
            with self.lock:
                out[job] = tr
                if tr is not None:
                    fh.write(json.dumps([self._k(text, kind), tr], ensure_ascii=False) + "\n")
                done[0] += 1
                progress(done[0], total)

        workers = 64 if self.engine in ("codex", "claude", "gemini") else 8
        with ThreadPoolExecutor(max_workers=workers) as ex:
            list(ex.map(work, todo))
        fh.close()
        if all(k in ("vision", "figvision") for _, k in todo):
            return out  # vision failures fall back to the text path; never fatal
        if self.dead or (total and len(self.errors) >= total):
            raise RuntimeError((self.dead or "翻译全部失败：" + self.errors[-1][:300]) +
                               "（已翻译的段落已缓存，稍后重试不会重复消耗）")
        return out


# ------------------------------------------------------------------------------------- OCR
def ocr_binary(src_dir):
    """macOS: compile the Vision helper once. Elsewhere (or without Xcode tools): "rapidocr" if the
    RapidOCR package is installed, else None (figure text then comes from the PDF / the vision model)."""
    src = os.path.join(src_dir, "ocr.swift")
    if (os.environ.get("CLITRANS_OCR") == "rapidocr" or sys.platform != "darwin" or not os.path.exists(src)
            or not shutil.which("xcrun")):
        return "rapidocr" if _rapidocr() else None
    tag = hashlib.sha1(open(src, "rb").read()).hexdigest()[:10]
    os.makedirs(CACHE_DIR, exist_ok=True)
    binp = os.path.join(CACHE_DIR, "clitrans-ocr-" + tag)
    if os.path.exists(binp):
        return binp
    emit({"stage": "Prepare OCR"})
    try:
        r = subprocess.run(["xcrun", "swiftc", "-O", src, "-o", binp + ".tmp"], capture_output=True, timeout=300)
        if r.returncode == 0:
            os.replace(binp + ".tmp", binp)
            return binp
    except Exception:  # noqa: BLE001
        pass
    return "rapidocr" if _rapidocr() else None  # no Xcode command line tools


_RAPID = []


def _rapidocr():
    if not _RAPID:
        try:
            from rapidocr_onnxruntime import RapidOCR

            _RAPID.append(RapidOCR())
        except Exception:  # noqa: BLE001
            _RAPID.append(None)
    return _RAPID[0]


def run_rapidocr(images):
    """Same shape as the Vision helper: {file: [{"text", "conf", "box": [x0, y0, x1, y1] (0–1, top-left)}]}"""
    eng = _rapidocr()
    out = {}
    for f in images if eng else []:
        try:
            pix = pymupdf.Pixmap(f)
            w, h = float(pix.width), float(pix.height)
            res, _ = eng(f)
        except Exception:  # noqa: BLE001
            continue
        lines = []
        for quad, text, conf in res or []:
            xs = [p[0] for p in quad]
            ys = [p[1] for p in quad]
            lines.append({"text": text, "conf": float(conf),
                          "box": [min(xs) / w, min(ys) / h, max(xs) / w, max(ys) / h]})
        # RapidOCR cuts one printed line into pieces ("(1)" + "Supplier: w"): group pieces into rows
        # (vertical overlap), then join neighbours whose gap is under one line height
        rows = []
        for d in sorted(lines, key=lambda d: (d["box"][1] + d["box"][3]) / 2):
            b = d["box"]
            row = next((r for r in rows if min(r["y1"], b[3]) - max(r["y0"], b[1]) > 0.5 * min(b[3] - b[1], r["y1"] - r["y0"])), None)
            if row:
                row["items"].append(d)
                row["y0"], row["y1"] = min(row["y0"], b[1]), max(row["y1"], b[3])
            else:
                rows.append({"y0": b[1], "y1": b[3], "items": [d]})
        merged = []
        for row in rows:
            cur = None
            for d in sorted(row["items"], key=lambda d: d["box"][0]):
                b = d["box"]
                lh = (b[3] - b[1]) * h / w  # line height in width units
                if cur and -0.6 * lh <= b[0] - cur["box"][2] < 0.9 * lh:
                    cur["text"] += " " + d["text"]
                    cur["box"] = [cur["box"][0], min(cur["box"][1], b[1]), b[2], max(cur["box"][3], b[3])]
                    cur["conf"] = min(cur["conf"], d["conf"])
                else:
                    cur = dict(d)
                    merged.append(cur)
        out[f] = merged
    return out


def run_ocr(binp, images):
    if not binp or not images:
        return {}
    if binp == "rapidocr":
        return run_rapidocr(images)
    try:
        r = subprocess.run([binp] + images, capture_output=True, timeout=600, text=True)
    except Exception:  # noqa: BLE001
        return {}
    out = {}
    for line in r.stdout.splitlines():
        try:
            d = json.loads(line)
            out[d["file"]] = d["lines"]
        except Exception:  # noqa: BLE001
            pass
    return out


def group_label_lines(lines, merge=True):
    """[(text, rect)] -> blocks [(text, rect, [rects])]: lines of one label stacked closely.
    Tables keep one block per line: stacked lines there are usually separate rows."""
    lines = sorted(lines, key=lambda t: (t[1].y0, t[1].x0))
    blocks = []
    for text, rect in lines:
        h = rect.height or 1
        host = None
        enum = re.match(r"^\s*(?:\d{1,2}|[a-zA-Z]|[ivx]{1,4})[.)]\s", text)
        for b in ([] if enum else blocks):
            last = b[2][-1]
            if not merge:
                # table: only a wrapped cell continues ("…working capital" / "management; SCF")
                prev = b[0].rstrip()
                if not (text[:1].islower() or prev.endswith(("-", ",", ";", "and", "of", "the"))):
                    continue
                if abs(last.x0 - rect.x0) > 3:
                    continue
            same_col = abs(last.x0 - rect.x0) < 1.5 * h or (min(last.x1, rect.x1) - max(last.x0, rect.x0)) > 0.5 * min(last.width, rect.width)
            if same_col and -0.5 * h <= rect.y0 - last.y1 < 0.9 * h and abs(last.height - h) < 0.6 * h:
                host = b
                break
        if host:
            sep = "" if host[0].endswith("-") else " "
            host[0] = (host[0][:-1] if sep == "" else host[0]) + sep + text
            host[1] |= rect
            host[2].append(rect)
        else:
            blocks.append([text, R(rect), [R(rect)]])
    return blocks


def table_rows(lines):
    """Table text → one entry per row: "cell | cell | cell". Rows are split at the larger vertical
    gaps (multi-line cells have small gaps inside a row); cells are columns of lines inside a row."""
    lines = [(t, R(r)) for t, r in lines if t.strip()]
    if not lines:
        return []
    lines.sort(key=lambda t: (t[1].y0 + t[1].y1) / 2)
    hmed = statistics.median([r.height for _, r in lines]) or 1
    bands = []  # [y0, y1, [(text, rect)], center]
    for t, r in lines:
        c = (r.y0 + r.y1) / 2
        if bands and abs(c - bands[-1][3]) < 0.45 * hmed:
            b = bands[-1]
            b[0], b[1] = min(b[0], r.y0), max(b[1], r.y1)
            b[2].append((t, r))
        else:
            bands.append([r.y0, r.y1, [(t, r)], c])
    # rows are anchored on the first column: a new row starts where its text starts after a gap
    # clearly larger than the leading inside a (multi-line) cell
    x_first = min(r.x0 for _, r in lines)
    first = sorted([r for _, r in lines if r.x0 < x_first + 1.5 * hmed], key=lambda r: r.y0)
    starts = [first[0].y0] if first else []
    if len(first) > 1:
        gaps = [max(0.0, b.y0 - a.y1) for a, b in zip(first, first[1:])]
        cut = None
        # the header rule makes the first gap large in every table: judge rows on the body only
        sg = sorted(gaps[1:] if len(gaps) > 2 else gaps)
        best = 1.0
        for a, b in zip(sg, sg[1:]):
            ratio = (b + 0.3) / (a + 0.3)
            if ratio > best and b > 0.25 * hmed:
                best, cut = ratio, (a + b) / 2
        if best < 1.6:
            cut = -1.0  # every first-column line is its own row
        starts += [b.y0 for k, (g, b) in enumerate(zip(gaps, first[1:])) if g > cut or (k == 0 and g > 0.6 * hmed)]
    rows = [[] for _ in starts] or [[]]
    for b in bands:
        k = 0
        for n, y in enumerate(starts):
            if b[3] >= y - 0.3 * hmed:
                k = n
        rows[k].append(b)
    rows = [r for r in rows if r]
    # a group heading ("Absorptive capability") sits alone on the row's first line: a row of its own
    split = []
    for row in rows:
        if len(row) > 1 and len(row[0][2]) == 1 and any(len(b[2]) > 1 for b in row[1:]) \
                and re.search(r"[A-Za-z]{3,}", row[0][2][0][0]) and row[0][2][0][1].x0 < x_first + 1.5 * hmed:
            split += [[row[0]], row[1:]]
        else:
            split.append(row)
    rows = split
    out = []
    for row in rows:
        items = [it for b in row for it in b[2]]
        cols = []  # group by left edge
        for t, r in sorted(items, key=lambda it: it[1].x0):
            host = next((c for c in cols if abs(c[0] - r.x0) < 2.5 * hmed or (r.x0 < c[1] and r.x1 > c[0] and abs(r.x0 - c[0]) < 6 * hmed)), None)
            if host:
                host[1] = max(host[1], r.x1)
                host[2].append((t, r))
            else:
                cols.append([r.x0, r.x1, [(t, r)]])
        cells, cell_boxes = [], []
        for c in sorted(cols, key=lambda c: c[0]):
            ordered = sorted(c[2], key=lambda it: (it[1].y0, it[1].x0))
            txt = ""
            for t, _ in ordered:
                txt = (txt[:-1] + t) if txt.endswith("-") else (txt + " " + t if txt else t)
            cells.append(txt.strip())
            cr = R(ordered[0][1])
            for _, r in ordered[1:]:
                cr |= r
            cell_boxes.append((txt.strip(), cr, [r for _, r in ordered]))
        rect = R(items[0][1])
        for _, r in items[1:]:
            rect |= r
        out.append([" | ".join(cells), rect, [r for _, r in items], cell_boxes])
    return out


def table_cells(lines):
    """Text cells of a table that need translating (numbers, single symbols stay as printed)."""
    cells = []
    for row in table_rows(lines):
        for text, rect, rects in row[3]:
            if re.search(r"[A-Za-z]{2,}", text):
                cells.append([text, rect, rects])
    return cells


def figure_copy_png(src, reg, items, dpi=230):
    """The figure as printed, with a small red number next to each label of the list below it."""
    tmp = pymupdf.open()
    tmp.insert_pdf(src, from_page=reg.pno, to_page=reg.pno)
    pg = tmp[0]
    if any(it["rects"] for it in items):
        ch = Chunks(7)
        marks = []
        for it in items:
            for r in it["rects"][:4]:
                st = ch.story("<p>%s</p>" % num_mark(it["k"]), "body{color:#c0392b;font-size:6.5pt;line-height:1}")
                idx, _, filled = ch.draw(st, 14, 9)
                marks.append((r, idx, filled.y1))
        cdoc = ch.close()
        for r, idx, fh in marks:
            x, y = max(reg.rect.x0, r.x0 - 7.5), r.y0 - 3.5
            pg.show_pdf_page(R(x, y, x + 14, y + fh), cdoc, idx, clip=R(0, 0, 14, fh))
    clip = R(reg.rect) + (-2, -2, 2, 2)
    return pg.get_pixmap(dpi=dpi, clip=clip, alpha=True).tobytes("png"), clip.width, clip.height


def render_table_copy(src, pno, reg_rect, cells, results, ocr, dpi=230):
    """The table redrawn with every text cell replaced, in place, by its translation (PNG bytes,
    width, height in pt). Vector tables: the English is removed from a page copy, so there are no
    white patches; scanned tables: the cell is covered with the paper colour first."""
    tmp = pymupdf.open()
    tmp.insert_pdf(src, from_page=pno, to_page=pno)
    pg = tmp[0]
    todo = [(t, r, rs) for t, r, rs in cells if results.get((t, "label"))]
    if not ocr:
        for _, _, rs in todo:
            for r in rs:
                # glyph boxes span the full font height and overlap the next line in tight tables:
                # only the middle band, or the line below loses its text ("ASC1" under a heading)
                pg.add_redact_annot(R(r.x0 - 0.2, r.y0 + 0.28 * r.height, r.x1 + 0.2, r.y1 - 0.28 * r.height))
        try:
            pg.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                                text=pymupdf.PDF_REDACT_TEXT_REMOVE)
        except Exception:  # noqa: BLE001
            pass
    ch = Chunks(7)
    placed = []
    # everything printed in the table (citations and numbers are not in `cells`) bounds the free space
    own = {(round(x.x0, 1), round(x.y0, 1)) for _, _, rs in cells for x in rs}
    boxes = [R(r) for _, r, _ in cells]
    boxes += [R(w[:4]) for w in src[pno].get_text("words", clip=reg_rect) if (round(w[0], 1), round(w[1], 1)) not in own]
    base = max(4.5, 0.82 * (statistics.median([x.height for _, _, rs in cells for x in rs]) or 7))
    for t, r, rs in todo:
        tr_ = results[(t, "label")]
        lh = statistics.median([x.height for x in rs]) or 7
        # room for the Chinese: up to the next cell on the right / below (not just the English box)
        right = min([o.x0 for o in boxes if o.x0 >= r.x1 - 0.5 and o.y0 < r.y1 and o.y1 > r.y0] + [reg_rect.x1])
        below = min([o.y0 for o in boxes if o.y0 >= r.y1 - 0.5 and o.x0 < r.x1 and o.x1 > r.x0] + [reg_rect.y1])
        box_w = max(r.width, 20, min(right - r.x0 - 3, r.width * 1.6))
        box_h = max(max(r.height, lh) * 1.12, below - r.y0 - 1.5)
        size = max(4.5, min(lh * 0.82, base * 1.15))
        floor = max(4.5, base * 0.72)
        while True:
            st = ch.story("<p>%s</p>" % html.escape(tr_), "body{color:%s;font-size:%.2fpt;line-height:1.18}" % (TR_COLOR, size))
            more, _ = st.place(R(0, 0, box_w, box_h))
            if not more or size <= floor:
                break
            size = max(floor, size * 0.92)
        st = ch.story("<p>%s</p>" % html.escape(tr_), "body{color:%s;font-size:%.2fpt;line-height:1.18}" % (TR_COLOR, size))
        idx, _, filled = ch.draw(st, box_w, box_h)
        placed.append((r, idx, box_w, filled.y1))
    cdoc = ch.close()
    for r, idx, bw, fh in placed:
        if ocr:
            pg.draw_rect(R(r) + (-1, -1, 1, 1), color=None, fill=(1, 1, 1), overlay=True)
        pg.show_pdf_page(R(r.x0, r.y0, r.x0 + bw, r.y0 + fh), cdoc, idx, clip=R(0, 0, bw, fh))
    clip = R(reg_rect) + (-2, -2, 2, 2)
    pix = pg.get_pixmap(dpi=dpi, clip=clip, alpha=True)
    return pix.tobytes("png"), clip.width, clip.height


GARBLED = re.compile(r"[\ufffd\ue000-\uf8ff]")
NUMTOK = r"[-+−]?\d+(?:[.,]\d+)*%?"


def clean_label(text):
    """Axis ticks glued to a title by the PDF ("0 0 Normalized retailer cash level 1.0"): drop them."""
    t = re.sub(r"\s+", " ", str(text)).strip()
    t = re.sub(r"^(?:%s\s+)+(?=[A-Za-z(])" % NUMTOK, "", t)
    t = re.sub(r"(?<=[A-Za-z)])(?:\s+%s)+$" % NUMTOK, "", t)
    return t


def label_key(text):
    return re.sub(r"[^a-z0-9]", "", str(text).lower())


def worth_translating(text):
    letters = re.findall(r"[A-Za-z]{2,}", text)
    return len(letters) >= 1 and sum(len(w) for w in letters) >= 3


META_START = re.compile(r"^(?:Received|Revised|Accepted|Published( Online)?|Copyright|©|History|Article history|"
                        r"https?://|doi:|DOI|ORCID|E-?mail|Contact|Electronic copy available)\b", re.I)
META_ANY = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+|https?://\S+|orcid\.org|doi\.org/\S+")


def is_metadata(text):
    """Dates, copyright, DOIs, e-mails, ORCID lists: nothing a reader needs translated."""
    t = re.sub(r"\{v\d+\}", "", text).strip()
    if META_START.match(t) and len(t) < 600:
        return True
    hits = META_ANY.findall(t)
    if hits:
        rest = META_ANY.sub("", t)
        words = re.findall(r"[A-Za-z]{3,}", rest)
        return len(words) < 12 + 2 * len(hits)
    return False


# ------------------------------------------------------------------------------- composing
class Chunks:
    """All Chinese text is drawn by one Story writer (one embedded font), stamped later."""

    def __init__(self, font_size):
        self.buf = io.BytesIO()
        self.writer = pymupdf.DocumentWriter(self.buf)
        self.n = 0
        self.fs = font_size
        self.arch = pymupdf.Archive(FONT_DIR)
        self.css = (
            "@font-face {font-family: cjk; src: url(%s);} "
            "body {font-family: cjk; color: %s; font-size: %.2fpt; line-height: 1.5; margin: 0;} "
            "@font-face {font-family: mathi; src: url(NotoSerif-Italic.ttf);} "
            "p {margin: 0;} img {vertical-align: middle;} i {font-family: mathi; font-style: italic;} "
            "sub, sup {font-size: 70%%;}" % (FONT_FILE, TR_COLOR, font_size)
        )
        self.img_names = {}
        self.slots = {}  # chunk index -> [(slot id, rect)]: space reserved for big images

    def add_image(self, key, png):
        name = self.img_names.get(key)
        if not name:
            name = "m%d.png" % len(self.img_names)
            self.arch.add(png, name)
            self.img_names[key] = name
        return name

    def story(self, body_html, css_extra=""):
        return pymupdf.Story(html=body_html, user_css=self.css + css_extra, archive=self.arch)

    def draw(self, story, w, h):
        dev = self.writer.begin_page(R(0, 0, w, h))
        more, filled = story.place(R(0, 0, w, h))
        found = []
        story.element_positions(lambda p_: found.append((p_.id, R(p_.rect))) if p_.id and p_.id.startswith("slot") else None)
        self.slots[self.n] = list({k: r for k, r in found}.items())
        story.draw(dev)
        self.writer.end_page()
        idx = self.n
        self.n += 1
        return idx, more, R(filled)

    def close(self):
        self.writer.close()
        doc = pymupdf.open("pdf", self.buf.getvalue())
        try:
            doc.subset_fonts()
        except Exception:  # noqa: BLE001
            pass
        return pymupdf.open("pdf", doc.tobytes(garbage=3, deflate=True))


class Flow:
    """Two-column (or single-column) flow on pages the size of the source pages."""

    def __init__(self, page_rect, cols, full):
        self.pw, self.ph = page_rect.width, page_rect.height
        self.top, self.bottom = 50, self.ph - 50
        self.cols, self.full = cols, full
        self.ops = []  # per page: list of ops
        self.new_page()

    def new_page(self):
        self.ops.append([])
        self.pi = len(self.ops) - 1
        self.ci = 0
        self.y = [self.top] * len(self.cols)

    def col(self):
        return self.cols[self.ci]

    def avail(self):
        return self.bottom - self.y[self.ci]

    def next_col(self):
        if self.ci + 1 < len(self.cols):
            self.ci += 1
        else:
            self.new_page()

    def start_wide(self):
        y = max(self.y)
        self.ci = 0
        self.y = [y] * len(self.cols)

    def end_wide(self, y):
        self.y = [y] * len(self.cols)
        self.ci = 0


def crop_png(doc, pno, rect, zoom=4.0, masks=()):
    """Crop a region of the original page. masks: ("x", rect) areas to blank, ("k", rect) areas whose
    original pixels are restored afterwards (the formula's own glyphs), so neighbours vanish cleanly."""
    clip = R(rect) + (-0.6, -0.6, 0.6, 0.6)
    # transparent background: on a tinted reader theme a formula must not sit in a white box
    pix = doc[pno].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip, alpha=True)
    if not masks:
        return tint(pix).tobytes("png")
    orig = pymupdf.Pixmap(pix)  # untouched copy (same alpha layout)

    def irect(r):
        r = R(r) & clip
        if r.is_empty:
            return None
        return pymupdf.IRect(int((r.x0 - clip.x0) * zoom), int((r.y0 - clip.y0) * zoom),
                             int((r.x1 - clip.x0) * zoom) + 1, int((r.y1 - clip.y0) * zoom) + 1) + (pix.x, pix.y, pix.x, pix.y)

    for kind, r in masks:
        if kind == "x" and irect(r):
            pix.set_rect(irect(r), (255, 255, 255, 0))
    for kind, r in masks:
        if kind == "k" and irect(r):
            pix.copy(orig, irect(r))
    return tint(pix).tobytes("png")


def tint(pix):
    """Recolour the (black) glyphs of a formula crop to the translation colour, keep transparency."""
    try:
        c = int(TR_COLOR.lstrip("#"), 16)
        pix.tint_with(c, 0xFFFFFF)
    except Exception:  # noqa: BLE001
        pass
    return pix


MARKS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"


def num_mark(k):
    return MARKS[k] if k < len(MARKS) else "(%d)" % (k + 1)


# ------------------------------------------------------------ LaTeX formulas (vision path)
_MT = {}


def mathtext_ok():
    if "ok" not in _MT:
        try:
            from matplotlib import mathtext, rcParams  # noqa: F401
            rcParams["mathtext.fontset"] = "stix"
            _MT["ok"] = True
        except Exception:  # noqa: BLE001
            _MT["ok"] = False
    return _MT["ok"]


TEX_ALIASES = {  # LaTeX that models write but matplotlib's mathtext does not know (Gemini: \ge, \le)
    "ge": "\\geq", "le": "\\leq", "gets": "\\leftarrow", "land": "\\wedge", "lor": "\\vee",
    "iff": "\\Leftrightarrow", "implies": "\\Rightarrow", "lvert": "|", "rvert": "|", "lVert": "\\Vert", "rVert": "\\Vert",
    "!": "", "tfrac": "\\frac", "dfrac": "\\frac", "displaystyle": "",
}


def tex_normalize(tex):
    tex = re.sub(r"\\tag\*?\{([^{}]*)\}", r"\\qquad (\1)", tex)
    tex = re.sub(r"\\(?:label|nonumber|notag)(?:\{[^{}]*\})?", "", tex)
    return re.sub(r"\\(!|[a-zA-Z]+)", lambda m: TEX_ALIASES.get(m.group(1), m.group(0)), tex)


def tex_variants(tex):
    yield tex_normalize(tex)
    tex = tex_normalize(tex)
    t = re.sub(r"\\[dt]frac", r"\\frac", tex)
    t = re.sub(r"\\(?:left|right|bigl|bigr|Bigl|Bigr|big|Big|biggl|biggr)\s*([.]?)", lambda m: "" if m.group(1) == "." else "", t)
    t = re.sub(r"\\(?:text|textrm|textit|operatorname)\s*\{([^{}]*)\}", r"\\mathrm{\1}", t)
    t = t.replace("\\geqslant", "\\geq").replace("\\leqslant", "\\leq").replace("\\displaystyle", "").replace("\\limits", "")
    t = t.replace("\\mid", "|").replace("\\coloneqq", ":=").replace("\\triangleq", "\\equiv").replace("\\eqqcolon", "=:")
    yield t
    yield re.sub(r"\\[a-zA-Z]+\s*", lambda m: m.group(0) if m.group(0).strip() in (
        "\\frac", "\\alpha", "\\beta", "\\gamma", "\\delta", "\\theta", "\\lambda", "\\mu", "\\pi", "\\sigma", "\\tau",
        "\\phi", "\\omega", "\\Pi", "\\Omega", "\\Delta", "\\in", "\\leq", "\\geq", "\\neq", "\\max", "\\min", "\\sum",
        "\\cdot", "\\times", "\\infty", "\\mathrm", "\\int") else "", t)


def mathtext_png(tex, size, color):
    """LaTeX → PNG (300 dpi). Returns (png bytes, height in pt) or (None, 0)."""
    if not mathtext_ok():
        return None, 0
    from matplotlib import mathtext
    from matplotlib.font_manager import FontProperties
    for cand in tex_variants(tex.strip()):
        try:
            b = io.BytesIO()
            # same as mathtext.math_to_image, but with a transparent background
            from matplotlib import figure
            parser = mathtext.MathTextParser("path")
            width, height, depth, _, _ = parser.parse("$" + cand + "$", dpi=72, prop=FontProperties(size=size))
            fig = figure.Figure(figsize=(width / 72.0, height / 72.0))
            fig.text(0, depth / height, "$" + cand + "$", fontproperties=FontProperties(size=size), color=color)
            fig.savefig(b, dpi=600, format="png", transparent=True)
            data = b.getvalue()
            return data, pymupdf.Pixmap(data).height / 600 * 72
        except Exception:  # noqa: BLE001
            continue
    return None, 0


def rich_inline(text, chunks, font_size, color):
    """Short text with $…$ math typeset inline (no paragraph wrapper)."""
    out, pos = [], 0
    text = str(text)
    for m in re.finditer(r"\$([^$]+?)\$", text):
        out.append(html.escape(text[pos:m.start()]))
        pos = m.end()
        png, h = mathtext_png(m.group(1), font_size, color)
        if png:
            out.append("<img src='%s' style='height:%.2fpt'/>" % (chunks.add_image(("tex", m.group(1), round(font_size, 1), color), png), h))
        else:
            out.append("<i>" + html.escape(m.group(1)) + "</i>")
    out.append(html.escape(text[pos:]))
    return "".join(out)


def figure_items(info, results):
    """Distinct labels of a figure: [{"k", "src", "tr", "rects"}]. Duplicates (an axis title under
    every panel) are listed once and marked everywhere they occur."""
    labels = info.get("labels", [])
    items = []
    fv = info.get("figkey")
    if fv and results.get((fv, "figvision")):
        try:
            from rapidfuzz import fuzz
        except Exception:  # noqa: BLE001
            fuzz = None
        for line in str(results[(fv, "figvision")]).splitlines():
            if "=>" not in line:
                continue
            a, b = line.split("=>", 1)
            a, b = a.strip(" -*•\t"), b.strip()
            if not a or not b or not re.search(r"[A-Za-z]{2,}", re.sub(r"\$[^$]*\$", "", a)):
                continue  # pure symbols/legend values ($\alpha_b = 0.25$) need no translation
            ka = label_key(re.sub(r"\$[^$]*\$", "", a))
            rects = []
            page, frect = info.get("page"), info.get("frect")
            if page is not None and frect is not None:
                # vector text: find exactly where this label is printed ("$w$" → "w")
                plain = re.sub(r"\$([^$]*)\$", lambda m: re.sub(r"\\[A-Za-z]+|[{}^_\\]", "", m.group(1)), a)
                plain = re.sub(r"\s+", " ", plain).strip()
                try:
                    hits = page.search_for(plain, clip=frect + (-2, -2, 2, 2)) if len(plain) >= 3 else []
                except Exception:  # noqa: BLE001
                    hits = []
                if hits:
                    rects = [R(hits[0])]
            if not rects and fuzz and ka:
                # single printed lines first: grouped labels merge neighbouring lines into one block
                scored = []
                for t, r in info.get("lines_raw", []):
                    kt = label_key(t)
                    if len(kt) >= 3 and min(len(ka), len(kt)) >= 0.3 * max(len(ka), len(kt)):
                        scored.append((max(fuzz.ratio(ka, kt), 0.95 * fuzz.partial_ratio(ka, kt)), r))
                best = max((sc for sc, _ in scored), default=0)
                if best >= 82:
                    rects = [r for sc, r in scored if sc >= best - 1][:4]
            if not rects and fuzz and ka:
                # the best-matching label only (and true repeats of it): "(1) Supplier: w" must not
                # also claim "(1) Supplier: product delivery"
                scored = []
                for t, r, _ in labels:
                    kt = label_key(t)
                    if kt and min(len(ka), len(kt)) >= 0.5 * max(len(ka), len(kt)):
                        scored.append((max(fuzz.ratio(ka, kt), 0.97 * fuzz.partial_ratio(ka, kt)), r))
                best = max((sc for sc, _ in scored), default=0)
                if best >= 80:
                    rects = [r for sc, r in scored if sc >= best - 2]
            items.append({"src": a, "tr": b, "rects": rects, "math": True})
    else:
        seen = {}
        for t, r, _ in labels:
            tr_ = results.get((t, "label"))
            if not tr_ or re.sub(r"\s+", "", tr_) == re.sub(r"\s+", "", t):
                continue
            k = label_key(t)
            if k in seen:
                seen[k]["rects"].append(r)
                continue
            seen[k] = {"src": clean_label(t), "tr": clean_label(tr_), "rects": [r], "math": False}
            items.append(seen[k])
    items.sort(key=lambda it: (round(it["rects"][0].y0 / 6), it["rects"][0].x0) if it["rects"] else (1e9, 0))
    for k, it in enumerate(items):
        it["k"] = k
    return items


def figure_list_html(items, chunks, size, base=0):
    rows = []
    for it in items:
        rows.append("<p style='margin:0 0 1.2pt 0'><span style='color:#c0392b'>%s</span> %s <span style='color:#888;font-size:85%%'>%s</span></p>" % (
            num_mark(base + it["k"]), rich_inline(it["tr"], chunks, size, TR_COLOR) if it["math"] else html.escape(it["tr"]),
            rich_inline(it["src"], chunks, size * 0.85, "#888888") if it["math"] else html.escape(it["src"])))
    return "".join(rows)


def with_line_height(markup, heights, font_size):
    """MuPDF does not grow a line for a tall inline image: give such paragraphs room explicitly."""
    big = max(heights) if heights else 0
    if big > 1.15 * font_size:
        return "<div style='line-height:%.1fpt'>%s</div>" % (big + 0.45 * font_size, markup)
    return markup


def strip_md(t):
    """Markdown emphasis some models add (Claude: *term*, **term**) — outside formulas only."""
    return re.sub(r"(?<![A-Za-z0-9*^_])\*{1,2}([^*\s$][^*\n$]{0,79}?)(?<!\s)\*{1,2}(?![A-Za-z0-9*])", r"\1", t)


def vision_html(tr, chunks, font_size):
    """Translation with $…$ / $$…$$ LaTeX: text escaped, every formula typeset as an image."""
    tr = str(tr).strip()
    out = []
    tall = []
    pos = 0
    for m in re.finditer(r"\$\$(.+?)\$\$|\\\[(.+?)\\\]|\$([^$]+?)\$|\\\((.+?)\\\)", tr, re.S):
        out.append(html.escape(strip_md(tr[pos:m.start()])).replace("\n", "<br/>"))
        pos = m.end()
        display = m.group(1) is not None or m.group(2) is not None
        tex = next(g for g in m.groups() if g is not None)
        png, h = mathtext_png(tex, font_size * (1.05 if display else 1.0), FORMULA_COLOR)
        if not png:
            out.append("<i>" + html.escape(tex) + "</i>")
            continue
        name = chunks.add_image(("tex", tex, round(font_size, 1)), png)
        img = "<img src='%s' style='height:%.2fpt'/>" % (name, h)
        if display:
            out.append("</p><p style='text-align:center;line-height:%.1fpt'>%s</p><p>" % (h + 3, img))
            rest = re.match(r"\s*[，,、；;。.]\s*", tr[pos:])
            if rest:  # "…为 $$…$$，其中…": the comma ends the equation line
                pos += rest.end()
        else:
            tall.append(h)
            out.append(img)
    out.append(html.escape(strip_md(tr[pos:])).replace("\n", "<br/>"))
    return with_line_height("<p>" + "".join(out) + "</p>", tall, font_size)


def translation_html(tr, ph_items, src, chunks, font_size, body_size):
    tr = strip_md(str(tr))
    known = {i: it for i, it in enumerate(ph_items, 1)}

    def glyph(pno, m, masks=()):
        x0, y0, x1, y1 = (float(v) for v in m.group(1).split(":"))
        rect = R(x0, y0, x1, y1)
        name = chunks.add_image((pno, round(x0, 1), round(y0, 1), "g"), crop_png(src, pno, rect, masks=masks))
        h = max(4.0, (rect.height + 0.6) * font_size / max(body_size, 1))
        return "<img src='%s' style='height:%.2fpt'/>" % (name, h)

    pieces = re.split(r"(\{\s*v\s*\d+\s*\})", tr)
    out = []
    tall = []
    after_display = False
    for piece in pieces:
        m = re.fullmatch(r"\{\s*v\s*(\d+)\s*\}", piece)
        if not m:
            if after_display:  # "满足 [equation] ，其中…": the comma belonged to the equation line
                piece = re.sub(r"^\s*[，,、；;。.]\s*", "", piece)
            after_display = False
            out.append(html.escape(piece).replace("\n", "<br/>"))
            continue
        it = known.get(int(m.group(1)))
        if not it:
            continue
        pno, rect, markup, masks = it
        if markup == DISPLAY:
            after_display = True
            png = crop_png(src, pno, rect, zoom=5)
            sc = font_size / max(body_size, 1)
            out.append("</p>%s<p>" % slot_html(png, rect.width * sc, rect.height * sc, 10000))
            continue
        if markup:
            out.append("<span class='m'>" + re.sub(r"\x00G:([^\x00]+)\x00", lambda g: glyph(pno, g, masks), markup) + "</span>")
        else:
            name = chunks.add_image((pno, round(rect.x0, 1), round(rect.y0, 1), round(rect.x1, 1), len(masks)),
                                    crop_png(src, pno, rect, masks=masks))
            h = max(4.0, (rect.height + 1.2) * font_size / max(body_size, 1))
            tall.append(h)
            out.append("<img src='%s' style='height:%.2fpt'/>" % (name, h))
    return with_line_height(re.sub(r"<p>\s*</p>", "", "<p>" + "".join(out) + "</p>"), tall, font_size)


def display_inline(u, results):
    """Did this unit's translation put its in-sentence equations back in place?"""
    disp = u.get("display") or []
    if not disp:
        return False
    if u.get("vision") and results.get((u["vision"], "vision")):
        t = results[(u["vision"], "vision")]
        return len(re.findall(r"\$\$|\\\[", t)) >= len(disp)  # $$…$$ counts twice, \[ once
    t = results.get((u["text"], "para")) or ""
    names = [i for i, it in enumerate(u["ph"].items, 1) if it[2] == DISPLAY]
    return all(re.search(r"\{\s*v\s*%d\s*\}" % i, t) for i in names)


SLOT_IMAGES = {}  # slot id -> (png bytes, width pt, height pt)


def slot_html(png, w, h, maxw):
    """Reserve room for a large image (Story mis-sizes big inline images); stamped afterwards."""
    sc = min(1.0, maxw / w)
    sid = "slot%d" % len(SLOT_IMAGES)
    SLOT_IMAGES[sid] = (png, w * sc, h * sc)
    return "<p id='%s' style='height:%.1fpt;margin:0'>&#160;</p>" % (sid, h * sc)


def stamp_chunk(page, cdoc, chunks, idx, tgt, clip):
    page.show_pdf_page(tgt, cdoc, idx, clip=clip)
    sc = tgt.width / clip.width if clip.width else 1.0  # < 1 when a panel was shrunk to fit its page
    for sid, r in chunks.slots.get(idx, []):
        if sid in SLOT_IMAGES and r.y0 >= clip.y0 - 1 and r.y0 < clip.y1:
            png, w, h = SLOT_IMAGES[sid]
            x = tgt.x0 + (r.x0 - clip.x0) * sc
            y = tgt.y0 + (r.y0 - clip.y0) * sc
            page.insert_image(R(x, y, x + w * sc, y + h * sc), stream=png)


def unit_html(u, results, src, chunks, body):
    """The translation of one text unit as HTML (formulas typeset), or None when nothing to show."""
    sizes = [s["size"] for p in u["parts"] for ln in p.lines for s in ln["spans"] if p.label in TEXT_LABELS]
    usz = round(min(max(statistics.median(sizes) * 0.97, body * 0.85), body * 1.6), 2) if sizes else body
    if u.get("vision") and results.get((u["vision"], "vision")):
        return vision_html(results[(u["vision"], "vision")], chunks, usz), usz
    t = results.get((u["text"], "para"))
    if t and re.sub(r"\s+", "", t) != re.sub(r"\s+", "", u["text"]):
        return translation_html(t, u["ph"].items, src, chunks, usz, body), usz
    return None, usz


def compose_pages(layout, src, pages, units, vinfo, results, body, out_path, tr):
    """Page-based bilingual layouts built from the same translations as 逐段对照:
    side      original page on the left, its translation on the right (continued on extra pages)
    alternate original page, then its translation page(s)
    mono      translation pages only
    The original is never re-typeset, so formulas stay intact; translated formulas are typeset."""
    emit({"p": 86, "stage": "Compose layout"})
    chunks = Chunks(round(body * 0.98, 2))
    by_page = {pno: [] for pno in pages}  # pno -> list of html pieces
    tags = {pno: [] for pno in pages}  # pno -> [(text, rect, k)] markers on the original page
    kept = translated = 0
    panel_w = lambda pno: src[pno].rect.width - 84

    def visual_piece(reg):
        """What the translation panel shows for a figure / table / displayed formula, so the reader
        never has to look back at the original."""
        info = vinfo.get(id(reg)) or {}
        if reg.label == "isolate_formula":
            png = crop_png(src, reg.pno, reg.rect, zoom=5)
            return "<div style='margin:2pt 0 4pt 0'>%s</div>" % slot_html(png, reg.rect.width, reg.rect.height, panel_w(reg.pno))
        labels = [b for b in info.get("labels", []) if results.get((b[0], "label"))
                  and re.sub(r"\s+", "", results[(b[0], "label")]) != re.sub(r"\s+", "", b[0])]
        if info.get("table") and labels:
            png, w_, h_ = render_table_copy(src, reg.pno, reg.rect, labels, results, bool(info.get("ocr")))
            return "<div style='margin:2pt 0 5pt 0'>%s</div>" % slot_html(png, w_, h_, panel_w(reg.pno))
        if reg.label in VISUAL_LABELS:
            items = figure_items(info, results) if (labels or info.get("figkey")) else []
            png, w_, h_ = figure_copy_png(src, reg, items)
            size = max(6.5, body * 0.82)
            lst = ""
            if items:
                lst = "<div style='font-size:%.2fpt'><p style='color:#888;font-size:6.5pt;margin:0'>图中文字%s</p>%s</div>" % (
                    size, "（%s 看图）" % VISION_NAME.get(os.environ.get("CLITRANS_ENGINE", ""), "模型") if info.get("figkey") else "（文字识别）" if info.get("ocr") else "",
                    figure_list_html(items, chunks, size))
            return "<div style='margin:2pt 0 5pt 0'>%s%s</div>" % (slot_html(png, w_, h_, panel_w(reg.pno)), lst)
        return ""

    for u in units:
        pno = u["parts"][0].pno
        if u["kind"] == "text":
            h, z = unit_html(u, results, src, chunks, body)
            if h:
                by_page[pno].append("<div style='font-size:%.2fpt;margin:0 0 5pt 0'>%s</div>" % (z, h))
                translated += 1
            else:
                kept += 1
            # equations / figures that sit inside this paragraph follow its translation
            # (an equation already put back inside the translated sentence is not repeated)
            inline = display_inline(u, results) if h else False
            for reg in u["parts"]:
                if reg.label not in TEXT_LABELS and not (inline and reg in u.get("display", [])):
                    by_page[pno].append(visual_piece(reg))
            continue
        for reg in u["parts"]:
            by_page[reg.pno].append(visual_piece(reg))

    # translation panels: one story per source page, continued on extra pages when it overflows
    panels = {}  # pno -> [(chunk index, height)]
    for pno in pages:
        w, h = src[pno].rect.width, src[pno].rect.height
        head = "<p style='color:#999;font-size:6.5pt;text-align:right;margin:0 0 4pt 0'>— 原文第 %d 页 · 译文 —</p>" % (pno + 1)
        body_html = head + ("".join(by_page[pno]) or "<p style='color:#999'>（本页无需翻译的正文）</p>")
        W, H = w - 2 * 42, h - 2 * 40

        def lay(scale):
            # draw on a page 1/scale times larger, stamped back at `scale`: everything shrinks evenly
            st = chunks.story(body_html)
            res_ = []
            while True:
                idx, more, filled = chunks.draw(st, W / scale, H / scale)
                res_.append((idx, filled.y1, scale))
                if not more or len(res_) > 30:
                    return res_

        out = lay(1.0)
        # a few lines over the page: shrink slightly (down to 78 %) rather than add a nearly empty page
        if len(out) > 1 and out[-1][1] <= 0.45 * H:
            target = len(out) - 1
            need = (target * H) / (target * H + out[-1][1])
            for scale in sorted({round(min(0.97, need * 0.99), 3), 0.93, 0.88, 0.83, 0.78}, reverse=True):
                if scale > 0.97 or scale < 0.78:
                    continue
                trial = lay(scale)
                if len(trial) <= target:
                    out = trial
                    break
        panels[pno] = out
    cdoc = chunks.close()

    emit({"p": 95, "stage": "Compose layout"})
    res = pymupdf.open()
    for pno in pages:
        sp = src[pno]
        w, h = sp.rect.width, sp.rect.height
        for n, (idx, hh, sc) in enumerate(panels[pno]):
            def stamp(page, x):
                stamp_chunk(page, cdoc, chunks, idx, R(x + 42, 40, x + w - 42, 40 + hh * sc), R(0, 0, (w - 84) / sc, hh))

            def original(page, x):
                page.show_pdf_page(R(x, 0, x + w, h), src, pno)
                pass

            if layout == "side":
                page = res.new_page(width=2 * w, height=h)
                original(page, 0)  # continued translation: the same original stays beside it
                if n > 0:
                    page.insert_text((w - 150, 14), "（原文第 %d 页 · 译文续）" % (pno + 1), fontsize=7, color=(0.6, 0.6, 0.6), fontname="china-s")
                page.draw_line((w, 0), (w, h), color=(0.75, 0.75, 0.75), width=0.5)
                stamp(page, w)
            elif layout == "alternate":
                if n == 0:
                    page = res.new_page(width=w, height=h)
                    original(page, 0)
                page = res.new_page(width=w, height=h)
                stamp(page, 0)
            else:
                page = res.new_page(width=w, height=h)
                stamp(page, 0)
    # the small ① markers on the originals
    if mark_ops:
        mdoc_chunks = chunks_marks
        placed = []
        for pg_no, x, y, st in mark_ops:
            idx, _, filled = mdoc_chunks.draw(st, 14, 9)
            placed.append((pg_no, x, y, idx, filled.y1))
        mdoc = mdoc_chunks.close()
        for pg_no, x, y, idx, fh in placed:
            res[pg_no].show_pdf_page(R(x, y, x + 14, y + fh), mdoc, idx, clip=R(0, 0, 14, fh))
    res.save(out_path, garbage=4, deflate=True)
    emit({"done": True, "dual": out_path, "translated": translated, "kept": kept,
          "errors": len(tr.errors), "error_sample": (tr.errors[-1][:200] if tr.errors else "")})
    return 0


chunks_marks = None
mark_ops = []


def main(argv):
    if len(argv) < 2:
        emit({"error": "usage: interleave.py <input.pdf> <output.pdf> [--pages SPEC]"})
        return 2
    src_path, out_path = argv[0], argv[1]
    pages_spec = argv[argv.index("--pages") + 1] if "--pages" in argv else ""
    layout = argv[argv.index("--layout") + 1] if "--layout" in argv else "interleave"
    here = os.path.dirname(os.path.abspath(__file__))
    src = pymupdf.open(src_path)
    pages = parse_pages(pages_spec, len(src))
    if not pages:
        emit({"error": "没有可翻译的页面"})
        return 2

    # 1. layout -------------------------------------------------------------------------------
    ensure_font()
    emit({"p": 1, "stage": "Analyze layout"})
    model = LayoutModel()
    per_page = []
    all_sizes = []
    for k, pno in enumerate(pages):
        page = src[pno]
        regs = dedup_regions(model.detect(page))
        lines = page_lines(page)
        regs = assign_lines(regs, lines, page)
        regs = [r for r in regs if r.label != "abandon"]  # headers, footers, page numbers
        for r in regs:
            if r.label in TEXT_LABELS:
                for ln in r.lines:
                    for s in ln["spans"]:
                        all_sizes += [round(s["size"], 1)] * len(s["chars"])
        per_page.append(order_regions(regs, page))
        emit({"p": 1 + 9 * (k + 1) / len(pages), "stage": "Analyze layout", "cur": k + 1, "tot": len(pages)})
    # a font carrying a large share of the prose is a text font even if its name looks like a math
    # family (Wiley/Advent "AdvPSPAL-R" is Palatino, not math): otherwise whole paragraphs become formulas
    font_chars, font_words = collections.Counter(), collections.Counter()
    for regs in per_page:
        for r in regs:
            for ln in r.lines:
                for s in ln["spans"]:
                    t = "".join(c["c"] for c in s["chars"])
                    if r.label in TEXT_LABELS and sum(1 for c in t if c.isalpha()) >= 4:
                        font_chars[font_family(s["font"])] += len(t)
                    font_words[font_family(s["font"])] += len(real_words(t))
    total_chars = sum(font_chars.values()) or 1
    TEXT_FONTS.clear()
    TEXT_FONTS.update(f for f, n in font_chars.items() if n >= 0.05 * total_chars)
    TEXT_FONTS.update(f for f, n in font_words.items() if n >= 3)  # spells real words: a text font
    font_marks = collections.Counter()
    for regs in per_page:
        for r in regs:
            if r.label in TEXT_LABELS:
                for ln in r.lines:
                    for s in ln["spans"]:
                        fam = font_family(s["font"])
                        if fam not in TEXT_FONTS:
                            font_marks[fam] += len(BROKEN_MARK.findall("".join(c["c"] for c in s["chars"])))
    BROKEN_FONTS.clear()
    BROKEN_FONTS.update(f for f, n in font_marks.items() if n >= 3)
    BAD_TOKS.clear()
    if not all_sizes:
        emit({"error": "这个 PDF 没有可提取的文字（可能是扫描件），暂不支持逐段对照"})
        return 1
    body = statistics.mode(all_sizes)

    # 2. units: paragraphs (merged across columns/pages when a sentence continues) and visuals ---
    ph_all = []
    units = []  # dict(kind, parts=[Region], text, ph)
    pending = None

    def ends_open(t, ph=None):
        # a footnote mark after the full stop ("… in Proposition 1.⁶") does not reopen the sentence
        while ph is not None:
            m = re.search(r"\{v(\d+)\}\s*$", t)
            k = int(m.group(1)) - 1 if m else -1
            mk = ph.items[k][2] if 0 <= k < len(ph.items) else None
            if not (mk and re.fullmatch(r"(?:<sup>)?\s*\d{1,2}\s*(?:</sup>)?|[*†‡§¶]", mk.strip())):
                break
            t = t[:m.start()].rstrip()
        t = re.sub(r"\{v\d+\}\s*$", "x", t).rstrip()
        return bool(t) and t[-1] not in ".!?:;)\"”’]" and not re.search(r"\b(?:et al|i\.e|e\.g)\.$", t)

    between = []  # visuals met while a sentence is still open

    def flush_between():
        for v in between:
            units.append({"kind": "visual", "parts": [v]})
        between.clear()

    in_refs = False
    REFS_HEAD = re.compile(r"^\s*(?:[\dIVX]+\.?\s*)?(?:References|Bibliography|Literature Cited|Works Cited|参考文献)\s*$", re.I)
    AFTER_REFS = re.compile(r"^\s*(?:[A-Z\d]+\.?\s*)?(?:Appendix|Appendices|Online (?:Appendix|Supplement)|Supplementary|附录)", re.I)
    for regs in per_page:
        for reg in regs:
            if reg.label in TEXT_LABELS:
                ph = Placeholders()
                text = region_text(reg, body, ph)
                if not text:
                    continue
                if REFS_HEAD.match(text):
                    in_refs = True
                elif in_refs and len(text) < 120 and AFTER_REFS.match(text):
                    in_refs = False
                elif in_refs:
                    flush_between()
                    units.append({"kind": "text", "parts": [reg], "text": text, "ph": ph, "skip": True})
                    pending = None
                    continue
                last = None if pending is None else [p_ for p_ in pending["parts"] if p_.label in TEXT_LABELS][-1]
                # a column or page break in mid-sentence: the next part may start with a capital ("New Hope | Group")
                jumped = last is not None and (
                    reg.pno != last.pno or abs((reg.rect.x0 + reg.rect.x1) - (last.rect.x0 + last.rect.x1)) / 2 > 0.25 * src[reg.pno].rect.width)
                cont = (
                    pending is not None and reg.label == "plain text" and last.label == "plain text"
                    and ends_open(pending["text"], pending["ph"]) and (text[:1].islower() or text.startswith("{v") or jumped)
                    and len(pending["text"]) < 6000
                )
                if cont:
                    # "… the threshold θt satisfies [equation] where …": the equation keeps its place
                    # inside the sentence, so the translation can put it back at the same spot
                    for v in between:
                        if v.label == "isolate_formula":
                            pending["text"] += " " + pending["ph"].add(v.pno, v.rect, DISPLAY)
                            pending.setdefault("display", []).append(v)
                    off = len(pending["ph"].items)
                    text = re.sub(r"\{v(\d+)\}", lambda m: "{v%d}" % (int(m.group(1)) + off), text)
                    pending["ph"].items += ph.items
                    if pending["text"].endswith("-") and text[:1].islower():
                        pending["text"] = pending["text"][:-1] + text
                    else:
                        pending["text"] += " " + text
                    pending["parts"] += between + [reg]
                    between.clear()
                    continue
                flush_between()
                pending = {"kind": "text", "parts": [reg], "text": text, "ph": ph}
                units.append(pending)
            else:
                # a figure or equation between two halves of a sentence must not break the sentence
                if pending is not None and pending["parts"][-1].label == "plain text" and ends_open(pending["text"], pending["ph"]) and len(between) < 3:
                    between.append(reg)
                else:
                    flush_between()
                    units.append({"kind": "visual", "parts": [reg]})
    flush_between()
    # 3. figure / table text: vector text, else OCR on raster -----------------------------------
    ocr_jobs, tmpdir = [], os.path.join(os.path.dirname(os.path.abspath(out_path)), "ocr-img")
    vinfo = {}  # id(region) -> {"labels": [...], "ocr": bool}
    visual_regs = [p for u in units for p in u["parts"] if p.label not in TEXT_LABELS]
    # CLITRANS_FIGURES=0 (setting 「翻译图片中的文字」 off): figures stay exactly as printed — no text
    # extraction, no OCR, no model reading the picture. Tables and captions are still translated.
    skip_figures = os.environ.get("CLITRANS_FIGURES") == "0"
    for reg in visual_regs:
        u = vinfo.setdefault(id(reg), {"labels": [], "ocr": False})
        u["page"], u["frect"] = src[reg.pno], R(reg.rect)  # where the figure's own text can be searched
        if reg.label == "isolate_formula" or (skip_figures and reg.label == "figure"):
            continue
        vec = [("".join(c["c"] for s in ln["spans"] for c in s["chars"]).strip(), ln["bbox"]) for ln in reg.lines]
        vec = [(t, r) for t, r in vec if t]
        u["lines_raw"] = [(t, R(r)) for t, r in vec]
        garbled = any(GARBLED.search(t) for t, _ in vec)
        if reg.label == "figure" and sum(len(t) for t, _ in vec) >= 6 and garbled:
            # glyphs without Unicode (Greek letters in plot labels): read the picture instead
            u["labels"] = group_label_lines([(GARBLED.sub("", t), r) for t, r in vec])
            u["needs_vision"] = True
        elif sum(len(t) for t, _ in vec) >= 6:
            u["labels"] = table_cells(vec) if reg.label == "table" else group_label_lines(vec)
            u["table"] = reg.label == "table"
        if reg.label in ("figure", "table") and (not u["labels"] or u.get("needs_vision")):
            os.makedirs(tmpdir, exist_ok=True)
            f = os.path.join(tmpdir, "fig-%d-%d.png" % (reg.pno, len(ocr_jobs)))
            src[reg.pno].get_pixmap(dpi=220, clip=reg.rect, alpha=False).save(f)
            ocr_jobs.append((u, f))
            u["rect"] = reg.rect
            u["is_table"] = reg.label == "table"
    if ocr_jobs:
        emit({"p": 12, "stage": "OCR figures"})
        res = run_ocr(ocr_binary(here), [f for _, f in ocr_jobs])
        for u, f in ocr_jobs:
            rr = u["rect"]
            lines = []
            for ln in res.get(f, []):
                if ln.get("conf", 1) < 0.3 or not ln.get("text", "").strip():
                    continue
                x0, y0, x1, y1 = ln["box"]
                lines.append((ln["text"].strip(), R(rr.x0 + x0 * rr.width, rr.y0 + y0 * rr.height, rr.x0 + x1 * rr.width, rr.y0 + y1 * rr.height)))
            ocr_labels = table_cells(lines) if u.get("is_table") else group_label_lines(lines)
            if u.get("needs_vision") or not u.get("lines_raw"):
                u["lines_raw"] = lines
            if not u.get("labels") or u.get("needs_vision"):
                u["labels"] = ocr_labels
            u["table"] = bool(u.get("is_table"))
            u["ocr"] = True

    for info in vinfo.values():
        if not info.get("table"):
            info["labels"] = [[clean_label(t), r, rs] for t, r, rs in info.get("labels", [])
                              if re.search(r"[A-Za-z]{2,}", clean_label(t))]

    # 4. translate ----------------------------------------------------------------------------
    jobs = []
    tr = Translator()
    vision = bool(os.environ.get("CLITRANS_VISION")) and tr.engine in VISION_ENGINES and mathtext_ok()
    if os.environ.get("CLITRANS_VISION") and tr.engine in VISION_ENGINES and not mathtext_ok():
        emit({"warn": "matplotlib 未安装，复杂公式改用截图方式"})
    vdir = os.path.join(os.path.dirname(os.path.abspath(out_path)), "vision")
    vision_jobs = []
    for u in units:
        if u["kind"] != "text" or u.get("skip") or is_metadata(u["text"]) or not worth_translating(re.sub(r"\{v\d+\}", "", u["text"])):
            continue
        # paragraphs with stacked formulas (fractions, multi-line) are read from their picture by the model (GPT / Claude / Gemini)
        if vision and any(it[2] is None for it in u["ph"].items):
            os.makedirs(vdir, exist_ok=True)
            tparts = [p_ for p_ in u["parts"] if p_.label in TEXT_LABELS or p_ in u.get("display", [])]
            w = max(p_.rect.width for p_ in tparts)
            hsum = sum(p_.rect.height for p_ in tparts) + 4 * (len(tparts) - 1)
            tmp = pymupdf.open()
            pg = tmp.new_page(width=w + 8, height=hsum + 8)
            y = 4
            for p_ in tparts:
                pg.show_pdf_page(R(4, y, 4 + p_.rect.width, y + p_.rect.height), src, p_.pno, clip=p_.rect)
                y += p_.rect.height + 4
            path = os.path.join(vdir, "para-%d.png" % len(vision_jobs))
            pg.get_pixmap(dpi=220, alpha=False).save(path)
            ctx = re.sub(r"\s*\{v\d+\}\s*", " [formula] ", u["text"])
            u["vision"] = ctx
            tr.images[(ctx, "vision")] = path
            vision_jobs.append((ctx, "vision"))
            continue
        jobs.append((u["text"], "para"))
    fig_jobs = []
    for rid, info in vinfo.items():
        reg = next((r for r in visual_regs if id(r) == rid), None)
        if vision and reg is not None and reg.label == "figure" and info.get("labels"):
            # the model reads the figure itself: correct symbols (α, Γ*), titles, legends; ticks skipped
            os.makedirs(vdir, exist_ok=True)
            path = os.path.join(vdir, "fig-%d.png" % len(fig_jobs))
            src[reg.pno].get_pixmap(dpi=220, clip=reg.rect, alpha=False).save(path)
            key = "FIGURE " + " / ".join(clean_label(t) for t, _, _ in info["labels"])[:1500]
            info["figkey"] = key
            tr.images[(key, "figvision")] = path
            fig_jobs.append((key, "figvision"))
            continue
        for b in info["labels"]:
            if worth_translating(clean_label(b[0])):
                jobs.append((b[0], "label"))
    emit({"p": 15, "stage": "Translate Paragraphs", "cur": 0, "tot": len(jobs) + len(vision_jobs)})
    try:
        vres = {}
        if vision_jobs or fig_jobs:
            vision_jobs = vision_jobs + fig_jobs
            vres = tr.translate_all(vision_jobs, lambda d, t: emit({"p": 15 + 35 * d / max(t, 1), "stage": "Read formulas", "cur": d, "tot": t}))
        failed = [u for u in units if u.get("vision") and not vres.get((u["vision"], "vision"))]
        for u in failed:  # vision failed: fall back to the glyph-based text path
            u.pop("vision")
            jobs.append((u["text"], "para"))
        for info in vinfo.values():
            if info.get("figkey") and not vres.get((info["figkey"], "figvision")):
                info.pop("figkey")
                for b in info["labels"]:
                    if worth_translating(clean_label(b[0])):
                        jobs.append((b[0], "label"))
        base = 50 if vision_jobs else 15
        results = tr.translate_all(jobs, lambda d, t: emit({"p": base + (85 - base) * d / max(t, 1), "stage": "Translate Paragraphs", "cur": d, "tot": t}))
        results.update(vres)
    except RuntimeError as e:
        emit({"error": str(e)})
        return 1

    if layout in ("side", "alternate", "mono"):
        global chunks_marks
        chunks_marks = Chunks(7)
        return compose_pages(layout, src, pages, units, vinfo, results, body, out_path, tr)

    # 5. compose ------------------------------------------------------------------------------
    emit({"p": 86, "stage": "Compose layout"})
    first = src[pages[0]].rect
    text_regs = [r for regs in per_page for r in regs if r.label == "plain text" and r.rect.width > 60]
    narrow = [r for r in text_regs if r.rect.width < 0.55 * first.width]
    if len(narrow) >= max(3, 0.5 * len(text_regs)):
        mid = first.width / 2
        left = [r for r in narrow if r.rect.x0 + r.rect.width / 2 < mid] or narrow
        right = [r for r in narrow if r.rect.x0 + r.rect.width / 2 >= mid] or narrow
        lx0 = statistics.median(r.rect.x0 for r in left)
        lx1 = statistics.median(r.rect.x1 for r in left)
        rx0 = statistics.median(r.rect.x0 for r in right)
        rx1 = statistics.median(r.rect.x1 for r in right)
        cols = [(lx0, lx1), (rx0, rx1)]
        full = (lx0, rx1)
    else:
        xs0 = [r.rect.x0 for r in text_regs] or [50]
        xs1 = [r.rect.x1 for r in text_regs] or [first.width - 50]
        full = (statistics.median(xs0), statistics.median(xs1))
        cols = [full]
    fs = round(body * 0.98, 2)
    chunks = Chunks(fs)
    flow = Flow(first, cols, full)
    GAP_TR, GAP_UNIT = 2.5, 7.0

    def is_wide(reg):
        return len(cols) == 1 or reg.rect.width > (cols[0][1] - cols[0][0]) * 1.25

    def place_crop(reg, rect, wide):
        """Place (part of) an original region; splits text regions at line boundaries."""
        clip = R(rect)
        while True:
            x0, x1 = flow.full if wide else flow.col()
            w = x1 - x0
            s = min(1.0, w / max(clip.width, 1))
            need = clip.height * s
            av = flow.avail()
            if need <= av:
                y = flow.y[flow.ci]
                tgt = R(x0, y, x0 + clip.width * s, y + need)
                flow.ops[flow.pi].append(("crop", reg.pno, tgt, R(clip)))
                if wide:
                    flow.end_wide(y + need)
                else:
                    flow.y[flow.ci] = y + need
                return
            cut = None
            if reg.label in TEXT_LABELS and reg.lines and av > 40:
                limit = clip.y0 + av / s
                bands = []
                for b0, b1 in sorted((ln["bbox"].y0 + 0.5, ln["bbox"].y1 - 0.5) for ln in reg.lines if ln["bbox"].y1 > clip.y0 + 1):
                    if bands and b0 < bands[-1][1]:
                        bands[-1][1] = max(bands[-1][1], b1)
                    else:
                        bands.append([b0, b1])
                gaps = [(a[1] + b[0]) / 2 for a, b in zip(bands, bands[1:]) if (a[1] + b[0]) / 2 <= limit]
                if gaps:
                    cut = max(gaps)
            if cut is not None and cut - clip.y0 > 8:
                part = R(clip.x0, clip.y0, clip.x1, cut)
                y = flow.y[flow.ci]
                flow.ops[flow.pi].append(("crop", reg.pno, R(x0, y, x0 + part.width * s, y + part.height * s), part))
                flow.y[flow.ci] = y + part.height * s
                clip = R(clip.x0, cut, clip.x1, clip.y1)
            elif flow.y[flow.ci] <= flow.top + 1:
                # does not fit even an empty column: shrink to fit
                s2 = min(s, av / max(clip.height, 1))
                y = flow.y[flow.ci]
                flow.ops[flow.pi].append(("crop", reg.pno, R(x0, y, x0 + clip.width * s2, y + clip.height * s2), R(clip)))
                if wide:
                    flow.end_wide(y + clip.height * s2)
                else:
                    flow.y[flow.ci] = y + clip.height * s2
                return
            if wide:
                flow.new_page()
            else:
                flow.next_col()

    def place_story(make_story, wide):
        story = make_story()
        while True:
            x0, x1 = flow.full if wide else flow.col()
            w = x1 - x0
            av = flow.avail()
            if av < 2 * fs * 1.5:
                flow.new_page() if wide else flow.next_col()
                continue
            idx, more, filled = chunks.draw(story, w, av)
            y = flow.y[flow.ci]
            # MuPDF's filled box ends at the last baseline box; tall inline formulas hang below it
            h = min(av, filled.y1 + (0.9 * fs if not more else 0))
            flow.ops[flow.pi].append(("chunk", idx, R(x0, y, x1, y + h), R(0, 0, w, h)))
            if wide:
                flow.end_wide(y + h)
            else:
                flow.y[flow.ci] = y + h
            if not more:
                return
            flow.new_page() if wide else flow.next_col()

    def add_gap(g, wide):
        if wide:
            flow.end_wide(max(flow.y) + g)
        else:
            flow.y[flow.ci] += g

    def place_table(reg, wide, info, labels):
        png, w_, h_ = render_table_copy(src, reg.pno, reg.rect, labels, results, bool(info.get("ocr")))
        x0, x1 = flow.full if wide else flow.col()
        add_gap(GAP_TR, wide)
        note = "<p style='color:#888;font-size:6.5pt;margin:0 0 2pt 0'>▼ 表格译文%s</p>%s" % (
            "（文字识别）" if info.get("ocr") else "", slot_html(png, w_, h_, x1 - x0))
        place_story(lambda n=note: chunks.story(n), wide)

    def place_visual(reg, wide):
        """Original figure/table untouched, then a numbered list: ① source → translation.
        Small numbered tags are drawn next to each label in the figure so the list is easy to follow."""
        start = (flow.pi, len(flow.ops[flow.pi]))
        place_crop(reg, reg.rect, wide)
        info = vinfo.get(id(reg)) or {}
        labels = [b for b in info.get("labels", []) if results.get((b[0], "label"))
                  and re.sub(r"\s+", "", results[(b[0], "label")]) != re.sub(r"\s+", "", b[0])]
        if not labels and not info.get("figkey"):
            return
        if info.get("table"):
            place_table(reg, wide, info, labels)
            return
        items = figure_items(info, results)
        if not items:
            return
        pi, oi = start
        if not (pi < len(flow.ops) and oi < len(flow.ops[pi]) and flow.ops[pi][oi][0] == "crop"):
            pi, oi = flow.pi, len(flow.ops[flow.pi]) - 1
        _, pno, tgt, clip = flow.ops[pi][oi]
        sx = tgt.width / clip.width
        sy = tgt.height / clip.height
        for it in items:
            for brect in it["rects"][:4]:
                x = tgt.x0 + (brect.x0 - clip.x0) * sx
                y = tgt.y0 + (brect.y0 - clip.y0) * sy
                st = chunks.story("<p>%s</p>" % num_mark(it["k"]), "body{color:#c0392b;font-size:6.5pt;line-height:1}")
                idx, _, filled = chunks.draw(st, 14, 9)
                flow.ops[pi].append(("chunk", idx, R(x - 7.5, y - 3.5, x - 7.5 + 14, y - 3.5 + filled.y1), R(0, 0, 14, filled.y1)))
        size = max(6.5, fs * 0.82)
        note = "<p style='color:#888;font-size:6.5pt;margin:0 0 1.5pt 0'>图中文字%s</p>%s" % (
            "（%s 看图）" % VISION_NAME.get(os.environ.get("CLITRANS_ENGINE", ""), "模型") if info.get("figkey") else "（文字识别）" if info.get("ocr") else "", figure_list_html(items, chunks, size))
        css = "body{font-size:%.2fpt;line-height:1.35}" % size
        add_gap(GAP_TR, wide)
        place_story(lambda n=note, c=css: chunks.story(n, c), wide)

    last_pno = None
    kept = translated = 0
    for u in units:
        reg0 = u["parts"][0]
        if reg0.pno != last_pno:
            last_pno = reg0.pno
            w0 = is_wide(reg0)
            if w0:
                flow.start_wide()
            mark = "<p style='color:#999;font-size:6.5pt;text-align:right'>— 原文第 %d 页 —</p>" % (reg0.pno + 1)
            place_story(lambda m=mark: chunks.story(m), w0)
        for p in u["parts"]:
            pw_ = is_wide(p)
            if pw_:
                flow.start_wide()
            if p.label in TEXT_LABELS:
                place_crop(p, p.rect, pw_)
            else:
                place_visual(p, pw_)
                add_gap(GAP_TR, pw_)
        wide = is_wide([p for p in u["parts"] if p.label in TEXT_LABELS or u["kind"] == "visual"][-1])
        if u["kind"] == "text" and u.get("vision") and results.get((u["vision"], "vision")):
            if wide:
                flow.start_wide()
            add_gap(GAP_TR, wide)
            sizes = [s["size"] for p in u["parts"] for ln in p.lines for s in ln["spans"] if p.label in TEXT_LABELS]
            usz = round(min(max(statistics.median(sizes) * 0.97, body * 0.85), body * 1.6), 2) if sizes else fs
            body_html = vision_html(results[(u["vision"], "vision")], chunks, usz)
            place_story(lambda b=body_html, z=usz: chunks.story(b, "body{font-size:%.2fpt}" % z), wide)
            translated += 1
        elif u["kind"] == "text":
            t = results.get((u["text"], "para"))
            if t and re.sub(r"\s+", "", t) != re.sub(r"\s+", "", u["text"]):
                if wide:
                    flow.start_wide()
                add_gap(GAP_TR, wide)
                sizes = [s["size"] for p in u["parts"] for ln in p.lines for s in ln["spans"] if p.label in TEXT_LABELS]
                usz = round(min(max(statistics.median(sizes) * 0.97, body * 0.85), body * 1.6), 2) if sizes else fs
                body_html = translation_html(t, u["ph"].items, src, chunks, usz, body)
                place_story(lambda b=body_html, z=usz: chunks.story(b, "body{font-size:%.2fpt}" % z), wide)
                translated += 1
            else:
                kept += 1
        add_gap(GAP_UNIT, wide)

    # 6. render -------------------------------------------------------------------------------
    emit({"p": 95, "stage": "Compose layout"})
    cdoc = chunks.close()
    if os.environ.get("CLITRANS_DEBUG"):
        with open(out_path + ".ops.json", "w") as f:
            json.dump([[[o[0]] + [list(x) if isinstance(x, pymupdf.Rect) else x for x in o[1:]] for o in ops] for ops in flow.ops], f)
    # A clipped show_pdf_page still embeds the whole source page: the text outside the clip is
    # invisible but extractable, and Zotero's reader turns it into phantom citation/link overlays.
    # So every crop comes from a copy of its page with all text outside the clip removed.
    clean = pymupdf.open()
    _gb = {}

    def glyph_boxes(pno):
        if pno not in _gb:
            # (box, is_delimiter): math-extension brackets (CMEX, Advent "…mex") report a box shifted
            # away from where they are drawn, so they are kept whenever they touch the clip at all
            _gb[pno] = [(R(c["bbox"]), c["c"] in "()[]{}|‖⟨⟩⌈⌉⌊⌋√∑∏∫" or bool(re.search(r"cmex|mex\b|mex\d|extension", s_["font"] or "", re.I)))
                        for b in src[pno].get_text("rawdict")["blocks"] for l in b.get("lines", [])
                        for s_ in l["spans"] for c in s_["chars"] if c["c"].strip()]
        return _gb[pno]

    def clean_crop(pno, clip):
        clean.insert_pdf(src, from_page=pno, to_page=pno)
        pg = clean[-1]
        r = pg.rect
        # keep every glyph that reaches into the clip whole (tall brackets, roots): only text that lies
        # entirely outside the protected box is removed
        c = R(clip) + (-0.3, -0.3, 0.3, 0.3)
        for ch, delim in glyph_boxes(pno):
            cy = (ch.y0 + ch.y1) / 2
            cx_in = clip.x0 <= (ch.x0 + ch.x1) / 2 <= clip.x1
            inside = clip.y0 <= cy <= clip.y1 and cx_in
            tall = ch.height > 1.6 * body and (ch & clip).get_area() > 0.3 * ch.get_area()
            bracket = delim and cx_in and (ch & clip).get_area() > 0.15 * ch.get_area()
            if inside or tall or bracket:
                c |= ch
        for band in (R(r.x0, r.y0, r.x1, c.y0), R(r.x0, c.y1, r.x1, r.y1), R(r.x0, c.y0, c.x0, c.y1), R(c.x1, c.y0, r.x1, c.y1)):
            if not (band & r).is_empty:
                pg.add_redact_annot(band & r)
        try:
            pg.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                                text=pymupdf.PDF_REDACT_TEXT_REMOVE)
        except Exception:  # noqa: BLE001
            pass
        for l in pg.get_links():
            pg.delete_link(l)
        return len(clean) - 1

    # build every cleaned crop first: show_pdf_page caches a graft map per source document,
    # so the source must not change while pages are being stamped
    crop_idx = {}
    for ops in flow.ops:
        for op in ops:
            if op[0] == "crop":
                key = (op[1], tuple(round(v, 2) for v in op[3]))
                if key not in crop_idx:
                    crop_idx[key] = clean_crop(op[1], op[3])
    out = pymupdf.open()
    for ops in flow.ops:
        if not ops:
            continue
        page = out.new_page(width=flow.pw, height=flow.ph)
        for op in ops:
            if op[0] == "crop":
                _, pno, tgt, clip = op
                page.show_pdf_page(tgt, clean, crop_idx[(pno, tuple(round(v, 2) for v in clip))], clip=clip)
            elif op[0] == "white":
                page.draw_rect(op[1], color=None, fill=(1, 1, 1), overlay=True)
            elif op[0] == "chunk":
                _, idx, tgt, clip = op
                stamp_chunk(page, cdoc, chunks, idx, tgt, clip)
    if not len(out):
        emit({"error": "没有生成任何页面"})
        return 1
    out.save(out_path, garbage=4, deflate=True)  # 4: merge the duplicated fonts of the per-crop page copies
    emit({"done": True, "dual": out_path, "translated": translated, "kept": kept,
          "errors": len(tr.errors), "error_sample": (tr.errors[-1][:200] if tr.errors else "")})
    return 0


if __name__ == "__main__":
    try:  # Windows pipes default to the ANSI code page; the plugin reads UTF-8
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    sys.exit(main(sys.argv[1:]))
