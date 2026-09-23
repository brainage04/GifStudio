import { defineConfig } from 'astro/config';
import astroShell from '@brainage04/astro-shell';
import { siteConfig } from './src/site.config.ts';

export default defineConfig({
  integrations: [
    astroShell({
      config: siteConfig,
      styles: ['@brainage04/astro-shell/themes/rose.css', './src/styles/site.css'],
    }),
  ],
});
