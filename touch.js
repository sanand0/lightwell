// @ts-check
// Touch input for experimental effects. Three sources become one stream of stage points:
// - Studio pokes (Touch tool), published in the scene so calls see them too
// - typing in a Markdown layer, detected locally wherever the text changes
// - hands from MediaPipe gestures, computed locally from the camera this page composes
// Gestures also act on layers: pinch drags a layer, a fist plays its exit, an open palm brings it back.
// Gesture results stay local to this page (Studio preview or call tab); they are not written to the scene.
(() => {
  const lab = globalThis.Lightwell;
  const keep = 3000;
  const held = 4;
  // Landmark indices from MediaPipe's hand model.
  const WRIST = 0, THUMB = 4, INDEX = 8, MIDDLE_BASE = 9;

  class Touch {
    constructor() {
      this.typed = [];
      this.fingers = [];
      this.nudges = new Map();
      this.exits = new Map();
      this.grab = null;
      this.pose = { name: "", frames: 0, done: false };
      this.cursor = null;
    }

    // caret: local point in the layer just after the last typed glyph.
    typing(item, caret) {
      const at = Date.now();
      this.typed = [...this.typed.filter(touch => at - touch.at < keep), { ...lab.toWorld(item, caret), at, kind: "type" }];
    }

    // hands: [{ points: [[u, v] x21] normalized to the camera frame, gesture, score }]; map: (u, v) => stage point.
    hands(list, scene, map) {
      const at = Date.now();
      const previous = this.fingers;
      this.fingers = list.map((hand, index) => {
        const tip = map(...hand.points[INDEX]);
        const last = previous[index];
        const dt = last ? Math.max(1, at - last.at) / 1000 : 1;
        return { ...tip, at, kind: "finger", vx: last ? (tip.x - last.x) / dt : 0, vy: last ? (tip.y - last.y) / dt : 0 };
      });
      const hand = list[0];
      if (!hand) { this.grab = null; this.cursor = null; this.pose = { name: "", frames: 0, done: false }; return; }
      const point = index => map(...hand.points[index]);
      const span = Math.hypot(...[0, 1].map(axis => hand.points[WRIST][axis] - hand.points[MIDDLE_BASE][axis])) || 1;
      const pinch = Math.hypot(...[0, 1].map(axis => hand.points[THUMB][axis] - hand.points[INDEX][axis])) / span < .32;
      const thumb = point(THUMB);
      const index = point(INDEX);
      const grip = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
      this.cursor = { ...grip, pinch };
      if (pinch && !this.grab) {
        const target = this.topmost(scene, grip, item => item.type !== "camera" && !(item.w >= lab.W && item.h >= lab.H));
        if (target) this.grab = { id: target.id, from: grip, base: this.offset(target) };
      } else if (pinch && this.grab) {
        const target = scene.layers.find(item => item.id === this.grab.id);
        if (target) this.nudges.set(target.id, {
          x: target.x, y: target.y,
          dx: this.grab.base.dx + grip.x - this.grab.from.x, dy: this.grab.base.dy + grip.y - this.grab.from.y,
        });
      } else this.grab = null;

      const name = hand.score > .55 ? hand.gesture : "";
      this.pose = name === this.pose.name ? { ...this.pose, frames: this.pose.frames + 1 } : { name, frames: 1, done: false };
      if (this.pose.done || this.pose.frames < held || pinch) return;
      const palm = point(MIDDLE_BASE);
      if (name === "Closed_Fist") this.pose.done = this.play(scene, palm, true);
      if (name === "Open_Palm") this.pose.done = this.play(scene, palm, false);
    }

    play(scene, point, gone) {
      const target = this.topmost(scene, point, item => item.fx?.exit && item.fx.exit !== "none" && !!this.state(item).gone !== gone, true);
      if (!target) return false;
      const local = lab.toLocal(this.apply(target), point);
      const ms = lab.fx.exitMs[target.fx.exit];
      const state = this.state(target);
      const elapsed = state.at ? Math.min(ms, Date.now() - state.at) : ms;
      this.exits.set(target.id, { gone, at: Date.now() - (ms - elapsed), ix: local.x / target.w, iy: local.y / target.h });
      return true;
    }

    // Topmost visible layer whose (nudged) box holds the point. Gone layers count when `hidden` is set.
    topmost(scene, point, accept, hidden = false) {
      return scene.layers.toReversed().find(item => {
        if (!item.visible || (!hidden && item.opacity <= 0) || !accept(item)) return false;
        const local = lab.toLocal(this.apply(item), point);
        return local.x >= 0 && local.y >= 0 && local.x <= item.w && local.y <= item.h;
      });
    }

    offset(item) {
      const nudge = this.nudges.get(item.id);
      return nudge && nudge.x === item.x && nudge.y === item.y ? nudge : { dx: 0, dy: 0 };
    }
    state(item) {
      const local = this.exits.get(item.id);
      return local && local.at > (item.fx?.at || 0) ? local : item.fx || {};
    }

    // The layer as this page should draw it: moved by a pinch, and with any newer gesture-played exit.
    apply(item) {
      const { dx, dy } = this.offset(item);
      const local = this.exits.get(item.id);
      const fx = local && item.fx && local.at > (item.fx.at || 0) ? { ...item.fx, ...local } : item.fx;
      return dx || dy || fx !== item.fx ? { ...item, x: item.x + dx, y: item.y + dy, fx } : item;
    }

    // Touches near this layer in its own coordinates, newest last. age is in ms.
    local(scene, item) {
      const at = Date.now();
      const all = [...(scene.pokes || []), ...this.typed, ...this.fingers].filter(touch => at - touch.at < keep);
      return all.map(touch => {
        const point = lab.toLocal(item, touch);
        const angle = -item.rotation * Math.PI / 180;
        const vx = touch.vx || 0;
        const vy = touch.vy || 0;
        return { ...point, age: at - touch.at, at: touch.at, kind: touch.kind,
          vx: vx * Math.cos(angle) - vy * Math.sin(angle), vy: vx * Math.sin(angle) + vy * Math.cos(angle) };
      }).sort((a, b) => a.at - b.at);
    }
  }

  lab.Touch = Touch;
})();
