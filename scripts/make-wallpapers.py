#!/usr/bin/env python3
"""
Paints Eaon's own wallpapers, the ones Settings -> Appearance -> See-through
offers beside the desktop's picture and one of the user's own
(main/features/wallpaper.ts, shared/wallpaper.ts WALLPAPERS).

Each is a few soft clouds of colour over a ground, drifted out of round, and
for some a gentle fold lit from one side: quiet enough to sit behind text all
day, with nothing in it that catches the eye. Each comes twice, dark and
light, and the app shows the one that goes with the theme. The dark ones
stay dim enough, and the light ones bright enough, that Keep text readable
has little to do over them (shared/seeThroughLegibility.ts, DIM_TO and
LIFT_TO).

Colours are mixed in Oklab, so a blend between two of them doesn't go grey
or muddy on the way. A little grain keeps the long gradients from banding.

    resources/wallpapers/<id>-dark.jpg, <id>-light.jpg   3840 x 2400

Needs Python 3 with NumPy and Pillow.

    python3 scripts/make-wallpapers.py              all of them
    python3 scripts/make-wallpapers.py dusk tide    only these
    python3 scripts/make-wallpapers.py --sheet DIR  small copies and a sheet of them all, in DIR, to look at
"""

import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'resources', 'wallpapers')
WIDTH, HEIGHT = 3840, 2400

# Each look, painted back to front:
#   sky     colours from the top of the picture down, evenly spaced
#   clouds  soft patches of colour: where (shares of the width and height),
#           how wide and tall (shares of the width), the colour, how much of it
#   drift   how far a slow wave pushes the clouds out of round
#   hills   soft-edged bands from far to near: where the edge sits (share of
#           the height), how high its waves rise and how many cross the
#           picture, the colour at its edge and at the bottom, how soft the
#           edge is, and how much light catches it
#   fold    a long low wave lit from the top left, as in silk or sand: how
#           strong its light and shade are, its angle and how many waves
WALLPAPERS = {
    'dusk': {
        'dark': {
            'sky': ['#0a0918', '#15123a', '#2a1c52'],
            'clouds': [(0.72, 0.62, 0.45, 0.16, '#5a3170', 0.75), (0.15, 0.10, 0.50, 0.30, '#1b1a4a', 0.70)],
            'hills': [
                (0.62, 0.05, 0.8, '#2b1d58', '#1e1645', 0.012, 0.035),
                (0.74, 0.06, 0.6, '#341b55', '#1b1236', 0.014, 0.030),
                (0.86, 0.05, 0.9, '#22122f', '#120a1c', 0.016, 0.020),
            ],
        },
        'light': {
            'sky': ['#ecebf8', '#efe6f4', '#f8e5e4'],
            'clouds': [(0.72, 0.62, 0.45, 0.16, '#fbd9cf', 0.75), (0.15, 0.10, 0.50, 0.30, '#dfe1f7', 0.70)],
            'hills': [
                (0.62, 0.05, 0.8, '#ddd4f1', '#d7d0ef', 0.012, 0.020),
                (0.74, 0.06, 0.6, '#d3c6ea', '#cdc3e8', 0.014, 0.020),
                (0.86, 0.05, 0.9, '#e5d2e6', '#dccbe1', 0.016, 0.015),
            ],
        },
    },
    'tide': {
        'dark': {
            'sky': ['#06141d', '#082230', '#071a2a'],
            'clouds': [
                (0.85, 0.20, 0.50, 0.40, '#0e3446', 0.85),
                (0.20, 0.85, 0.55, 0.35, '#0b3d44', 0.80),
                (1.00, 1.00, 0.40, 0.30, '#11305c', 0.70),
            ],
            'drift': 0.10,
            'fold': (0.042, -24, 0.9),
        },
        'light': {
            'sky': ['#e6f1f5', '#e2eff3', '#e8eff8'],
            'clouds': [
                (0.85, 0.20, 0.50, 0.40, '#cfe4f0', 0.85),
                (0.20, 0.85, 0.55, 0.35, '#cde9e6', 0.80),
                (1.00, 1.00, 0.40, 0.30, '#d6ddf6', 0.70),
            ],
            'drift': 0.10,
            'fold': (0.035, -24, 0.9),
        },
    },
    'dune': {
        'dark': {
            'sky': ['#120e0b', '#1d1611', '#2a1f16'],
            'clouds': [(0.80, 0.25, 0.50, 0.30, '#3a2a1c', 0.70)],
            'hills': [
                (0.48, 0.07, 0.7, '#3b2b1d', '#2a1f16', 0.010, 0.045),
                (0.63, 0.08, 0.5, '#46321f', '#2c2017', 0.010, 0.045),
                (0.80, 0.07, 0.8, '#382717', '#1d150f', 0.012, 0.040),
            ],
        },
        'light': {
            'sky': ['#f6f0e7', '#f3e9dc', '#efe2d0'],
            'clouds': [(0.80, 0.25, 0.50, 0.30, '#f7e6d6', 0.70)],
            'hills': [
                (0.48, 0.07, 0.7, '#eddcc6', '#e7d4bb', 0.010, 0.030),
                (0.63, 0.08, 0.5, '#e9d2b5', '#e0c7a8', 0.010, 0.030),
                (0.80, 0.07, 0.8, '#efdcc4', '#e5cfb4', 0.012, 0.025),
            ],
        },
    },
    'moss': {
        'dark': {
            'sky': ['#0c1712', '#12241b', '#1a3022'],
            'clouds': [(0.25, 0.05, 0.55, 0.30, '#1f3a2b', 0.70)],
            'hills': [
                (0.54, 0.08, 0.7, '#21402c', '#1b3424', 0.012, 0.022),
                (0.68, 0.09, 0.9, '#183223', '#13281c', 0.012, 0.020),
                (0.84, 0.07, 0.6, '#10221a', '#0b1712', 0.014, 0.014),
            ],
        },
        'light': {
            'sky': ['#f0f5ee', '#eaf2e8', '#e2eee0'],
            'clouds': [(0.25, 0.05, 0.55, 0.30, '#f7faf2', 0.70)],
            'hills': [
                (0.54, 0.08, 0.7, '#dbe8d6', '#d6e4d1', 0.012, 0.015),
                (0.68, 0.09, 0.9, '#d0e2cc', '#cadec6', 0.012, 0.015),
                (0.84, 0.07, 0.6, '#c6dbc2', '#c1d7bd', 0.014, 0.010),
            ],
        },
    },
    'ember': {
        'dark': {
            'sky': ['#0f0d0d', '#110e0e', '#140f0d'],
            'clouds': [
                (1.00, 1.00, 0.60, 0.42, '#5a3015', 0.85),
                (0.78, 0.86, 0.35, 0.22, '#4a2122', 0.60),
                (0.00, 0.00, 0.50, 0.40, '#191515', 0.80),
            ],
            'drift': 0.06,
        },
        'light': {
            'sky': ['#f7f3ef', '#f7f2ed', '#f6efe9'],
            'clouds': [
                (1.00, 1.00, 0.60, 0.42, '#fad6b8', 0.85),
                (0.78, 0.86, 0.35, 0.22, '#f4d0d2', 0.65),
                (0.00, 0.00, 0.50, 0.40, '#f8f6f3', 0.80),
            ],
            'drift': 0.06,
        },
    },
    'slate': {
        'dark': {
            'sky': ['#151920', '#0f1216', '#0b0d10'],
            'clouds': [(0.35, 0.00, 0.70, 0.35, '#202733', 0.80)],
            'drift': 0.06,
            'fold': (0.018, 18, 0.7),
        },
        'light': {
            'sky': ['#f4f5f7', '#eef0f2', '#e9ebee'],
            'clouds': [(0.35, 0.00, 0.70, 0.35, '#fafbfc', 0.80)],
            'drift': 0.06,
            'fold': (0.012, 18, 0.7),
        },
    },
}


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def to_oklab(rgb):
    r, g, b = srgb_to_linear(rgb)
    l = np.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    m = np.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    s = np.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return np.array([
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ])


def from_oklab(L, a, b):
    l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return (
        linear_to_srgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        linear_to_srgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        linear_to_srgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076882762 * s),
    )


def hex_oklab(value):
    value = value.lstrip('#')
    return to_oklab(np.array([int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]))


def paint(look, width, height, seed):
    """One wallpaper as 8-bit RGB, `width` x `height`."""
    rng = np.random.default_rng(seed)
    aspect = height / width
    # Positions in shares of the width across and down, so a cloud is round whatever the shape.
    x = np.linspace(0, 1, width, dtype=np.float32)[None, :]
    y = np.linspace(0, aspect, height, dtype=np.float32)[:, None]
    down = y / aspect
    phase = rng.uniform(0, 2 * np.pi, 8)

    def mix(base, colour, weight):
        for channel, c in zip(base, hex_oklab(colour)):
            channel += weight * (c - channel)

    # The sky, top to bottom.
    stops = [hex_oklab(c) for c in look['sky']]
    at = np.linspace(0, 1, len(stops))
    L, A, B = (np.broadcast_to(np.interp(down, at, [s[i] for s in stops]), (height, width)).astype(np.float32).copy() for i in range(3))
    lab = (L, A, B)

    # Drift: a slow wave or two pushes the places around, so the clouds aren't perfect ellipses.
    d = look.get('drift', 0.08)
    u = x + d * np.sin(2 * np.pi * (0.9 * y + 0.35 * x) + phase[0]) + 0.5 * d * np.sin(2 * np.pi * 1.7 * y + phase[1])
    v = y + d * np.sin(2 * np.pi * (0.8 * x - 0.25 * y) + phase[2]) + 0.5 * d * np.sin(2 * np.pi * 1.5 * x + phase[3])
    for cx, cy, rx, ry, colour, amount in look.get('clouds', []):
        mix(lab, colour, amount * np.exp(-(((u - cx) / rx) ** 2 + ((v - cy * aspect) / ry) ** 2)))

    # Hills, far to near: each covers what's behind it below its soft edge.
    for i, (edge, rise, waves, top, bottom, soft, light) in enumerate(look.get('hills', [])):
        p = phase[(i + 4) % 8]
        line = aspect * (edge + rise * (np.sin(2 * np.pi * waves * x + p) + 0.35 * np.sin(2 * np.pi * 2.3 * waves * x + 2 * p)) / 1.35)
        below = (y - line) / aspect
        cover = 1 / (1 + np.exp(-(y - line) / soft))
        fill = np.clip(below / 0.35, 0, 1)
        top_lab, bottom_lab = hex_oklab(top), hex_oklab(bottom)
        for channel, t, b in zip(lab, top_lab, bottom_lab):
            channel += cover * (t + fill * (b - t) - channel)
        # Light along the crest, fading down the slope.
        L += light * cover * np.exp(-np.clip(below, 0, None) / 0.05)

    # The fold: a long, low wave lit from the top left, bending as it goes.
    strength, angle, waves = look.get('fold', (0, 0, 0))
    if strength:
        t = np.radians(angle)
        along = np.cos(t) * u + np.sin(t) * v
        across = -np.sin(t) * u + np.cos(t) * v
        k = 2 * np.pi * waves
        bend = 0.22 * np.sin(2 * np.pi * 0.55 * across + phase[4])
        slope = np.cos(k * (along + bend)) + 0.35 * np.cos(1.9 * k * (along + 0.6 * bend) + phase[5])
        L += strength * slope + 0.5 * strength * np.clip(slope, 0, None) ** 3

    # A little darker at the edges, so the middle, where the app is, holds still.
    r = ((x - 0.5) / 0.5) ** 2 + ((y - aspect / 2) / (aspect / 2)) ** 2
    L *= 1 - 0.035 * np.clip(r - 0.4, 0, None)

    rgb = np.stack(from_oklab(L, A, B), axis=-1) * 255
    # Grain against banding: a little noise, the same in each channel.
    rgb += rng.normal(0, 0.9, (height, width, 1)).astype(np.float32)
    return np.clip(np.round(rgb), 0, 255).astype(np.uint8)


def luminance_at(rgb, share):
    """The relative luminance below which `share` of the picture's pixels fall, the way the app reads a picture."""
    small = np.asarray(Image.fromarray(rgb).resize((160, 100), Image.BILINEAR), dtype=np.float32) / 255
    lin = srgb_to_linear(small)
    lum = 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]
    return float(np.quantile(lum, share))


def main():
    args = sys.argv[1:]
    sheet = None
    if '--sheet' in args:
        at = args.index('--sheet')
        sheet = args[at + 1]
        del args[at:at + 2]
    ids = args or list(WALLPAPERS)
    unknown = [i for i in ids if i not in WALLPAPERS]
    if unknown:
        sys.exit(f'No wallpaper called {", ".join(unknown)}. There are: {", ".join(WALLPAPERS)}')

    width, height = (960, 600) if sheet else (WIDTH, HEIGHT)
    out = sheet or OUT
    os.makedirs(out, exist_ok=True)
    tiles = []
    for index, id in enumerate(ids):
        for tone in ('dark', 'light'):
            rgb = paint(WALLPAPERS[id][tone], width, height, seed=index * 2 + (tone == 'light'))
            # Over a dark one the text is light: its bright end should sit low. Over a light one, its dark end high.
            end = luminance_at(rgb, 0.97 if tone == 'dark' else 0.03)
            path = os.path.join(out, f'{id}-{tone}.jpg')
            Image.fromarray(rgb).save(path, quality=90, optimize=True, progressive=True)
            print(f'{path}  {os.path.getsize(path) // 1024} KB  {"bright" if tone == "dark" else "dark"} end {end:.3f}')
            tiles.append(rgb)
    if sheet:
        tw, th = 480, 300
        grid = Image.new('RGB', (tw * 2 + 30, (th + 10) * len(ids) + 10), '#808080')
        for i, rgb in enumerate(tiles):
            grid.paste(Image.fromarray(rgb).resize((tw, th), Image.LANCZOS), (10 + (i % 2) * (tw + 10), 10 + (i // 2) * (th + 10)))
        grid.save(os.path.join(out, 'sheet.png'))


if __name__ == '__main__':
    main()
