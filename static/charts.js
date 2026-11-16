// Safe SVG chart, score gauge, currency formatter & stacked contribution renderer
// built exclusively with document.createElementNS and textContent.

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  return node;
}

export function formatCurrencyCompact(amount, currency = "INR") {
  const num = Number(amount || 0);
  const abs = Math.abs(num);
  const sign = num < 0 ? "-" : "";

  if (currency === "USD") {
    if (abs >= 1000000000) {
      const b = abs / 1000000000;
      return b >= 100
        ? `${sign}$${Math.round(b).toLocaleString("en-US")}B`
        : `${sign}$${b.toFixed(2)}B`;
    }
    if (abs >= 1000000) {
      const m = abs / 1000000;
      return m >= 100
        ? `${sign}$${Math.round(m).toLocaleString("en-US")}M`
        : `${sign}$${m.toFixed(2)}M`;
    }
    return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
  }

  if (abs >= 10000000) {
    const cr = abs / 10000000;
    return cr >= 100
      ? `${sign}₹${Math.round(cr).toLocaleString("en-IN")} Cr`
      : `${sign}₹${cr.toFixed(2)} Cr`;
  }
  if (abs >= 100000) {
    return `${sign}₹${(abs / 100000).toFixed(2)} L`;
  }
  return `${sign}₹${Math.round(abs).toLocaleString("en-IN")}`;
}

export function formatINRCompact(amount) {
  return formatCurrencyCompact(amount, "INR");
}

export function formatStockPrice(price, currency = "INR") {
  const num = Number(price || 0);
  if (currency === "USD") {
    return `$${num.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (Math.abs(num) < 100) {
    return `₹${num.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  return `₹${Math.round(num).toLocaleString("en-IN")}`;
}

export function formatMarketCap(mcapRaw, market = "IN", currency = "INR") {
  const num = Number(mcapRaw || 0);
  if (market === "US" || currency === "USD") {
    if (num >= 1000) {
      const b = num / 1000;
      return b >= 100
        ? `$${b.toLocaleString("en-US", { maximumFractionDigits: 1 })}B`
        : `$${b.toFixed(1)}B`;
    }
    return `$${Math.round(num).toLocaleString("en-US")}M`;
  }
  return `₹${Math.round(num).toLocaleString("en-IN")} Cr`;
}

export function createProgressSvg(percent, colorHex, height = 7) {
  const clamped = Math.max(0, Math.min(100, Number(percent || 0)));
  const svg = svgEl("svg", {
    viewBox: `0 0 200 ${height}`,
    width: "100%",
    height: String(height),
    preserveAspectRatio: "none",
  });
  svg.appendChild(
    svgEl("rect", {
      x: 0,
      y: 0,
      width: 200,
      height,
      rx: Math.round(height / 2),
      fill: "#172236",
    })
  );
  svg.appendChild(
    svgEl("rect", {
      x: 0,
      y: 0,
      width: (clamped * 2).toFixed(1),
      height,
      rx: Math.round(height / 2),
      fill: colorHex,
    })
  );
  return svg;
}

export function createScoreRingSvg(score, rating, size = 58) {
  const val = Math.max(0, Math.min(100, Number(score || 0)));
  let strokeColor = "#10b981";
  if (rating === "Buy") strokeColor = "#38bdf8";
  else if (rating === "Hold") strokeColor = "#f59e0b";
  else if (rating === "Avoid") strokeColor = "#f43f5e";

  const r = 23;
  const c = 2 * Math.PI * r;
  const dashOffset = c * (1 - val / 100);

  const svg = svgEl("svg", {
    viewBox: "0 0 56 56",
    width: String(size),
    height: String(size),
  });

  svg.appendChild(
    svgEl("circle", {
      cx: 28,
      cy: 28,
      r,
      fill: "#0d1524",
      stroke: "#1e2d47",
      "stroke-width": "4.5",
    })
  );

  svg.appendChild(
    svgEl("circle", {
      cx: 28,
      cy: 28,
      r,
      fill: "none",
      stroke: strokeColor,
      "stroke-width": "4.5",
      "stroke-linecap": "round",
      "stroke-dasharray": c.toFixed(2),
      "stroke-dashoffset": dashOffset.toFixed(2),
      transform: "rotate(-90 28 28)",
    })
  );

  const txt = svgEl("text", {
    x: 28,
    y: 32,
    fill: "#f1f5f9",
    "font-size": "13.5",
    "font-weight": "700",
    "text-anchor": "middle",
  });
  txt.textContent = val.toFixed(1);
  svg.appendChild(txt);
  return svg;
}

export function createContributionBarSvg(contributions, height = 8) {
  const c = contributions || { quality: 0, growth: 0, value: 0, momentum: 0 };
  const segments = [
    { val: Math.max(0, Number(c.quality || 0)), color: "#10b981" },
    { val: Math.max(0, Number(c.growth || 0)), color: "#818cf8" },
    { val: Math.max(0, Number(c.value || 0)), color: "#38bdf8" },
    { val: Math.max(0, Number(c.momentum || 0)), color: "#f59e0b" },
  ];

  const svg = svgEl("svg", {
    viewBox: `0 0 200 ${height}`,
    width: "100%",
    height: String(height),
    preserveAspectRatio: "none",
  });

  svg.appendChild(
    svgEl("rect", {
      x: 0,
      y: 0,
      width: 200,
      height,
      rx: Math.round(height / 2),
      fill: "#172236",
    })
  );

  let curX = 0;
  for (const seg of segments) {
    const w = Math.min(200 - curX, seg.val * 2.0);
    if (w > 0.4) {
      svg.appendChild(
        svgEl("rect", {
          x: curX.toFixed(1),
          y: 0,
          width: Math.max(0.4, w - 0.8).toFixed(1),
          height,
          rx: 1.5,
          fill: seg.color,
        })
      );
      curX += w;
    }
  }
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
  const height = opts.height || 245;
  const padL = 74;
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
      fill: "#8ea2c6",
      "font-size": "10.5",
      "text-anchor": "end",
    });
    lbl.textContent = yFormatter(val);
    svg.appendChild(lbl);
  }

  const xTickIndices = [0, Math.floor((xLabels.length - 1) / 2), xLabels.length - 1];
  for (const idx of xTickIndices) {
    const x = xCoord(idx);
    const anchor = idx === 0 ? "start" : idx === xLabels.length - 1 ? "end" : "middle";
    const t = svgEl("text", {
      x: x.toFixed(1),
      y: height - 8,
      fill: "#8ea2c6",
      "font-size": "10.5",
      "text-anchor": anchor,
    });
    t.textContent = String(xLabels[idx]);
    svg.appendChild(t);
  }

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
        "stroke-width": String(s.width || 2.3),
        "stroke-dasharray": s.dashed ? "5,4" : "none",
        points: pts.join(" "),
      })
    );
  }

  container.appendChild(svg);
}
