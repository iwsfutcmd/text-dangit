<script lang="ts">
	import { onMount } from 'svelte';
	import type * as HB from 'harfbuzzjs';

	let hb = $state<typeof HB>();

	let text = $state('');
	let paths = $state<{ path: string; cl: number }[]>([]);
	const defaultBbox = '0 0 128 128';
	let bbox = $state(defaultBbox);
	let svgElement = $state<SVGElement>();

	let fileName = $state('');
	let font = $state<HB.Font>();
	let glyphCache: Record<number, HB.SvgPathCommand[]> = {};
	let googleFontsInput = $state('');
	let googleFontsError = $state('');
	let googleFontsLoading = $state(false);

	const WOFF_MAGIC = 0x774f4646; // 'wOFF'

	function parseFontFaceEntries(css: string) {
		return [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].flatMap((m) => {
			const urlMatch = m[1].match(/url\(['"]?(https:\/\/fonts\.gstatic\.com[^'")]+)['"]?\)/);
			if (!urlMatch) return [];
			const rangeMatch = m[1].match(/unicode-range:\s*([^;]+)/);
			const unicodeRange = rangeMatch
				? rangeMatch[1]
						.trim()
						.split(',')
						.map((r) => {
							r = r.trim().replace('U+', '');
							if (r.includes('-')) {
								const [a, b] = r.split('-');
								return [parseInt(a, 16), parseInt(b, 16)] as [number, number];
							}
							const v = parseInt(r, 16);
							return [v, v] as [number, number];
						})
				: null;
			return [{ url: urlMatch[1], unicodeRange }];
		});
	}

	function bestEntryForText(entries: ReturnType<typeof parseFontFaceEntries>, text: string) {
		// Score each entry by how many characters in the text fall within its unicode-range
		let best = entries[entries.length - 1]; // default: last entry (latin)
		let bestScore = -1;
		for (const entry of entries) {
			if (!entry.unicodeRange) continue;
			let score = 0;
			for (const char of text) {
				const cp = char.codePointAt(0)!;
				if (entry.unicodeRange.some(([a, b]) => cp >= a && cp <= b)) score++;
			}
			if (score > bestScore) {
				bestScore = score;
				best = entry;
			}
		}
		return best;
	}

	async function decodeWoff1(woff: Uint8Array): Promise<Uint8Array> {
		const v = new DataView(woff.buffer, woff.byteOffset);
		const flavor = v.getUint32(4);
		const numTables = v.getUint16(12);

		// Parse table directory (starts at byte 44, 20 bytes per entry)
		const tables = Array.from({ length: numTables }, (_, i) => {
			const b = 44 + i * 20;
			return {
				tag: v.getUint32(b),
				offset: v.getUint32(b + 4),
				compLen: v.getUint32(b + 8),
				origLen: v.getUint32(b + 12),
				checksum: v.getUint32(b + 16)
			};
		});

		// Decompress each table (WOFF1 uses zlib/RFC 1950)
		const decompressed = await Promise.all(
			tables.map(async (t) => {
				if (t.compLen === t.origLen) return woff.slice(t.offset, t.offset + t.origLen);
				const ds = new DecompressionStream('deflate');
				const writer = ds.writable.getWriter();
				writer.write(woff.slice(t.offset, t.offset + t.compLen));
				writer.close();
				const chunks: Uint8Array[] = [];
				const reader = ds.readable.getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					chunks.push(value);
				}
				const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
				let pos = 0;
				for (const c of chunks) {
					out.set(c, pos);
					pos += c.length;
				}
				return out;
			})
		);

		// Build offset table header values
		let maxPow = 1,
			log2 = 0;
		while (maxPow * 2 <= numTables) {
			maxPow *= 2;
			log2++;
		}

		// Calculate output offsets (tables are 4-byte aligned)
		let dataStart = 12 + numTables * 16;
		const outOffsets = decompressed.map((d) => {
			const off = dataStart;
			dataStart += (d.length + 3) & ~3;
			return off;
		});

		// Write TTF
		const ttf = new Uint8Array(dataStart);
		const tv = new DataView(ttf.buffer);
		tv.setUint32(0, flavor);
		tv.setUint16(4, numTables);
		tv.setUint16(6, maxPow * 16); // searchRange
		tv.setUint16(8, log2); // entrySelector
		tv.setUint16(10, numTables * 16 - maxPow * 16); // rangeShift
		tables.forEach((t, i) => {
			const b = 12 + i * 16;
			tv.setUint32(b, t.tag);
			tv.setUint32(b + 4, t.checksum);
			tv.setUint32(b + 8, outOffsets[i]);
			tv.setUint32(b + 12, decompressed[i].length);
			ttf.set(decompressed[i], outOffsets[i]);
		});
		return ttf;
	}

	const loadFontData = (fontData: Uint8Array, name: string) => {
		if (!hb) return;
		const blob = new hb.Blob(fontData.buffer as ArrayBuffer);
		const face = new hb.Face(blob, 0);
		font = new hb.Font(face);
		glyphCache = {};
		fileName = name;
	};

	// Handles the file drop
	const handleDrop = (event: DragEvent) => {
		event.preventDefault();
		const file = [...(event.dataTransfer?.files ?? [])][0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = (e) => loadFontData(new Uint8Array(e.target!.result as ArrayBuffer), file.name);
		reader.readAsArrayBuffer(file);
	};

	const loadFromGoogleFonts = async () => {
		googleFontsError = '';
		googleFontsLoading = true;
		try {
			let input = googleFontsInput.trim();

			// Extract href from a pasted <link> tag
			const linkMatch = input.match(/href="([^"]+)"/);
			if (linkMatch) input = linkMatch[1].replace(/&amp;/g, '&');

			// Convert specimen page URL to CSS API URL
			if (input.includes('fonts.google.com/specimen/')) {
				const fontName = input.split('/specimen/')[1].split('?')[0];
				input = `https://fonts.googleapis.com/css2?family=${fontName}`;
			}

			if (!input.startsWith('https://fonts.googleapis.com/')) {
				throw new Error('Not a recognized Google Fonts URL');
			}

			const css = await (await fetch(input)).text();

			const entries = parseFontFaceEntries(css);
			if (!entries.length) throw new Error('No font URL found in CSS response');
			const entry = bestEntryForText(entries, text);

			const fontData = new Uint8Array(await (await fetch(entry.url)).arrayBuffer());

			const magic = new DataView(fontData.buffer).getUint32(0);
			const ttfData = magic === WOFF_MAGIC ? await decodeWoff1(fontData) : fontData;

			const familyMatch = input.match(/family=([^&:]+)/);
			const name = familyMatch
				? decodeURIComponent(familyMatch[1].replace(/\+/g, ' '))
				: 'Google Font';
			loadFontData(ttfData, name);
		} catch (e) {
			googleFontsError = e instanceof Error ? e.message : String(e);
			console.error('Google Fonts load error:', e);
		} finally {
			googleFontsLoading = false;
		}
	};

	const downloadSVG = () => {
		if (!svgElement) return;
		const blob = new Blob([svgElement.outerHTML], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);

		const link = document.createElement('a');
		link.href = url;
		link.download = 'output.svg';
		link.click();

		URL.revokeObjectURL(url); // Clean up the object URL
	};

	// HarfBuzz is loaded at runtime from a CDN rather than bundled. The package
	// locates its WASM via `new URL('harfbuzz.wasm', import.meta.url)`, so serving
	// the ESM module from a raw-file CDN (jsDelivr) lets the browser fetch the
	// .wasm alongside it. `harfbuzzjs` stays a devDependency for its types only.
	const HB_CDN = 'https://cdn.jsdelivr.net/npm/harfbuzzjs@1.2.0/dist/index.mjs';

	onMount(async () => {
		hb = (await import(/* @vite-ignore */ HB_CDN)) as typeof HB;
	});

	$effect(() => {
		if (!(hb && text && font)) {
			paths = [];
			bbox = defaultBbox;
			return;
		}

		const normalized = text.normalize('NFD');
		const buffer = new hb.Buffer();
		buffer.addText(normalized);
		buffer.guessSegmentProperties();
		hb.shape(font, buffer);
		const result = buffer.getGlyphInfosAndPositions();
		result.forEach((x) => {
			if (glyphCache[x.codepoint]) return;
			glyphCache[x.codepoint] = font!.glyphToJson(x.codepoint);
		});

		let xmin = 10000;
		let xmax = -10000;
		let ymin = 10000;
		let ymax = -10000;
		let ax = 0;
		let ay = 0;
		const nextPaths = result
			.map((ginfo) => {
				const path = glyphCache[ginfo.codepoint]
					.filter((command) => command.type !== 'Z')
					.map((command) => {
						const coords = command.values
							.map((p, i) => {
								// apply ax/ay/dx/dy to coords
								return i % 2 ? -(p + ay + (ginfo.yOffset ?? 0)) : p + ax + (ginfo.xOffset ?? 0);
							})
							.map((x, i) => {
								// bbox calc
								if (i % 2) {
									if (x < ymin) ymin = x;
									if (x > ymax) ymax = x;
								} else {
									if (x < xmin) xmin = x;
									if (x > xmax) xmax = x;
								}
								return x;
							});
						return [command.type, ...coords];
					});
				ax += ginfo.xAdvance ?? 0;
				ay += ginfo.yAdvance ?? 0;
				return { path, cl: ginfo.cluster };
			})
			.map(({ path, cl }) => ({
				path: path
					.map((y) => y[0] + y.slice(1).join(' '))
					.join('')
					.replace(/ -/g, '-'),
				cl
			}));

		let width = xmax - xmin;
		let height = ymax - ymin;
		// pad it a bit
		const pad = Math.round(Math.min(width / 10, height / 10));
		xmin -= pad;
		ymin -= pad;
		width += pad * 2;
		height += pad * 2;

		paths = nextPaths;
		bbox = xmin + ' ' + ymin + ' ' + width + ' ' + height;
	});
</script>

<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
<div
	class="dropzone"
	ondragover={(e) => e.preventDefault()}
	ondrop={handleDrop}
	role="button"
	tabindex="0"
>
	<span class="material-symbols-outlined">upload_file</span>
</div>
<label
	>Google Fonts: <input
		type="text"
		placeholder="Paste a Google Fonts URL or &lt;link&gt; tag"
		bind:value={googleFontsInput}
		onkeydown={(e) => e.key === 'Enter' && loadFromGoogleFonts()}
	/><button onclick={loadFromGoogleFonts} disabled={googleFontsLoading}>
		<span class="material-symbols-outlined"
			>{googleFontsLoading ? 'hourglass_empty' : 'download'}</span
		>
	</button></label
>
{#if googleFontsError}<div class="error">{googleFontsError}</div>{/if}
<div>{fileName}</div>
<button onclick={downloadSVG}><span class="material-symbols-outlined">download</span></button>
<label>text: <textarea dir="auto" bind:value={text}></textarea></label>
<div>
	<svg class="svg-preview" viewBox={bbox} xmlns="http://www.w3.org/2000/svg" bind:this={svgElement}>
		{#each paths as path, i (i)}
			<path d={path.path} />
		{/each}
	</svg>
</div>

<style>
	.svg-preview {
		inline-size: 100vw;
	}
	.error {
		color: red;
	}
	.material-symbols-outlined {
		font-variation-settings:
			'FILL' 0,
			'wght' 400,
			'GRAD' 0,
			'opsz' 24;
	}
</style>
