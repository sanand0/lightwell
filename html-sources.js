// @ts-check
(() => {
  const lab = globalThis.Lightwell;
  const svgNS = "http://www.w3.org/2000/svg";
  function element(tag, text = "", style = {}) {
    const node = document.createElement(tag);
    node.textContent = text;
    Object.assign(node.style, style);
    return node;
  }

  const buttonStyle = {
    font: "bold 12px monospace", border: "1px solid #839786", borderRadius: "6px", padding: "8px 12px",
    background: "#1e3027", color: "#f3ffe5", cursor: "pointer", letterSpacing: ".06em",
  };

  function sparkline() {
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 320 58");
    Object.assign(svg.style, { width: "100%", height: "54px", overflow: "visible" });
    const line = document.createElementNS(svgNS, "polyline");
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "#dfff8e");
    line.setAttribute("stroke-width", "3");
    line.setAttribute("stroke-linecap", "round");
    svg.append(line);
    return { svg, line };
  }

  function metric(root, action) {
    const card = element("section", "", {
      boxSizing: "border-box", width: "100%", height: "100%", padding: "22px 25px",
      borderRadius: "24px", border: "1px solid #baff9f88", overflow: "hidden",
      background: "linear-gradient(155deg,#182d28eb,#191e33b5 68%,#16251dcf)",
      boxShadow: "inset 0 0 24px #bdfc8633", color: "#f4ffe7",
      display: "grid", gridTemplateRows: "auto auto 1fr auto", alignItems: "center",
    });
    const category = element("span", "●  LIVE TELEMETRY", { font: "bold 11px monospace", letterSpacing: ".19em", color: "#deff9c" });
    const title = element("span", "", { font: "19px Georgia, serif", color: "#eef7ed" });
    const heading = element("div", "", { display: "grid", gap: "8px", marginBottom: "12px" });
    heading.append(category, title);
    const metricRow = element("div", "", { display: "flex", alignItems: "baseline", gap: "10px" });
    const value = element("strong", "", { font: "normal 59px Georgia,serif", color: "#e3ff9d" });
    metricRow.append(value, element("span", "%", { font: "24px Georgia,serif", color: "#b1caba" }));
    const { svg, line } = sparkline();
    const footer = element("div", "", { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" });
    const toggle = element("button", "Freeze signal", buttonStyle);
    toggle.type = "button";
    toggle.addEventListener("click", () => action("frozen"));
    footer.append(element("span", "SIGNAL / 12 S", { font: "10px monospace", letterSpacing: ".12em", color: "#b6c3c2" }), toggle);
    card.append(heading, metricRow, svg, footer);
    root.append(card);
    let clock = 0;
    let last = -1;
    return (source, now) => {
      if (title.textContent !== source.title) title.textContent = source.title;
      const label = source.frozen ? "Resume signal" : "Freeze signal";
      if (toggle.textContent !== label) toggle.textContent = label;
      if (!source.frozen || last < 0) clock = now;
      const tick = Math.floor(clock / 115);
      if (tick === last) return;
      last = tick;
      const phase = tick / 11;
      value.textContent = String(Math.round(83 + Math.sin(phase) * 11));
      line.setAttribute("points", Array.from({ length: 32 }, (_, index) => {
        const level = 31 - 15 * Math.sin(index / 4.5 + phase) - 5 * Math.sin(index * 1.6 + phase * 2);
        return (index * 10.3).toFixed(1) + "," + level.toFixed(1);
      }).join(" "));
    };
  }

  function portal(root, action) {
    const layout = element("div", "", {
      boxSizing: "border-box", width: "100%", height: "100%", position: "relative", perspective: "720px",
      padding: "14px", color: "#fff6de",
    });
    function panel(title, note, background) {
      const node = element("article", "", {
        position: "absolute", inset: "12px 12px 56px", boxSizing: "border-box", borderRadius: "22px",
        padding: "30px", border: "1px solid #ffe5b89e", overflow: "hidden", background,
        display: "grid", alignContent: "center", boxShadow: "inset 0 0 38px #fff4c62b",
      });
      node.append(element("div", note, { font: "bold 12px monospace", letterSpacing: ".22em" }),
        element("strong", title, { font: "normal 59px Georgia,serif", lineHeight: ".95", marginTop: "10px" }));
      return node;
    }
    const near = panel("Near side", "01 / ORBIT", "radial-gradient(ellipse at 78% 22%,#718cee,#303564 46%,#141529 85%)");
    const far = panel("Far side", "02 / AFTERGLOW", "radial-gradient(ellipse at 72% 20%,#ffa374,#8b285b 44%,#2d1347 92%)");
    near.style.transformOrigin = "left center";
    far.style.transformOrigin = "right center";
    const control = element("button", "Open portal", { ...buttonStyle, position: "absolute", bottom: "9px", left: "14px", background: "#221a32" });
    control.type = "button";
    control.addEventListener("click", () => action("active"));
    layout.append(far, near, control);
    root.append(layout);
    let amount = 0;
    let last = 0;
    return (source, now) => {
      const target = Number(source.active);
      const step = Math.min(70, now - (last || now)) / 650;
      last = now;
      const next = amount < target ? Math.min(target, amount + step) : Math.max(target, amount - step);
      const eased = matchMedia("(prefers-reduced-motion: reduce)").matches ? target : next * next * (3 - 2 * next);
      amount = next;
      near.style.transform = "rotateY(" + (-91 * eased) + "deg) translateX(" + (-90 * eased) + "px)";
      near.style.opacity = String(1 - eased);
      far.style.transform = "rotateY(" + (86 * (1 - eased)) + "deg)";
      far.style.opacity = String(eased);
      const label = target ? "Close portal" : "Open portal";
      if (control.textContent !== label) control.textContent = label;
      return eased;
    };
  }

  const allowedTags = new Set(["main", "section", "article", "div", "span", "h1", "h2", "h3", "p", "strong", "b", "i", "em", "small", "ul", "ol", "li", "br"]);
  const allowedSVG = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);
  const svgAttrs = new Set(["viewBox", "width", "height", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "stroke", "stroke-width", "opacity", "transform"]);
  const allowedCSS = /^(color|background(?:-color|-image)?|opacity|font(?:-[a-z-]+)?|line-height|letter-spacing|padding(?:-[a-z-]+)?|margin(?:-[a-z-]+)?|border(?:-[a-z-]+)?|box-shadow|text(?:-[a-z-]+)?|display|grid(?:-[a-z-]+)?|gap|align-[a-z-]+|justify-[a-z-]+|(?:max-)?(?:width|height)|transform(?:-origin)?)$/;
  const unsafeCSS = /(?:url|image-set|image|var|attr|expression|src)\s*\(|\\/i;

  function appendMarkup(root, markup) {
    // The template is inert. Only freshly built allowlisted nodes are connected to the live document.
    let content;
    if (typeof Document.parseHTML === "function") {
      const elements = [...allowedTags, ...Array.from(allowedSVG, name => ({ name, namespace: svgNS }))];
      content = Document.parseHTML(markup, { sanitizer: { elements: ["html", "head", "body", ...elements], attributes: ["style", ...svgAttrs] } }).body;
    } else {
      const template = document.createElement("template");
      template.innerHTML = markup;
      content = template.content;
    }
    const sheet = new CSSStyleSheet();
    function declaration(node) {
      const raw = node.getAttribute("style");
      if (!raw || /[{}]/.test(raw)) return null;
      // Parse in a detached sheet. Host CSP can suppress the inert document's inline CSSOM.
      sheet.replaceSync("*{" + raw + "}");
      return sheet.cssRules[0]?.style;
    }
    function copy(node, parent) {
      if (node.nodeType === Node.TEXT_NODE) return parent.append(document.createTextNode(node.data));
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const name = node.localName;
      const isSVG = node.namespaceURI === svgNS;
      if (!(isSVG ? allowedSVG : allowedTags).has(name)) return;
      const output = isSVG ? document.createElementNS(svgNS, name) : element(name);
      const style = declaration(node);
      for (const property of style || []) {
        const value = style.getPropertyValue(property);
        if (allowedCSS.test(property) && !unsafeCSS.test(value)) output.style.setProperty(property, value);
      }
      if (isSVG) for (const { name, value } of node.attributes) {
        if (svgAttrs.has(name) && !unsafeCSS.test(value)) output.setAttribute(name, value);
      }
      for (const child of node.childNodes) copy(child, output);
      parent.append(output);
    }
    for (const node of content.childNodes) copy(node, root);
  }

  function custom(root, action, source) {
    appendMarkup(root, source.markup || '<div style="padding:18px;color:#f2ffe3;font:22px Georgia">Choose an HTML or SVG file or URL</div>');
    return () => {};
  }

  function sweep(root) {
    Object.assign(root.style, { borderRadius: "22px", background: "#1a2441df", border: "2px solid #aabbff", padding: "24px" });
    const title = element("h2", "", { position: "relative", color: "#f7eccd", font: "37px Georgia,serif", margin: "110px 0 0" });
    const beam = element("div", "", { position: "absolute", inset: "0", width: "60px", background: "linear-gradient(90deg,#e2ff8800,#e2ff88de,#e2ff8800)" });
    root.append(beam, title);
    return (source, now) => {
      if (title.textContent !== source.title) title.textContent = source.title;
      beam.style.left = (Math.sin(now / 1350) * 165 + 165) + "px";
    };
  }

  const htmlRecipes = Object.assign(Object.create(null), { metric, portal, custom, sweep });
  function htmlSource(source, action) {
    const portal = source.template === "portal";
    const authored = source.template === "custom" && source.markup && (source.url || source.filename);
    const viewBox = authored && /viewBox=["\x27]\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(source.markup);
    const width = viewBox ? Math.max(16, Math.min(1600, Number(viewBox[1]))) : portal ? 640 : authored ? 640 : 390;
    const height = viewBox ? Math.max(16, Math.min(1600, Number(viewBox[2]))) : portal ? 410 : authored ? 480 : 275;
    const root = element("div", "", {
      display: "block", position: "absolute", width: width + "px", height: height + "px",
      boxSizing: "border-box", color: "#f2ffe3", font: "16px Georgia,serif", overflow: "hidden",
    });
    root.setAttribute("drawable", "");
    const build = htmlRecipes[source.template] || custom;
    return { root, width, height, update: build(root, action, source) };
  }

  function htmlFallback(ctx, item, now, reason) {
    const { w, h, source } = item;
    const portal = source.template === "portal";
    const color = portal && source.active ? "#742854" : "#263955";
    const t = source.frozen ? 0 : now / 920;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, Math.min(22, w / 5, h / 5));
    ctx.fill();
    ctx.fillStyle = "#e7ffad";
    ctx.font = Math.max(11, Math.min(w / 25, h / 10)) + "px monospace";
    ctx.fillText(reason.toUpperCase(), w * .06, h * .17, w * .88);
    ctx.font = Math.max(14, Math.min(w / 10, h / 4)) + "px Georgia";
    const subtitle = portal ? source.active ? "Far side" : "Near side" : source.template === "metric" ? Math.round(83 + 11 * Math.sin(t)) + "%" : "Custom HTML";
    ctx.fillText(subtitle, w * .06, h * .48, w * .88);
    ctx.fillStyle = "#f6f6e5";
    ctx.font = Math.max(12, Math.min(w / 18, h / 8)) + "px Georgia";
    ctx.fillText(source.title, w * .06, h * .68, w * .88);
    if (source.template !== "metric") return;
    ctx.beginPath();
    for (let i = 0; i < 30; i++) ctx.lineTo(w * (.06 + i * .03), h * (.84 + .05 * Math.sin(i / 3 + t)));
    ctx.strokeStyle = "#e7ffad";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  Object.assign(lab, { htmlSource, htmlFallback });
})();
