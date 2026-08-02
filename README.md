# GifStudio

Browser-based GIF compositor for selecting a base animation, positioning an image overlay, rendering with FFmpeg WebAssembly, and downloading the result without uploading source files.

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

## Deployment

Pushes to `master` are validated and deployed to [GifStudio](https://brainage04.github.io/GifStudio/) through GitHub Actions and GitHub Pages.
