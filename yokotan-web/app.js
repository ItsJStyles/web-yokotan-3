(() => {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  /* ---------- Scroll progress ---------- */
  const bar = $(".scroll-progress");
  const updateProgress = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const p = max > 0 ? window.scrollY / max : 0;
    bar.style.transform = `scaleX(${p})`;
  };
  window.addEventListener("scroll", updateProgress, { passive: true });
  updateProgress();

  /* ---------- Reveal + count-up on scroll ---------- */
  const countUp = (node) => {
    const target = Number(node.dataset.count);
    if (reduceMotion) { node.textContent = target.toLocaleString("es-MX"); return; }
    const duration = 1600;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 4);
      node.textContent = Math.round(target * eased).toLocaleString("es-MX");
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const node = entry.target;
      node.classList.add("in");
      if (node.dataset.count && !node.dataset.done) {
        node.dataset.done = "1";
        countUp(node);
      }
      io.unobserve(node);
    }
  }, { threshold: 0.18, rootMargin: "0px 0px -6% 0px" });

  const observeAll = () => {
    document.querySelectorAll(".reveal, .stat-num").forEach((n) => io.observe(n));
  };

  /* ---------- Data ---------- */
  const statusEl = $("#map-status");
  let DATA = null;

  const renderMunicipios = (munis) => {
    const grid = $("#municipios");
    munis.forEach((m, i) => {
      const card = el("article", "muni");
      card.style.transitionDelay = `${i * 70}ms`;
      card.append(el("h3", null, m.nombre));
      const refs = m.localidades_indigenas_referidas.length;
      card.append(el("p", null, refs ? `${refs} localidades referidas en fuentes` : "Presencia yokot'an en el municipio"));
      grid.append(card);
      io.observe(card);
    });
  };

  const renderLocalidades = (locs) => {
    const list = $("#localidades");
    locs.forEach((l, i) => {
      const row = el("div", "loc");
      row.style.transitionDelay = `${i * 60}ms`;
      const info = el("div");
      info.append(el("strong", null, l.nombre));
      const sub = [l.municipio];
      if (l.nombre_yokot_an) sub.push(`yokot'an: ${l.nombre_yokot_an}`);
      info.append(el("small", null, sub.join(" · ")));
      row.append(info);
      const verified = l.coordenadas && typeof l.coordenadas.lat === "number";
      row.append(el("span", `badge${verified ? " ok" : ""}`, verified ? "Coordenadas verificadas" : "Pendiente INEGI"));
      list.append(row);
      io.observe(row);
    });
  };

  const renderSources = (fuentes) => {
    const ul = $("#sources");
    fuentes.forEach((f) => {
      const li = el("li");
      const a = el("a");
      a.href = f.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.append(el("strong", null, f.titulo));
      a.append(el("span", null, f.nota));
      li.append(a);
      ul.append(li);
    });
  };

  /* ---------- Map ---------- */
  const initMap = (data) => {
    if (typeof L === "undefined") {
      statusEl.textContent = "El mapa no pudo cargar la librería Leaflet. Revisa tu conexión y recarga la página.";
      return;
    }
    const map = L.map("map", { scrollWheelZoom: false, zoomControl: true }).setView([17.95, -92.75], 9);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 16,
      attribution: "&copy; OpenStreetMap",
    }).addTo(map);

    const bounds = [];
    data.municipios.forEach((m) => {
      const icon = L.divIcon({ className: "", html: '<div class="muni-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
      const marker = L.marker([m.cabecera.lat, m.cabecera.lon], { icon, title: m.nombre }).addTo(map);
      marker.bindPopup(`<strong>${m.nombre}</strong><br>Cabecera municipal (aprox.)`);
      bounds.push([m.cabecera.lat, m.cabecera.lon]);
    });

    let placed = 0;
    data.localidades.forEach((l) => {
      if (!l.coordenadas || typeof l.coordenadas.lat !== "number") return;
      L.circleMarker([l.coordenadas.lat, l.coordenadas.lon], {
        radius: 7, color: "#b5532f", weight: 2, fillColor: "#e08a63", fillOpacity: 0.9,
      }).addTo(map).bindPopup(`<strong>${l.nombre}</strong><br>${l.municipio}`);
      bounds.push([l.coordenadas.lat, l.coordenadas.lon]);
      placed++;
    });

    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] });
    statusEl.textContent = placed
      ? `${placed} localidad(es) con coordenadas verificadas. Las demás aparecerán al verificarse en el catálogo del INEGI.`
      : "Aún no hay coordenadas verificadas de localidades. Se muestran las cabeceras municipales, aproximadas.";
  };

  /* ---------- Trilateration ---------- */
  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = $("#tri-svg");
  const circlesG = $("#tri-circles");
  const anchorsG = $("#tri-anchors");
  const target = $("#tri-target");
  const estimate = $("#tri-estimate");
  const err = $("#tri-err");
  const noise = $("#noise");
  const noiseOut = $("#noiseOut");

  const PX_TO_KM = 0.1; // 600 px = 60 km del plano local
  const anchors = [
    { id: "A", x: 120, y: 110 },
    { id: "B", x: 480, y: 92 },
    { id: "C", x: 300, y: 340 },
  ];
  const state = { x: 330, y: 200 };

  const svgEl = (tag, attrs = {}) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  const circles = anchors.map((a) => {
    const fill = svgEl("circle", { class: "tri-circle-fill" });
    const ring = svgEl("circle", { class: "tri-circle" });
    circlesG.append(fill, ring);
    return { fill, ring };
  });

  anchors.forEach((a) => {
    anchorsG.append(svgEl("circle", { cx: a.x, cy: a.y, r: 6, class: "tri-anchor" }));
    const t = svgEl("text", { x: a.x + 12, y: a.y - 10, class: "tri-anchor-label" });
    t.textContent = `Estación ${a.id}`;
    anchorsG.append(t);
  });

  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  // Intersección de tres círculos: se resta la primera ecuación a las otras dos
  // y se resuelve el sistema lineal 2x2 resultante (regla de Cramer).
  const trilaterate = (d) => {
    const [a, b, c] = anchors;
    const A11 = 2 * (b.x - a.x), A12 = 2 * (b.y - a.y);
    const A21 = 2 * (c.x - a.x), A22 = 2 * (c.y - a.y);
    const k = (p) => p.x * p.x + p.y * p.y;
    const B1 = d[0] * d[0] - d[1] * d[1] + k(b) - k(a);
    const B2 = d[0] * d[0] - d[2] * d[2] + k(c) - k(a);
    const det = A11 * A22 - A12 * A21;
    if (Math.abs(det) < 1e-6) return null; // estaciones alineadas: no hay solución única
    return { x: (B1 * A22 - A12 * B2) / det, y: (A11 * B2 - B1 * A21) / det };
  };

  const toSvgPoint = (evt) => {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    return { x: Math.max(12, Math.min(588, p.x)), y: Math.max(12, Math.min(408, p.y)) };
  };

  const fmtKm = (px) => `${(px * PX_TO_KM).toFixed(1)} km`;

  const render = () => {
    const exact = anchors.map((a) => Math.hypot(state.x - a.x, state.y - a.y));
    const nSigma = Number(noise.value);
    const measured = exact.map((d) => Math.max(0, d + gauss() * nSigma));

    circles.forEach((c, i) => {
      const r = measured[i];
      const ax = anchors[i];
      c.ring.setAttribute("cx", ax.x);
      c.ring.setAttribute("cy", ax.y);
      c.ring.setAttribute("r", r);
      c.fill.setAttribute("cx", ax.x);
      c.fill.setAttribute("cy", ax.y);
      c.fill.setAttribute("r", r);
    });

    target.setAttribute("cx", state.x);
    target.setAttribute("cy", state.y);

    const est = trilaterate(measured);
    if (est) {
      estimate.style.opacity = "1";
      estimate.setAttribute("cx", est.x.toFixed(2));
      estimate.setAttribute("cy", est.y.toFixed(2));
      err.style.opacity = "1";
      err.setAttribute("x1", state.x);
      err.setAttribute("y1", state.y);
      err.setAttribute("x2", est.x.toFixed(2));
      err.setAttribute("y2", est.y.toFixed(2));
      const e = Math.hypot(est.x - state.x, est.y - state.y);
      $("#dErr").textContent = fmtKm(e);
    } else {
      estimate.style.opacity = "0";
      err.style.opacity = "0";
      $("#dErr").textContent = "sin solución";
    }

    $("#dA").textContent = fmtKm(measured[0]);
    $("#dB").textContent = fmtKm(measured[1]);
    $("#dC").textContent = fmtKm(measured[2]);
  };

  const setupDrag = () => {
    let dragging = false;
    const move = (evt) => {
      if (!dragging) return;
      const p = toSvgPoint(evt);
      state.x = p.x;
      state.y = p.y;
      render();
    };
    svg.addEventListener("pointerdown", (evt) => {
      dragging = true;
      svg.setPointerCapture(evt.pointerId);
      move(evt);
    });
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", () => { dragging = false; });
    svg.addEventListener("pointercancel", () => { dragging = false; });
  };

  noise.addEventListener("input", () => {
    noiseOut.textContent = `${noise.value} px`;
    render();
  });

  /* ---------- Boot ---------- */
  const boot = async () => {
    observeAll();
    setupDrag();
    render();

    try {
      const res = await fetch("data/localidades.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      DATA = await res.json();
    } catch (e) {
      statusEl.textContent = "No se pudieron cargar los datos de localidades. Abre la página desde un servidor local (por ejemplo, npx serve).";
      $("#localidades").append(el("p", "note", "Datos no disponibles en este momento."));
      return;
    }

    renderMunicipios(DATA.municipios);
    renderLocalidades(DATA.localidades);
    renderSources(DATA.fuentes);
    initMap(DATA);
    observeAll();
  };

  boot();
})();
