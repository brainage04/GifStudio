# GifStudio

Browser-based GIF compositor for selecting a base GIF or image, cropping and positioning a GIF or image overlay, rendering with FFmpeg WebAssembly, and downloading the result without uploading source files.

The **Who is this** page (`/who-is-this/`) remakes the "who is this kid?" GIF: it puts a picture over the kid's face and swaps "kid" in both captions for MOID or FOID. The picture can be cropped, resized and moved relative to the face, and masked to a circle, a square or its own transparency.

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

## Who is this template

The page only resizes, colour-matches and pastes the picture. Everything that does not depend on the picture is computed ahead of time by `tools/who-is-this/build_template.py` from `public/assets/who-is-this/who_is_this_kid.gif` and committed: the face track, the painted-out "KID", the end-of-clip colour regrade, and each word's caption overlay. Rerun it after changing the source GIF, the caption words (`WORDS`) or the font:

```bash
tools/who-is-this/build_template.py
```

It needs Nix, which provides Python with OpenCV, Pillow and NumPy, plus ffmpeg. Montserrat (`tools/who-is-this/Montserrat.ttf`) is under the SIL Open Font License; see `tools/who-is-this/OFL.txt`.

## Deployment

Pushes to `main` are validated and deployed to [GifStudio](https://brainage04.github.io/GifStudio/) through GitHub Actions and GitHub Pages.
