/**
 * Generate an .excalidraw file of the design-sync system architecture.
 *
 * Excalidraw's file format is well-documented and stable. To use:
 *   1. Run:   node scripts/generate-excalidraw.mjs
 *   2. Open:  https://excalidraw.com  (or open the file in your local
 *             Excalidraw / VSCode-Excalidraw extension)
 *   3. File → Open → choose docs/architecture.excalidraw
 *
 * Edit this script (positions, labels, colors) and re-run to regenerate.
 */

import { writeFileSync } from "node:fs";

let seq = 0;
const id = (prefix) => `${prefix}-${++seq}`;
const rand = () => (Math.random() * 2_000_000_000) | 0;
const NOW = Date.now();

const elements = [];

// Excalidraw element factory — fills in the boilerplate fields.
function el(extra) {
  return {
    id: extra.id ?? id("el"),
    type: extra.type,
    x: extra.x,
    y: extra.y,
    width: extra.width,
    height: extra.height,
    angle: 0,
    strokeColor: extra.strokeColor ?? "#1e1e1e",
    backgroundColor: extra.backgroundColor ?? "transparent",
    fillStyle: extra.fillStyle ?? "solid",
    strokeWidth: extra.strokeWidth ?? 2,
    strokeStyle: extra.strokeStyle ?? "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: `a${seq}`,
    roundness: extra.roundness ?? { type: 3 },
    seed: rand(),
    version: 1,
    versionNonce: rand(),
    isDeleted: false,
    boundElements: extra.boundElements ?? null,
    updated: NOW,
    link: null,
    locked: false,
    ...extra,
  };
}

/** A rectangle with an attached label (creates two elements, returns the rect id). */
function box({ x, y, width, height, label, color = "built", subtitle = "" }) {
  const palette = {
    built: { bg: "#b2f2bb", stroke: "#2f9e44", style: "solid" },
    surface: { bg: "transparent", stroke: "#868e96", style: "dashed" },
    target: { bg: "#a5d8ff", stroke: "#1971c2", style: "solid" },
    future: { bg: "transparent", stroke: "#868e96", style: "dashed" },
  };
  const p = palette[color] ?? palette.built;

  const rectId = id("rect");
  const textId = id("text");

  // Rectangle
  elements.push(
    el({
      id: rectId,
      type: "rectangle",
      x,
      y,
      width,
      height,
      strokeColor: p.stroke,
      backgroundColor: p.bg,
      strokeStyle: p.style,
      boundElements: [{ id: textId, type: "text" }],
    }),
  );

  // Text bound inside it
  const fullText = subtitle ? `${label}\n${subtitle}` : label;
  const fontSize = 16;
  const lineHeight = 1.25;
  const lines = fullText.split("\n").length;
  const textHeight = lines * fontSize * lineHeight;

  elements.push(
    el({
      id: textId,
      type: "text",
      x: x + 8,
      y: y + (height - textHeight) / 2,
      width: width - 16,
      height: textHeight,
      strokeColor: "#1e1e1e",
      fontSize,
      fontFamily: 1,
      text: fullText,
      textAlign: "center",
      verticalAlign: "middle",
      baseline: fontSize,
      containerId: rectId,
      originalText: fullText,
      autoResize: true,
      lineHeight,
    }),
  );

  return rectId;
}

/** Standalone text — for titles, legend labels. */
function label({ x, y, width, text, fontSize = 16, color = "#1e1e1e", textAlign = "left" }) {
  const lines = text.split("\n").length;
  const lineHeight = 1.25;
  elements.push(
    el({
      type: "text",
      x,
      y,
      width,
      height: fontSize * lineHeight * lines,
      strokeColor: color,
      fontSize,
      fontFamily: 1,
      text,
      textAlign,
      verticalAlign: "top",
      baseline: fontSize,
      containerId: null,
      originalText: text,
      autoResize: true,
      lineHeight,
      roundness: null,
    }),
  );
}

/**
 * Free-floating arrow. `from` and `to` are absolute canvas coordinates of
 * the arrow's start/end points. Optionally bind to elements via fromId/toId.
 */
function arrow({ from, to, fromId = null, toId = null, dashed = false, label: arrowLabel = "" }) {
  const arrowId = id("arrow");
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];

  const a = el({
    id: arrowId,
    type: "arrow",
    x: from[0],
    y: from[1],
    width: Math.abs(dx),
    height: Math.abs(dy),
    strokeColor: dashed ? "#868e96" : "#1e1e1e",
    strokeStyle: dashed ? "dashed" : "solid",
    roundness: { type: 2 },
    points: [
      [0, 0],
      [dx, dy],
    ],
    lastCommittedPoint: null,
    startBinding: fromId ? { elementId: fromId, focus: 0, gap: 1 } : null,
    endBinding: toId ? { elementId: toId, focus: 0, gap: 1 } : null,
    startArrowhead: null,
    endArrowhead: "arrow",
  });
  elements.push(a);

  if (arrowLabel) {
    label({
      x: from[0] + dx / 2 - 60,
      y: from[1] + dy / 2 - 10,
      width: 120,
      text: arrowLabel,
      fontSize: 12,
      color: "#666",
      textAlign: "center",
    });
  }
  return arrowId;
}

// ============================================================================
// Layout
// ============================================================================

label({
  x: 80,
  y: 40,
  width: 1200,
  text: "The design-sync system",
  fontSize: 28,
  textAlign: "left",
});

label({
  x: 80,
  y: 78,
  width: 1200,
  text: "Three sibling repos · one Edit contract · replaces Syncything · sits beside Baluarte (codegen)",
  fontSize: 14,
  color: "#666",
  textAlign: "left",
});

// --- Surfaces (col 1) ---
const sbId = box({ x: 80, y: 200, width: 200, height: 80, label: "📖 Storybook", color: "surface" });
const fgId = box({ x: 80, y: 480, width: 200, height: 80, label: "🎨 Figma", color: "surface" });

// --- Front doors + Pipeline (col 2) ---
const addonId = box({
  x: 360,
  y: 200,
  width: 240,
  height: 80,
  label: "design-sync addon",
  subtitle: "Storybook front door",
  color: "built",
});

const pipelineId = box({
  x: 360,
  y: 340,
  width: 240,
  height: 100,
  label: "design-sync-pipeline",
  subtitle: "local Node service · Edit router",
  color: "built",
});

const pluginId = box({
  x: 360,
  y: 480,
  width: 240,
  height: 80,
  label: "design-sync figma-plugin",
  subtitle: "Figma front door + engine",
  color: "built",
});

// --- Engines (col 3) ---
const cssEng = box({
  x: 700,
  y: 200,
  width: 220,
  height: 60,
  label: "CSS token swap",
  color: "built",
});

const apiEng = box({
  x: 700,
  y: 280,
  width: 220,
  height: 60,
  label: "Plugin API (via plugin)",
  color: "built",
});

const balEng = box({
  x: 700,
  y: 380,
  width: 220,
  height: 60,
  label: "Baluarte (codegen)",
  subtitle: "future",
  color: "future",
});

const restEng = box({
  x: 700,
  y: 470,
  width: 220,
  height: 60,
  label: "figma-rest-write",
  subtitle: "variable values · future",
  color: "future",
});

// --- Targets (col 4) ---
const codeId = box({
  x: 1000,
  y: 230,
  width: 220,
  height: 80,
  label: "Codebase",
  subtitle: "style.css · components",
  color: "target",
});

const figmaFileId = box({
  x: 1000,
  y: 410,
  width: 220,
  height: 80,
  label: "Figma file",
  subtitle: "variables · bindings",
  color: "target",
});

// --- Arrows ---
arrow({ from: [280, 240], to: [360, 240], fromId: sbId, toId: addonId });
arrow({ from: [280, 520], to: [360, 520], fromId: fgId, toId: pluginId });
arrow({ from: [480, 280], to: [480, 340], fromId: addonId, toId: pipelineId, label: "Edit / drift check" });
arrow({ from: [480, 440], to: [480, 480], fromId: pipelineId, toId: pluginId, label: "queue · result" });
arrow({ from: [600, 380], to: [700, 230], fromId: pipelineId, toId: cssEng });
arrow({ from: [600, 390], to: [700, 310], fromId: pipelineId, toId: apiEng });
arrow({ from: [600, 400], to: [700, 410], fromId: pipelineId, toId: balEng, dashed: true });
arrow({ from: [600, 410], to: [700, 500], fromId: pipelineId, toId: restEng, dashed: true });
arrow({ from: [920, 230], to: [1000, 270], fromId: cssEng, toId: codeId, label: "writes" });
arrow({ from: [920, 310], to: [1000, 450], fromId: apiEng, toId: figmaFileId, label: "writes" });
arrow({ from: [920, 410], to: [1000, 270], fromId: balEng, toId: codeId, dashed: true });
arrow({ from: [920, 500], to: [1000, 450], fromId: restEng, toId: figmaFileId, dashed: true });

// --- Legend ---
label({ x: 80, y: 640, width: 200, text: "Legend", fontSize: 14, color: "#1e1e1e" });

box({ x: 80, y: 670, width: 16, height: 16, label: "", color: "built" });
label({ x: 105, y: 672, width: 200, text: "built · shipped", fontSize: 12, color: "#1e1e1e" });

box({ x: 80, y: 700, width: 16, height: 16, label: "", color: "future" });
label({ x: 105, y: 702, width: 240, text: "future · contract reserved", fontSize: 12, color: "#666" });

box({ x: 80, y: 730, width: 16, height: 16, label: "", color: "target" });
label({ x: 105, y: 732, width: 240, text: "target (file the engine writes to)", fontSize: 12, color: "#1e1e1e" });

// ============================================================================
// File envelope
// ============================================================================

const file = {
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements,
  appState: {
    gridSize: null,
    viewBackgroundColor: "#ffffff",
  },
  files: {},
};

writeFileSync("docs/architecture.excalidraw", JSON.stringify(file, null, 2));
console.log(`Wrote docs/architecture.excalidraw (${elements.length} elements)`);
