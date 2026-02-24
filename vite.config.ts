import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit(),
		{
			name: 'hb-esm-export',
			transform(code: string, id: string) {
				if (id.endsWith('/hb.js') && code.includes('createHarfBuzz')) {
					return code + '\nexport default createHarfBuzz;';
				}
				if (id.endsWith('/hbjs.js') && code.includes('function hbjs')) {
					return code + '\nexport default hbjs;';
				}
			}
		}
	]
});
