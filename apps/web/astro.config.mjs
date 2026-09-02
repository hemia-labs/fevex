import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://fevex.dev',

  integrations: [
    starlight({
      title: 'FEVEX',
      description:
        'Documentation for FEVEX, the code-first, provider-neutral Agent Engineering Framework for TypeScript.',
      logo: {
        src: './src/assets/fevex-wordmark.svg',
        replacesTitle: true,
      },
      favicon: '/favicon.svg',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/hemia-labs/fevex',
        },
      ],
      customCss: ['./src/styles/starlight-brand.css'],
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Overview', slug: 'docs' },
            { label: 'Install', slug: 'docs/install' },
            { label: 'Quickstart', slug: 'docs/quickstart' },
          ],
        },
        {
          label: 'Core concepts',
          items: [
            { label: 'Agents', slug: 'docs/agents' },
            { label: 'Tools', slug: 'docs/tools' },
            { label: 'Models', slug: 'docs/models' },
          ],
        },
        {
          label: 'Durable execution',
          items: [{ label: 'Workflows & teams', slug: 'docs/workflows' }],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Adapters', slug: 'docs/adapters' },
            { label: 'Package subpaths', slug: 'docs/packages' },
            { label: 'Status & scope', slug: 'docs/status' },
          ],
        },
      ],
    }),
  ],

  vite: {
    plugins: [tailwindcss()],
  },
});
