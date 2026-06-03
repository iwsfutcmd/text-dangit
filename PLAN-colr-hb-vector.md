# Plan: COLR (v0 + v1) color-font support via HarfBuzz `hb-vector`

Status: **not started** — investigation complete (incl. the build open-item), implementation deferred to a future session.
Branch: `colr-hb-vector-support`.

> **Session 2 update:** the step-4 open item and the step-5 API are now resolved.
> See "## RESOLVED: exact build delta + API" near the bottom — start there.

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
4. **[RESOLVED]** The amalgam does NOT include `hb-vector*.cc`; add them to `HARFBUZZ_SRCS`.
   See "## RESOLVED: exact build delta + API" for the exact file list.
5. **[RESOLVED]** Entry point is `hb_vector_paint_*` → `hb_vector_paint_render()` returns an
   `hb_blob_t*` of SVG bytes (per glyph). Full flow + gotchas in the RESOLVED section.
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

## RESOLVED: exact build delta + API (verified against HarfBuzz tag 14.2.0)

### Build delta (resolves open item from step 4)

Verified facts at tag `14.2.0`:
- The amalgam `src/harfbuzz.cc` **does** include `hb-ot-color.cc`, `hb-paint.cc`,
  `hb-paint-bounded.cc`, `hb-paint-extents.cc`. So enabling color/paint is purely the
  two `#undef`s below — those units are already compiled.
- The amalgam **does NOT** include any `hb-vector*.cc`. And `hb-vector.cc` is **not**
  itself a mini-amalgam (it includes only `hb-vector-buf.hh`). Each vector `.cc` is an
  independent translation unit that includes only `.hh` headers.
- No `HB_NO_VECTOR`-style guard exists on the vector files — they compile unconditionally
  once their deps (paint, ot-color) are enabled.

So the harfbuzzjs-fork build changes are exactly:

1. `config-override.h` — add:
   ```c
   #undef HB_NO_COLOR
   #undef HB_NO_PAINT
   ```
2. `Makefile` — add the vector TUs to `HARFBUZZ_SRCS` (they are NOT in the amalgam):
   ```
   harfbuzz/src/hb-vector.cc
   harfbuzz/src/hb-vector-path.cc
   harfbuzz/src/hb-vector-paint.cc
   harfbuzz/src/hb-vector-paint-svg.cc
   harfbuzz/src/hb-vector-draw.cc      # optional: monochrome vector path; can replace hand-rolled outline+bbox
   ```
   (Do NOT add `hb-vector-paint-pdf.cc` — PDF output, not needed.)
3. `harfbuzz.symbols` — add the exported entry points (emscripten wants `_`-prefixed):
   ```
   _hb_vector_paint_create_or_fail
   _hb_vector_paint_destroy
   _hb_vector_paint_set_palette
   _hb_vector_paint_set_foreground
   _hb_vector_paint_set_transform
   _hb_vector_paint_set_svg_prefix
   _hb_vector_paint_glyph_or_fail
   _hb_vector_paint_render
   _hb_vector_paint_recycle_blob
   ```
   Plus confirm `hb_blob_get_data` / `hb_blob_get_length` / `hb_blob_destroy` are exported
   (the existing `Blob` wrapper likely already pulls these in — verify).
   The linker keeps transitive deps, so listing the public entry points is enough.
4. Rebuild: `make harfbuzz` (Emscripten `em++`, already configured).

`-DHB_EXPERIMENTAL_API` is already set — fine, but note hb-vector's public symbols are
NOT experimental-gated in the header (no `#ifdef HB_EXPERIMENTAL_API` around them), so
that flag isn't strictly required for these.

### Color API (resolves step 5) — `hb_vector_paint_t`, format `HB_VECTOR_FORMAT_SVG`

Two contexts exist: `hb_vector_draw_t` (monochrome outline → SVG) and `hb_vector_paint_t`
(**color, COLR v0/v1 → SVG**). We want the paint one. `hb_vector_paint_render()` returns
an `hb_blob_t*` containing the SVG bytes. Canonical per-glyph flow (from
`util/hb-vector-svg-all.c`):

```c
hb_vector_paint_t *p = hb_vector_paint_create_or_fail(HB_VECTOR_FORMAT_SVG);
hb_vector_paint_set_palette(p, 0);
hb_vector_paint_set_foreground(p, HB_COLOR(0,0,0,255));  // fallback color for "foreground" paints
hb_vector_paint_set_transform(p, 1,0,0,1, penX,penY);     // position this glyph
if (hb_vector_paint_glyph_or_fail(p, font, gid, extents_mode)) {
    hb_blob_t *blob = hb_vector_paint_render(p);          // -> SVG bytes for this glyph
    // hb_blob_get_data(blob, &len) -> read out of WASM heap
    hb_vector_paint_recycle_blob(p, blob);
}
hb_vector_paint_destroy(p);
```

### Wiring notes / gotchas for the app side

- **Per-glyph SVG, not whole-run.** `hb_vector_paint_glyph` renders ONE glyph id. The app
  already shapes the buffer and computes pen advances/offsets in `render()`; reuse that to
  position each glyph, then combine. Either set the per-glyph transform via
  `hb_vector_paint_set_transform` (pen position) and merge the fragments, or wrap each
  fragment in a translated `<g>`.
- **ID collisions when merging.** Each glyph's SVG defines its own gradient/clip ids
  (`#g0`, `#c1`, …). Merging multiple glyph SVGs into one document WILL collide. Use
  `hb_vector_paint_set_svg_prefix(p, "g<i>_")` per glyph to namespace ids — this is exactly
  what that API is for. Don't skip it.
- **Drop the forced black fill** (`.svg-preview path { fill: #000 }`) so palette colors show
  — but only in color mode (see product note).
- `hb_vector_paint_glyph_or_fail` returning false = glyph has no color data; fall back to
  the monochrome `hb_vector_draw_*` path (or current outline path) for that glyph.
- Input gid is a SHAPED glyph id, not a codepoint — feed `result[i].codepoint` from the
  shaping buffer (HarfBuzz reuses `.codepoint` to mean glyph id post-shaping, as the
  current code already does with `glyphToJson`).

### Quick repro commands used in investigation (for reference)

```sh
# exports of the current CDN wasm
curl -sL https://cdn.jsdelivr.net/npm/harfbuzzjs@1.2.0/dist/harfbuzz.wasm -o /tmp/hb.wasm
node -e 'const m=new WebAssembly.Module(require("fs").readFileSync("/tmp/hb.wasm"));
  console.log(WebAssembly.Module.exports(m).map(e=>e.name).join("\n"))'
# embedded HB version: strings /tmp/hb.wasm | grep -E "^[0-9]+\.[0-9]+\.[0-9]+$"  -> 14.2.0
```
