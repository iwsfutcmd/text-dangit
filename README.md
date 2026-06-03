# text, dang it

A tiny font → SVG playground. Drop in a font (or load one from Google Fonts), type some
text, and get clean SVG outlines — shaped by [HarfBuzz](https://harfbuzz.github.io/).

The whole app is a **single, self-contained `index.html`**: HTML, CSS, and a vanilla
`<script type="module">`. No build step, no dependencies to install, no `node_modules`.
[HarfBuzz](https://www.npmjs.com/package/harfbuzzjs) is loaded at runtime from a CDN.

## Run it

It must be served over **http(s)** — opening `index.html` directly from disk (`file://`)
does **not** work, because browsers block loading ES modules from a `file://` (null) origin.

Any static server works, e.g.:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

or `npx serve`, etc.

> Note: it needs a network connection. HarfBuzz, the Material Symbols icons, and the
> Google Fonts loader all fetch from the network at runtime.

## Edit it

Open `index.html` and edit. That's the whole app — markup, styles, and logic are all in
that one file. Reload the served page to see changes.

## Deploy

Pushing to `main` publishes `index.html` to GitHub Pages via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) — no build, it just uploads
the file.

## License

[MIT](LICENSE)
