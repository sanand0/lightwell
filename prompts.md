# Prompts

## HTML in Canvas, 21 Nov 2026

<!--
cd ~/code/lightwell
claude --model opus --effort high
-->

See ~/code/research/html-in-canvas-techniques/
HTML in Canvas seems like a really cool technique!
What would be novel and fun to use in a Google Meet session? Can you build a control for that?
Remember: this should be a side experiment that doesn't distract from the main controls.
Elegance beats overbearing. But quantity can beat quality - so try different things.
Composability is good.
Use relevant skills and ideate.

---

I like the composable approach of Look x Motion x Exit. Exit may be less useful, but let it be. And if you can think of more composables types as well as elements within each, great!

A few points:

- I can see the results in the studio but not in the outgoing video. Fix that.
- Others may not be able to click, but I can, and since I have a pen / drawing mode, that makes more things possible. In fact, gesture controls (e.g. via MediaPipe) are a possibility. Explore and expand - make it fun.
- I have nothing against incorporating WebGL into lightwell if that works well. Test it out - and expand possibilities based on that.
- You suggested a few things - typing that ripples, camera showing through letters, etc. Feel free to factor that in.

Commit into a new branch as you go. Commit what you have so far (including prompts.md) and commit when you're done.

--- <!-- steering -->

I'd rather large downloads were optional and on-demand, e.g. if I'm on a slow network.

<!-- claude --resume 6659132a-22bb-440c-8af1-166127e327ae -->

## Polish, 20 Nov 2026

<!--
cd ~/code/lightwell
codex --model gpt-6.2-sol --config model_reasoning_effort=medium
-->

Add an icon to the extension.
Clean up unnecessary code.
Document - with screenshots - for a layman. Write very clearly and simply, like the UK Govt Comms / ASD-STE-100, for an audience that doesn't know our discussion and forgets what they said or heard.
Commit what's required, ignore what's not, and push.

<!-- codex resume 01a1f79e-c700-7db2-ad22-5e2944b44a58 -->

## Initial Experimentation, 20 Nov 2026

<!--
cd ~/code/camera-compositor
codex --model gpt-6.2-sol --config model_reasoning_effort=high
-->
<!-- Source: https://chatgpt.com/c/6afe8804-6160-83ec-8411-7e3e47edfd04 -->


```markdown
# Build an experimental browser-camera layering compositor

Build a standalone experimental Chrome/Edge Manifest V3 extension in `~/code/camera-compositor/`.

**Goal:** Turn my browser camera into a programmable visual stage with a background layer, a configurable webcam/person layer, and independent foreground layers. I want to draw over it, drag and resize my webcam, combine sources with transparency, use HTML-in-Canvas, and eventually deliver the resulting video to Google Meet, Microsoft Teams, Zoom Web, and other sites that use the browser camera.

This is an **exploration playground**, not a production application. Prioritize a working vertical slice, fast experimentation, imaginative visual possibilities, and easy debugging over architectural completeness.

No gesture controls are required.

## 1. Read before building

Inspect:

- `~/code/anand-chrome-tools/README.md`, `AGENTS.md`, manifest, and package configuration. Understand its conventions, but **do not modify that repository**.
- https://github.com/SujalPradhan/spatial-mirror/ — especially `extension/main-world.ts`, `tracker.ts`, `share.ts`, and `render.ts`. Learn from its camera interception, compositing, segmentation, and track-lifecycle handling. Check its license before reusing code.
- https://developer.chrome.com/blog/html-in-canvas
- https://developer.chrome.com/docs/web-platform/html-in-canvas/2d
- https://developer.chrome.com/docs/web-platform/html-in-canvas/concepts
- https://developer.chrome.com/blog/background-blur
- Chrome's documentation for MAIN-world content scripts, media capture, and `canvas.captureStream()`.

Read and follow the relevant skills at `~/code/scripts/agents/*/SKILL.md` or https://github.com/sanand0/skills, especially `code`, `design`, `interactions`, `possibility-scan`, and `verification-gate`.

Inspect the actual environment, browser versions, existing project conventions, and tests rather than assuming they match documentation.

## 2. Architecture

Create two tightly related parts.

**A. Studio / Playground**

A standalone extension page where I can use the compositor without joining a meeting.

It should have:
- A large, accurate live preview, ideally 16:9.
- A clearly organized layers panel.
- Layer property controls.
- A compact scene/preset selector.
- Source selection.
- Capability diagnostics.
- Controls that work with mouse and keyboard.
- Save/load scene JSON.
- Export a still PNG and record a short WebM demonstration.

**B. Browser-camera integration**

A thin, reusable integration mechanism for sites using `navigator.mediaDevices.getUserMedia()`.

Investigate and implement the proven approach of intercepting the camera request in the page's MAIN world at `document_start`, preserving the original webcam source but substituting a canvas-captured video track.

Use opt-in per-origin activation. Register scripts early enough to intercept requests; tell the user to reload or rejoin when necessary.

Avoid permanently injecting heavy compositor code into every website.

The same scene schema and rendering logic should work in Studio and inside a browser call. Do not assume a MediaStream can be transferred between tabs via `postMessage()`. Design the separation of scene configuration, local media sources, and renderers accordingly.

Initially validate the integration with a tiny local fake video-call page, then try Google Meet and Teams Web if feasible.

Preserve audio untouched for the first version. Do not implement audio mixing.

## 3. Core layer compositor

Implement a small, data-driven scene model.

Minimum layer types:

1. **Background:** solid color, gradient, image, local video, generated Canvas, or live HTML source.
2. **Camera:** original webcam feed, independently positioned, with configurable effects and an optional person mask.
3. **Foreground:** text, SVG, editable HTML, image, video, or Canvas drawing.

Support multiple instances of layers, not exactly one of each type.

Each layer should have:
- Visible/hidden.
- Z-order and reorder.
- Position X/Y.
- Width/height or scale.
- Rotation.
- Opacity.
- Fit mode (`contain`, `cover`, `stretch` where relevant).
- Optional clipping/mask.
- Optional blend mode.
- Duplicate/remove.
- Reset transform.

Make the layer schema simple enough to inspect and edit manually. Avoid a large plugin framework. Pure functions and declarative scene data are preferable.

Support independent source lifecycles: deleting a layer must release only the resources it owns; stopping the camera must actually release the device when there are no consumers.

## 4. HTML-in-Canvas is a first-class feature

This is especially important.

Chrome 157 introduced native `drawElementImage()` support. Explore it seriously rather than treating HTML as a screenshot or using `html2canvas` by default.

Investigate:
- `<canvas content="drawable">` and its `drawable` children.
- Legacy `layoutsubtree` support in Chromium 155/156.
- `ctx.drawElementImage(element, ...)` including scaling and cropping.
- The `paint` event and `requestPaint()`.
- DOM-to-canvas geometry synchronization and hit testing.
- What happens when the resulting canvas is captured through `captureStream()`.
- Browser layout, fonts, animations, SVG, videos, and CSS effects inside drawable HTML.
- Alpha, shadows, transforms, cropping, and complex stacking.
- Cross-origin restrictions and canvas origin-clean behavior.

Use capability detection, not a browser-version assumption.

Build at least **two real demonstrations**:

**Live HTML metric card:** A styled HTML card containing a title, animated value, tiny chart, and controls. Draw it as a floating foreground layer using `drawElementImage()`. Its pixels must be visible in the output video, not merely overlaid on the Studio UI.

**HTML transition:** Two live HTML panels that animate between states while being composited over the webcam, ideally with a dramatic transition such as a fold, portal, spinning card, or perspective reveal. Use native HTML-in-Canvas where supported. Explore what is possible without rasterizing HTML manually.

The HTML should remain editable and interactive in Studio as far as the platform permits. Remote meeting participants receive pixels only.

For unsupported browsers, provide a clear diagnostic and a limited, working fallback. Do not quietly display an empty layer.

## 5. Camera controls and effects

Provide:
- Camera device selector.
- Show/hide webcam.
- Drag directly to reposition.
- Resize handles.
- Corner/side/fullscreen presets.
- Mirror/flip.
- Brightness, contrast, saturation, grayscale.
- Rounded/circular clipping when desired.
- Reset camera.

**Background blur must be correctly implemented**, not confused with blurring the entire webcam image.

Experiment with these modes:

1. Original camera, no effects.
2. OS/hardware blur via `MediaStreamTrack.getCapabilities().backgroundBlur` and `applyConstraints()` when genuinely supported.
3. Independent segmentation with the original sharp person composited over a blurred original background.
4. Person cutout over an arbitrary image/HTML/video background.

Start with the simplest reliable segmentation model, potentially MediaPipe. Investigate GPU versus CPU, mask resolution, feathering, temporal stability, and latency. Do not spend most of this project optimizing matting before the rest of the compositor works.

Show which blur modes are genuinely available. Fail gracefully if OS blur is unsupported. Avoid falsely presenting a whole-frame blur as background blur.

Make it easy to compare the results side by side and take snapshots.

## 6. On-screen interaction

I need controls for both editing and live presenting.

**Director controls:** Visible to me, but never included in the outgoing meeting video.

**Stage content:** Composited into the outgoing video and visible to others.

Include:
- A selectable layer outline and resize handles.
- Mouse/stylus drawing over the stage, with pen, highlighter, eraser, undo, and clear.
- Stroke color and width.
- Correct pointer coordinate mapping when the preview is letterboxed, scaled, or resized.
- Layer selection, opacity, show/hide, reorder, and properties.
- Keyboard shortcuts for essential actions.
- Start/stop camera and capture controls.

Use a distinctive, polished dark interface rather than a generic form-based dashboard. Keep the preview large, controls compact, and errors visible.

Support narrow windows and keyboard navigation.

## 7. Make exploring fun

Include several small scene presets that exercise genuinely different mechanisms:

- **Talking Head:** Original camera, no effects.
- **Presenter:** Live background with a smaller webcam cutout.
- **Glass Dashboard:** Transparent HTML metric cards floating over the camera.
- **Portal:** An HTML/CSS visual transition revealing a different background.
- **Data Magic:** An animated chart with the presenter in front and selected details in a foreground layer.

One compelling, working scene is better than five mocked scenes.

Make iteration easy:
- Scene configuration as JSON.
- Hot reload for development.
- No complex build pipeline unless an actual browser or model-loading constraint demands one.
- Easy substitution of a locally authored HTML/CSS/JS experiment as a scene source.
- A diagnostics panel showing camera permissions, detected APIs, resolution, FPS, frame time, segmentation time, capture state, and last errors.
- A synthetic camera input for automated tests, so a physical webcam is not mandatory.

Try to make it possible to experiment with a new HTML scene without modifying core compositor logic.

## 8. Browser integration and safety

The final composited video must actually reach a test consumer of `getUserMedia()`. A pretty standalone Studio preview does not establish browser integration.

For the MAIN-world interception:
- Preserve the original media request behavior as closely as feasible.
- Do not interfere with audio-only requests.
- Preserve expected video track settings, capabilities, constraints, label, stop, clone, and ended behavior where practical.
- Handle multiple camera requests and cleanup.
- Preserve the caller's actual camera selection and video constraints.
- Avoid re-intercepting your own internal media requests.
- Do not silently return a broken track when composition fails.
- Ensure disabling the extension or stopping the call releases cameras and captures.
- Do not assume meeting apps all mirror local video in the same way.
- Detect and warn about competing camera-interception extensions when feasible.
- Distinguish an in-call control panel from the pixels sent to the call.

Test on a local mock-call page first. Then test Meet/Teams Web separately, noting unverified behavior. Desktop applications are out of scope.

Use minimal, explicit permissions. Camera, screen, and tab capture must require appropriate user action or permission. No remote telemetry or server-side camera processing.

## 9. Implementation order — avoid overengineering

Work in vertical slices, not a large scaffold followed by an unfinished application.

**Milestone 1 — The first useful compositor**

Get background + webcam + foreground HTML + drawing working in Studio. Include working drag/resize, opacity, z-order, PNG export, and a saved preset.

Use native HTML-in-Canvas and confirm its pixels appear in the exported PNG or video.

**Milestone 2 — The camera bridge**

Prove that the same compositor output is actually substituted into a `getUserMedia()` stream on a local mock-call page, without breaking normal camera/microphone behavior.

**Milestone 3 — Blur and real-world sources**

Implement/compare OS blur and segmentation, local video, and a user-selected captured tab/window where feasible. Add effect diagnostics.

**Milestone 4 — Conferencing and creative demonstration**

Try Meet and Teams Web, document results, and create one memorable HTML transition with webcam and background composited together.

Complete as much as possible, but favor two genuinely working milestones over four nominal ones. Do not defer all testing until the end.

## 10. Verification and deliverables

Add automated tests for scene ordering, transform math, opacity, image export, permission/fallback behavior, and stream lifecycle.

Run real browser-level tests for:
- Live HTML rendering into Canvas.
- HTML changing and the exported/captured pixels changing.
- Camera resizing and clipping.
- Director UI excluded from outgoing video.
- A mock website receiving the composited video track.
- Disabling the compositor, closing the page, and releasing media resources.
- Missing permissions, missing HTML-in-Canvas support, and segmentation failure.

Where possible, inspect captured output pixels rather than only checking DOM state. Use screenshots and a short example recording.

Do not claim Meet/Teams compatibility without testing.

At the end, provide:
1. Exact local file paths.
2. How to load the unpacked extension.
3. How to run Studio and the mock-call test.
4. What works, what failed, and what remains unverified.
5. Example scene presets with a short explanation of the effect they demonstrate.
6. A short list of the three most exciting next experiments, based on what actually worked.

Implement the project now. Make reasonable decisions independently, keep existing unrelated files untouched, and optimize for a compelling working experiment rather than exhaustive feature coverage.
```

---

OS Blur is not working. Segmented blur works OK in the studio but doesn't transfer to the outgoing video.
Display capture also works OK in the studio but doesn't transfer to the outgoing video. Same for image and local video (which displays the file name instead).
Fix these.

---

Add a "Live" mode, where changes made on the studio reflect live on the main tab immediately - even changes to text / inputs while they're being typed, and pen strokes, etc. All changes should reflect live in the studio (on input, not just change) in any case.
Allow saving, loading, and creating new scenes. A scene is a collection of all the layers.

Outside Controls.
Not sure what the "Stop outgoing video" button does. When I press it, the camera light turns off, the screen flickers, and everything comes back again. Not that I need this button in the first place. Instead, I need the "Open Studio" button on the page.

Drawing:
Move the pen's "Undo" and "Clear" buttons next to "Erase".
Re-label "Width" as "Thickness".
Undo should be able to undo a clear as well, not just strokes.

Layers:
Add a delete icon to each layer so that I can delete it in-place, without having to go to the "Remove" at the bottom. Then you can remove the "Remove" button.
Allow dragging and dropping layers. Once that works well, we can remove the Raise / Lower.
Drop the duplicate button too. So there will be no buttons bar.
Instead, each layer can be dragged and dropped to reorder. Each has icons for hide, remove, duplicate, rename, maybe even choose source or other layer-specific options directly.
You may use small icons, or a dropdown, or both, keeping extensibility in mind.

Layer selection:
In Select mode, when a layer below is selected, clicking on any layer on top of it does not select that layer. Maybe that's intentional... but it's disorienting. Fix that.

Layer categories:
We can skip Gradient, Solid, Generated Canvas. I won't need those.
For Live HTML / SVG, drop the predefined sources like Metric Card, etc. and options. Just have it point to a file or URL.
Rename Text to Markdown, allow picking the font family, and render the text as Markdown, e.g. **bold**, _italic_, `code`, `# Heading`, etc.
Merge Image and Local video into a single "Media" layer type, which can point to a file or URL. Allow picking the fit mode (contain, cover, stretch) and the background color for letterboxing.

Inspector:
Add an option to lock to the native aspect ratio and enable it by default.
I'd like to be able to crop layers, e.g. a tab source, a HTML page, etc. so that only a portion of it is visible. Add cropping to the inspector.
The inspector takes up too much vertical space. Group X, Y, Width, Height, Rotation, Opacity into a collapsible segment and collapse it by default. Similarly the cropping.
Prefer sliders for rotation and opacity

Camera:
The Camera selection dropdown and "Stop camera" / "Start camera" buttons should be in the Camera inspector panel. I should be able to use multiple camera with independent brightness, etc.

These are the changes I could think of. But you should think along these lines, from a practical usability perspective, and improve the app.

---

When adjusting layers, snap to edges: top, left, bottom, right of viewport; also the middles and thirds; also the edges of other layers.
Clicking on the 3 dots in the layer menu shows the popup somewhere near the middle of the screen - it should appear near the three dots. There may be other UI issues - find and fix.
Closing studio makes all cameras to go invisible and shared tabs/screens to vanish. I then need to reopen the studio and press live and share the tab again. How can we avoid this?
Selecting a tab to share switches to that tab - I'd rather avoid that.
OS blur seems unavailable. Why is that? Doesn't my Edge browser support it? What do I need to do?

---

Let me move the "Lightwell camera" card arond the screen.

<!-- codex resume 01a1f63d-6274-7fe2-80a5-6be34777f430 -->
