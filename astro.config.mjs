import node from '@astrojs/node';
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone',
    bodySizeLimit: 50 * 1024 * 1024,
  }),
});
