import type { SiteConfig } from '@brainage04/astro-shell/config';

export const siteConfig = {
  siteName: 'GifStudio',
  homeTitle: 'GifStudio',
  description: 'Browser-based GIF overlay renderer by brainage04.',
  navItems: [
    { name: 'GifStudio', href: '/', match: '/', activeMode: 'exact' },
    { name: 'Main site', href: 'https://brainage04.github.io/', external: true },
  ],
  sourceHref: 'https://github.com/brainage04/GifStudio',
  faviconHref: '/assets/overlays/brainage.jpg',
  faviconType: 'image/jpeg',
  image: '/assets/overlays/brainage.jpg',
  themeColor: '#171218',
  preconnectHrefs: [],
  ownerHref: 'https://github.com/brainage04',
  ownerName: 'brainage04',
  creatorHref: undefined,
  creatorName: undefined,
} as const satisfies SiteConfig;
