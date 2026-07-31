// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';
import mermaid from 'astro-mermaid'; //  AstroでMermaid図を表示させる設定

// https://astro.build/config
export default defineConfig({
	site: 'https://juehara-crypto.github.io',
    integrations: [
		    mdx(),
		    sitemap(),
		    mermaid(), //  AstroでMermaid図を表示させる設定
	],
	fonts: [
		{
			provider: fontProviders.local(),
			name: 'Atkinson',
			cssVariable: '--font-atkinson',
			fallbacks: ['sans-serif'],
			options: {
				variants: [
					{
						src: ['./src/assets/fonts/atkinson-regular.woff'],
						weight: 400,
						style: 'normal',
						display: 'swap',
					},
					{
						src: ['./src/assets/fonts/atkinson-bold.woff'],
						weight: 700,
						style: 'normal',
						display: 'swap',
					},
				],
			},
		},
	],
});
