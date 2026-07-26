import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
const blog = defineCollection({
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
			category: z.string().optional(),
			tags: z.array(z.string()).optional(),
			seriesId: z.string().optional(),
			seriesNo: z.number().optional(),
			prevPost: z.string().optional(),
			nextPost: z.string().optional(),
			relatedSeries: z.string().optional(),
		}),
});
export const collections = { blog };
