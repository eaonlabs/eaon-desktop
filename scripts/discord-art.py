#!/usr/bin/env python3
"""
Renders the animated art Eaon shows on Discord (Rich Presence).

Discord only animates images it loads from an external URL, never ones
uploaded to the developer portal, so these GIFs are served from
eaon.dev/img/discord/ and bundled into the app for the preview on
Settings -> Discord.

    presence-vN.gif   the large image: in the dot-matrix look of the Eaon
                      website, a field of faint twinkling dots with a band
                      of light sweeping across, and the Eaon mark (the "e")
                      turning in 3D in front of it, drawn in the same dots
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
from PIL import Image, ImageDraw

VERSION = 3
FPS = 25
SS = 4  # supersampling: frames are drawn this many times larger, then reduced

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'src/renderer/src/assets/discord'

# The website's dark theme (eaon.dev site.css --bg / --fg): never tinted.
BG = (17, 17, 17)
FG = (237, 237, 237)
DIM = (110, 110, 114)
INK = (24, 24, 27)
WHITE = (255, 255, 255)


# ------------------------------------------------------------------ helpers

def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def lerp(a, b, t):
    return a + (b - a) * t


def mix(a, b, t):
    return tuple(round(lerp(x, y, t)) for x, y in zip(a, b))


def hash2(a, b):
    """A stable value in [0, 1) per cell, so the field doesn't crawl."""
    h = np.sin(a * 12.9898 + b * 78.233) * 43758.5453
    return h - np.floor(h)


# ------------------------------------------------------------------- the mark

# The mark is resources/brand/eaon-symbol.svg: a disc with two slots cut in
# from the right, their inner ends rounded. Here it is a thick coin with the
# slots cut right through, so the field shows through them as it turns.
SLOT_MID, SLOT_HALF, SLOT_END = 0.35, 0.15, 0.03
THICKNESS = 0.22


def e_sdf(u, v):
    """Signed distance to the "e" of radius 1 (negative inside)."""
    d = np.hypot(u, v) - 1
    for mid in (-SLOT_MID, SLOT_MID):
        slot = np.where(u >= SLOT_END, np.abs(v - mid), np.hypot(u - SLOT_END, v - mid)) - SLOT_HALF
        d = np.maximum(d, -slot)
    return d


def is_e(x, y, radius, slot_mid=SLOT_MID, slot_half=SLOT_HALF, slot_end=SLOT_END):
    """Whether points (x, y) are the "e" of a disc `radius` wide, centred on 0."""
    u, v = x / radius, y / radius
    inside = u * u + v * v <= 1
    for mid in (-slot_mid, slot_mid):
        slot = (np.abs(v - mid) <= slot_half) & ((u >= slot_end) | (np.hypot(u - slot_end, v - mid) <= slot_half))
        inside &= ~slot
    return inside


def symbol_mask(size, cx, cy, r):
    """The "e" at its true proportions, as an L mask `size` square: for the badges."""
    yy, xx = (np.mgrid[0:size, 0:size].astype(np.float32) + 0.5) / size
    m = is_e(xx - cx, yy - cy, r)
    return Image.fromarray((m * 255).astype(np.uint8), 'L')


# --------------------------------------------------------------- presence art

PRESENCE_SIZE = 320
PRESENCE_SECONDS = 7.0  # one turn of the mark and one pass of the band, like the website's 7s sweep
PITCH = 6               # a 53 × 53 grid of dots: fine enough for the slots to read
DOT = 4                 # each a crisp square this wide, like the website's
LEVELS = 16             # brightness steps, as the website buckets its dots: fewer colours, smaller GIF
GRID = PRESENCE_SIZE // PITCH
LOGO_HALF = 17.5        # the mark's radius, in dots
SUB = 3                 # rays per dot, each way, so the silhouette's edge dots are partly lit

# A light in front, up and to the left: near enough that brightness falls off across the face.
LIGHT = np.array([-1.3, -1.5, 2.4])
FACE, RIM = 0.9, 0.42


def mark_dots(theta):
    """Coverage and brightness of the turning "e" at each dot: two GRID × GRID arrays."""
    n = GRID * SUB
    step = 1 / (LOGO_HALF * SUB)
    centre = (n - 1) / 2
    j, i = np.mgrid[0:n, 0:n].astype(np.float64)
    x = (i - centre) * step
    y = (j - centre) * step
    cos = math.cos(theta)
    cos = 1e-4 if abs(cos) < 1e-4 else cos
    sin = math.sin(theta)
    # Turned past edge-on, the far face is in front: draw it as an "e" that reads
    # the right way round, not mirrored. The outline is a circle either way, so
    # the swap happens while the coin is a line and can't be seen.
    flip = -1.0 if cos < 0 else 1.0
    shape = lambda u, v: e_sdf(flip * u, v)

    # Where each ray (going into the screen) is inside the slab |z| ≤ T/2, in the object's own x.
    za = (-THICKNESS / 2 - sin * x) / cos
    zb = (THICKNESS / 2 - sin * x) / cos
    z_in, z_out = np.maximum(za, zb), np.minimum(za, zb)
    x_in, x_out = cos * x - sin * z_in, cos * x - sin * z_out

    nx = np.zeros_like(x)
    ny = np.zeros_like(x)
    nz = np.zeros_like(x)
    z = z_in.copy()
    albedo = np.full_like(x, RIM)

    # The face the ray enters by.
    hit = shape(x_in, y) <= 0
    side = np.sign(sin * x + cos * z_in)
    side[side == 0] = 1
    nz[hit] = side[hit]
    albedo[hit] = FACE

    # Missed the face: the rim or a slot's wall, where the ray first meets the solid.
    e = 0.004
    for k in range(1, 97):
        xo = x_in + (x_out - x_in) * k / 96
        meet = ~hit & (shape(xo, y) <= 0)
        if not meet.any():
            continue
        gx = shape(xo + e, y) - shape(xo - e, y)
        gy = shape(xo, y + e) - shape(xo, y - e)
        g = np.hypot(gx, gy)
        g[g == 0] = 1
        nx[meet] = (gx / g)[meet]
        ny[meet] = (gy / g)[meet]
        z[meet] = (z_in + (z_out - z_in) * k / 96)[meet]
        hit |= meet

    # Into the world, then the light and a highlight.
    wx = cos * nx + sin * nz
    wz = -sin * nx + cos * nz
    lx, ly, lz = LIGHT[0] - x, LIGHT[1] - y, LIGHT[2] - z
    ll = np.sqrt(lx * lx + ly * ly + lz * lz)
    diffuse = np.maximum(0, (wx * lx + ny * ly + wz * lz) / ll) / (1 + 0.05 * ll * ll)
    hx, hy, hz = lx / ll, ly / ll, lz / ll + 1
    hl = np.sqrt(hx * hx + hy * hy + hz * hz)
    spec = np.maximum(0, (wx * hx + ny * hy + wz * hz) / hl) ** 24
    shade = np.clip(albedo * (0.3 + 1.1 * diffuse) + 0.35 * spec, 0, 1)

    # Each dot is the average of its rays: coverage, and the brightness where it's covered.
    cover = hit.reshape(GRID, SUB, GRID, SUB).mean(axis=(1, 3))
    lit = np.where(hit, shade, 0).reshape(GRID, SUB, GRID, SUB).sum(axis=(1, 3))
    bright = np.divide(lit, cover * SUB * SUB, out=np.zeros_like(lit), where=cover > 0)
    return cover, bright


def spin(t):
    """One turn per loop, slowing as either face comes round so the "e" can be read."""
    u = 2 * math.pi * t / PRESENCE_SECONDS
    return u - 0.32 * math.sin(2 * u)


# The field: fixed per dot, so only the twinkle and the band move.
_j, _i = np.mgrid[0:GRID, 0:GRID].astype(np.float64)
SEED = hash2(_i, _j)
BASE = 0.05 + 0.1 * SEED ** 3
PHASE = hash2(_j + 11, _i + 5) * 2 * math.pi
# Whole cycles per loop, so the GIF loops without a jump.
SPEED = 1 + np.floor(hash2(_i + 3, _j + 17) * 3)
BAND_GAIN = 0.18 + 0.27 * hash2(_i + 7, _j + 3)
# The field dims toward the middle, so the mark stands clear of it.
_r = np.hypot((_i - (GRID - 1) / 2) / (LOGO_HALF + 3), (_j - (GRID - 1) / 2) / (LOGO_HALF + 3))
QUIET = 0.3 + 0.7 * np.clip((_r - 0.75) / 0.5, 0, 1)
# Each dot of the mark is a little brighter or dimmer than the next, for good.
GRAIN = 0.7 + 0.3 * hash2(_i + 23, _j + 41)


def band(t):
    """A soft vertical band of light, crossing once per loop from off the left to off the right."""
    centre = lerp(-13, GRID + 13, t / PRESENCE_SECONDS)
    return np.exp(-(((_i - centre) / 4.2) ** 2))


def dot_tile():
    """One grid cell: a square dot, pixel-aligned so each dot is one flat colour."""
    m = np.zeros((PITCH, PITCH), np.float32)
    lo = (PITCH - DOT) // 2
    m[lo:lo + DOT, lo:lo + DOT] = 1
    return m


DOT_TILE = dot_tile()


def presence_frame(t):
    tw = 0.55 + 0.45 * np.sin(2 * math.pi * SPEED * t / PRESENCE_SECONDS + PHASE)
    sweep = band(t)
    field = (BASE * tw + sweep * BAND_GAIN + sweep * BASE * 0.8) * QUIET

    cover, bright = mark_dots(spin(t))
    # The band lights the mark a little as it passes, and each dot shimmers a
    # little on its own, like the letters of the website's "eaon".
    mark = np.clip(bright * GRAIN * (0.86 + 0.14 * tw) + sweep * 0.15, 0, 1)
    a = np.clip(cover * mark + (1 - cover) * field, 0, 1)
    a = np.round(a * LEVELS) / LEVELS

    alpha = np.kron(a, DOT_TILE)[..., None]
    img = np.array(BG, np.float32) + (np.array(FG, np.float32) - np.array(BG, np.float32)) * alpha
    return Image.fromarray(np.clip(np.round(img), 0, 255).astype(np.uint8), 'RGB')


# ------------------------------------------------------------------- badges

BADGE_SIZE = 96


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


def badge_background():
    return Image.new('RGBA', (BADGE_SIZE * SS, BADGE_SIZE * SS), (*BG, 255))


def thinking_frame(t, bg, period):
    f = Frame(BADGE_SIZE, bg)
    dots = []
    for i, x in enumerate((0.29, 0.5, 0.71)):
        a = ((t / period) - i * 0.14) % 1
        lift = math.sin(math.pi * a / 0.45) if a < 0.45 else 0
        dots.append((x, 0.54 - 0.13 * lift, 0.075 + 0.012 * lift, mix(DIM, WHITE, lift), 1.0))
    f.dots(dots)
    return f.output()


def working_frame(t, bg, period):
    f = Frame(BADGE_SIZE, bg)
    head = 2 * math.pi * t / period
    dots = []
    for i in range(22):
        ang = head - i * 0.12
        a = 1 - i / 22
        dots.append((0.5 + 0.34 * math.cos(ang), 0.5 + 0.34 * math.sin(ang), 0.045 * (0.55 + 0.45 * a), FG, a ** 1.3))
    f.dots(dots[::-1])
    pulse = 1 + 0.05 * math.sin(2 * math.pi * t / period)
    f.mask_color(symbol_mask(f.px, 0.5, 0.5, 0.2 * pulse), WHITE, 1.0)
    return f.output()


def ready_frame(t, bg, period):
    f = Frame(BADGE_SIZE, bg)
    bob = 0.018 * math.sin(2 * math.pi * t / period)
    layer = f.layer()
    draw = ImageDraw.Draw(layer)
    u = f.u
    x0, y0, x1, y1 = 0.2, 0.26 + bob, 0.8, 0.68 + bob
    draw.rounded_rectangle((u(x0), u(y0), u(x1), u(y1)), radius=u(0.12), fill=(*FG, 255))
    draw.polygon([(u(0.3), u(y1 - 0.02)), (u(0.44), u(y1 - 0.02)), (u(0.27), u(y1 + 0.12))], fill=(*FG, 255))
    f.blend(layer)
    # A caret that blinks, then types three dashes.
    phase = t / period
    typed = min(3, int(phase * 6))
    for i in range(typed):
        f.line(0.31 + i * 0.12, 0.47 + bob, 0.38 + i * 0.12, 0.47 + bob, 0.05, DIM, 1.0)
    caret_x = 0.31 + typed * 0.12
    if (phase * 4) % 1 < 0.6:
        f.line(caret_x, 0.39 + bob, caret_x, 0.55 + bob, 0.045, INK, 1.0)
    return f.output()


def away_frame(t, bg, period):
    f = Frame(BADGE_SIZE, bg)
    glow = 0.5 + 0.5 * math.sin(2 * math.pi * t / period)
    f.dots([(0.4, 0.56, 0.3, WHITE, 0.06 + 0.06 * glow)])
    f.dots([(0.4, 0.56, 0.22, FG, 1.0)])
    f.dots([(0.5, 0.48, 0.19, BG, 1.0)])
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


# ------------------------------------------------------------------- encode

def encode(frames, out, fps=FPS):
    with tempfile.TemporaryDirectory() as tmp:
        for i, frame in enumerate(frames):
            frame.save(f'{tmp}/f_{i:04d}.png')
        # One palette for the whole loop, no dithering (the art is flat greys),
        # and only changed rectangles written for each frame.
        subprocess.run(
            [
                'ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(fps), '-i', f'{tmp}/f_%04d.png',
                '-vf', 'split[a][b];[a]palettegen=stats_mode=full:max_colors=64[p];'
                       '[b][p]paletteuse=dither=none:diff_mode=rectangle',
                '-loop', '0', str(out),
            ],
            check=True,
        )
    print(f'{out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}  {out.stat().st_size / 1024:.0f} KB')


def render(name, frame_fn, seconds, start=0.0):
    """`start` rotates the loop: some Discord views show only the first frame."""
    count = round(seconds * FPS)
    frames = [frame_fn((start + i / FPS) % seconds) for i in range(count)]
    encode(frames, ASSETS / f'{name}-v{VERSION}.gif')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--site', type=Path, help='eaon-website checkout to copy the GIFs into (img/discord/)')
    args = parser.parse_args()

    ASSETS.mkdir(parents=True, exist_ok=True)
    # Starts face-on, the "e" readable, with the band yet to come.
    render('presence', presence_frame, PRESENCE_SECONDS)
    badges = (('thinking', thinking_frame, 1.2), ('working', working_frame, 1.0),
              ('ready', ready_frame, 2.4), ('away', away_frame, 2.4))
    for name, fn, seconds in badges:
        bg = badge_background()
        render(name, lambda t, fn=fn, seconds=seconds, bg=bg: fn(t, bg, seconds), seconds)

    if args.site:
        dest = args.site / 'img/discord'
        dest.mkdir(parents=True, exist_ok=True)
        for gif in ASSETS.glob(f'*-v{VERSION}.gif'):
            shutil.copy2(gif, dest / gif.name)
        print(f'copied to {dest}')


if __name__ == '__main__':
    main()
