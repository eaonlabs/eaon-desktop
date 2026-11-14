// Adapted from AICSS (MIT, Copyright (c) 2026 AICSS); see components/aicss/LICENSE.

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import s from "./ReasoningEffort.module.css";

const TRACK = 264;
const HEIGHT = 32;
const RADIUS = HEIGHT / 2;
const BUMP_H = 20;
const REST_W = 27.2;
const DRAG_W = 33.6;
const REST_H = 27.2;
const EDGE_PAD = (HEIGHT - REST_H) / 2;

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function centerFor(value: number, count: number) {
  const span = TRACK - RADIUS * 2;
  return RADIUS + (value / (count - 1)) * span;
}

function easeOut(t: number) {
  return 1 - (1 - t) ** 3;
}

const LEFT_SHOULDER = 23.572;
/** Space from each glyph edge to the foot of the label shoulder. */
const TEXT_SIDE = 20;
/** How far the outer foot walks down the cap once it passes the crown. */
const PHI_MAX = 0.6;
const PHI_REACH = 36;

function plateauFor(textW: number) {
  return Math.max(8, textW + TEXT_SIDE * 2 - LEFT_SHOULDER * 2);
}

function smoothstep(t: number) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function capFoot(side: -1 | 1, phi: number) {
  const crown = side === -1 ? RADIUS : TRACK - RADIUS;
  return {
    x: crown + side * RADIUS * Math.sin(phi),
    y: BUMP_H + RADIUS * (1 - Math.cos(phi)),
  };
}

function shellGeom(cx: number, plateauW: number) {
  const crownL = RADIUS;
  const crownR = TRACK - RADIUS;
  let topL = cx - plateauW / 2;
  let topR = topL + plateauW;
  let phiL = 0;
  let phiR = 0;

  const overflowL = crownL - (topL - LEFT_SHOULDER);
  if (overflowL > 0) {
    phiL = PHI_MAX * smoothstep(overflowL / PHI_REACH);
    const foot = capFoot(-1, phiL);
    const minTopL = foot.x + LEFT_SHOULDER * Math.cos(phiL);
    if (topL < minTopL) {
      topR += minTopL - topL;
      topL = minTopL;
    }
  }

  const overflowR = topR + LEFT_SHOULDER - crownR;
  if (overflowR > 0) {
    phiR = PHI_MAX * smoothstep(overflowR / PHI_REACH);
    const foot = capFoot(1, phiR);
    const maxTopR = foot.x - LEFT_SHOULDER * Math.cos(phiR);
    if (topR > maxTopR) {
      topL -= topR - maxTopR;
      topR = maxTopR;
    }
  }

  // The tilted shoulder is shorter in x, which would pull the text onto the
  // outer edge. Grow the plateau inward by that loss and keep the label with it.
  const insetL = phiL > 0 ? LEFT_SHOULDER * (1 - Math.cos(phiL)) : 0;
  const insetR = phiR > 0 ? LEFT_SHOULDER * (1 - Math.cos(phiR)) : 0;
  topR += insetL;
  topL -= insetR;

  return { topL, topR, phiL, phiR, insetL, insetR };
}

/** Reference shoulder. phi tilts the foot onto the cap tangent; 0 is the flat scoop. */
function shoulderCmds(
  footX: number,
  footY: number,
  platX: number,
  platY: number,
  phi: number,
  dir: 1 | -1,
) {
  const xScale = Math.abs(platX - footX) / LEFT_SHOULDER;
  const yScale = Math.max(0.001, (footY - platY) / 20);
  const tangent = { x: dir * Math.cos(phi), y: -Math.sin(phi) };
  const map = (lx: number, ly: number) => ({
    x: footX + dir * lx * xScale,
    y: footY + (ly - 20) * yScale,
  });
  const h1 = 5.398 * xScale;
  const p0 = { x: footX, y: footY };
  const c1 = { x: footX + tangent.x * h1, y: footY + tangent.y * h1 };
  const c2 = map(10.012, 16.114);
  const p1 = map(10.93, 10.794);
  const c3 = map(11.916, 4.577);
  const c4 = map(17.277, 0);
  const p3 = { x: platX, y: platY };
  const fmt = (p: { x: number; y: number }) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  if (dir === 1) return `C${fmt(c1)} ${fmt(c2)} ${fmt(p1)}C${fmt(c3)} ${fmt(c4)} ${fmt(p3)}`;
  return `C${fmt(c4)} ${fmt(c3)} ${fmt(p1)}C${fmt(c2)} ${fmt(c1)} ${fmt(p0)}`;
}

/** One outline: the pill, with the label shoulder grown out of its top edge. */
function shellPath(cx: number, open: number, plateauW: number) {
  const trackTop = BUMP_H;
  const trackBot = BUMP_H + HEIGHT;
  const crownL = RADIUS;
  const crownR = TRACK - RADIUS;
  if (open < 0.012) {
    return `M${crownL} ${trackTop}H${crownR}A${RADIUS} ${RADIUS} 0 0 1 ${crownR} ${trackBot}H${crownL}A${RADIUS} ${RADIUS} 0 0 1 ${crownL} ${trackTop}Z`;
  }

  const bumpTop = BUMP_H * (1 - open);
  const { topL, topR, phiL, phiR } = shellGeom(cx, plateauW);
  const cmds = [`M${crownL} ${trackBot}`];

  if (phiL > 0.001) {
    const foot = capFoot(-1, phiL);
    cmds.push(`A${RADIUS} ${RADIUS} 0 0 1 ${foot.x.toFixed(2)} ${foot.y.toFixed(2)}`);
    cmds.push(shoulderCmds(foot.x, foot.y, topL, bumpTop, phiL, 1));
  } else {
    cmds.push(`A${RADIUS} ${RADIUS} 0 0 1 ${crownL} ${trackTop}`);
    const footL = topL - LEFT_SHOULDER;
    if (footL > crownL + 0.4) cmds.push(`H${footL.toFixed(2)}`);
    cmds.push(shoulderCmds(footL, trackTop, topL, bumpTop, 0, 1));
  }

  if (topR > topL + 0.4) cmds.push(`H${topR.toFixed(2)}`);

  if (phiR > 0.001) {
    const foot = capFoot(1, phiR);
    cmds.push(shoulderCmds(foot.x, foot.y, topR, bumpTop, phiR, -1));
    cmds.push(`A${RADIUS} ${RADIUS} 0 0 1 ${crownR} ${trackBot}`);
  } else {
    const footR = topR + LEFT_SHOULDER;
    cmds.push(shoulderCmds(footR, trackTop, topR, bumpTop, 0, -1));
    if (footR < crownR - 0.4) cmds.push(`H${crownR}`);
    cmds.push(`A${RADIUS} ${RADIUS} 0 0 1 ${crownR} ${trackBot}`);
  }

  cmds.push(`H${crownL}Z`);
  return cmds.join("");
}


/** Motion is off: the system setting or Eaon's own (Settings → Appearance). */
function stillMotion() {
  return (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.body.dataset.reduceMotion === "on"
  );
}

/** The dot grid's pitch and each dot's radius, in track units. */
const PITCH = 4;
const DOT = 0.8;
/** The dots fill in from the left this fast when the top level is reached. */
const FILL_IN_S = 0.45;
/** A wave crosses toward the thumb every this often, taking this long. */
const WAVE_EVERY_S = 3;
const WAVE_TAKES_S = 2;

/**
 * The fill at the top level: Eaon's dot matrix (the sidebar's status dots,
 * the home page's field) laid over the accent, faint, with a slow wave of
 * brighter dots travelling toward the thumb every few seconds and a few
 * single dots lighting up in between, as if something were being thought
 * through. Reaching the level fills the dots in from the left. Drawn on a
 * canvas the width of the whole track, clipped by the fill, at about 30
 * frames a second and only while the level is chosen. With motion off the
 * dots are drawn once, still.
 */
function Overdrive() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = TRACK * dpr;
    canvas.height = HEIGHT * dpr;
    ctx.scale(dpr, dpr);
    const still = stillMotion();
    const cols = Math.floor(TRACK / PITCH);
    const rows = Math.floor(HEIGHT / PITCH);
    // Each dot's own moment to light up, fixed for the dot so it doesn't flicker at random.
    const phase = Array.from({ length: cols * rows }, (_, i) => (Math.sin(i * 12.9898) * 43758.5453) % 1);
    const born = performance.now();
    let raf = 0;
    let last = -Infinity;

    const draw = (now: number) => {
      if (!still) raf = requestAnimationFrame(draw);
      if (now - last < 33) return;
      last = now;
      const t = still ? 0 : (now - born) / 1000;
      const filled = still ? cols : (Math.min(1, t / FILL_IN_S) * cols);
      const cycle = t % WAVE_EVERY_S;
      const wave = cycle < WAVE_TAKES_S ? (cycle / WAVE_TAKES_S) * (TRACK + 60) - 30 : -1e3;
      ctx.clearRect(0, 0, TRACK, HEIGHT);
      ctx.fillStyle = "#ffffff";
      for (let c = 0; c < cols; c++) {
        if (c > filled) break;
        const x = c * PITCH + PITCH / 2;
        const swell = Math.exp(-(((x - wave) / 16) ** 2));
        for (let r = 0; r < rows; r++) {
          const y = r * PITCH + PITCH / 2;
          const p = Math.abs(phase[c * rows + r]);
          // A dot now and then, each at its own time, slowly up and down.
          const glow = still ? 0 : Math.max(0, Math.sin(t * 0.8 + p * Math.PI * 2)) ** 14 * 0.32;
          const alpha = 0.1 + swell * 0.42 + glow;
          ctx.globalAlpha = Math.min(0.62, alpha);
          ctx.beginPath();
          ctx.arc(x, y, DOT + swell * 0.35, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} className={s.overdrive} aria-hidden />;
}

/**
 * A stepped slider for reasoning effort. `labels` are the levels the current
 * model takes, lowest first (two or more); `value` is the index of the chosen
 * one. `onChange` fires once a drag is released or a key moves it.
 */
export function ReasoningEffort({
  labels,
  value,
  model,
  onChange,
}: {
  labels: string[];
  value: number;
  model: string;
  onChange: (index: number) => void;
}) {
  const count = labels.length;
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  const displayRef = useRef(value);
  const openRef = useRef(0);
  const draggingRef = useRef(false);
  const [display, setDisplay] = useState(value);
  const [open, setOpen] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [textW, setTextW] = useState(64);
  const plateauTarget = plateauFor(textW);
  const plateauRef = useRef(plateauTarget);
  const [plateauW, setPlateauW] = useState(plateauTarget);
  const revealRef = useRef(0);
  const [reveal, setReveal] = useState(0);
  const gradId = useId().replace(/:/g, "");

  // The level can change from outside (another model, another window); follow
  // it while the user isn't dragging.
  useEffect(() => {
    if (draggingRef.current || Math.round(valueRef.current) === value) return;
    valueRef.current = value;
    displayRef.current = value;
    setDisplay(value);
  }, [value]);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const toOpen = dragging ? 1 : 0;
    const fromOpen = openRef.current;
    const fromValue = displayRef.current;
    const targetValue = dragging ? fromValue : Math.round(valueRef.current);
    if (reduce) {
      openRef.current = toOpen;
      setOpen(toOpen);
      if (!dragging) {
        valueRef.current = targetValue;
        displayRef.current = targetValue;
        setDisplay(targetValue);
      }
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 220);
      const e = easeOut(t);
      const nextOpen = fromOpen + (toOpen - fromOpen) * e;
      openRef.current = nextOpen;
      setOpen(nextOpen);
      if (!dragging) {
        const nextValue = fromValue + (targetValue - fromValue) * e;
        displayRef.current = nextValue;
        setDisplay(nextValue);
        if (t === 1) {
          valueRef.current = targetValue;
          displayRef.current = targetValue;
        }
      }
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [dragging]);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const from = plateauRef.current;
    const to = plateauTarget;
    if (reduce || Math.abs(to - from) < 0.3) {
      plateauRef.current = to;
      setPlateauW(to);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 90);
      const next = from + (to - from) * easeOut(t);
      plateauRef.current = next;
      setPlateauW(next);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [plateauTarget]);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const to = dragging ? 1 : 0;
    const from = revealRef.current;
    if (reduce) {
      revealRef.current = to;
      setReveal(to);
      return;
    }
    const delay = dragging ? 85 : 0;
    const dur = dragging ? 132 : 90;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const elapsed = now - start - delay;
      if (elapsed < 0) {
        raf = requestAnimationFrame(step);
        return;
      }
      const t = Math.min(1, elapsed / dur);
      const next = from + (to - from) * easeOut(t);
      revealRef.current = next;
      setReveal(next);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [dragging]);

  function commit(next: number) {
    valueRef.current = next;
    displayRef.current = next;
    setDisplay(next);
  }

  function valueFrom(clientX: number) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return valueRef.current;
    // In track units: the menu around it scales while it opens.
    const x = ((clientX - rect.left) / rect.width) * TRACK;
    const t = (x - RADIUS) / (TRACK - RADIUS * 2);
    return clamp(t * (count - 1), 0, count - 1);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    draggingRef.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* Pointer capture needs a trusted event. */
    }
    setDragging(true);
    commit(valueFrom(event.clientX));
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    commit(valueFrom(event.clientX));
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      /* Ignore when the event was not trusted. */
    }
    setDragging(false);
    onChange(Math.round(valueRef.current));
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const max = count - 1;
    const current = Math.round(valueRef.current);
    let next = current;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(max, current + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = max;
    else return;
    event.preventDefault();
    commit(next);
    if (next !== current) onChange(next);
  }

  const center = centerFor(display, count);
  const thumbW = REST_W + (DRAG_W - REST_W) * open;
  const thumbH = REST_H;
  const outerPad = EDGE_PAD;
  let thumbLeft = center - thumbW / 2;
  let thumbRight = thumbLeft + thumbW;
  if (thumbLeft < outerPad) {
    thumbLeft = outerPad;
    thumbRight = thumbLeft + thumbW;
  }
  if (thumbRight > TRACK - outerPad) {
    thumbRight = TRACK - outerPad;
    thumbLeft = thumbRight - thumbW;
  }
  const fillW = Math.min(TRACK, thumbRight + EDGE_PAD);
  const active = Math.round(display);
  const level = labels[active];
  // The highest level the model takes (Extra high or Max): the fill shows its dot matrix.
  const overdrive = count >= 2 && active === count - 1;
  // 4.8 to 9.6px, rising with the level, however many levels there are.
  const tickHeights = labels.map((_, i) => Math.round((4.8 + (4.8 * i) / (count - 1)) * 100) / 100);
  const plateau = shellGeom(center, plateauW);
  const labelX =
    (plateau.topL + plateau.topR) / 2 + (plateau.insetL - plateau.insetR) / 2;

  useLayoutEffect(() => {
    const root = rootRef.current;
    // Unscaled width: the menu around it scales while it opens.
    const scale = root && root.offsetWidth > 0 ? root.getBoundingClientRect().width / root.offsetWidth : 1;
    const w = (labelRef.current?.getBoundingClientRect().width ?? 0) / (scale || 1);
    if (w > 0 && Math.abs(w - textW) > 0.4) setTextW(w);
  }, [level, model, textW]);

  return (
    <div
      ref={rootRef}
      className={s.root}
      data-dragging={dragging ? "true" : "false"}
      data-overdrive={overdrive ? "true" : undefined}
    >
      <svg
        className={s.shell}
        viewBox={`0 0 ${TRACK} ${BUMP_H + HEIGHT}`}
        aria-hidden
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--ss-shell)" />
            <stop offset="1" stopColor="var(--ss-shell-2)" />
          </linearGradient>
        </defs>
        <path
          d={shellPath(center, open, plateauW)}
          fill={`url(#${gradId})`}
          stroke="var(--ss-line)"
          strokeWidth="0.5"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div
        ref={labelRef}
        className={s.label}
        style={{
          left: labelX,
          opacity: reveal,
          filter: reveal > 0.98 ? undefined : `blur(${((1 - reveal) * 3).toFixed(2)}px)`,
          transform: `translate(-50%, ${3 * (1 - open)}px)`,
        }}
      >
        <span key={level} className={s.swap}>
          <span className={s.current}>{model}</span>
          <span className={s.next}>{level}</span>
        </span>
      </div>
      {/* At rest the level reads above the track; the label that rises out of
          the track while dragging takes its place. */}
      <div className={s.rest} style={{ opacity: 1 - reveal }} aria-hidden>
        <span>Reasoning</span>
        <span key={level} className={s.restLevel}>
          {level}
        </span>
      </div>
      <div
        ref={trackRef}
        className={s.track}
        role="slider"
        tabIndex={0}
        aria-label="Reasoning effort"
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={active}
        aria-valuetext={`${model} ${level}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div className={s.fill} style={{ width: fillW }}>
          {overdrive && <Overdrive />}
        </div>
        <div
          className={s.thumb}
          style={{
            left: thumbLeft,
            width: thumbW,
            height: thumbH,
            marginTop: -thumbH / 2,
          }}
        />
        {labels.map((label, index) => {
          const x = centerFor(index, count);
          const onThumb = x >= thumbLeft + 0.5 && x <= thumbRight - 0.5;
          return (
            <span
              key={label}
              className={s.tick}
              data-on-thumb={onThumb ? "true" : "false"}
              data-active={index === active && !onThumb ? "true" : "false"}
              style={{ left: x, height: tickHeights[index] }}
            />
          );
        })}
      </div>
    </div>
  );
}
