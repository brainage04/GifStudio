import { defineConfig } from 'astro/config';

const repository = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'GifStudio';
const isPagesBuild = process.env.GITHUB_ACTIONS === 'true';

export default defineConfig({
  output: 'static',
  base: isPagesBuild ? `/${repository}` : '/',
});
