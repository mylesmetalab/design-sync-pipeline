/**
 * Generate a .tldr file (TLDraw v2 file format) of the design-sync system
 * architecture. Written as a script (not hand-edited JSON) so the layout is
 * reproducible if shapes need re-positioning.
 *
 * Run: node scripts/generate-tldr.mjs > docs/architecture.tldr
 */

import { writeFileSync, mkdirSync } from "node:fs";

let idCounter = 0;
const shapeId = (prefix = "shape") => `${prefix}:n${++idCounter}`;
const indexCounter = (() => {
  // tldraw uses fractional-style index strings ("a1", "a2", ...) for ordering.
  let n = 0;
  return () => `a${++n}`;
})();

const records = [];

records.push({
  gridSize: 10,
  name: "",
  meta: {},
  id: "document:document",
  typeName: "document",
});

records.push({
  id: "page:page",
  name: "Architecture",
  index: "a1",
  meta: {},
  typeName: "page",
});

/** Make a geo (rectangle) shape. */
function geo({ x, y, w, h, text, color = "black", fill = "none", dash = "draw", size = "m", id }) {
  records.push({
    x,
    y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    id: id ?? shapeId(),
    type: "geo",
    props: {
      w,
      h,
      geo: "rectangle",
      color,
      labelColor: "black",
      fill,
      dash,
      size,
      font: "draw",
      text,
      align: "middle",
      verticalAlign: "middle",
      growY: 0,
      url: "",
    },
    parentId: "page:page",
    index: indexCounter(),
    typeName: "shape",
  });
  return records[records.length - 1].id;
}

/** Make a text label. */
function text({ x, y, w, content, size = "m", color = "black", align = "middle" }) {
  records.push({
    x,
    y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    id: shapeId(),
    type: "text",
    props: {
      color,
      size,
      w,
      text: content,
      font: "draw",
      textAlign: align,
      autoSize: false,
      scale: 1,
    },
    parentId: "page:page",
    index: indexCounter(),
    typeName: "shape",
  });
  return records[records.length - 1].id;
}

/** Make a free-floating arrow between two coordinates with optional label. */
function arrow({ start, end, label = "", dash = "draw", color = "black", bothEnds = false }) {
  records.push({
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    id: shapeId(),
    type: "arrow",
    props: {
      dash,
      size: "m",
      fill: "none",
      color,
      labelColor: "black",
      bend: 0,
      start: { x: start[0], y: start[1] },
      end: { x: end[0], y: end[1] },
      arrowheadStart: bothEnds ? "arrow" : "none",
      arrowheadEnd: "arrow",
      text: label,
      labelPosition: 0.5,
      font: "draw",
      scale: 1,
    },
    parentId: "page:page",
    index: indexCounter(),
    typeName: "shape",
  });
}

// ============================================================================
// Layout
// ============================================================================

// Title
text({
  x: 80,
  y: 40,
  w: 1200,
  content: "The design-sync system — three sibling repos, one Edit contract",
  size: "xl",
  color: "black",
  align: "start",
});

text({
  x: 80,
  y: 90,
  w: 1200,
  content: "Replaces Syncything. Sits beside Baluarte (codegen pipeline).",
  size: "s",
  color: "grey",
  align: "start",
});

// --- Surfaces (col 1: x≈80) ---
geo({ x: 80, y: 200, w: 200, h: 80, text: "Storybook", dash: "dashed", color: "grey" });
geo({ x: 80, y: 480, w: 200, h: 80, text: "Figma", dash: "dashed", color: "grey" });

// --- Front doors + Pipeline (col 2: x≈360) ---
const addonId = geo({
  x: 360,
  y: 200,
  w: 240,
  h: 80,
  text: "design-sync addon\n(Storybook front door)",
  fill: "solid",
  color: "green",
});
const pipelineId = geo({
  x: 360,
  y: 340,
  w: 240,
  h: 100,
  text: "design-sync-pipeline\n(local Node service)\nEdit { kind, scope, oldValue, newValue }",
  fill: "solid",
  color: "green",
});
const pluginId = geo({
  x: 360,
  y: 480,
  w: 240,
  h: 80,
  text: "design-sync figma-plugin\n(Figma front door + engine)",
  fill: "solid",
  color: "green",
});

// --- Engines (col 3: x≈680) ---
geo({ x: 680, y: 200, w: 220, h: 60, text: "CSS token swap", fill: "solid", color: "green", size: "s" });
geo({ x: 680, y: 280, w: 220, h: 60, text: "Plugin API\n(via plugin)", fill: "solid", color: "green", size: "s" });
geo({ x: 680, y: 380, w: 220, h: 60, text: "Baluarte\n(codegen — future)", dash: "dashed", color: "grey", size: "s" });
geo({ x: 680, y: 460, w: 220, h: 60, text: "figma-rest-write\n(values — future)", dash: "dashed", color: "grey", size: "s" });

// --- Targets (col 4: x≈980) ---
geo({ x: 980, y: 230, w: 220, h: 80, text: "Codebase\nstyle.css · components", fill: "semi", color: "blue" });
geo({ x: 980, y: 410, w: 220, h: 80, text: "Figma file\nvariables · bindings", fill: "semi", color: "blue" });

// --- Arrows ---
// Surfaces → front doors
arrow({ start: [285, 240], end: [355, 240] });
arrow({ start: [285, 520], end: [355, 520] });

// addon ↔ pipeline
arrow({ start: [480, 285], end: [480, 335], bothEnds: true, label: "Edit · drift" });
// pipeline ↔ plugin
arrow({ start: [480, 445], end: [480, 475], bothEnds: true, label: "queue · result" });

// pipeline → engines
arrow({ start: [605, 380], end: [675, 230], label: "" });
arrow({ start: [605, 390], end: [675, 310] });
arrow({ start: [605, 400], end: [675, 410], dash: "dashed" });
arrow({ start: [605, 410], end: [675, 490], dash: "dashed" });

// engines → targets
arrow({ start: [905, 230], end: [975, 270] });
arrow({ start: [905, 310], end: [975, 450] });
arrow({ start: [905, 410], end: [975, 270], dash: "dashed" });
arrow({ start: [905, 490], end: [975, 450], dash: "dashed" });

// --- Legend ---
text({ x: 980, y: 550, w: 220, content: "Legend", size: "s", color: "black", align: "start" });
geo({ x: 980, y: 580, w: 16, h: 16, text: "", fill: "solid", color: "green" });
text({ x: 1004, y: 580, w: 200, content: "built · shipped", size: "s", color: "black", align: "start" });
geo({ x: 980, y: 610, w: 16, h: 16, text: "", dash: "dashed", color: "grey" });
text({ x: 1004, y: 610, w: 200, content: "future · contract reserved", size: "s", color: "grey", align: "start" });

// ============================================================================
// File envelope
// ============================================================================

const tldrFile = {
  tldrawFileFormatVersion: 1,
  schema: {
    schemaVersion: 2,
    sequences: {
      "com.tldraw.store": 4,
      "com.tldraw.asset": 1,
      "com.tldraw.camera": 1,
      "com.tldraw.document": 2,
      "com.tldraw.instance": 25,
      "com.tldraw.instance_page_state": 5,
      "com.tldraw.page": 1,
      "com.tldraw.instance_presence": 6,
      "com.tldraw.pointer": 1,
      "com.tldraw.shape": 4,
      "com.tldraw.asset.bookmark": 2,
      "com.tldraw.asset.image": 5,
      "com.tldraw.asset.video": 5,
      "com.tldraw.shape.group": 0,
      "com.tldraw.shape.text": 2,
      "com.tldraw.shape.bookmark": 2,
      "com.tldraw.shape.draw": 2,
      "com.tldraw.shape.geo": 9,
      "com.tldraw.shape.note": 9,
      "com.tldraw.shape.line": 5,
      "com.tldraw.shape.frame": 0,
      "com.tldraw.shape.arrow": 5,
      "com.tldraw.shape.highlight": 1,
      "com.tldraw.shape.embed": 4,
      "com.tldraw.shape.image": 4,
      "com.tldraw.shape.video": 4,
      "com.tldraw.binding.arrow": 1,
    },
  },
  records,
};

// Write to docs/architecture.tldr next to ARCHITECTURE.md.
mkdirSync("docs", { recursive: true });
writeFileSync("docs/architecture.tldr", JSON.stringify(tldrFile, null, 2));
console.log(`Wrote docs/architecture.tldr (${records.length} records)`);
