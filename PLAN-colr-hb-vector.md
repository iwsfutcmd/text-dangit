# Plan: COLR (v0 + v1) color-font support via HarfBuzz `hb-vector`

Status: **not started** — investigation complete, implementation deferred to a future session.
Branch: `colr-hb-vector-support`.

## Goal

Make the app render **COLR v0 and v1** color fonts as appropriately colored/gradiented
**vector** SVG (real `<path>` + `<linearGradient>`/`<radialGradient>`, clip paths,
transforms), instead of the current monochrome-outline-only behavior.

## Why the app doesn't do this today

- The app shapes text with HarfBuzz (WASM, CDN-loaded) and extracts each glyph's outline
  via `font.glyphToJson(...)` → `index.html` `render()`. That uses only the
  `hb_draw_funcs_*` / outline path. The preview also force-fills paths black
  (`.svg-preview path { fill: #000 }`).
- COLR fonts store appearance as layered, colored sub-glyphs (v0) or a full paint graph
  with gradients/transforms/compositing (v1). The outline path never touches those tables,
  so COLR fonts render as nothing or a flat fallback.

## Key finding: it's a HarfBuzz build-config gap, not a missing feature

Verified facts (as of this investigation):

- The CDN build `harfbuzzjs@1.2.0` (`dist/harfbuzz.wasm`) embeds **HarfBuzz 14.2.0**.
  Its export table has **113 functions, none paint/COLR** — confirmed via
  `WebAssembly.Module.exports`. No `hb_font_paint_glyph`, no `hb_paint_funcs_*`,
  no `hb_ot_color_*`, no vector/SVG entry points. The strings `paint`/`colr`/`cpal`
  don't even appear in the binary.
- HarfBuzz **13.0.0+** added a public **`hb-vector`** API whose only output format is
  **SVG**, supporting **COLR v0, v1, and OT-SVG** as true vector output (gradients,
  compositing, transforms). 14.2.0 has it. Source files exist in the HarfBuzz tree:
  `src/hb-vector.{cc,h,hh}`, `src/hb-vector-paint-svg.cc`, `src/hb-vector-paint.{cc,hh}`,
  `src/hb-paint.*`, `src/hb-ot-color.*`.
- The reason it's stripped: harfbuzzjs's `Makefile` compiles with **`-DHB_TINY`**.
  In HarfBuzz `src/hb-config.hh`, `HB_TINY` → `HB_LEAN` + `HB_MINI`;
  `HB_LEAN` defines `HB_NO_COLOR` (line ~85) **and** `HB_NO_PAINT` (~87);
  `HB_MINI` also defines `HB_NO_PAINT` (~141). So color + paint are compiled out.
- harfbuzzjs's `config-override.h` selectively `#undef`s features it wants back
  (`HB_NO_CFF`, `HB_NO_DRAW`, `HB_NO_VAR`, `HB_NO_NAME`, …) but **does not** re-enable
  color or paint.
- harfbuzzjs already sets `-DHB_EXPERIMENTAL_API` (hb-vector lives behind it),
  and links with `ALLOW_TABLE_GROWTH` + exports `addFunction` (so JS-side paint
  callbacks are possible if ever needed). Exports are gated by an allowlist file
  `harfbuzz.symbols` (`-s EXPORTED_FUNCTIONS=@harfbuzz.symbols`).

Conclusion: **a fresh WASM build is required, but it's a config change in a harfbuzzjs
fork — not a HarfBuzz source patch.**

## Alternatives considered (and why hb-vector won)

- **BlackRenderer** (Python, fonttools+HarfBuzz): verified to emit real vector SVG with
  gradients, incl. variable COLRv1. Best CLI/server option, but Python → only browser-usable
  via Pyodide (heavy). Rejected for a client-side, self-contained app.
- **fontkit / opentype.js** (JS, browser-native): **COLRv0 only**, no gradients/v1.
  Possible fallback if we ever want a no-WASM-rebuild v0-only path.
- **resvg/usvg**: doesn't render COLRv1; outputs PNG. No.
- **FreeType / Skia `SkSVGCanvas`**: building blocks, no turnkey COLRv1→vector-SVG;
  no supported way to capture Chrome's COLRv1 render as SVG vectors. No.
- **dokutan/OpenType-COLRv1-to-SVG**: just wraps BlackRenderer.

hb-vector wins because it's the **same engine the app already loads**, keeps everything
client-side, and returns SVG directly (likely simplifying `render()` even for the
monochrome case).

## Universal caveat (applies to ALL tools, incl. hb-vector)

SVG 1.1 has **no native sweep/conic gradient**, and several COLRv1 composite/blend modes
have no clean SVG analog. So sweep-gradient glyphs and exotic blends won't round-trip
losslessly with any tool — they'll be approximated or dropped. **Test with a
sweep-gradient glyph** from https://github.com/googlefonts/color-fonts before promising
fidelity.

## Implementation steps (deferred)

1. **Fork harfbuzzjs.** Repo: https://github.com/harfbuzz/harfbuzzjs
   Build files of interest: `Makefile`, `config-override.h`, `harfbuzz.symbols`,
   `src/font-funcs.ts`, the `index.mjs` wrapper.
2. **Re-enable color + paint** in `config-override.h`:
   add `#undef HB_NO_COLOR` and `#undef HB_NO_PAINT` (mirrors how DRAW/CFF/VAR are
   already re-enabled).
3. **Export the symbols** in `harfbuzz.symbols`: the `hb-vector` SVG emitter entry
   point(s), plus any `hb_ot_color_*` / `hb_color_*` helpers needed. Unlisted symbols
   stay invisible even if compiled in.
4. **OPEN ITEM — verify before estimating:** does the amalgamated `harfbuzz/src/harfbuzz.cc`
   (the only file in `HARFBUZZ_SRCS`) already `#include` `hb-vector-paint-svg.cc` /
   `hb-vector-paint.cc`? If not, add those `.cc` files to the compile line. This is the
   single biggest unknown for effort sizing. Check `src/harfbuzz.cc` includes in the
   14.2.0 tree.
5. **Confirm the exact `hb-vector` entry-point signature** (how you ask it to render a
   shaped buffer / a string+font to an SVG string, and how the result is returned —
   into a `hb_blob_t` / caller buffer). See `util/hb-vector.cc` and `util/hb-vector-svg-all.c`
   for canonical usage; mirror that from JS.
6. **Build** with the existing Emscripten toolchain (`em++`, `make harfbuzz`).
   Prereq: emsdk — use a Dockerized emsdk for reproducibility. Produces a new
   `harfbuzz.wasm` + `harfbuzz.js` + `index.mjs` (larger than the 400KB tiny build).
7. **Host the artifact.** The app is CDN-loaded + self-contained `index.html`. Options:
   publish the fork to npm and load from jsDelivr (cleanest, matches current pattern),
   or vendor the `.wasm`/`.js` into the repo / GitHub Pages deploy. Decide based on size.
8. **Wire up the app** (`index.html`):
   - Add a JS wrapper for the vector→SVG call, pulling the SVG string out of WASM memory.
   - In `render()`: prefer the vector/color path; the emitter likely returns ready SVG
     so much of the hand-rolled outline + bbox math can be replaced.
   - **Remove the forced black fill** (`.svg-preview path { fill: #000 }`) so color shows.
     Keep a monochrome mode? Consider a toggle (see product note).
   - Preserve current Google-Fonts loading + WOFF1 decode paths.
9. **Test matrix:** monochrome TTF/OTF (no regression), COLRv0 font, COLRv1 with
   linear + radial gradients, COLRv1 with a **sweep gradient** (expect approximation),
   variable COLRv1. Use googlefonts/color-fonts test fonts.

## Product note to resolve during implementation

This tool currently exists to produce **clean monochrome outline SVG** (force-black fill —
good for cutting/single-color use). Colored COLR output changes what the tool *is*.
Decide: a mode toggle (monochrome outlines vs. color), auto-detect COLR and switch, or
two separate outputs. Don't silently turn every font multicolor.

## Quick repro commands used in investigation (for reference)

```sh
# exports of the current CDN wasm
curl -sL https://cdn.jsdelivr.net/npm/harfbuzzjs@1.2.0/dist/harfbuzz.wasm -o /tmp/hb.wasm
node -e 'const m=new WebAssembly.Module(require("fs").readFileSync("/tmp/hb.wasm"));
  console.log(WebAssembly.Module.exports(m).map(e=>e.name).join("\n"))'
# embedded HB version: strings /tmp/hb.wasm | grep -E "^[0-9]+\.[0-9]+\.[0-9]+$"  -> 14.2.0
```
