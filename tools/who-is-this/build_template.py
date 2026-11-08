#!/usr/bin/env nix-shell
#!nix-shell -i python3 -p "python3.withPackages(ps: [ps.numpy ps.opencv4 ps.pillow])" ffmpeg
"""Build the data the "Who is this" page needs to remake who_is_this_kid.gif in the browser.

Usage: tools/who-is-this/build_template.py

The page pastes a visitor's picture over the kid's face and swaps "KID" in both captions for one of
WORDS. Everything that does not depend on the picture is worked out here once and committed, so the
browser (src/lib/whoIsThis.ts) only has to resize, regrade and paste the picture:

  src/data/whoIsThisTemplate.json
                 per frame: smoothed face box, colour regrade, where each sheet crop goes
  public/assets/who-is-this/patches.png
                 RGB: the caption frames with "KID" painted out (OpenCV inpainting), drawn under the picture
  public/assets/who-is-this/overlays.png
                 RGBA: per word, everything drawn over the picture - the original caption and arrow
                 pixels, the new word (Montserrat at weight 850) with its glow, and the copied '*'

Reads public/assets/who-is-this/who_is_this_kid.gif and tools/who-is-this/Montserrat.ttf. Requires
ffmpeg on PATH (the nix-shell line provides it).
"""
import json
import os
import subprocess
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'public', 'assets', 'who-is-this')
TEMPLATE = os.path.join(ROOT, 'src', 'data', 'whoIsThisTemplate.json')
SOURCE = os.path.join(OUT, 'who_is_this_kid.gif')
FONT = os.path.join(HERE, 'Montserrat.ttf')
WORDS = ('foid', 'moid')
FPS = 22


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
class Text:
    def __init__(self, font_path, w, h):
        self.font_path, self.W, self.H = font_path, w, h
        self.cache = {}

    def font(self, px):
        if px not in self.cache:
            f = ImageFont.truetype(self.font_path, px)
            try:
                f.set_variation_by_axes([850])
            except OSError:
                pass  # static (non-variable) font
            self.cache[px] = f
        return self.cache[px]

    def layer(self, text, cap_h, x0, base_y, track):
        """Alpha mask (H, W) of `text` with cap height ~cap_h, left edge x0, baseline base_y; returns (mask, end_x)."""
        S = 4
        f = self.font(int(round(cap_h / 0.70)) * S)
        im = Image.new('L', (self.W * S, self.H * S), 0)
        d = ImageDraw.Draw(im)
        x = x0 * S
        for ch in text:
            d.text((x, base_y * S), ch, font=f, fill=255, anchor='ls')
            x += f.getlength(ch) + track * S
        im = im.resize((self.W, self.H), Image.LANCZOS)
        return np.asarray(im, np.float32) / 255, x / S


class Overlay:
    """Successive `img * (1 - a) + color * a` blends, folded into one straight-alpha RGBA layer."""

    def __init__(self, w, h):
        self.keep = np.ones((h, w), np.float64)
        self.color = np.zeros((h, w, 3), np.float64)

    def blend(self, alpha, color, x=0, y=0):
        h, w = alpha.shape
        a = alpha.astype(np.float64)
        self.keep[y:y + h, x:x + w] *= 1 - a
        self.color[y:y + h, x:x + w] = self.color[y:y + h, x:x + w] * (1 - a[..., None]) + np.asarray(color, np.float64) * a[..., None]

    def rgba(self):
        alpha = 1 - self.keep
        rgb = np.divide(self.color, alpha[..., None], out=np.zeros_like(self.color), where=alpha[..., None] > 0)
        return np.dstack([np.clip(np.rint(rgb), 0, 255), np.clip(np.rint(alpha * 255), 0, 255)]).astype(np.uint8)


def glow(alpha, grow, blur):
    return cv2.GaussianBlur(cv2.dilate(alpha, np.ones((grow, grow), np.uint8)), (0, 0), blur)


def inpaint_box(img, x0, y0, x1, y1):
    m = np.zeros(img.shape[:2], np.uint8)
    m[y0:y1, x0:x1] = 255
    return cv2.inpaint(img, m, 6, cv2.INPAINT_TELEA)


def pink_mask(f):
    f = f.astype(int)
    return (f[..., 2] > 150) & (f[..., 0] > 130) & (f[..., 1] < 120)


def white_mask(f):
    return f.min(2) > 175


def red_mask(f):
    f = f.astype(int)
    return (f[..., 2] - f[..., 1] > 60) & (f[..., 2] - f[..., 0] > 40)


def red_geom(frame):
    band = frame[118:166].astype(int)
    rg = band[..., 2] - band[..., 1]
    m = (rg > 0.55 * rg.max()) & (rg > 25)
    xs = np.nonzero(m.any(0))[0]
    rows = m[:, 80:230].sum(1)
    base = 118 + np.nonzero(rows > 0.3 * rows.max())[0].max()
    return xs.min(), xs.max(), rg.max(), base


def draw_caption(overlay, text, word, orig, restore, caption):
    """The original script's caption pass, as blends into `overlay`; colours are RGB."""
    W = orig.shape[1]
    rgb = orig[..., ::-1]
    overlay.blend(restore, rgb)
    if caption[0] == 'pink':
        _, ka, qa = caption
        a, xe = text.layer(word, 19, 302, 307.5, 2.2)
        overlay.blend(np.clip(glow(a, 5, 3.0) * 0.85, 0, 1) * ka, (75, 0, 70))
        overlay.blend(a * ka, (215, 4, 215))
        q, _ = text.layer('?', 19, xe + 4.5, 307.5, 0)
        overlay.blend(cv2.GaussianBlur(cv2.dilate(q, np.ones((3, 3))), (0, 0), 2) * 0.35 * qa, (40, 30, 40))
        overlay.blend(q * qa, (245, 245, 245))
    else:
        _, sc, mp, col, strength, base, red_base_ref = caption
        fade = np.clip((strength - 40) / 130.0, 0, 1)
        sharp, _ = text.layer(word, 23 * sc, mp(244), 154 + (base - red_base_ref), 2.0 * sc)
        a = sharp
        if fade < 0.95:  # caption is still fading/zooming in: match its softness
            a = cv2.GaussianBlur(sharp, (0, 0), 0.3 + 2.0 * (1 - fade)) * (0.55 + 0.45 * fade)
        overlay.blend(np.clip(glow(sharp, 5, 3.5) * 0.7, 0, 1) * fade, (90, 10, 25))
        overlay.blend(a, col[::-1])
        # trailing '*': reuse the caption's own leading asterisk
        lx0, lx1 = int(mp(58)), int(mp(74)) + 1
        fx = (sharp > 0.3).any(0).nonzero()[0].max() + int(round(2 * sc))
        patch = orig[118:166, lx0:lx1].astype(np.float32)
        prg = patch[..., 2] - patch[..., 1]
        pm = cv2.GaussianBlur((prg > 0.6 * strength).astype(np.float32), (0, 0), 0.6)
        w_ = min(lx1 - lx0, W - fx)
        if w_ > 0:
            overlay.blend(pm[:, :w_], rgb[118:166, lx0:lx0 + w_], fx, 118)


# ---------------------------------------------------------------- main
def main():
    frames, W, H = read_gif(SOURCE)
    N = len(frames)
    if (W, H, N) != (450, 498, 47):
        sys.exit(f'{SOURCE}: expected the 450x498, 47-frame who_is_this_kid.gif, got {W}x{H}, {N} frames')
    sm = track_face(frames)
    text = Text(FONT, W, H)
    ref = frames[N - 1]
    patches, overlays = Sheet(3), Sheet(4)

    # "WHO IS THIS KID?" (frames 22-32): KID at x 302-350, '?' at 356-366, caps 289-307
    ref_pink = pink_mask(frames[29])[285:312, 300:352].sum()
    ref_q = white_mask(frames[29])[285:312, 354:368].sum()
    # "*RANDOM KID*" (frames 35-46, zooms in): in the last frame spans x 61-310
    red_x0, red_x1 = 61, 310
    red_base_ref = red_geom(frames[46])[3]

    out = []
    for n, orig in enumerate(frames):
        entry = {}
        img = orig.copy()
        restore = None
        caption = None
        box = None
        if 22 <= n <= 32:
            ka = min(1.0, pink_mask(orig)[285:312, 300:352].sum() / ref_pink)
            qa = min(1.0, white_mask(orig)[285:312, 354:368].sum() / ref_q)
            box = (296, 279, 372, 315)
            restore = pink_mask(orig) | white_mask(orig)
            restore[:, 293:] = False
            restore[:272] = False
            restore[316:] = False
            caption = ('pink', ka, qa)
        elif n >= 35:
            x0, x1, strength, base = red_geom(orig)
            sc = (x1 - x0) / (red_x1 - red_x0)
            mp = lambda X, c=(x0 + x1) / 2, sc=sc: c + (X - (red_x0 + red_x1) / 2) * sc
            kx0, kx1 = int(mp(240)), int(mp(316)) + 2
            box = (kx0, 118, kx1, 166)
            restore = red_mask(orig)
            restore[:166, kx0:kx1] = False
            restore[245:] = False
            restore[166:, int(mp(252)):] = False  # arrow stays on top, but not the kid's face
            seg = orig[125:160, int(mp(75)):int(mp(227))].astype(int)
            rgv = seg[..., 2] - seg[..., 1]
            col = np.median(seg[rgv >= np.percentile(rgv, 80)], 0)
            caption = ('red', sc, mp, col, strength, base, red_base_ref)

        if box:
            bx0, by0, bx1, by1 = box
            img = inpaint_box(img, *box)
            entry['patch'] = patches.add(bx0, by0, np.ascontiguousarray(img[by0:by1, bx0:bx1, ::-1]))
        if n in sm:
            entry['face'] = [float(v) for v in sm[n]]
            if n >= 33:
                entry['regrade'] = regrade(img, n, sm, ref)
        if caption:
            rmf = cv2.dilate(restore.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(np.float32)
            rmf = cv2.GaussianBlur(rmf, (0, 0), 0.7)[..., None]
            entry['overlays'] = {}
            for word in WORDS:
                overlay = Overlay(W, H)
                draw_caption(overlay, text, word.upper(), orig, rmf[..., 0], caption)
                rgba = overlay.rgba()
                ys, xs = np.nonzero(rgba[..., 3])
                y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
                entry['overlays'][word] = overlays.add(x0, y0, np.ascontiguousarray(rgba[y0:y1, x0:x1]))
        out.append(entry)

    template = {
        'width': W, 'height': H, 'fps': FPS, 'words': list(WORDS),
        'source': 'who_is_this_kid.gif',
        'patches': {'file': 'patches.png', 'size': patches.save(os.path.join(OUT, 'patches.png'))},
        'overlays': {'file': 'overlays.png', 'size': overlays.save(os.path.join(OUT, 'overlays.png'))},
        'frames': out,
    }
    with open(TEMPLATE, 'w') as fh:
        json.dump(template, fh, separators=(',', ':'))
        fh.write('\n')
    print(TEMPLATE)


if __name__ == '__main__':
    main()
