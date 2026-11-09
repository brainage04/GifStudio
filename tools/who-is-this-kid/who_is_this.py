#!/usr/bin/env nix-shell
#!nix-shell -i python3 -p "python3.withPackages(ps: [ps.pillow ps.numpy ps.opencv4])" ffmpeg
"""Remake who_is_this_kid.gif with a profile picture over the kid's face and "KID" swapped for a word.

Usage: ./who_is_this.py PFP --word WORD [-o OUT.gif] [--raw] [--scale 1.6] [--zoom 1.0] [--shape auto|circle|square|alpha]

PFP can be any image Pillow reads (JPG, PNG, WebP, ...); JPEG EXIF rotation is honoured.

The kid's face is tracked with OpenCV, "KID" is painted out of both captions and redrawn as
the chosen word (Montserrat.ttf next to this script), and the picture is pasted per frame with the
captions/arrow kept on top. Requires ffmpeg on PATH.

This is the original script the WhoIsThisKid page was ported from. It stays here as the reference
the browser compositor is tested against (src/lib/whoIsThisKid.golden.test.ts; regenerate its
fixtures with tools/who-is-this-kid/make_golden.py).
"""
import argparse
import os
import subprocess
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))


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


def write_gif(path, frames, w, h, fps=22):
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24',
                          '-s', f'{w}x{h}', '-framerate', str(fps), '-i', '-', '-lavfi',
                          'split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1:dither=sierra2_4a',
                          '-loop', '0', path], stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    if p.wait():
        sys.exit('ffmpeg failed to encode the GIF')


def load_pfp(path, zoom, shape):
    im = Image.open(path)
    im.seek(0)
    im = ImageOps.exif_transpose(im).convert('RGBA')  # phone JPEGs are often stored rotated
    side = min(im.size)
    keep = max(8, int(side * zoom))
    l, t = (im.width - keep) // 2, (im.height - keep) // 2
    im = im.crop((l, t, l + keep, t + keep))
    rgba = np.asarray(im)
    bgr = np.ascontiguousarray(rgba[..., 2::-1])
    alpha = rgba[..., 3].astype(np.float32) / 255
    if shape == 'auto':
        shape = 'alpha' if (alpha < 0.99).mean() > 0.02 else 'circle'
    if shape == 'alpha':
        mask = alpha
    else:
        mask = np.zeros(alpha.shape, np.float32)
        r = keep // 2
        if shape == 'circle':
            cv2.circle(mask, (r, r), r - max(2, keep // 60), 1, -1)
        else:
            mask[:] = 1
        mask = cv2.GaussianBlur(mask, (0, 0), max(1, keep / 90)) * alpha
    return bgr, mask


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


def paste_face(img, n, sm, ref, pfp, pmask, scale):
    H, W = img.shape[:2]
    cx, cy, s = sm[n]
    size = max(4, int(s * scale))
    x0, y0 = int(round(cx - size / 2)), int(round(cy - size / 2 - s * 0.08))
    spr = cv2.resize(pfp, (size, size), interpolation=cv2.INTER_AREA).astype(np.float32)
    m = cv2.resize(pmask, (size, size), interpolation=cv2.INTER_AREA)
    if n >= 33:  # white flash and regrade: per-channel linear map fitted against the clean last frame
        last = max(sm)
        x, y, w = int(cx - s / 2), int(cy - s / 2), int(s)
        rx, ry, rs = sm[last]
        a_ = ref[int(ry - rs / 2):int(ry + rs / 2), int(rx - rs / 2):int(rx + rs / 2)].astype(np.float32)
        b_ = cv2.resize(img[y:y + w, x:x + w].astype(np.float32), (a_.shape[1], a_.shape[0]))
        for c in range(3):
            A = np.vstack([a_[..., c].ravel(), np.ones(a_[..., c].size)]).T
            k, off = np.linalg.lstsq(A, b_[..., c].ravel(), rcond=None)[0]
            spr[..., c] = spr[..., c] * float(np.clip(k, 0, 1)) + float(np.clip(off, 0, 255))
    X0, Y0 = max(x0, 0), max(y0, 0)
    X1, Y1 = min(x0 + size, W), min(y0 + size, H)
    if X1 <= X0 or Y1 <= Y0:
        return img
    sp = spr[Y0 - y0:Y1 - y0, X0 - x0:X1 - x0]
    mm = m[Y0 - y0:Y1 - y0, X0 - x0:X1 - x0, None]
    roi = img[Y0:Y1, X0:X1].astype(np.float32)
    img[Y0:Y1, X0:X1] = np.clip(roi * (1 - mm) + sp * mm, 0, 255).astype(np.uint8)
    return img


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


def composite(img, alpha, color):
    a = alpha[..., None]
    return np.clip(img.astype(np.float32) * (1 - a) + np.array(color, np.float32) * a, 0, 255).astype(np.uint8)


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


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('pfp', help='profile picture (any format Pillow reads; non-square is centre-cropped)')
    ap.add_argument('-w', '--word', required=True, help='word that replaces "kid" (drawn in capitals)')
    ap.add_argument('-o', '--out', help='output GIF (default: the input path with a .gif extension, e.g. thomas.jpg -> thomas.gif)')
    ap.add_argument('--raw', action='store_true', help='write the frames as raw RGB24 bytes instead of encoding a GIF')
    ap.add_argument('--source', default=os.path.join(HERE, '..', '..', 'public', 'assets', 'who-is-this-kid', 'who_is_this_kid.gif'))
    ap.add_argument('--font', default=os.path.join(HERE, 'Montserrat.ttf'))
    ap.add_argument('--scale', type=float, default=1.6, help='pasted size relative to the detected face box (default 1.6)')
    ap.add_argument('--zoom', type=float, default=1.0, help='fraction of the picture kept, centred (0.7 = tighter on the face)')
    ap.add_argument('--shape', choices=['auto', 'circle', 'square', 'alpha'], default='auto',
                    help='auto: use the picture\'s transparency if it has any, else a feathered circle')
    args = ap.parse_args()
    if not 0 < args.zoom <= 1:
        ap.error('--zoom must be in (0, 1]')
    out_path = args.out or os.path.splitext(args.pfp)[0] + '.gif'
    for protected in (args.pfp, args.source):
        if os.path.exists(out_path) and os.path.samefile(out_path, protected):
            ap.error(f'output {out_path} would overwrite {protected}; pass -o')
    word = args.word.upper()

    frames, W, H = read_gif(args.source)
    N = len(frames)
    if (W, H, N) != (450, 498, 47):
        sys.exit(f'{args.source}: expected the 450x498, 47-frame who_is_this_kid.gif, got {W}x{H}, {N} frames')
    pfp, pmask = load_pfp(args.pfp, args.zoom, args.shape)
    sm = track_face(frames)
    text = Text(args.font, W, H)
    ref = frames[N - 1]

    # "WHO IS THIS KID?" (frames 22-32): KID at x 302-350, '?' at 356-366, caps 289-307
    ref_pink = pink_mask(frames[29])[285:312, 300:352].sum()
    ref_q = white_mask(frames[29])[285:312, 354:368].sum()
    # "*RANDOM KID*" (frames 35-46, zooms in): in the last frame spans x 61-310
    red_x0, red_x1 = 61, 310
    red_base_ref = red_geom(frames[46])[3]

    out = []
    for n, orig in enumerate(frames):
        img = orig.copy()
        restore = None
        draw = None
        if 22 <= n <= 32:
            ka = min(1.0, pink_mask(orig)[285:312, 300:352].sum() / ref_pink)
            qa = min(1.0, white_mask(orig)[285:312, 354:368].sum() / ref_q)
            img = inpaint_box(img, 296, 279, 372, 315)
            restore = pink_mask(orig) | white_mask(orig)
            restore[:, 293:] = False
            restore[:272] = False
            restore[316:] = False
            draw = ('pink', ka, qa)
        elif n >= 35:
            x0, x1, strength, base = red_geom(orig)
            sc = (x1 - x0) / (red_x1 - red_x0)
            mp = lambda X, c=(x0 + x1) / 2, sc=sc: c + (X - (red_x0 + red_x1) / 2) * sc
            kx0, kx1 = int(mp(240)), int(mp(316)) + 2
            img = inpaint_box(img, kx0, 118, kx1, 166)
            restore = red_mask(orig)
            restore[:166, kx0:kx1] = False
            restore[245:] = False
            restore[166:, int(mp(252)):] = False  # arrow stays on top, but not the kid's face
            seg = orig[125:160, int(mp(75)):int(mp(227))].astype(int)
            rgv = seg[..., 2] - seg[..., 1]
            col = np.median(seg[rgv >= np.percentile(rgv, 80)], 0)
            draw = ('red', sc, mp, col, strength, base)

        if n in sm:
            img = paste_face(img, n, sm, ref, pfp, pmask, args.scale)
        if restore is not None:
            rmf = cv2.dilate(restore.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(np.float32)
            rmf = cv2.GaussianBlur(rmf, (0, 0), 0.7)[..., None]
            img = np.clip(img * (1 - rmf) + orig * rmf, 0, 255).astype(np.uint8)

        if draw and draw[0] == 'pink':
            _, ka, qa = draw
            a, xe = text.layer(word, 19, 302, 307.5, 2.2)
            img = composite(img, np.clip(glow(a, 5, 3.0) * 0.85, 0, 1) * ka, (70, 0, 75))
            img = composite(img, a * ka, (215, 4, 215))
            q, _ = text.layer('?', 19, xe + 4.5, 307.5, 0)
            img = composite(img, cv2.GaussianBlur(cv2.dilate(q, np.ones((3, 3))), (0, 0), 2) * 0.35 * qa, (40, 30, 40))
            img = composite(img, q * qa, (245, 245, 245))
        elif draw:
            _, sc, mp, col, strength, base = draw
            fade = np.clip((strength - 40) / 130.0, 0, 1)
            sharp, _ = text.layer(word, 23 * sc, mp(244), 154 + (base - red_base_ref), 2.0 * sc)
            a = sharp
            if fade < 0.95:  # caption is still fading/zooming in: match its softness
                a = cv2.GaussianBlur(sharp, (0, 0), 0.3 + 2.0 * (1 - fade)) * (0.55 + 0.45 * fade)
            img = composite(img, np.clip(glow(sharp, 5, 3.5) * 0.7, 0, 1) * fade, (25, 10, 90))
            img = composite(img, a, col)
            # trailing '*': reuse the caption's own leading asterisk
            lx0, lx1 = int(mp(58)), int(mp(74)) + 1
            fx = (sharp > 0.3).any(0).nonzero()[0].max() + int(round(2 * sc))
            patch = orig[118:166, lx0:lx1].astype(np.float32)
            prg = patch[..., 2] - patch[..., 1]
            pm = cv2.GaussianBlur((prg > 0.6 * strength).astype(np.float32), (0, 0), 0.6)[..., None]
            w_ = min(lx1 - lx0, W - fx)
            roi = img[118:166, fx:fx + w_].astype(np.float32)
            img[118:166, fx:fx + w_] = np.clip(roi * (1 - pm[:, :w_]) + patch[:, :w_] * pm[:, :w_], 0, 255).astype(np.uint8)
        out.append(img)

    if args.raw:
        with open(out_path, 'wb') as fh:
            fh.write(b''.join(np.ascontiguousarray(f[..., ::-1]).tobytes() for f in out))
    else:
        write_gif(out_path, out, W, H)
    print(out_path)


if __name__ == '__main__':
    main()
