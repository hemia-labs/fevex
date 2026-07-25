import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://fevex.dev',
  i18n: {
    locales: ['en', 'es'],
    defaultLocale: 'en',
  },

  vite: {
    plugins: [tailwindcss()],
  },
});
