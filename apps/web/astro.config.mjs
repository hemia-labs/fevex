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
      components: {
        ThemeProvider: './src/components/DocsThemeProvider.astro',
      },
      expressiveCode: {
        styleOverrides: {
          borderRadius: '0.5rem',
          borderColor: 'var(--sl-color-hairline-light)',
          codeFontFamily: 'var(--brand-font-mono)',
          codeFontSize: '0.8125rem',
          codeLineHeight: '1.7',
        },
      },
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Overview', slug: 'docs' },
            { label: 'Install', slug: 'docs/install' },
            { label: 'Quickstart', slug: 'docs/quickstart' },
            { label: 'Templates & debugging', slug: 'docs/development' },
            { label: 'Local Studio', slug: 'docs/studio' },
          ],
        },
        {
          label: 'Core concepts',
          items: [
            { label: 'Agents', slug: 'docs/agents' },
            { label: 'Tools', slug: 'docs/tools' },
            { label: 'Models', slug: 'docs/models' },
            { label: 'Knowledge & skills', slug: 'docs/knowledge' },
          ],
        },
        {
          label: 'Durable execution',
          items: [
            { label: 'Workflows & teams', slug: 'docs/workflows' },
            { label: 'Evaluations & release gates', slug: 'docs/evals' },
            { label: 'Operations & soak tests', slug: 'docs/operations' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Adapters', slug: 'docs/adapters' },
            { label: 'Channels & resolvers', slug: 'docs/channels' },
            { label: 'Slack', slug: 'docs/slack' },
            { label: 'Package subpaths', slug: 'docs/packages' },
            { label: 'Status & scope', slug: 'docs/status' },
            { label: 'Compatibility & releases', slug: 'docs/compatibility' },
          ],
        },
      ],
    }),
  ],

  vite: {
    plugins: [tailwindcss()],
  },
});
