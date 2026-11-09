#!/usr/bin/env nix-shell
#!nix-shell -i python3 -p "python3.withPackages(ps: [ps.numpy ps.opencv4 ps.pillow])" ffmpeg
"""Write the fixtures src/lib/whoIsThisKid.golden.test.ts compares the browser compositor against.

Usage: tools/who-is-this-kid/make_golden.py

Runs who_is_this.py (the original script) on a fixed synthetic picture for each word in WORDS, with
its defaults (size 1.6, zoom 1, shape auto). The first word is stored for all 47 frames, as the pixels
that differ from the source GIF; every other word for CAPTION_FRAMES only, as the pixels that differ
from the first word's output. Each frame is an RGBA crop (alpha 255: this pixel, alpha 0: the
base's), stacked into one lossless WebP per word. Rerun it after changing who_is_this.py, the
template or the words; rerun build_template.py first if the template changed.
"""
import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
SOURCE = os.path.join(ROOT, 'public', 'assets', 'who-is-this-kid', 'who_is_this_kid.gif')
OUT = os.path.join(ROOT, 'src', 'lib', '__fixtures__', 'who-is-this-kid')
W, H, N = 450, 498, 47
# The default, a one-letter word, a wide six-letter word, the most characters that fit, and words
# outside ASCII (composite accented capitals, Cyrillic, 'ß' upper-casing to 'SS', Turkish).
WORDS = ['moid', 'a', 'genius', 'IIIIIIIIIII', 'Ærø', 'друг', 'maß', 'Ğış']
# One frame per caption size and fade path: the question (108 px), the zooming label at 92 px while
# still fading in (the soft-blur path), at 128 px, and at 132 px fully in.
CAPTION_FRAMES = [29, 35, 38, 46]


def picture(path):
    """A 320x240 opaque picture of flat shapes (the script centre-crops it to 240x240); flat colours
    keep the stored frames small while every edge still goes through the resize, mask and regrade."""
    im = Image.new('RGB', (320, 240), (40, 90, 200))
    d = ImageDraw.Draw(im)
    d.ellipse((90, 40, 230, 180), fill=(250, 220, 40))
    d.rectangle((120, 150, 200, 210), fill=(20, 140, 60))
    d.polygon([(160, 20), (260, 120), (60, 120)], outline=(255, 255, 255))
    im.save(path, optimize=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    pic = os.path.join(OUT, 'picture.png')
    picture(pic)
    src = subprocess.run(['ffmpeg', '-v', 'error', '-i', SOURCE, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                         check=True, capture_output=True).stdout
    src = np.frombuffer(src, np.uint8).reshape(N, H, W, 3)
    index = {'picture': 'picture.png', 'captionFrames': CAPTION_FRAMES, 'words': []}
    base = src
    for n, word in enumerate(WORDS):
        raw = os.path.join(OUT, 'out.raw')
        subprocess.run([sys.executable, os.path.join(HERE, 'who_is_this.py'), pic, '--word', word, '--raw', '-o', raw],
                       check=True, stdout=subprocess.DEVNULL)
        out = np.fromfile(raw, np.uint8).reshape(N, H, W, 3)
        os.remove(raw)
        crops, boxes, sheet_h = [], [], 0
        for f in range(N):
            if n and f not in CAPTION_FRAMES:
                boxes.append(None)
                continue
            changed = (out[f] != base[f]).any(2)
            if not changed.any():
                boxes.append(None)
                continue
            ys, xs = np.nonzero(changed)
            x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
            keep = changed[y0:y1, x0:x1]
            crop = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
            crop[keep, :3] = out[f, y0:y1, x0:x1][keep]
            crop[keep, 3] = 255
            crops.append(crop)
            boxes.append({'x': x0, 'y': y0, 'width': x1 - x0, 'height': y1 - y0, 'sheetY': sheet_h})
            sheet_h += y1 - y0
        sheet = np.zeros((sheet_h, max(c.shape[1] for c in crops), 4), np.uint8)
        for c, b in zip(crops, [b for b in boxes if b]):
            sheet[b['sheetY']:b['sheetY'] + b['height'], :b['width']] = c
        name = f'expected-{n}.webp'
        Image.fromarray(sheet).save(os.path.join(OUT, name), lossless=True, quality=100, method=6, exact=True)
        index['words'].append({'word': word, 'file': name, 'frames': boxes})
        print(word, name, os.path.getsize(os.path.join(OUT, name)))
        if n == 0:
            base = out
    with open(os.path.join(OUT, 'index.json'), 'w') as fh:
        json.dump(index, fh, ensure_ascii=False, separators=(',', ':'))
        fh.write('\n')


if __name__ == '__main__':
    main()
