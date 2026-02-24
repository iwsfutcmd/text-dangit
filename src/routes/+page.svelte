<script lang="ts">
	import createHarfBuzz from '$lib/hb';
	import hbjs from '$lib/hbjs';
	import { base } from '$app/paths';
	let hb: any;
	import { onMount } from 'svelte';
	// let selectedFont = 'Noto Naskh Arabic';
	// const fonts: { [key: string]: string } = {
	// 	'Noto Nastaliq Urdu':
	// 		'https://raw.githack.com/google/fonts/main/ofl/notonastaliqurdu/NotoNastaliqUrdu[wght].ttf',
	// 	'Noto Naskh Arabic':
	// 		'https://raw.githack.com/google/fonts/main/ofl/notonaskharabic/NotoNaskhArabic[wght].ttf',
	// 	'Noto Sans Arabic':
	// 		'https://raw.githack.com/google/fonts/main/ofl/notosansarabic/NotoSansArabic[wdth,wght].ttf',
	// 	'Noto Sans': 'https://raw.githack.com/google/fonts/main/ofl/notosans/NotoSans[wdth,wght].ttf',
	// 	'Noto Sans Armenian':
	// 		'https://raw.githack.com/google/fonts/main/ofl/notosansarmenian/NotoSansArmenian[wdth,wght].ttf',
	// 	'Noto Serif Armenian':
	// 		'https://raw.githack.com/google/fonts/main/ofl/notoserifarmenian/NotoSerifArmenian[wdth,wght].ttf',
	// 	'Noto Sans Georgian':
	// 		'https://raw.githack.com/google/fonts/main/ofl/notosansgeorgian/NotoSansGeorgian[wdth,wght].ttf',
	// 	'Noto Serif Georgian':
	// 		'https://raw.githack.com/google/fonts/main/ofl/notoserifgeorgian/NotoSerifGeorgian[wdth,wght].ttf'
	// };
	// let fontCache: { [key: string]: any } = {};
	let text = '';
	// let hb: any;
	let paths: { path: string; cl: number }[] = [];
	const defaultBbox = '0 0 128 128';
	let bbox = defaultBbox;
	// let glyphCache: { [key: string]: { [key: number]: any } } = {};
	let svgSize = 256;
	let svgElement: SVGElement;
	// const loadFont = async (fontName: string) => {
	// 	const fontBlob = new Uint8Array(await (await fetch(fonts[fontName])).arrayBuffer());
	// 	const blob = hb.createBlob(fontBlob);
	// 	const face = hb.createFace(blob, 0);
	// 	fontCache[fontName] = hb.createFont(face);
	// 	glyphCache[fontName] = {};
	// };

	let fileName = '';
	let font: any;
	let glyphs = {};
	let googleFontsInput = '';
	let googleFontsError = '';
	let googleFontsLoading = false;

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
				for (const c of chunks) { out.set(c, pos); pos += c.length; }
				return out;
			})
		);

		// Build offset table header values
		let maxPow = 1, log2 = 0;
		while (maxPow * 2 <= numTables) { maxPow *= 2; log2++; }

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
		tv.setUint16(6, maxPow * 16);        // searchRange
		tv.setUint16(8, log2);               // entrySelector
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
		const blob = hb.createBlob(fontData);
		const face = hb.createFace(blob, 0);
		font = hb.createFont(face);
		glyphs = {};
		fileName = name;
	};

	// Handles the file drop
	const handleDrop = (event) => {
		event.preventDefault();
		const file = [...event.dataTransfer.files][0];
		const reader = new FileReader();
		reader.onload = (e) => loadFontData(new Uint8Array(e.target.result), file.name);
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
			console.log('Google Fonts CSS:', css.slice(0, 500));

			const entries = parseFontFaceEntries(css);
			if (!entries.length) throw new Error('No font URL found in CSS response');
			const entry = bestEntryForText(entries, text);

			console.log('Font URL:', entry.url);
			const fontData = new Uint8Array(await (await fetch(entry.url)).arrayBuffer());
			console.log('Font data size:', fontData.length, 'bytes, first bytes:', fontData.slice(0, 4));

			const magic = new DataView(fontData.buffer).getUint32(0);
			const ttfData = magic === WOFF_MAGIC ? await decodeWoff1(fontData) : fontData;

			const familyMatch = input.match(/family=([^&:]+)/);
			const name = familyMatch ? decodeURIComponent(familyMatch[1].replace(/\+/g, ' ')) : 'Google Font';
			loadFontData(ttfData, name);
		} catch (e) {
			googleFontsError = e.message;
			console.error('Google Fonts load error:', e);
		} finally {
			googleFontsLoading = false;
		}
	};

	const downloadSVG = () => {
		const blob = new Blob([svgElement.outerHTML], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);

		const link = document.createElement('a');
		link.href = url;
		link.download = 'output.svg';
		link.click();

		URL.revokeObjectURL(url); // Clean up the object URL
	};

	onMount(async () => {
		const module = await createHarfBuzz({ locateFile: (path: string) => `${base}/${path}` });
		hb = hbjs(module);
		// Object.keys(fonts).forEach(async (fontName) => await loadFont(fontName));
	});

	$: {
		if (hb && text && font) {
			text = text.normalize('NFD');
			// const font = fontCache[selectedFont];
			const buffer = hb.createBuffer();
			buffer.addText(text);
			buffer.guessSegmentProperties();
			hb.shape(font, buffer);
			const result = buffer.json(font);
			result.forEach((x) => {
				// if (glyphCache[selectedFont][x.g]) return;
				// glyphCache[selectedFont][x.g] = font.glyphToJson(x.g);
				if (glyphs[x.g]) return;
				glyphs[x.g] = font.glyphToJson(x.g);
			});
			buffer.destroy();
			let xmin = 10000;
			let xmax = -10000;
			let ymin = 10000;
			let ymax = -10000;
			let ax = 0;
			let ay = 0;
			paths = result
				.map((ginfo) => {
					// let path = glyphCache[selectedFont][ginfo.g]
					let path = glyphs[ginfo.g]
						.filter((command) => {
							return command.type !== 'Z';
						})
						.map((command) => {
							let result = command.values
								.map((p, i) => {
									// apply ax/ay/dx/dy to coords
									return i % 2 ? -(p + ay + ginfo.dy) : p + ax + ginfo.dx;
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
							return [command.type].concat(result);
						});
					ax += ginfo.ax;
					ay += ginfo.ay;
					return { path, cl: ginfo.cl };
				})
				.map(({ path, cl }) => ({
					path: path
						.map((y) => {
							return y[0] + y.slice(1).join(' ');
						})
						.join('')
						.replace(/ -/g, '-'),
					cl
				}));

			let width = xmax - xmin;
			let height = ymax - ymin;
			// pad it a bit
			let pad = Math.round(Math.min(width / 10, height / 10));
			xmin -= pad;
			ymin -= pad;
			width += pad * 2;
			height += pad * 2;

			bbox = xmin + ' ' + ymin + ' ' + width + ' ' + height;
		} else {
			paths = [];
			bbox = defaultBbox;
		}
	}
</script>

<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
<div class="dropzone" on:dragover|preventDefault on:drop={handleDrop}>
	<span class="material-symbols-outlined">upload_file</span>
</div>
<label>Google Fonts: <input
	type="text"
	placeholder="Paste a Google Fonts URL or &lt;link&gt; tag"
	bind:value={googleFontsInput}
	on:keydown={(e) => e.key === 'Enter' && loadFromGoogleFonts()}
/><button on:click={loadFromGoogleFonts} disabled={googleFontsLoading}>
	<span class="material-symbols-outlined">{googleFontsLoading ? 'hourglass_empty' : 'download'}</span>
</button></label>
{#if googleFontsError}<div class="error">{googleFontsError}</div>{/if}
<div>{fileName}</div>
<!-- <label>svg size:<input type="number" bind:value={svgSize} /></label> -->
<button on:click={downloadSVG}><span class="material-symbols-outlined">download</span></button>
<!-- <select bind:value={selectedFont}>
	{#each Object.keys(fonts) as font}
		<option>{font}</option>
	{/each}
</select> -->
<label>text: <textarea dir="auto" bind:value={text} /></label>
<div>
	<svg class="svg-preview" viewBox={bbox} xmlns="http://www.w3.org/2000/svg" bind:this={svgElement}>
		{#each paths as path}
			<path d={path.path} />
		{/each}
	</svg>
</div>

<!-- height={svgSize}  -->
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
