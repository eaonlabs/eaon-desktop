#!/usr/bin/env python3
"""
Renders the animated art Eaon shows on Discord (Rich Presence).

Discord only animates images it loads from an external URL, never ones
uploaded to the developer portal, so these GIFs are served from
eaon.dev/img/discord/ and bundled into the app for the preview on
Settings -> Discord.

    presence-vN.gif   the large image: the Eaon mark rising in, pulsing,
                      spinning, orbiting and blasting off, on a loop
    thinking-vN.gif   small status badges, shown in the corner of the large
    working-vN.gif    image for what Eaon is doing right now
    ready-vN.gif
    away-vN.gif

Discord's media proxy caches external images by URL, so after changing the
art bump VERSION here and DISCORD_ART_VERSION in src/shared/discordPresence.ts
together, then publish the new files to eaon.dev.

Needs Python 3 with Pillow and numpy, and ffmpeg on PATH.

    python3 scripts/discord-art.py [--site ../eaon-website]
"""

import argparse
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

VERSION = 1
FPS = 25
SS = 4  # supersampling: frames are drawn this many times larger, then reduced

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'src/renderer/src/assets/discord'

# Brand colours, sampled from resources/icon.png.
EMBER = (246, 138, 102)
EMBER_DEEP = (214, 96, 62)
EMBER_LIGHT = (255, 176, 143)
BLUSH = (255, 226, 214)
SHADOW = (170, 64, 34)
INK = (24, 24, 27)
WHITE = (255, 255, 255)

# The mark, as measured on the 1024px icon: apex (512, 368), tips at y 656
# x 359 and 665, and a concave base that rises to y 597 in the middle — a
# quadratic curve whose control point sits at y 538.
MARK_ASPECT = 288 / 306
MARK_BASE_CONTROL = (538 - 368) / 288


# ------------------------------------------------------------------ easing

def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def lerp(a, b, t):
    return a + (b - a) * t


def ease_out_cubic(t):
    return 1 - (1 - t) ** 3


def ease_in_cubic(t):
    return t ** 3


def ease_in_out_cubic(t):
    return 4 * t ** 3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def ease_out_back(t, s=1.70158):
    t -= 1
    return 1 + (s + 1) * t ** 3 + s * t ** 2


def window(t, start, end):
    """Progress 0..1 through [start, end), or None outside it."""
    if t < start or t >= end:
        return None
    return (t - start) / (end - start)


# ------------------------------------------------------------------ shapes

def mark_points(cx, cy, w, sx=1.0, sy=1.0, steps=28):
    """The Eaon mark centred on (cx, cy), `w` wide, scaled about its centre."""
    h = w * MARK_ASPECT
    top, bottom = -h / 2, h / 2
    control = top + MARK_BASE_CONTROL * h
    pts = [(0.0, top), (w / 2, bottom)]
    for i in range(1, steps):
        t = i / steps
        x = (1 - t) ** 2 * (w / 2) + t ** 2 * (-w / 2)  # control point x is 0
        y = (1 - t) ** 2 * bottom + 2 * (1 - t) * t * control + t ** 2 * bottom
        pts.append((x, y))
    pts.append((-w / 2, bottom))
    return [(cx + x * sx, cy + y * sy) for x, y in pts]


def star_points(cx, cy, r, angle=0.0, inner=0.3):
    """A four-point sparkle."""
    pts = []
    for i in range(8):
        a = angle + i * math.pi / 4
        rr = r if i % 2 == 0 else r * inner
        pts.append((cx + math.cos(a) * rr, cy + math.sin(a) * rr))
    return pts


class Frame:
    """An RGBA canvas at SS× the output size, with blended shape helpers."""

    def __init__(self, size, background):
        self.size = size
        self.px = size * SS
        self.img = background.copy()

    def u(self, v):
        """Canvas units (0..1) to pixels."""
        return v * self.px

    def layer(self):
        return Image.new('RGBA', (self.px, self.px), (0, 0, 0, 0))

    def blend(self, layer):
        self.img.alpha_composite(layer)

    def polygon(self, pts, color, alpha=1.0):
        if alpha <= 0.004:
            return
        layer = self.layer()
        ImageDraw.Draw(layer).polygon([(self.u(x), self.u(y)) for x, y in pts], fill=(*color, round(255 * alpha)))
        self.blend(layer)

    def dots(self, dots):
        """[(x, y, r, color, alpha)] drawn on one layer — they must not overlap much."""
        layer = self.layer()
        draw = ImageDraw.Draw(layer)
        for x, y, r, color, alpha in dots:
            if alpha <= 0.004 or r <= 0:
                continue
            x, y, r = self.u(x), self.u(y), self.u(r)
            draw.ellipse((x - r, y - r, x + r, y + r), fill=(*color, round(255 * clamp(alpha))))
        self.blend(layer)

    def ring(self, cx, cy, r, width, color, alpha):
        if alpha <= 0.004:
            return
        layer = self.layer()
        x, y, r = self.u(cx), self.u(cy), self.u(r)
        ImageDraw.Draw(layer).ellipse(
            (x - r, y - r, x + r, y + r), outline=(*color, round(255 * alpha)), width=max(1, round(self.u(width)))
        )
        self.blend(layer)

    def line(self, x0, y0, x1, y1, width, color, alpha):
        if alpha <= 0.004:
            return
        layer = self.layer()
        draw = ImageDraw.Draw(layer)
        w = max(1, round(self.u(width)))
        draw.line((self.u(x0), self.u(y0), self.u(x1), self.u(y1)), fill=(*color, round(255 * alpha)), width=w)
        for x, y in ((x0, y0), (x1, y1)):  # round caps
            x, y, r = self.u(x), self.u(y), w / 2
            draw.ellipse((x - r, y - r, x + r, y + r), fill=(*color, round(255 * alpha)))
        self.blend(layer)

    def mask_color(self, mask, color, alpha):
        """Paint `color` through an L-mode mask at the output size or SS size."""
        if mask.size != (self.px, self.px):
            mask = mask.resize((self.px, self.px), Image.BILINEAR)
        a = mask.point(lambda v: round(v * alpha))
        layer = Image.new('RGBA', (self.px, self.px), (*color, 0))
        layer.putalpha(a)
        self.blend(layer)

    def output(self):
        return self.img.convert('RGB').resize((self.size, self.size), Image.LANCZOS)


def mix(a, b, t):
    return tuple(round(lerp(x, y, t)) for x, y in zip(a, b))


# ------------------------------------------------------------ presence art

PRESENCE_SIZE = 320
PRESENCE_SECONDS = 6.4
MARK_W = 0.44
MARK_H = MARK_W * MARK_ASPECT


def presence_background(size):
    """Ember with a soft light from the upper left and a gentle vignette."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    col = np.empty((size, size, 3), np.float32)
    col[:] = EMBER
    d = np.sqrt((xx - 0.5) ** 2 + (yy - 0.5) ** 2)
    vignette = np.clip((d - 0.28) / 0.45, 0, 1) ** 1.6 * 0.7
    col = col * (1 - vignette[..., None]) + np.array(EMBER_DEEP) * vignette[..., None]
    light = np.exp(-((xx - 0.3) ** 2 + (yy - 0.25) ** 2) / (2 * 0.26 ** 2)) * 0.5
    col = col * (1 - light[..., None]) + np.array(EMBER_LIGHT) * light[..., None]
    img = Image.fromarray(np.clip(col, 0, 255).astype(np.uint8), 'RGB').convert('RGBA')
    return img.resize((size * SS, size * SS), Image.BICUBIC)


def shine_mask(size, p):
    """A soft diagonal band crossing the tile, p = 0..1 left to right."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    angle = math.radians(24)
    along = xx * math.cos(angle) + yy * math.sin(angle)
    centre = lerp(-0.35, 1.45, ease_in_out_cubic(p))
    band = np.exp(-((along - centre) ** 2) / (2 * 0.07 ** 2))
    thin = np.exp(-((along - centre - 0.16) ** 2) / (2 * 0.018 ** 2)) * 0.8
    return Image.fromarray((np.clip(band + thin, 0, 1) * 255).astype(np.uint8), 'L')


def mark_y_launch_in(t):
    """Phase A: rises in from below with an overshoot."""
    return lerp(0.85, 0.0, ease_out_back(clamp(t / 0.8), 1.8))


def mark_y_blast_off(t):
    """Phase F launch: accelerates up and out of the top."""
    p = clamp((t - 5.62) / 0.42)
    return lerp(0.0, -1.05, p ** 2.2)


def presence_frame(t, background):
    f = Frame(PRESENCE_SIZE, background)
    cx, cy = 0.5, 0.52
    y, sx, sy = 0.0, 1.0, 1.0
    ghosts = []  # (y, sx, sy, alpha)
    tint = WHITE
    visible = True

    def stretch_from(fn, at):
        v = abs(fn(at) - fn(at - 0.04)) / 0.04
        k = min(0.32, v * 0.075)
        return 1 - k * 0.45, 1 + k

    # ---- A: launch in (0.00 - 0.80)
    if t < 0.8:
        y = mark_y_launch_in(t)
        sx, sy = stretch_from(mark_y_launch_in, t)
        for k, a in ((1, 0.30), (2, 0.17), (3, 0.08)):
            gt = t - 0.035 * k
            if gt >= 0 and abs(mark_y_launch_in(gt) - y) > 0.01:
                gx, gy = stretch_from(mark_y_launch_in, gt)
                ghosts.append((mark_y_launch_in(gt), gx, gy, a))

    # ---- B: pulse rings and sparkles (0.80 - 2.20)
    for start in (0.86, 1.42):
        a = window(t, start, start + 0.95)
        if a is not None:
            r = 0.2 + 0.52 * ease_out_cubic(a)
            f.ring(cx, cy, r, lerp(0.03, 0.004, a), WHITE, 0.55 * (1 - a) ** 1.4)
    if 0.8 <= t < 2.2:
        y = -0.012 * math.sin(2 * math.pi * (t - 0.8) / 1.4)
        s = 1 + 0.03 * math.sin(2 * math.pi * (t - 0.8) / 0.7)
        sx = sy = s

    # ---- C: a glossy sweep across the tile (2.20 - 2.90)
    p = window(t, 2.2, 2.9)
    if p is not None:
        f.mask_color(shine_mask(PRESENCE_SIZE, p), WHITE, 0.32)

    # ---- D: 360° spin with a hop, then a burst (2.90 - 4.10)
    p = window(t, 2.95, 3.85)
    if p is not None:
        theta = 2 * math.pi * ease_in_out_cubic(p)
        c = math.cos(theta)
        sx = max(0.04, abs(c))
        y = -0.09 * math.sin(math.pi * p)
        # The back of the mark is a warmer white, so the turn reads as 3D.
        tint = WHITE if c >= 0 else BLUSH

    # ---- E: orbiting sparks (4.10 - 5.30)
    orbit_front, orbit_back = [], []
    p = window(t, 4.1, 5.3)
    if p is not None:
        y = -0.014 * math.sin(2 * math.pi * p)
        fade = clamp(p / 0.15) * clamp((1 - p) / 0.15)
        tilt = math.radians(-18)
        for i in range(3):
            for trail in range(6):
                phi = 2 * math.pi * (1.35 * p - trail * 0.018) + i * 2 * math.pi / 3
                ox, oy = 0.36 * math.cos(phi), 0.12 * math.sin(phi)
                x = cx + ox * math.cos(tilt) - oy * math.sin(tilt)
                yy = cy + ox * math.sin(tilt) + oy * math.cos(tilt)
                z = math.sin(phi)
                r = 0.022 * (1 + 0.35 * z) * (1 - trail * 0.13)
                alpha = fade * (1 - trail * 0.16) * (0.55 + 0.45 * (z + 1) / 2)
                dot = (x, yy, r, WHITE if trail == 0 else BLUSH, alpha)
                (orbit_front if z >= 0 else orbit_back).append(dot)

    # ---- F: crouch and blast off (5.30 - 6.40)
    p = window(t, 5.3, 5.62)
    if p is not None:
        k = ease_in_out_cubic(p)
        sy, sx = 1 - 0.17 * k, 1 + 0.1 * k
        y = MARK_H / 2 * (1 - sy)  # keep the base planted while squashing
        cx += 0.004 * math.sin(t * 95) * k
    if t >= 5.62:
        y = mark_y_blast_off(t)
        sx, sy = stretch_from(mark_y_blast_off, t)
        visible = y > -1.0
        for k, a in ((1, 0.30), (2, 0.17), (3, 0.08)):
            gt = t - 0.035 * k
            if gt >= 5.62:
                gx, gy = stretch_from(mark_y_blast_off, gt)
                ghosts.append((mark_y_blast_off(gt), gx, gy, a))
    # Speed lines streaming down past the launch.
    for i, lx in enumerate((0.22, 0.34, 0.46, 0.58, 0.7, 0.8, 0.28, 0.64)):
        a = window(t, 5.66 + 0.035 * i, 5.66 + 0.035 * i + 0.4)
        if a is not None:
            top = lerp(-0.1, 1.05, ease_in_cubic(a) * 0.4 + a * 0.6)
            f.line(lx, top, lx, top + 0.16, 0.008, WHITE, 0.45 * (1 - a))
    # Exhaust puffs left at the launch point.
    puffs = []
    for i in range(7):
        a = window(t, 5.6 + 0.03 * i, 5.6 + 0.03 * i + 0.55)
        if a is not None:
            px = cx + (i - 3) * 0.035
            py = cy + MARK_H / 2 + 0.02 + ease_out_cubic(a) * (0.08 + 0.02 * (i % 3))
            puffs.append((px, py, 0.02 + 0.045 * ease_out_cubic(a), BLUSH, 0.6 * (1 - a) ** 1.3))
    if puffs:
        f.dots(puffs)

    # ---- draw the mark
    if orbit_back:
        f.dots(orbit_back)
    for gy, gsx, gsy, a in ghosts:
        f.polygon(mark_points(cx, cy + gy, MARK_W, gsx, gsy), WHITE, a)
    if visible:
        # Soft shadow, drawn small and blurred, then scaled up.
        small = Image.new('L', (PRESENCE_SIZE, PRESENCE_SIZE), 0)
        pts = mark_points(cx, cy + y + 0.022, MARK_W, sx, sy)
        ImageDraw.Draw(small).polygon([(x * PRESENCE_SIZE, yv * PRESENCE_SIZE) for x, yv in pts], fill=255)
        f.mask_color(small.filter(ImageFilter.GaussianBlur(PRESENCE_SIZE * 0.022)), SHADOW, 0.32)
        f.polygon(mark_points(cx, cy + y, MARK_W, sx, sy), tint)
    if orbit_front:
        f.dots(orbit_front)

    # Burst when the spin lands.
    a = window(t, 3.85, 4.5)
    if a is not None:
        burst = []
        for i in range(14):
            ang = 2 * math.pi * i / 14 + 0.22
            r = 0.17 + 0.36 * ease_out_cubic(a)
            burst.append((cx + math.cos(ang) * r, cy + math.sin(ang) * r, 0.02 * (1 - a) + 0.005,
                          WHITE if i % 2 == 0 else BLUSH, (1 - a) ** 1.2))
        f.dots(burst)

    # Sparkles twinkling around the mark during the pulse.
    for i, (sx_, sy_, start) in enumerate(((0.2, 0.24, 0.95), (0.81, 0.3, 1.15), (0.78, 0.8, 1.35),
                                           (0.19, 0.74, 1.55), (0.62, 0.13, 1.75))):
        a = window(t, start, start + 0.6)
        if a is not None:
            f.polygon(star_points(sx_, sy_, 0.05 * math.sin(math.pi * a), math.pi / 2 * a), WHITE, 0.95)
    # A glint on the apex as the sweep passes it.
    a = window(t, 2.55, 3.0)
    if a is not None:
        apex_y = cy + y - MARK_H / 2
        f.polygon(star_points(cx + 0.005, apex_y + 0.01, 0.07 * math.sin(math.pi * a), math.pi / 3 * a), WHITE, 1.0)

    return f.output()


# ---------------------------------------------------------------- badges

BADGE_SIZE = 96


def badge_background():
    return Image.new('RGBA', (BADGE_SIZE * SS, BADGE_SIZE * SS), (*INK, 255))


def thinking_frame(t, bg, period):
    f = Frame(BADGE_SIZE, bg)
    dots = []
    for i, x in enumerate((0.29, 0.5, 0.71)):
        a = ((t / period) - i * 0.14) % 1
        lift = math.sin(math.pi * a / 0.45) if a < 0.45 else 0
        dots.append((x, 0.54 - 0.13 * lift, 0.075 + 0.012 * lift, mix(EMBER, WHITE, lift * 0.75), 1.0))
    f.dots(dots)
    return f.output()


def working_frame(t, bg, period):
    f = Frame(BADGE_SIZE, bg)
    head = 2 * math.pi * t / period
    dots = []
    for i in range(22):
        ang = head - i * 0.12
        a = 1 - i / 22
        dots.append((0.5 + 0.3 * math.cos(ang), 0.5 + 0.3 * math.sin(ang), 0.05 * (0.55 + 0.45 * a), EMBER, a ** 1.3))
    f.dots(dots[::-1])
    pulse = 1 + 0.06 * math.sin(2 * math.pi * t / period)
    f.polygon(mark_points(0.5, 0.51, 0.3 * pulse), WHITE)
    return f.output()


def ready_frame(t, bg, period):
    f = Frame(BADGE_SIZE, bg)
    bob = 0.018 * math.sin(2 * math.pi * t / period)
    layer = f.layer()
    draw = ImageDraw.Draw(layer)
    u = f.u
    x0, y0, x1, y1 = 0.2, 0.26 + bob, 0.8, 0.68 + bob
    draw.rounded_rectangle((u(x0), u(y0), u(x1), u(y1)), radius=u(0.12), fill=(*WHITE, 255))
    draw.polygon([(u(0.3), u(y1 - 0.02)), (u(0.44), u(y1 - 0.02)), (u(0.27), u(y1 + 0.12))], fill=(*WHITE, 255))
    f.blend(layer)
    # A caret that blinks, then types three dashes.
    phase = t / period
    typed = min(3, int(phase * 6))
    for i in range(typed):
        f.line(0.31 + i * 0.12, 0.47 + bob, 0.38 + i * 0.12, 0.47 + bob, 0.05, INK, 0.9)
    caret_x = 0.31 + typed * 0.12
    if (phase * 4) % 1 < 0.6:
        f.line(caret_x, 0.39 + bob, caret_x, 0.55 + bob, 0.045, EMBER, 1.0)
    return f.output()


def away_frame(t, bg, period):
    f = Frame(BADGE_SIZE, bg)
    glow = 0.5 + 0.5 * math.sin(2 * math.pi * t / period)
    f.dots([(0.4, 0.56, 0.3, EMBER, 0.12 + 0.1 * glow)])
    f.dots([(0.4, 0.56, 0.22, BLUSH, 1.0)])
    f.dots([(0.5, 0.48, 0.19, INK, 1.0)])
    for i in range(3):
        a = ((t / period) + i / 3) % 1
        size = 0.05 + 0.05 * a
        x = 0.62 + 0.18 * a
        y = 0.5 - 0.36 * a
        alpha = math.sin(math.pi * a)
        pts = [(x - size, y - size), (x + size, y - size), (x - size, y + size), (x + size, y + size)]
        for (xa, ya), (xb, yb) in zip(pts, pts[1:]):
            f.line(xa, ya, xb, yb, 0.028, WHITE, alpha)
    return f.output()


# ---------------------------------------------------------------- encode

def encode(frames, out, fps=FPS):
    with tempfile.TemporaryDirectory() as tmp:
        for i, frame in enumerate(frames):
            frame.save(f'{tmp}/f_{i:04d}.png')
        # One palette for the whole loop, ordered dithering so still areas do
        # not shimmer, and only changed rectangles written for each frame.
        subprocess.run(
            [
                'ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(fps), '-i', f'{tmp}/f_%04d.png',
                '-vf', 'split[a][b];[a]palettegen=stats_mode=full[p];'
                       '[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
                '-loop', '0', str(out),
            ],
            check=True,
        )
    print(f'{out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}  {out.stat().st_size / 1024:.0f} KB')


def render(name, frame_fn, seconds, background, start=0.0):
    """`start` rotates the loop: some Discord views show only the first frame."""
    count = round(seconds * FPS)
    frames = [frame_fn((start + i / FPS) % seconds, background) for i in range(count)]
    encode(frames, ASSETS / f'{name}-v{VERSION}.gif')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--site', type=Path, help='eaon-website checkout to copy the GIFs into (img/discord/)')
    args = parser.parse_args()

    ASSETS.mkdir(parents=True, exist_ok=True)
    # Starts with the mark at rest rather than on the empty tile before it rises in.
    render('presence', presence_frame, PRESENCE_SECONDS, presence_background(PRESENCE_SIZE), start=0.8)
    badges = (('thinking', thinking_frame, 1.2), ('working', working_frame, 1.0),
              ('ready', ready_frame, 2.4), ('away', away_frame, 2.4))
    for name, fn, seconds in badges:
        render(name, lambda t, bg, fn=fn, seconds=seconds: fn(t, bg, seconds), seconds, badge_background())

    if args.site:
        dest = args.site / 'img/discord'
        dest.mkdir(parents=True, exist_ok=True)
        for gif in ASSETS.glob(f'*-v{VERSION}.gif'):
            shutil.copy2(gif, dest / gif.name)
        print(f'copied to {dest}')


if __name__ == '__main__':
    main()
