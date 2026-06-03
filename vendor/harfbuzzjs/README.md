# Vendored harfbuzzjs (custom build with COLR color support)

These files are a **custom build of [harfbuzzjs](https://github.com/harfbuzz/harfbuzzjs)**
that enables HarfBuzz's `hb-vector` color paint API, so the app can render
**COLR v0/v1** color fonts (gradients, transforms, compositing) to vector SVG.

The stock npm/CDN build (`harfbuzzjs@1.2.0`) is compiled with `-DHB_TINY`, which
strips the color/paint/vector code, so a custom build is required.

## Files

- `index.mjs` — the JS wrapper (adds `Font.glyphsToSvg(glyphs, options)`)
- `harfbuzz.js` — Emscripten loader
- `harfbuzz.wasm` — the WASM module (HarfBuzz 14.2.1)

## How it was built

Against `harfbuzz/harfbuzzjs` with the `harfbuzz` submodule at **14.2.1**, using
**Emscripten 4.0.13** (matching harfbuzzjs CI), with these changes:

1. `config-override.h` — re-enable color/paint (stripped by `HB_TINY`):
   ```c
   #undef HB_NO_COLOR
   #undef HB_NO_PAINT
   ```
2. `Makefile` — add the hb-vector translation units (not in the `harfbuzz.cc`
   amalgam) to `HARFBUZZ_SRCS`:
   `hb-vector.cc hb-vector-path.cc hb-vector-draw.cc hb-vector-paint.cc
   hb-vector-paint-svg.cc hb-vector-paint-pdf.cc`
3. `harfbuzz.symbols` — export `_hb_vector_paint_*` entry points.
4. `src/font.ts` — add the `glyphsToSvg` method (uses `hb_vector_paint_*`).

Then:
```sh
make harfbuzz          # build the WASM
npx tsdown --no-dts    # bundle index.mjs (dts generation hangs; not needed)
```

The full design rationale lives in `PLAN-colr-hb-vector.md` at the repo root.
