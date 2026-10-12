(() => {
  'use strict';

  // Global mouse-controlled scene movement + custom cursor.
  //
  // Sizing, safe-travel derivation, smoothing shape, and cursor mechanics
  // are adapted from the Glonari Global Campus reference implementation
  // (see PROJECT_RULES/UI_LAYOUT_CAMPUS there) — reused as a proven
  // technique, not copied wholesale. .scene-world itself stays statically
  // centered; each .layer gets its own depth-scaled movement transform
  // (per-layer parallax) — see the "layers" setup and applyLayerTransforms()
  // below.

  // Logical Figma frame size — the internal 2050x800 coordinate system
  // every .layer's percentage position/size is still expressed against.
  const IMG_W = 2050;
  const IMG_H = 800;

  // Overscan beyond pure "object-fit: cover" fit. Cover math alone leaves
  // zero slack on whichever axis drives the scale — for this composition
  // that's almost always the height axis on real desktop viewports, which
  // would leave zero room for vertical drift without this.
  const BLEED = 1.035;

  // Hard cap on vertical travel regardless of how much bleed slack the
  // current viewport ratio provides, so vertical movement always reads
  // as subtle/secondary to horizontal.
  const MAX_TRAVEL_Y_PX = 24;

  // Damping time constant (seconds), frame-rate independent. Shared by
  // both axes — the dominant/secondary feel comes from the amplitude
  // (maxTravelX vs maxTravelY, derived from real overflow below), not
  // from different easing speeds per axis.
  const TAU = 0.6;

  const STOP_THRESHOLD = 0.05; // px

  const viewport = document.querySelector('.stage-viewport');
  const world = document.querySelector('.scene-world');
  if (!viewport || !world) return;

  // Per-layer parallax: each .layer carries its own depth multiplier
  // applied on top of the shared pointer offset below — sky/buildings lag
  // behind (background), plaza leads (foreground). Sky and plaza use a
  // fixed data-depth (design constants); buildings instead carry their
  // real logical position (data-left/data-width, the same 2050x800-frame
  // numbers already used to position them in CSS), and their depth is
  // derived from that geometry inside layout() below.
  const layers = Array.from(document.querySelectorAll('.layer')).map((el) => ({
    el,
    depth: parseFloat(el.dataset.depth) || 1,
    leftPx: el.dataset.left !== undefined ? parseFloat(el.dataset.left) : null,
    widthPx: el.dataset.width !== undefined ? parseFloat(el.dataset.width) : null,
  }));
  const plazaLayer = layers.find((layer) => layer.el.classList.contains('plaza'));

  // Floor applied to buildings that are already fully visible at rest
  // (their required reveal shift is 0) — keeps them participating in the
  // depth effect instead of sitting perfectly still.
  const BASELINE_BUILDING_DEPTH = 0.55;

  // Hover z-index override: normal building z-index is depth-derived
  // (roughly 55-110, see layout() below) so that adjacent buildings
  // correctly occlude each other at a parallax-shifted seam. Once a
  // building is hover-scaled (see the "Building hover" section further
  // down) its enlarged edges can reach into a neighbor's footprint, so
  // the hovered building needs to temporarily win that stacking order
  // regardless of its own depth. Kept below the plaza's fixed z-index
  // (1000) on purpose — plaza is the deliberate foreground layer and
  // should keep covering building bases as it already does at rest.
  // Declared here (not inside the later hover section) because layout()
  // below reads it on every pass, including its first call at startup.
  const HOVER_Z_INDEX = 500;
  let hoveredBuildingEl = null;

  const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)');

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // ---------- Presenter close-up (Meet Gia) ----------
  // The plaza presenter is the scene's lead: a close-up framed in viewport
  // terms, not plaza tiles — scaled PRESENTER_SCALE x her former size
  // (CSS width 10.64% of the 2050 frame, i.e. a 218.12x367.57 logical
  // 540x910 frame) and positioned so the viewport's bottom edge crosses
  // her knees. Measurements are in the 540x910 frame: head top y 20, knee
  // y ~645 (mid-thigh ~560, mid-shin ~745 — the allowed band for the
  // bottom edge), static figure centre x 194, and the hitmask's full reach
  // incl. the gesture arm x 16-523. Sized/placed in layout(); her
  // horizontal parallax is the plaza's, damped per side (presenterRoom)
  // just enough that the figure never reaches a viewport edge.
  const PRESENTER_SCALE = 1.84;
  const PRESENTER_CENTER_X_VW = 0.22;
  const PRESENTER_BASE_H = 367.57;
  const PRESENTER_FRAME_W = 540;
  const PRESENTER_FRAME_H = 910;
  const PRESENTER_HEAD_Y = 20;
  const PRESENTER_KNEE_Y = 645;
  const PRESENTER_FIGURE_X = 194;
  const PRESENTER_REACH_LEFT = 16;
  const PRESENTER_REACH_RIGHT = 523;
  const PRESENTER_HEAD_MIN_VH = 0.12; // head-top floor (leaves room for the hover scale-up)
  const PRESENTER_EDGE_PX = 12;
  const presenterBox = document.querySelector('.presenter');
  const presenterRoom = { kLeft: 1, kRight: 1 };

  function layoutPresenter(vw, vh, renderW, renderH, scale, plazaMaxShiftX) {
    if (!presenterBox) return;
    const reachW = PRESENTER_REACH_RIGHT - PRESENTER_REACH_LEFT;
    let h = PRESENTER_SCALE * PRESENTER_BASE_H * scale;
    // Ultra-wide (width-driven cover) or very narrow windows: shrink
    // rather than crop the head or push the reach past the sides.
    h = Math.min(
      h,
      (vh * (1 - PRESENTER_HEAD_MIN_VH) * PRESENTER_FRAME_H) / (PRESENTER_KNEE_Y - PRESENTER_HEAD_Y),
      ((vw - 2 * PRESENTER_EDGE_PX) * PRESENTER_FRAME_H) / reachW,
    );
    const px = h / PRESENTER_FRAME_H; // screen px per frame px
    const cx = clamp(
      vw * PRESENTER_CENTER_X_VW,
      PRESENTER_EDGE_PX + (PRESENTER_FIGURE_X - PRESENTER_REACH_LEFT) * px,
      vw - PRESENTER_EDGE_PX - (PRESENTER_REACH_RIGHT - PRESENTER_FIGURE_X) * px,
    );
    const frameLeft = cx - PRESENTER_FIGURE_X * px;
    const frameTop = vh - PRESENTER_KNEE_Y * px;

    // .presenter lives in .layer.plaza, whose box is .scene-world's
    // (centered, top-left at ((vw-renderW)/2, (vh-renderH)/2) at rest).
    presenterBox.style.left = `${frameLeft - (vw - renderW) / 2}px`;
    presenterBox.style.top = `${frameTop - (vh - renderH) / 2}px`;
    presenterBox.style.width = `${PRESENTER_FRAME_W * px}px`;

    const roomLeft = frameLeft + PRESENTER_REACH_LEFT * px - PRESENTER_EDGE_PX;
    const roomRight = vw - PRESENTER_EDGE_PX - (frameLeft + PRESENTER_REACH_RIGHT * px);
    presenterRoom.kLeft = plazaMaxShiftX > 0 ? clamp(roomLeft / plazaMaxShiftX, 0, 1) : 1;
    presenterRoom.kRight = plazaMaxShiftX > 0 ? clamp(roomRight / plazaMaxShiftX, 0, 1) : 1;
  }

  // ---------- Cover-fit sizing + real-overflow safe travel ----------
  // .scene-world is sized in real pixels to the "object-fit: cover"
  // render size of the 2050x800 frame for the current viewport (plus
  // BLEED). Because the frame's aspect ratio (2.5625) is far wider than
  // any realistic desktop viewport, the height axis drives the scale,
  // and the composition naturally renders much wider than the viewport —
  // that horizontal overflow *is* the real space mouse movement explores.
  // No artificial headroom/buffer layer is used: every pixel a translate
  // can reveal is actual rendered composition.
  let maxTravelX = 0;
  let maxTravelY = 0;

  function layout() {
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (vw === 0 || vh === 0) return;

    const scale = Math.max(vw / IMG_W, vh / IMG_H) * BLEED;
    const renderW = IMG_W * scale;
    const renderH = IMG_H * scale;

    world.style.width = `${renderW}px`;
    world.style.height = `${renderH}px`;

    // Real safe travel for a full-bleed layer (sky, plaza — both exactly
    // as wide as .scene-world, with zero horizontal slack of their own
    // beyond this bleed): how far it can shift before its own edge enters
    // the viewport.
    const worldMaxTravelX = Math.max(0, (renderW - vw) / 2);
    const worldMaxTravelY = Math.min(Math.max(0, (renderH - vh) / 2), MAX_TRAVEL_Y_PX);

    // Each building's depth is derived from its actual geometry, not
    // guessed: compute how far its clipped edge sits from the viewport
    // edge at rest (the "required shift" to fully reveal it), express
    // that as a fraction of worldMaxTravelX, then scale by the plaza
    // reference depth — a building needing the full worldMaxTravelX
    // reach (ratio 1) lands at the same depth as plaza, so it becomes
    // exactly as fully revealed at the pointer extreme.
    for (const layer of layers) {
      if (layer.leftPx === null) continue; // sky/plaza keep their fixed data-depth
      const leftAbs = renderW * (layer.leftPx / IMG_W - 0.5);
      const rightAbs = renderW * ((layer.leftPx + layer.widthPx) / IMG_W - 0.5);
      const vwHalf = vw / 2;
      const requiredShift = Math.max(0, -vwHalf - leftAbs, rightAbs - vwHalf);
      const ratio = worldMaxTravelX > 0 ? requiredShift / worldMaxTravelX : 0;
      layer.depth = Math.max(BASELINE_BUILDING_DEPTH, ratio * plazaLayer.depth);

      // Adjacent buildings move at different rates, so at nonzero offset
      // their shared edge no longer lines up — one overlaps into the
      // other's footprint. Stack the higher-depth (faster, more
      // foreground-like) neighbor on top so it's the one that occludes,
      // matching how closer objects naturally cover farther ones.
      // The currently-hovered building overrides this with a flat, much
      // higher z-index instead (see HOVER_Z_INDEX above) so its hover
      // scale is never clipped by a neighbor — re-applied here too so a
      // resize mid-hover doesn't clobber the override with the natural
      // depth-based value.
      layer.el.style.zIndex =
        layer.el === hoveredBuildingEl ? String(HOVER_Z_INDEX) : String(Math.round(layer.depth * 100));
    }

    // Normalize so the deepest layer (usually plaza, but a building can
    // take over if its required reveal exceeds worldMaxTravelX) is the
    // one that reaches worldMaxTravelX/Y exactly — never more, since
    // that's the hard ceiling a full-bleed layer can safely travel.
    // Every other, shallower layer then gets its own smaller share of
    // this reference range via its depth multiplier in
    // applyLayerTransforms(), so it always moves less and stays safe
    // automatically.
    const maxDepth = layers.reduce((max, layer) => Math.max(max, layer.depth), 1);
    maxTravelX = worldMaxTravelX / maxDepth;
    maxTravelY = worldMaxTravelY / maxDepth;

    layoutPresenter(vw, vh, renderW, renderH, scale, maxTravelX * plazaLayer.depth);

    // Keep any in-flight target within the freshly recomputed range.
    target.x = clamp(target.x, -maxTravelX, maxTravelX);
    target.y = clamp(target.y, -maxTravelY, maxTravelY);
  }

  // applyLayerTransforms() too: the presenter's per-side damping changes
  // with the viewport even while the pointer offset doesn't.
  function relayout() {
    layout();
    applyLayerTransforms();
  }
  window.addEventListener('resize', relayout);
  window.addEventListener('orientationchange', relayout);

  // ---------- Pointer-driven movement (independent transform per .layer) ----------
  const target = { x: 0, y: 0 };
  const offset = { x: 0, y: 0 };
  let rafId = null;
  let lastTime = null;

  function applyLayerTransforms() {
    for (const layer of layers) {
      const lx = (offset.x * layer.depth).toFixed(2);
      const ly = (offset.y * layer.depth).toFixed(2);
      layer.el.style.transform = `translate3d(${lx}px, ${ly}px, 0)`;
    }
    // Counter-shift inside the plaza so the presenter travels k x the
    // plaza's horizontal shift (see layoutPresenter()).
    if (presenterBox) {
      const shift = offset.x * plazaLayer.depth;
      const k = shift < 0 ? presenterRoom.kLeft : presenterRoom.kRight;
      presenterBox.style.transform = `translate3d(${(shift * (k - 1)).toFixed(2)}px, 0, 0)`;
    }
  }

  function startLoop() {
    if (rafId !== null) return;
    lastTime = null;
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    lastTime = null;
  }

  function tick(now) {
    if (lastTime === null) lastTime = now;
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    const ease = 1 - Math.exp(-dt / TAU);
    offset.x += (target.x - offset.x) * ease;
    offset.y += (target.y - offset.y) * ease;

    const settled =
      Math.abs(target.x - offset.x) < STOP_THRESHOLD &&
      Math.abs(target.y - offset.y) < STOP_THRESHOLD;

    if (settled) {
      offset.x = target.x;
      offset.y = target.y;
      applyLayerTransforms();
      stopLoop();
      return;
    }

    applyLayerTransforms();
    rafId = requestAnimationFrame(tick);
  }

  function setTargetFromPointer(clientX, clientY) {
    const rect = viewport.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const nx = clamp(((clientX - rect.left) / rect.width - 0.5) * 2, -1, 1);
    const ny = clamp(((clientY - rect.top) / rect.height - 0.5) * 2, -1, 1);

    // Negated: moving the pointer right shifts the world left, bringing
    // the scene's right side into view — the pointer indicates where to
    // "look", not a handle the world drags along 1:1.
    target.x = -nx * maxTravelX;
    target.y = -ny * maxTravelY;

    startLoop();
  }

  function resetTarget() {
    target.x = 0;
    target.y = 0;
    startLoop();
  }

  function handlePointerMove(event) {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    setTargetFromPointer(event.clientX, event.clientY);
  }

  function handlePointerLeave(event) {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    resetTarget();
  }

  function enableMovement() {
    viewport.addEventListener('pointermove', handlePointerMove);
    viewport.addEventListener('pointerleave', handlePointerLeave);
    window.addEventListener('blur', resetTarget);
  }

  function disableMovement() {
    viewport.removeEventListener('pointermove', handlePointerMove);
    viewport.removeEventListener('pointerleave', handlePointerLeave);
    window.removeEventListener('blur', resetTarget);
    stopLoop();
    target.x = 0;
    target.y = 0;
    offset.x = 0;
    offset.y = 0;
    applyLayerTransforms();
  }

  function applyMotionPreference() {
    if (reduceMotionQuery.matches) {
      disableMovement();
    } else {
      enableMovement();
    }
  }

  layout();
  applyLayerTransforms();
  applyMotionPreference();
  reduceMotionQuery.addEventListener('change', applyMotionPreference);

  // ---------- Building hover (silhouette-accurate hit-testing) ----------
  // Bounding-box hover would trigger across each building's transparent
  // PNG padding, not just its visible facade — adapted here from the
  // Glonari Global Campus reference concept of a defined "hit area" per
  // building, but implemented against this project's real per-building
  // alpha channel (the reference itself uses hand-measured rectangular
  // hotspots, not pixel alpha, since it renders one flattened image; each
  // building here is already its own transparent-background PNG, which
  // makes true silhouette hit-testing both possible and more accurate).
  // Detection is done via direct pointer coordinate math against each
  // building's own rendered box (which already reflects its live
  // parallax translate3d), independent of native pointer-events/:hover —
  // this sidesteps the foreground .plaza layer's bounding box (z-index
  // 1000, sized near-full-scene) ever swallowing hover before it reaches
  // a building underneath.
  const HOVER_ALPHA_THRESHOLD = 20; // 0-255; ignores near-fully-transparent pixels

  const buildings = Array.from(document.querySelectorAll('.layer.building')).map((el) => ({
    el,
    img: el.querySelector('img'),
    canvas: null,
    ctx: null,
    ready: false,
  }));

  // The plaza presenter (Meet Gia) joins the same list as one more
  // hover/click/focus target. Its hit mask is a separate, never-rendered
  // silhouette (assets/presenter-hitmask.png: same 540x910 frame as the
  // video, union of every arm position, no ground shadow) sampled against
  // whichever media is actually shown (the video, or the poster under
  // html.no-alpha-webm) — that box already carries the plaza's parallax.
  // It lives inside .layer.plaza (z-index 1000, above every building), so
  // where it overlaps a building it always wins (zPriority).
  const presenterEl = document.querySelector('.presenter');
  if (presenterEl) {
    const hitImg = new Image();
    hitImg.src = 'assets/presenter-hitmask.png';
    buildings.push({
      el: presenterEl,
      img: hitImg,
      hitEl: () => presenterEl.querySelector('.presenter__video') || presenterEl.querySelector('.presenter__poster img'),
      zPriority: Infinity,
      canvas: null,
      ctx: null,
      ready: false,
    });
  }
  // Set by setupPresenterGesture() (see the end of this file); hover entry
  // onto the presenter asks it for a replay under its usual rules.
  let presenterGesture = null;

  function prepareBuildingMask(building) {
    const { img } = building;
    if (!img.naturalWidth || !img.naturalHeight) return;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    building.canvas = canvas;
    building.ctx = ctx;
    building.ready = true;
  }

  for (const building of buildings) {
    if (building.img.complete) {
      prepareBuildingMask(building);
    } else {
      building.img.addEventListener('load', () => prepareBuildingMask(building), { once: true });
    }
  }

  // Maps a viewport point to a natural-pixel coordinate in the building's
  // own source image, honoring whichever object-fit the image actually
  // uses (cover for most buildings; the ancillary crop technique relies
  // on the default "fill" stretch instead) — so the same function works
  // for both without hardcoding per-building crop math here.
  function sampleAlpha(building, clientX, clientY) {
    if (!building.ready) return 0;
    const hitEl = building.hitEl ? building.hitEl() : building.img;
    if (!hitEl) return 0;
    const rect = hitEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return 0;

    const lx = (clientX - rect.left) / rect.width;
    const ly = (clientY - rect.top) / rect.height;
    if (lx < 0 || lx > 1 || ly < 0 || ly > 1) return 0;

    const nw = building.canvas.width;
    const nh = building.canvas.height;
    let ix;
    let iy;

    if (getComputedStyle(hitEl).objectFit === 'cover') {
      const scale = Math.max(rect.width / nw, rect.height / nh);
      const drawW = nw * scale;
      const drawH = nh * scale;
      const offX = (rect.width - drawW) / 2;
      const offY = (rect.height - drawH) / 2;
      ix = (lx * rect.width - offX) / scale;
      iy = (ly * rect.height - offY) / scale;
    } else {
      ix = lx * nw;
      iy = ly * nh;
    }

    ix = Math.floor(clamp(ix, 0, nw - 1));
    iy = Math.floor(clamp(iy, 0, nh - 1));

    try {
      return building.ctx.getImageData(ix, iy, 1, 1).data[3];
    } catch (err) {
      // Tainted canvas (e.g. page opened via file:// instead of served
      // over http) — fail closed: no hover rather than a thrown error.
      return 0;
    }
  }

  // Cursor handle shared with the "Custom cursor" section further down —
  // declared here (not there) because building hover needs to toggle its
  // "hover" class the moment hover state changes, independent of whether
  // this device matches finePointerQuery (that gate only controls the
  // cursor's own position-tracking loop below; toggling a class on an
  // element that's display:none on non-fine-pointer devices is harmless).
  const cursorDot = document.querySelector('.cursor-dot');

  // Two independent input-mode states feed the same visual "elevated"
  // look (glow + scale + z-index boost + cursor reaction): hoveredBuilding
  // (mouse, via alpha hit-testing) and focusedBuilding (keyboard, via
  // native focus/blur on the now-tabbable building elements — see the
  // "Keyboard access" loop below). Kept separate so a mouse pointerleave
  // firing elsewhere can't clobber a keyboard user's focus state and vice
  // versa; applyElevated()/recomputeElevated() reconcile them into the one
  // building that's actually shown as elevated at any moment.
  let hoveredBuilding = null;
  let focusedBuilding = null;
  let elevatedBuilding = null;

  // Restores a building to its normal depth-derived z-index (or, if it's
  // the currently-elevated one, applies the HOVER_Z_INDEX override) —
  // shared by both applyElevated() below and layout()'s own per-resize
  // pass, so there's one formula, not two copies of it.
  function refreshZIndex(el) {
    const layerEntry = layers.find((l) => l.el === el);
    if (!layerEntry) return;
    el.style.zIndex = el === hoveredBuildingEl ? String(HOVER_Z_INDEX) : String(Math.round(layerEntry.depth * 100));
  }

  function applyElevated(building) {
    if (building === elevatedBuilding) return;
    const previousEl = elevatedBuilding ? elevatedBuilding.el : null;
    if (elevatedBuilding) elevatedBuilding.el.classList.remove('is-hovered');
    if (building) building.el.classList.add('is-hovered');
    elevatedBuilding = building;
    // hoveredBuildingEl is the name layout()/refreshZIndex() already know
    // about (see HOVER_Z_INDEX above) — reused as-is here rather than
    // introducing a second z-index-override variable for the same job.
    hoveredBuildingEl = building ? building.el : null;
    if (previousEl) refreshZIndex(previousEl);
    if (building) refreshZIndex(building.el);
    // Same trigger (real silhouette hit or keyboard focus, never a
    // rectangular bounding box) drives the reference project's cursor
    // hover reaction — see .cursor-dot.hover in styles.css.
    if (cursorDot) cursorDot.classList.toggle('hover', building !== null);
  }

  function recomputeElevated() {
    applyElevated(hoveredBuilding || focusedBuilding);
  }

  function updateBuildingHover(clientX, clientY) {
    // While the section modal is open it visually covers the scene, but
    // this hit-testing is raw coordinate math, not native pointer-events —
    // it would otherwise keep "seeing" a building right through the
    // modal. Suspend it entirely for the duration.
    if (sectionModal && sectionModal.isOpen()) return;

    // When two buildings' boxes momentarily overlap at a parallax-shifted
    // seam, prefer whichever one the depth-based z-index already renders
    // on top, so hover matches what's visually in front.
    let best = null;
    let bestZ = -Infinity;
    for (const building of buildings) {
      if (sampleAlpha(building, clientX, clientY) <= HOVER_ALPHA_THRESHOLD) continue;
      const z = building.zPriority || parseInt(building.el.style.zIndex, 10) || 0;
      if (z > bestZ) {
        best = building;
        bestZ = z;
      }
    }
    if (best && best.el === presenterEl && hoveredBuilding !== best && presenterGesture) {
      presenterGesture.replay();
    }
    hoveredBuilding = best;
    recomputeElevated();
  }

  function clearBuildingHover() {
    hoveredBuilding = null;
    recomputeElevated();
  }

  // Independent of enableMovement()/disableMovement() above: hover is a
  // static affordance, not the vestibular-motion concern reduced-motion
  // targets (the reference project keeps its own hover transitions active
  // under reduced-motion for the same reason), so it stays wired
  // regardless of the movement/reduced-motion state.
  viewport.addEventListener('pointermove', (event) => {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    updateBuildingHover(event.clientX, event.clientY);
  });
  viewport.addEventListener('pointerleave', clearBuildingHover);
  window.addEventListener('blur', clearBuildingHover);

  // ---------- Section modal (click a building to open) ----------
  // Content, open/close, and focus-trap behavior live in section-modal.js
  // (shared with mobile/main.js) — see index.html/section-modal.css for
  // the matching markup/CSS. Only what's desktop-specific stays here: the
  // hover→click trigger, and clearing hover state when the modal opens.
  function getBuildingKey(el) {
    if (el === presenterEl) return 'presenter';
    return Array.from(el.classList).find((cls) => cls.startsWith('building-')) || null;
  }

  // ---------- Cross-project navigation (Digital Banker, Meet Gia presenter) ----------
  // Every other building opens the in-page section modal (below). Digital
  // Banker is the one exception: it leaves this page entirely for the
  // separate Digital-Banker-GIA scroll-cinematic project. NAV_TARGETS maps
  // a building key to that destination so adding a future building->site
  // link (e.g. Global Dream once it has its own project) only means adding
  // one more entry here, not another special-cased branch.
  const NAV_TARGETS = {
    'building-banker': 'digital-banker/gia/index.html',
    'presenter': 'meet-gia/index.html',
  };

  const exitTransition = document.getElementById('exit-transition');
  // Matches #exit-transition's CSS transition duration (styles.css) plus a
  // small margin, so the fade is visually complete before the real
  // navigation swaps the page out from under it.
  const EXIT_FADE_MS = 550;

  function navigateWithFade(url) {
    if (!exitTransition) {
      window.location.href = url;
      return;
    }
    exitTransition.classList.add('active');
    window.setTimeout(() => {
      window.location.href = url;
    }, EXIT_FADE_MS);
  }

  // Single entry point for "a building was activated" (click or keyboard),
  // used by both call sites below instead of each duplicating the
  // NAV_TARGETS check.
  function activateBuilding(key, el) {
    const target = NAV_TARGETS[key];
    if (target) {
      navigateWithFade(target);
      return;
    }
    if (!sectionModal || sectionModal.isOpen()) return;
    sectionModal.open(key, el);
  }

  const sectionModal = window.SectionModal.create({
    overlay: document.getElementById('modal-overlay'),
    card: document.getElementById('modal-card'),
    title: document.getElementById('modal-title'),
    desc: document.getElementById('modal-desc'),
    closeBtn: document.getElementById('modal-close'),
    // The modal visually covers the building being hovered/clicked — drop
    // its hover state so the glow/scale doesn't linger, pointlessly, under
    // the overlay for as long as the modal stays open.
    onOpen: () => {
      clearBuildingHover();
      // Same body-level flag the former digital-banker/lobby/ page used
      // to hide its own persistent hint while a modal covers the scene —
      // .explore-hint (styles.css) is hidden by this class, not by any
      // per-element open/close call here.
      document.body.classList.add('modal-active');
    },
    onClose: () => {
      document.body.classList.remove('modal-active');
    },
  });

  viewport.addEventListener('click', () => {
    if (!hoveredBuilding) return;
    if (sectionModal && sectionModal.isOpen()) return;
    activateBuilding(getBuildingKey(hoveredBuilding.el), hoveredBuilding.el);
  });

  // ---------- Keyboard access (buildings) ----------
  // Not present in the Glonari Global Campus reference to carry over
  // either — its hit areas are real <button> elements, which get
  // keyboard focusability and Enter/Space activation for free from the
  // browser. This project's buildings are plain <div> layers (needed for
  // the alpha-mask hit-testing above), so both have to be added by hand:
  // tabindex="0"/role="button" in index.html make them reachable, and
  // this loop supplies the activation behavior a real <button> would
  // otherwise provide natively.
  for (const building of buildings) {
    building.el.addEventListener('focus', () => {
      focusedBuilding = building;
      recomputeElevated();
    });
    building.el.addEventListener('blur', () => {
      if (focusedBuilding !== building) return;
      focusedBuilding = null;
      recomputeElevated();
    });
    building.el.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      event.preventDefault(); // Space must not also scroll the page
      if (sectionModal && sectionModal.isOpen()) return;
      activateBuilding(getBuildingKey(building.el), building.el);
    });
  }

  // ---------- Custom cursor (fine-pointer desktop only) ----------
  // Gated so touch/coarse-pointer devices never attach these listeners at
  // all (CSS also hides the elements independently). Entirely independent
  // of the scene's own transform/state above.
  if (finePointerQuery.matches) {
    const cursorRing = document.querySelector('.cursor-ring');

    if (cursorDot && cursorRing) {
      let mx = window.innerWidth / 2;
      let my = window.innerHeight / 2;
      let rx = mx;
      let ry = my;

      cursorDot.style.left = `${mx}px`;
      cursorDot.style.top = `${my}px`;
      cursorRing.style.left = `${rx}px`;
      cursorRing.style.top = `${ry}px`;

      window.addEventListener('pointermove', (event) => {
        if (event.pointerType !== 'mouse') return;
        mx = event.clientX;
        my = event.clientY;
        cursorDot.style.left = `${mx}px`;
        cursorDot.style.top = `${my}px`;
      });

      function ringLoop() {
        rx += (mx - rx) * 0.15;
        ry += (my - ry) * 0.15;
        cursorRing.style.left = `${rx}px`;
        cursorRing.style.top = `${ry}px`;
        requestAnimationFrame(ringLoop);
      }
      ringLoop();
    }
  }

  // ---------- Fountain water video (reduced-motion) ----------
  // PRODUCT_REQUIREMENTS.md §21: any global movement must respect
  // prefers-reduced-motion. autoplay/loop can't be gated in CSS for
  // <video>, so it's paused here on a matching frame (leaving the pool
  // showing whatever frame it stopped on, rather than removed entirely) and
  // resumed if the OS-level setting changes live — same reduceMotionQuery
  // instance declared above, mirroring index.html's own live-query pattern.
  // The presenter video is loaded here too but driven by its own
  // play-once/replay logic (setupPresenterGesture below). Its <source> ships as
  // data-src: under html.no-alpha-webm (WebKit, see index.html <head>) the
  // video is removed unfetched and only the poster <picture> shows;
  // everywhere else the src is filled in and loaded here.
  const loopVideos = [document.querySelector('.water-video')];
  const presenterVideo = document.querySelector('.presenter__video');
  if (presenterVideo) {
    if (document.documentElement.classList.contains('no-alpha-webm')) {
      presenterVideo.remove();
    } else {
      presenterVideo.querySelectorAll('source[data-src]').forEach((source) => {
        source.src = source.dataset.src;
      });
      presenterVideo.load();
      presenterGesture = setupPresenterGesture(presenterVideo);
    }
  }

  // ---------- Presenter gesture (play once, replay on mouse movement) ----------
  // No loop/autoplay on .presenter__video: the greeting plays once on load
  // (after the branded intro has faded out, if one is shown) and rests on
  // its last frame (arm lowered). A noticeable mouse movement
  // over the scene replays it from the start — never mid-gesture, never
  // within the cooldown after it ends, never while the tab is hidden.
  // Touch-only devices produce no mouse pointermove, so they get the load
  // greeting only. Under reduced-motion it never plays and sits on frame 0.
  function setupPresenterGesture(video) {
    const PRESENTER_REPLAY_COOLDOWN_MS = 5000; // pause after a gesture ends before mouse can replay it
    const PRESENTER_REPLAY_MIN_MOVE_PX = 40;   // accumulated pointer travel needed to trigger a replay

    let greeted = false;   // load greeting has started (deferred while hidden / reduced-motion / intro)
    // The branded intro overlay (intro.js) removes html.intro-active only
    // after its exit fade completes, so the greeting waits for that and
    // starts once the scene is actually visible. No intro → play on load.
    let introPending = document.documentElement.classList.contains('intro-active');
    let cooldownUntil = 0;
    let travel = 0;
    let lastX = null;
    let lastY = null;

    const isPlaying = () => !video.paused && !video.ended;
    // Never mid-gesture, never during the post-gesture cooldown, never
    // before the load greeting has run.
    const canReplay = () => greeted && !isPlaying() && performance.now() >= cooldownUntil;

    function playFromStart() {
      if (reduceMotionQuery.matches || document.hidden) return;
      greeted = true;
      travel = 0;
      video.currentTime = 0;
      video.play().catch(() => {});
    }

    video.addEventListener('ended', () => {
      cooldownUntil = performance.now() + PRESENTER_REPLAY_COOLDOWN_MS;
      travel = 0;
    });

    viewport.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'mouse') return;
      const { clientX: x, clientY: y } = event;
      if (lastX !== null) travel += Math.hypot(x - lastX, y - lastY);
      lastX = x;
      lastY = y;
      // Movement during playback or cooldown doesn't count toward the next replay.
      if (!canReplay()) {
        travel = 0;
        return;
      }
      if (travel >= PRESENTER_REPLAY_MIN_MOVE_PX) playFromStart();
    });

    function syncPresenterMotion() {
      if (reduceMotionQuery.matches) {
        video.pause();
        video.currentTime = 0;
      } else if (!greeted && !introPending) {
        playFromStart();
      }
    }
    syncPresenterMotion();
    if (introPending) {
      const introObserver = new MutationObserver(() => {
        if (document.documentElement.classList.contains('intro-active')) return;
        introObserver.disconnect();
        introPending = false;
        syncPresenterMotion();
      });
      introObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    }
    reduceMotionQuery.addEventListener('change', syncPresenterMotion);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !greeted) syncPresenterMotion();
    });

    // Hover entry onto the figure (updateBuildingHover) — same rules as a
    // mouse-movement replay, minus the travel threshold.
    return {
      replay() {
        if (canReplay()) playFromStart();
      },
    };
  }

  const motionVideos = loopVideos.filter(Boolean);
  if (motionVideos.length) {
    const syncWaterMotion = () => {
      motionVideos.forEach((video) => {
        if (reduceMotionQuery.matches) {
          video.pause();
        } else {
          video.play().catch(() => {});
        }
      });
    };
    syncWaterMotion();
    reduceMotionQuery.addEventListener('change', syncWaterMotion);
  }
})();
