# GifStudio

Browser-based GIF compositor for selecting a base GIF or image, cropping and positioning a GIF or image overlay, rendering with FFmpeg WebAssembly, and downloading the result without uploading source files.

The **WhoIsThisKid** page (`/who-is-this-kid/`) remakes the "who is this kid?" GIF: it puts a picture over the kid's face and swaps "kid" in both captions for any word the visitor types, drawn exactly as the original `who_is_this.py` script draws it. The picture can be cropped, resized and moved relative to the face, and masked to a circle, a square or its own transparency. The clip is from IShowSpeed's livestream [irl stream in South Africa (New Years)](https://www.youtube.com/watch?v=2yGZz3Z_p4E&t=2435s), 31 December 2025, at about 40:35, and the page credits it.

## Requirements

- Node.js 24
- npm
- A browser with WebAssembly support

## Development

```bash
npm ci
npm run dev
```

The renderer runs entirely in the browser. Remote image URLs must allow cross-origin browser requests.

## Validation

```bash
npm run check
npm run lint
npm run format:check
npm test
npm run build
```

## WhoIsThisKid template

The page pastes the picture and draws the word; everything that depends on neither is computed ahead of time by `tools/who-is-this-kid/build_template.py` from `public/assets/who-is-this-kid/who_is_this_kid.gif` and committed: the face track, the painted-out "KID", the end-of-clip colour regrade, what each caption frame measures, the editor's still frame, and `glyphs.json`, the caption font (Montserrat at weight 850) as FreeType loads it at the caption sizes. Before exporting a character the script checks that Pillow draws it exactly where the browser port (`src/lib/textLayer.ts`, a port of FreeType's rasteriser and Pillow's text placement and Lanczos reduce) will; characters that fail are left out, and the page refuses words containing them. Rerun it after changing the source GIF or the font:

```bash
tools/who-is-this-kid/build_template.py
```

`tools/who-is-this-kid/who_is_this.py` is the original script. `src/lib/whoIsThisKid.golden.test.ts` compares the browser compositor with its output on a fixed picture for several words (one-letter, long, accented, Cyrillic, `ß`): every frame must be within one level of the script on at most 0.1% of values. Regenerate those fixtures after changing the script, the template or the test words:

```bash
tools/who-is-this-kid/make_golden.py
```

Both scripts need Nix, which provides Python with OpenCV, Pillow, NumPy and freetype-py, plus ffmpeg. Montserrat (`tools/who-is-this-kid/Montserrat.ttf`) is under the SIL Open Font License; see `tools/who-is-this-kid/OFL.txt`.

## Deployment

Pushes to `main` are validated and deployed to [GifStudio](https://brainage04.github.io/GifStudio/) through GitHub Actions and GitHub Pages.
