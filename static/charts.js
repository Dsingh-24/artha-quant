// Safe SVG chart & progress bar renderer using strictly document.createElementNS and textContent.

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  return node;
}

export function formatINRCompact(amount) {
  const num = Number(amount || 0);
  const abs = Math.abs(num);
  const sign = num < 0 ? "-" : "";
  if (abs >= 10000000) {
    return `${sign}₹${(abs / 10000000).toFixed(2)} Cr`;
  }
  if (abs >= 100000) {
    return `${sign}₹${(abs / 100000).toFixed(2)} L`;
  }
  return `${sign}₹${Math.round(abs).toLocaleString("en-IN")}`;
}

export function createProgressSvg(percent, colorHex) {
  const clamped = Math.max(0, Math.min(100, Number(percent || 0)));
  const svg = svgEl("svg", {
    viewBox: "0 0 200 8",
    width: "100%",
    height: "8",
    preserveAspectRatio: "none",
  });
  svg.appendChild(svgEl("rect", { x: 0, y: 0, width: 200, height: 8, rx: 4, fill: "#182338" }));
  svg.appendChild(
    svgEl("rect", {
      x: 0,
      y: 0,
      width: (clamped * 2).toFixed(1),
      height: 8,
      rx: 4,
      fill: colorHex,
    })
  );
  return svg;
}

export function renderMultiLineChart(container, seriesList, xLabels, yFormatter, opts = {}) {
  container.replaceChildren();
  if (!xLabels || xLabels.length < 2) {
    const empty = document.createElement("div");
    empty.className = "muted-note";
    empty.textContent = "Insufficient time-series points.";
    container.appendChild(empty);
    return;
  }

  const width = opts.width || 640;
  const height = opts.height || 255;
  const padL = 68;
  const padR = 18;
  const padT = 18;
  const padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of seriesList) {
    for (const val of s.values) {
      const n = Number(val);
      if (Number.isFinite(n)) {
        if (n < minY) minY = n;
        if (n > maxY) maxY = n;
      }
    }
  }
  if (opts.includeZero) {
    minY = Math.min(minY, 0);
    maxY = Math.max(maxY, 0);
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || minY === maxY) {
    minY = 0;
    maxY = 100;
  }
  const spanY = maxY - minY;
  minY -= spanY * 0.05;
  maxY += spanY * 0.06;

  const xCoord = (i) => padL + (i / (xLabels.length - 1)) * plotW;
  const yCoord = (v) => padT + (1 - (v - minY) / (maxY - minY)) * plotH;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width: "100%",
    height: String(height),
  });

  // Horizontal grid lines + Y-axis labels
  const gridTicks = 4;
  for (let g = 0; g <= gridTicks; g++) {
    const val = minY + (g / gridTicks) * (maxY - minY);
    const y = yCoord(val);
    svg.appendChild(
      svgEl("line", {
        x1: padL,
        y1: y.toFixed(1),
        x2: width - padR,
        y2: y.toFixed(1),
        stroke: "#1f2c46",
        "stroke-width": "1",
      })
    );
    const lbl = svgEl("text", {
      x: padL - 8,
      y: (y + 4).toFixed(1),
      fill: "#7c8fb2",
      "font-size": "10",
      "text-anchor": "end",
    });
    lbl.textContent = yFormatter(val);
    svg.appendChild(lbl);
  }

  // X-axis labels (start, mid, end)
  const xTickIndices = [0, Math.floor((xLabels.length - 1) / 2), xLabels.length - 1];
  for (const idx of xTickIndices) {
    const x = xCoord(idx);
    const anchor = idx === 0 ? "start" : idx === xLabels.length - 1 ? "end" : "middle";
    const t = svgEl("text", {
      x: x.toFixed(1),
      y: height - 8,
      fill: "#7c8fb2",
      "font-size": "10",
      "text-anchor": anchor,
    });
    t.textContent = String(xLabels[idx]);
    svg.appendChild(t);
  }

  // Draw optional area fill + polyline for each series
  for (const s of seriesList) {
    const pts = s.values.map((v, i) => `${xCoord(i).toFixed(1)},${yCoord(Number(v)).toFixed(1)}`);
    if (s.areaFill) {
      const baseLineY = yCoord(opts.areaBaseline !== undefined ? opts.areaBaseline : minY).toFixed(1);
      const polyPts = [
        `${xCoord(0).toFixed(1)},${baseLineY}`,
        ...pts,
        `${xCoord(s.values.length - 1).toFixed(1)},${baseLineY}`,
      ].join(" ");
      svg.appendChild(
        svgEl("polygon", {
          points: polyPts,
          fill: s.areaFill,
        })
      );
    }

    svg.appendChild(
      svgEl("polyline", {
        fill: "none",
        stroke: s.color,
        "stroke-width": String(s.width || 2.2),
        "stroke-dasharray": s.dashed ? "5,4" : "none",
        points: pts.join(" "),
      })
    );
  }

  container.appendChild(svg);
}
