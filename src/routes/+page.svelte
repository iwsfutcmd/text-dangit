<script lang="ts">
	import hbjs from '$lib/hbjs';
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
	let hb: any;
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
	// Handles the file drop
	const handleDrop = (event) => {
		event.preventDefault();
		const reader = new FileReader();
		reader.onload = (event) => {
			const fontBlob = new Uint8Array(event.target.result);
			const blob = hb.createBlob(fontBlob);
			const face = hb.createFace(blob, 0);
			font = hb.createFont(face);
			glyphs = {};
		};
		const file = [...event.dataTransfer.files][0];
		reader.readAsArrayBuffer(file);
		fileName = file.name;
	};

	// Prevents the browser’s default handling of the file on dragover
	const handleDragOver = (event) => {
		event.preventDefault();
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
		hb = hbjs((await WebAssembly.instantiateStreaming(fetch('./hb.wasm'))).instance);
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
	.material-symbols-outlined {
		font-variation-settings:
			'FILL' 0,
			'wght' 400,
			'GRAD' 0,
			'opsz' 24;
	}
</style>
