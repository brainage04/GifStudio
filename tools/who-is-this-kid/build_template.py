#!/usr/bin/env nix-shell
#!nix-shell -i python3 -p "python3.withPackages(ps: [ps.numpy ps.opencv4 ps.pillow ps.freetype-py ps.fonttools])" ffmpeg
"""Build the data the WhoIsThisKid page needs to remake who_is_this_kid.gif in the browser.

Usage: tools/who-is-this-kid/build_template.py

The page pastes a visitor's picture over the kid's face and swaps "KID" in both captions for any word
the visitor types, drawing it the way who_is_this.py does. Everything that does not depend on the
picture or the word is worked out here once and committed, so the browser (src/lib/whoIsThisKid.ts)
only has to paste the picture and draw the word:

  src/data/whoIsThisKidTemplate.json
                 per frame: smoothed face box, colour regrade, where the patch goes, and what the
                 caption measures (its fade-in, or the zooming caption's extent, strength, baseline
                 and colour)
  public/assets/who-is-this-kid/patches.png
                 RGB: the caption frames with "KID" painted out (OpenCV inpainting)
  public/assets/who-is-this-kid/glyphs.json
                 Montserrat at weight 850 as FreeType loads it for Pillow, for every character a
                 visitor's word can contain after upper-casing: unrounded outlines, per caption size
                 the advance Pillow uses and FreeType's grid offsets for composite glyphs
  src/assets/who-is-this-kid/editor-frame.jpg
                 the last frame with a tracked face, the backdrop the page places the picture on
                 (Astro optimises it for display)

Each exported character is checked against Pillow: drawn by Pillow and placed from FreeType's own
bitmap the way src/lib/textLayer.ts places it, both must agree at every caption size, or the
character is left out (and the page refuses it).

Reads public/assets/who-is-this-kid/who_is_this_kid.gif and tools/who-is-this-kid/Montserrat.ttf.
Requires ffmpeg on PATH (the nix-shell line provides it).
"""
import json
import math
import os
import subprocess
import sys

import cv2
import freetype
import numpy as np
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'public', 'assets', 'who-is-this-kid')
EDITOR_FRAME = os.path.join(ROOT, 'src', 'assets', 'who-is-this-kid', 'editor-frame.jpg')
TEMPLATE = os.path.join(ROOT, 'src', 'data', 'whoIsThisKidTemplate.json')
SOURCE = os.path.join(OUT, 'who_is_this_kid.gif')
FONT = os.path.join(HERE, 'Montserrat.ttf')
WEIGHT = 850
FPS = 22
S = 4  # who_is_this.py draws text at 4x and reduces it with Lanczos

# who_is_this.py's caption geometry
QUESTION_CAP = 19
LABEL_CAP = 23
LABEL_REF_X0, LABEL_REF_X1 = 61, 310


# ---------------------------------------------------------------- io
def read_gif(path):
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries',
                            'stream=width,height', '-of', 'csv=p=0', path],
                           check=True, capture_output=True, text=True).stdout
    w, h = map(int, probe.strip().split(',')[:2])
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
                         check=True, capture_output=True).stdout
    arr = np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)
    return [f.copy() for f in arr], w, h


class Sheet:
    """Crops stacked top to bottom, left-aligned; the browser finds each one by its `sheetY`."""

    def __init__(self, channels):
        self.channels, self.parts, self.height = channels, [], 0

    def add(self, x, y, crop):
        entry = {'x': int(x), 'y': int(y), 'width': crop.shape[1], 'height': crop.shape[0], 'sheetY': self.height}
        self.parts.append(crop)
        self.height += crop.shape[0]
        return entry

    def save(self, path):
        width = max(p.shape[1] for p in self.parts)
        sheet = np.zeros((self.height, width, self.channels), np.uint8)
        y = 0
        for p in self.parts:
            sheet[y:y + p.shape[0], :p.shape[1]] = p
            y += p.shape[0]
        Image.fromarray(sheet).save(path, optimize=True)
        return [width, self.height]


# ---------------------------------------------------------------- face track
def cascade_path():
    root = os.path.realpath(cv2.__file__)
    for _ in range(5):
        root = os.path.dirname(root)
    for cand in (os.path.join(root, 'share/opencv4/haarcascades'), getattr(getattr(cv2, 'data', None), 'haarcascades', '')):
        p = os.path.join(cand, 'haarcascade_frontalface_default.xml')
        if os.path.exists(p):
            return p
    sys.exit('haarcascade_frontalface_default.xml not found in the OpenCV install')


def track_face(frames):
    casc = cv2.CascadeClassifier(cascade_path())
    det = {}
    for n in range(20, len(frames)):
        g = cv2.equalizeHist(cv2.cvtColor(frames[n], cv2.COLOR_BGR2GRAY))
        c = [d for d in casc.detectMultiScale(g, 1.05, 3, minSize=(60, 60)) if d[0] > 200 and d[1] < 260]
        if c:
            x, y, w, h = max(c, key=lambda d: d[2])
            det[n] = (x + w / 2, y + h / 2, w)
    # the kid slides in from the right edge: template-match backwards from the first detection
    first = min(det)
    cx, cy, s = det[first]
    tpl = frames[first][int(cy - s * .35):int(cy + s * .35), int(cx - s * .35):int(cx + s * .35)]
    for n in range(first - 1, 18, -1):
        big = cv2.copyMakeBorder(frames[n], 0, 0, 0, 80, cv2.BORDER_REPLICATE)
        res = cv2.matchTemplate(big[:, 300:], tpl, cv2.TM_CCOEFF_NORMED)
        _, mv, _, ml = cv2.minMaxLoc(res)
        if mv < 0.4:
            break
        det[n] = (ml[0] + 300 + tpl.shape[1] / 2, ml[1] + tpl.shape[0] / 2, s)
        tpl = big[ml[1]:ml[1] + tpl.shape[0], 300 + ml[0]:300 + ml[0] + tpl.shape[1]]
    track = {}
    for n in range(min(det), max(det) + 1):
        if n in det:
            track[n] = np.array(det[n], float)
        else:
            a = max(k for k in det if k < n)
            b = min(k for k in det if k > n)
            t = (n - a) / (b - a)
            track[n] = (1 - t) * np.array(det[a]) + t * np.array(det[b])
    sm = {}
    for n in track:
        nb = [k for k in (n - 1, n, n + 1) if k in track]
        sm[n] = np.mean([track[k] for k in nb], 0)
        sm[n][:2] = 0.5 * track[n][:2] + 0.5 * sm[n][:2]
    return sm


def regrade(img, n, sm, ref):
    """White flash and regrade: per-channel linear map, RGB order, fitted against the clean last frame."""
    cx, cy, s = sm[n]
    x, y, w = int(cx - s / 2), int(cy - s / 2), int(s)
    rx, ry, rs = sm[max(sm)]
    a_ = ref[int(ry - rs / 2):int(ry + rs / 2), int(rx - rs / 2):int(rx + rs / 2)].astype(np.float32)
    b_ = cv2.resize(img[y:y + w, x:x + w].astype(np.float32), (a_.shape[1], a_.shape[0]))
    fit = []
    for c in (2, 1, 0):
        A = np.vstack([a_[..., c].ravel(), np.ones(a_[..., c].size)]).T
        k, off = np.linalg.lstsq(A, b_[..., c].ravel(), rcond=None)[0]
        fit.append([float(np.clip(k, 0, 1)), float(np.clip(off, 0, 255))])
    return fit


# ---------------------------------------------------------------- captions
def inpaint_box(img, x0, y0, x1, y1):
    m = np.zeros(img.shape[:2], np.uint8)
    m[y0:y1, x0:x1] = 255
    return cv2.inpaint(img, m, 6, cv2.INPAINT_TELEA)


def pink_mask(f):
    f = f.astype(int)
    return (f[..., 2] > 150) & (f[..., 0] > 130) & (f[..., 1] < 120)


def white_mask(f):
    return f.min(2) > 175


def red_geom(frame):
    band = frame[118:166].astype(int)
    rg = band[..., 2] - band[..., 1]
    m = (rg > 0.55 * rg.max()) & (rg > 25)
    xs = np.nonzero(m.any(0))[0]
    rows = m[:, 80:230].sum(1)
    base = 118 + np.nonzero(rows > 0.3 * rows.max())[0].max()
    return xs.min(), xs.max(), rg.max(), base


def font_px(cap_h):
    """who_is_this.py's `Text.font` size for a cap height, at the 4x drawing scale."""
    return int(round(cap_h / 0.70)) * S


# ---------------------------------------------------------------- glyphs
def mulfix(a, b):
    """FreeType's FT_MulFix: (a * b) / 0x10000, rounded half away from zero."""
    sign = -1 if (a < 0) != (b < 0) else 1
    return sign * ((abs(a) * abs(b) + 0x8000) >> 16)


def f32(value):
    return float(np.float32(value))


def pixel(v):
    """Pillow's PIXEL(): 26.6 to whole pixels, halves up."""
    return (v + 32) >> 6


def c_round(v):
    """C's round(): halves away from zero."""
    return math.floor(abs(v) + 0.5) * (1 if v >= 0 else -1)


def glyph_left(x, bitmap_left):
    """Where Pillow puts a glyph bitmap's left column when drawing one character at 4x position `x`."""
    x_min = min(0, bitmap_left)
    start = f32(f32(-x_min) + f32(math.modf(x)[0]))
    return int(x) + x_min + pixel(c_round(start * 64)) + bitmap_left


def export_glyphs(sizes):
    face = freetype.Face(FONT)
    font = TTFont(FONT)
    cmap, glyf = font.getBestCmap(), font['glyf']
    # Every character a word can hold after Python's str.upper(), as long as the font has it.
    codepoints = sorted({ord(c) for cp in cmap for c in chr(cp).upper() if ord(c) in cmap})

    def set_size(px):
        face.set_pixel_sizes(0, px)
        face.set_var_design_coords((WEIGHT,))

    def load(index, flags):
        face.load_glyph(index, flags)
        o = face.glyph.outline
        return list(o.points), [t & 3 for t in o.tags], list(o.contours), o.flags

    def leaves(name):
        """The simple glyphs a glyph is built from, in FreeType's contour order."""
        g = glyf[name]
        if not g.isComposite():
            return [name]
        return [leaf for component in g.components for leaf in leaves(component.glyphName)]

    # At 1000 px a font unit is 64 units of 26.6, so outlines come out unscaled but unrounded: the
    # coordinates FreeType scales after applying the weight's variation deltas. A composite's points
    # are kept in its components' own coordinates, because FreeType scales and rounds those before
    # adding each component's (grid-rounded) offset.
    set_size(1000)
    assert (face.size.x_scale, face.size.y_scale) == (64 << 16, 64 << 16)
    local = {}
    for cp in codepoints:
        points = []
        for leaf in leaves(cmap[cp]):
            points += load(font.getGlyphID(leaf), freetype.FT_LOAD_NO_HINTING)[0]
        local[cp] = points
    unrounded = {cp: load(face.get_char_index(cp), freetype.FT_LOAD_NO_HINTING) for cp in codepoints}

    per_size = []
    for px in sizes:
        set_size(px)
        hinted = {cp: load(face.get_char_index(cp), freetype.FT_LOAD_DEFAULT) for cp in codepoints}
        pillow = ImageFont.truetype(FONT, px)
        pillow.set_variation_by_axes([WEIGHT])
        per_size.append((px, face.size.x_scale, face.size.y_scale, hinted, pillow))

    glyphs, skipped = [], []
    canvas_w, canvas_h = 900, 600
    for cp in codepoints:
        ch = chr(cp)
        _, tags, ends, _ = unrounded[cp]
        points = local[cp]
        if any(t not in (0, 1) for t in tags) or len(points) != len(tags):
            skipped.append(ch)
            continue
        advances, offsets, ok = [], [], True
        for px, x_scale, y_scale, hinted, pillow in per_size:
            h_points, h_tags, h_ends, h_flags = hinted[cp]
            # Even-odd fill or overlapping contours would need FreeType paths the browser port lacks.
            if h_tags != tags or h_ends != ends or h_flags & (0x2 | 0x40):
                ok = False
                break
            # Composite glyphs: FreeType grid-rounds each component's offset; record it per contour.
            size_offsets = []
            first = 0
            for contour, last in enumerate(ends):
                deltas = {(h_points[i][0] - ((mulfix(points[i][0], x_scale) + 32) >> 6),
                           h_points[i][1] - ((mulfix(points[i][1], y_scale) + 32) >> 6)) for i in range(first, last + 1)}
                if len(deltas) != 1:
                    ok = False
                    break
                dx, dy = deltas.pop()
                if dx or dy:
                    size_offsets.append([contour, dx, dy])
                first = last + 1
            if not ok:
                break
            offsets.append(size_offsets)
            advance = pillow.getlength(ch) * 64
            assert advance == int(advance), (ch, px, advance)
            advances.append(int(advance))

            # Pillow must draw exactly FreeType's bitmap, where glyph_left() says it goes.
            face.set_pixel_sizes(0, px)
            face.set_var_design_coords((WEIGHT,))
            face.load_char(ch, freetype.FT_LOAD_DEFAULT | freetype.FT_LOAD_RENDER)
            g = face.glyph
            bitmap = np.array(g.bitmap.buffer, np.uint8).reshape(g.bitmap.rows, g.bitmap.width)
            for x in (300.0, 300.3, 300.5078125, 300.75):
                drawn = Image.new('L', (canvas_w, canvas_h), 0)
                ImageDraw.Draw(drawn).text((x, 400), ch, font=pillow, fill=255, anchor='ls')
                expected = np.zeros((canvas_h, canvas_w), np.uint8)
                if bitmap.size:
                    left, top = glyph_left(x, g.bitmap_left), 400 - g.bitmap_top
                    expected[top:top + bitmap.shape[0], left:left + bitmap.shape[1]] = bitmap
                if not np.array_equal(np.asarray(drawn), expected):
                    ok = False
                    break
            if not ok:
                break
        if not ok:
            skipped.append(ch)
            continue
        flat = []
        px_, py_ = 0, 0
        for x, y in points:
            flat += [x - px_, y - py_]
            px_, py_ = x, y
        glyphs.append([cp, ends, flat, ''.join(str(t) for t in tags), advances, offsets])

    data = {
        'font': 'Montserrat', 'weight': WEIGHT,
        'sizes': [{'px': px, 'xScale': xs, 'yScale': ys} for px, xs, ys, _, _ in per_size],
        # [codepoint, contour end indices, points as deltas from the previous point (unrounded
        #  26.6 font units), on-curve flags, advance per size (26.6 px), per size [[contour, dx, dy]]]
        'glyphs': glyphs,
    }
    with open(os.path.join(OUT, 'glyphs.json'), 'w') as fh:
        json.dump(data, fh, separators=(',', ':'))
        fh.write('\n')
    return len(glyphs), skipped


# ---------------------------------------------------------------- main
def main():
    frames, W, H = read_gif(SOURCE)
    N = len(frames)
    if (W, H, N) != (450, 498, 47):
        sys.exit(f'{SOURCE}: expected the 450x498, 47-frame who_is_this_kid.gif, got {W}x{H}, {N} frames')
    sm = track_face(frames)
    ref = frames[N - 1]
    patches = Sheet(3)

    # "WHO IS THIS KID?" (frames 22-32): KID at x 302-350, '?' at 356-366, caps 289-307
    ref_pink = pink_mask(frames[29])[285:312, 300:352].sum()
    ref_q = white_mask(frames[29])[285:312, 354:368].sum()
    # "*RANDOM KID*" (frames 35-46, zooms in): in the last frame spans x 61-310
    red_base_ref = red_geom(frames[46])[3]
    sizes = {font_px(QUESTION_CAP)}

    out = []
    for n, orig in enumerate(frames):
        entry = {}
        img = orig.copy()
        box = None
        if 22 <= n <= 32:
            ka = min(1.0, pink_mask(orig)[285:312, 300:352].sum() / ref_pink)
            qa = min(1.0, white_mask(orig)[285:312, 354:368].sum() / ref_q)
            box = (296, 279, 372, 315)
            entry['caption'] = {'kind': 'question', 'wordAlpha': float(ka), 'markAlpha': float(qa)}
        elif n >= 35:
            x0, x1, strength, base = red_geom(orig)
            sc = (x1 - x0) / (LABEL_REF_X1 - LABEL_REF_X0)
            mp = lambda X, c=(x0 + x1) / 2, sc=sc: c + (X - (LABEL_REF_X0 + LABEL_REF_X1) / 2) * sc
            box = (int(mp(240)), 118, int(mp(316)) + 2, 166)
            seg = orig[125:160, int(mp(75)):int(mp(227))].astype(int)
            rgv = seg[..., 2] - seg[..., 1]
            col = np.median(seg[rgv >= np.percentile(rgv, 80)], 0)
            entry['caption'] = {
                'kind': 'label', 'left': int(x0), 'right': int(x1), 'strength': int(strength),
                'baseline': int(base), 'color': [float(col[2]), float(col[1]), float(col[0])],
            }
            sizes.add(font_px(LABEL_CAP * sc))

        if box:
            bx0, by0, bx1, by1 = box
            img = inpaint_box(img, *box)
            entry['patch'] = patches.add(bx0, by0, np.ascontiguousarray(img[by0:by1, bx0:bx1, ::-1]))
        if n in sm:
            entry['face'] = [float(v) for v in sm[n]]
            if n >= 33:
                entry['regrade'] = regrade(img, n, sm, ref)
        out.append(entry)

    exported, skipped = export_glyphs(sorted(sizes))
    print(f'glyphs: {exported} characters at sizes {sorted(sizes)}; left out: {"".join(skipped) or "none"}')

    editor_frame = max(sm)
    Image.fromarray(np.ascontiguousarray(frames[editor_frame][..., ::-1])).save(EDITOR_FRAME, quality=90)
    template = {
        'width': W, 'height': H, 'fps': FPS,
        'source': 'who_is_this_kid.gif',
        'patches': {'file': 'patches.png', 'size': patches.save(os.path.join(OUT, 'patches.png'))},
        'glyphs': 'glyphs.json',
        'label': {'referenceLeft': LABEL_REF_X0, 'referenceRight': LABEL_REF_X1, 'referenceBaseline': int(red_base_ref)},
        'editor': {'frame': editor_frame},
        'frames': out,
    }
    with open(TEMPLATE, 'w') as fh:
        json.dump(template, fh, separators=(',', ':'))
        fh.write('\n')
    print(TEMPLATE)


if __name__ == '__main__':
    main()
