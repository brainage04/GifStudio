import type { SiteConfig } from '@brainage04/astro-shell/config';

export const siteConfig = {
  siteName: 'GifStudio',
  description: 'Browser-based GIF overlay renderer by brainage04.',
  navItems: [
    { name: 'GifStudio', href: '/' },
    { name: 'Main site', href: 'https://brainage04.github.io/', external: true },
  ],
  sourceHref: 'https://github.com/brainage04/GifStudio',
  faviconHref: '/pfp.webp',
  faviconType: 'image/webp',
  image: '/pfp.webp',
  themeColor: '#171218',
  ownerHref: 'https://github.com/brainage04',
  ownerName: 'brainage04',
} as const satisfies SiteConfig;
