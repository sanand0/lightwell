# Develop and test Lightwell

Load the repository folder as an unpacked extension. See the [installation guide](../README.md#install-lightwell). Use Chrome or Edge 157 for the browser checks.

```sh
npm ci
npm test
npm run test:browser
CHROME_BIN=/usr/bin/microsoft-edge npm run test:browser
LIGHTWELL_HEADED=1 xvfb-run -a npm run test:display
```

The browser tests use fresh profiles and fake webcams. The headed display test captures a browser tab. Set `LIGHTWELL_ARTIFACTS=artifacts` when running the browser suite to save test screenshots and clips locally.

Run `npm run dev` for the [development Studio](http://localhost:8765/studio.html?dev) and [local test call](http://localhost:8765/mock-call.html). In the development Studio, use `?no-html`, `?seg-fail` or `?delegate=gpu` before the preset hash to exercise renderer behaviour. Use **Load JSON** in Studio to try the [Glass Dashboard](../scenes/glass-dashboard.json) or [Portal](../scenes/portal.json) example.

## How scenes and sources work

- **Save** stores the layer settings and local files with the named scene. **Save JSON** exports the settings. When you use **Load JSON**, reattach any local files that the export could not embed.
- Older image and video layers open as Media, and older text layers open as Markdown. Imported scenes can still use the earlier generated backgrounds and built-in HTML templates.
- Media and HTML URLs need cross-origin access (CORS). HTML and SVG files use sanitised markup and a subset of inline styles. Use display capture for a running website. When native HTML drawing is unavailable, the preview shows a labelled placeholder.
- Studio camera and display captures run in the extension's background page. To release a source, use its **Stop** control or **Stop captures**. Reloading the extension or exiting the browser also releases these sources.
- **OS blur** uses the webcam effect when the browser exposes it. The Camera inspector shows when Lightwell uses segmented blur instead. Person cutout and segmented blur use a local model. [Chrome background blur API](https://developer.chrome.com/blog/background-blur)

## Experimental effects

[Effects](../effects.js) adds an optional `fx` object to any layer: `{ look, move, exit, amount, gone, at }`. The compositor first flattens the layer into its own bitmap. For HTML it calls `drawElementImage` on the stage canvas, copies the result, then paints over it. The effects work only in Canvas 2D, using strips, tiles, clipped shards, masks and additive copies. A look and a motion run together, and a running exit replaces the motion. Exits store `Date.now()` in `at`, so Studio and the call tabs play the same moment. Effects ignore layer clipping because shards and rays leave the layer box. The HTML tool still hit-tests the unbent element. Software rendering costs 20-45 ms a frame on a full 1280×720 camera layer.

## Source files

- [Studio](../studio.js) handles editing. [Scene](../scene.js) defines the format. [Compositor](../compositor.js) draws the result.
- [Publication](../publication.js) stores saved scenes and their local files.
- [Worker](../worker.js) registers scripts for approved websites. [Call](../call-main.js) supplies the composed track and [call media](../call-media.js) transfers source frames. [Captures](../captures.js) owns background captures.
- [Browser tests](../test/browser.js) and the [display test](../test/display.js) verify what reaches the receiving end of the local call.

[Spatial Mirror](https://github.com/SujalPradhan/spatial-mirror/tree/atp-mirror-world) informed the track and masking implementation. Lightwell bundles [MediaPipe Vision 0.10.32](https://github.com/google-ai-edge/mediapipe) and the landscape SelfieSegmenter float16 v1 model under [vendor/vision](../vendor/vision).
