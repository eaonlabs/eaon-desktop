#!/usr/bin/env python3
"""
Builds every app-icon file from the Icon Composer documents.

Two documents are the source; open either in Icon Composer (it ships inside
Xcode, Xcode.app/Contents/Applications/Icon Composer.app) to change colours,
layers or glass, then run this script:

    resources/Eaon.icon       the app icon (the Disc E)
    resources/EaonAgent.icon  the agent face on the same tile, which the user
                              can switch to in Settings -> Appearance -> App
                              icon (main/appIcon.ts)

From them, Icon Composer's own renderer (ictool) and asset compiler (actool)
make:

    resources/Assets.car       the Liquid Glass app icon, with its dark, clear
                               and tinted looks. macOS 26+ shows this one: it
                               is copied into Contents/Resources and named by
                               CFBundleIconName (electron-builder.yml, mac:)
    resources/icon.icns        the same icon pre-rendered, for older macOS
    resources/icon.png         1024 px, for Linux and the Dock in dev runs
    resources/icon.ico         Windows
    resources/icon-agent.png   the agent icon, for the Dock (macOS) and the
    resources/icon-agent.ico   window icon (Windows, Linux) when it is chosen
    src/renderer/src/assets/providers/eaon.png
                               256 px, the Eaon tile inside the app
    src/renderer/src/assets/app-icons/default.png, agent.png
                               256 px, the two choices in Settings

and the other backgrounds the user can pick for the same Disc E (VARIANTS
below: Light, Ocean, Sunset, Forest, Grape, and two painted scenes, Aurora
and Peaks, drawn here rather than taken from photos), each made from
resources/Eaon.icon with its fill, mark colour or a background layer
swapped:

    resources/app-icons/<id>.png, <id>.ico
                               1024 px and Windows, shipped as icons/<id>.*
    src/renderer/src/assets/app-icons/<id>.png
                               256 px, its choice in Settings

The PNGs and the icns follow macOS's icon grid: the tile is 824 of 1024 px,
centred, with a soft shadow in the margin (none on the in-app tiles). The ico
files are full bleed, as Windows draws icons.

actool refuses to run until the Xcode licence is accepted
(sudo xcodebuild -license accept). Without it everything except Assets.car
is still rebuilt, and the script says so.

Needs Python 3 with Pillow, and Xcode 26 or later.

    python3 scripts/make-icon.py
    python3 scripts/make-icon.py --variants    only the background variants
"""

import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
RESOURCES = ROOT / 'resources'
ASSETS = ROOT / 'src' / 'renderer' / 'src' / 'assets'
APP_ICON = RESOURCES / 'Eaon.icon'
AGENT_ICON = RESOURCES / 'EaonAgent.icon'
NAME = 'Eaon'  # the asset-catalog icon name; matches CFBundleIconName
TILE = 824 / 1024  # macOS icon grid
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def developer_dir() -> Path:
    """Xcode's Developer folder: DEVELOPER_DIR, xcode-select, the usual install folders, or any
    Xcode Spotlight knows of (Spotlight alone is not enough: its index comes and goes)."""
    candidates = []
    if os.environ.get('DEVELOPER_DIR'):
        candidates.append(Path(os.environ['DEVELOPER_DIR']))
    selected = subprocess.run(['xcode-select', '-p'], capture_output=True, text=True).stdout.strip()
    if selected:
        candidates.append(Path(selected))
    for folder in (Path('/Applications'), Path.home() / 'Applications', Path.home() / 'Downloads'):
        candidates += [app / 'Contents' / 'Developer' for app in sorted(folder.glob('Xcode*.app'), reverse=True)]
    found = subprocess.run(['mdfind', "kMDItemCFBundleIdentifier == 'com.apple.dt.Xcode'"], capture_output=True, text=True).stdout
    candidates += [Path(line) / 'Contents' / 'Developer' for line in found.splitlines() if line]
    for dev in candidates:
        if (dev.parent / 'Applications' / 'Icon Composer.app').exists():
            return dev
    sys.exit('error: no Xcode with Icon Composer found (Xcode 26 or later). Set DEVELOPER_DIR to its Contents/Developer.')


DEV = developer_dir()
ICTOOL = DEV.parent / 'Applications' / 'Icon Composer.app' / 'Contents' / 'Executables' / 'ictool'


def render(doc: Path, size: int, tmp: Path) -> Image.Image:
    """The Default (light) look, full bleed: the squircle fills the image."""
    out = tmp / f'{doc.stem}-{size}.png'
    subprocess.run(
        [str(ICTOOL), str(doc), '--export-image', '--output-file', str(out), '--platform', 'macOS',
         '--rendition', 'Default', '--width', str(size), '--height', str(size), '--scale', '1'],
        check=True, capture_output=True,
    )
    return Image.open(out).convert('RGBA')


def on_grid(doc: Path, size: int, tmp: Path, shadow: bool = True) -> Image.Image:
    """A size × size icon with the tile at 824/1024, as macOS draws its own."""
    art_size = round(size * TILE)
    art = render(doc, art_size, tmp)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    at = ((size - art_size) // 2, (size - art_size) // 2)
    if shadow:
        alpha = Image.new('L', (size, size), 0)
        alpha.paste(art.getchannel('A'), (at[0], at[1] + round(size * 0.012)))
        alpha = alpha.filter(ImageFilter.GaussianBlur(size * 0.018)).point(lambda a: round(a * 0.3))
        canvas.putalpha(alpha)
    canvas.alpha_composite(art, at)
    return canvas


def save_ico(doc: Path, out: Path, tmp: Path) -> None:
    """Windows has no icon grid: the tile fills the image, rendered at each size."""
    frames = [render(doc, s, tmp) for s in ICO_SIZES]
    frames[-1].save(out, format='ICO', sizes=[(s, s) for s in ICO_SIZES], append_images=frames[:-1])


def save_icns(doc: Path, big: Image.Image, out: Path, tmp: Path) -> None:
    iconset = tmp / f'{NAME}.iconset'
    iconset.mkdir()
    for points in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = points * scale
            image = big if px == 1024 else on_grid(doc, px, tmp)
            image.save(iconset / f'icon_{points}x{points}{"@2x" if scale == 2 else ""}.png')
    subprocess.run(['iconutil', '--convert', 'icns', '--output', str(out), str(iconset)], check=True)


def compile_car(tmp: Path) -> bool:
    out = tmp / 'car'
    out.mkdir()
    env = {**os.environ, 'DEVELOPER_DIR': str(DEV)}
    result = subprocess.run(
        ['xcrun', 'actool', str(APP_ICON), '--compile', str(out), '--app-icon', NAME, '--include-all-app-icons',
         '--output-partial-info-plist', str(tmp / 'partial.plist'), '--platform', 'macosx',
         '--target-device', 'mac', '--minimum-deployment-target', '12.0', '--enable-on-demand-resources', 'NO',
         '--development-region', 'en', '--errors', '--warnings', '--output-format', 'human-readable-text'],
        capture_output=True, text=True, env=env,
    )
    car = out / 'Assets.car'
    if result.returncode != 0 or not car.exists():
        reason = (result.stderr or result.stdout).strip().splitlines()
        print('skipped resources/Assets.car: actool failed —', reason[-1] if reason else 'no output')
        if 'license' in (result.stderr + result.stdout).lower():
            print(f'  accept the Xcode licence first: sudo "{DEV}/usr/bin/xcodebuild" -license accept')
        return False
    shutil.copy(car, RESOURCES / 'Assets.car')
    return True


# ------------------------------------------------------------ backgrounds

def vertical(size: int, top: tuple, bottom: tuple) -> Image.Image:
    """A top-to-bottom gradient."""
    image = Image.new('RGB', (1, size))
    for y in range(size):
        t = y / (size - 1)
        image.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return image.resize((size, size))


def glow(base: Image.Image, at: tuple, radius: float, color: tuple, strength: float) -> None:
    """A soft blob of light, added onto `base`."""
    size = base.size[0]
    layer = Image.new('RGB', base.size, (0, 0, 0))
    mask = Image.new('L', base.size, 0)
    d = ImageDraw.Draw(mask)
    x, y = at[0] * size, at[1] * size
    r = radius * size
    d.ellipse((x - r, y - r, x + r, y + r), fill=round(255 * strength))
    mask = mask.filter(ImageFilter.GaussianBlur(r * 0.55))
    layer.paste(color, mask=mask)
    base.paste(Image.composite(Image.blend(base, layer, 1), base, mask), (0, 0))


def ridge(size: int, seed: int, base: float, height: float, waves: int) -> list:
    """A mountain skyline: a few sine waves of falling size, summed, as a closed polygon."""
    rng = random.Random(seed)
    parts = [(rng.uniform(0, math.tau), rng.uniform(0.6, 1.4) * (k + 1), 1 / (k + 1) ** 1.3) for k in range(waves)]
    points = []
    for i in range(size + 1):
        x = i / size
        y = sum(a * math.sin(x * f * math.tau + p) for p, f, a in parts)
        peak = abs(math.sin(x * math.pi * 1.6 + parts[0][0])) ** 3
        points.append((i, (base - height * (0.55 * y / waves + 0.6 * peak)) * size))
    return points + [(size, size), (0, size)]


def aurora(size: int) -> Image.Image:
    """A night sky: deep blue, curtains of green and violet light, a few stars, a dark horizon."""
    image = vertical(size, (8, 14, 38), (16, 34, 52))
    glow(image, (0.22, 0.34), 0.30, (60, 240, 160), 1.0)
    glow(image, (0.50, 0.18), 0.30, (70, 225, 200), 0.9)
    glow(image, (0.84, 0.36), 0.30, (175, 105, 255), 0.95)
    glow(image, (0.12, 0.66), 0.22, (40, 205, 140), 0.7)
    glow(image, (0.86, 0.72), 0.18, (120, 80, 230), 0.6)
    rng = random.Random(7)
    d = ImageDraw.Draw(image)
    for _ in range(70):
        x, y, r = rng.uniform(0, size), rng.uniform(0, size * 0.55), rng.choice((0.8, 1.1, 1.6))
        tone = rng.randint(170, 255)
        d.ellipse((x - r, y - r, x + r, y + r), fill=(tone, tone, 255))
    d.polygon(ridge(size, 3, 0.86, 0.10, 4), fill=(6, 12, 22))
    return image


def peaks(size: int) -> Image.Image:
    """Mountains at sunrise: a clear sky warming towards the horizon, a low sun, three ridges in haze."""
    image = vertical(size, (86, 140, 214), (250, 196, 150))
    glow(image, (0.68, 0.60), 0.20, (255, 236, 196), 0.9)
    d = ImageDraw.Draw(image)
    for seed, base, height, color in ((11, 0.66, 0.30, (150, 150, 186)), (5, 0.78, 0.26, (98, 96, 138)), (2, 0.92, 0.20, (52, 52, 84))):
        d.polygon(ridge(size, seed, base, height, 5), fill=color)
    return image


# Each variant: an id (the AppIcon value), a fill, the mark's colour, and
# optionally a painted background laid under the mark and grain.
VARIANTS = [
    {'id': 'light', 'fill': ((0.99, 0.99, 0.99), (0.90, 0.90, 0.92)), 'mark': (0.09, 0.09, 0.10)},
    {'id': 'ocean', 'fill': ((0.24, 0.52, 0.99), (0.04, 0.17, 0.45))},
    {'id': 'sunset', 'fill': ((1.00, 0.58, 0.26), (0.85, 0.18, 0.43))},
    {'id': 'forest', 'fill': ((0.22, 0.64, 0.44), (0.04, 0.22, 0.16))},
    {'id': 'grape', 'fill': ((0.58, 0.40, 0.98), (0.21, 0.08, 0.46))},
    {'id': 'aurora', 'paint': aurora},
    {'id': 'peaks', 'paint': peaks},
]


def srgb(color: tuple) -> str:
    return 'srgb:' + ','.join(f'{c:.5f}' for c in (*color, 1.0))


def variant_doc(spec: dict, tmp: Path) -> Path:
    """resources/Eaon.icon with this variant's fill, mark colour and background."""
    doc = tmp / f"{spec['id']}.icon"
    shutil.copytree(APP_ICON, doc)
    data = json.loads((doc / 'icon.json').read_text())
    if 'fill' in spec:
        data['fill']['linear-gradient'] = [srgb(spec['fill'][0]), srgb(spec['fill'][1])]
    if 'mark' in spec:
        for group in data['groups']:
            for layer in group['layers']:
                if layer.get('name') == 'Mark':
                    for option in layer.get('fill-specializations', []):
                        option['value'] = {'solid': srgb(spec['mark'])}
    if 'paint' in spec:
        spec['paint'](1024).save(doc / 'Assets' / 'background.png')
        data['groups'].append({
            'layers': [{'image-name': 'background.png', 'name': 'Background', 'glass': False}],
            'shadow': {'kind': 'none', 'opacity': 0},
            'translucency': {'enabled': False, 'value': 0},
            'specular': False,
        })
    (doc / 'icon.json').write_text(json.dumps(data, indent=2))
    return doc


def build_variants(tmp: Path) -> None:
    out = RESOURCES / 'app-icons'
    out.mkdir(exist_ok=True)
    for spec in VARIANTS:
        doc = variant_doc(spec, tmp)
        on_grid(doc, 1024, tmp).save(out / f"{spec['id']}.png")
        save_ico(doc, out / f"{spec['id']}.ico", tmp)
        on_grid(doc, 256, tmp, shadow=False).save(ASSETS / 'app-icons' / f"{spec['id']}.png")
    print('wrote resources/app-icons/ and the Settings tiles for', ', '.join(v['id'] for v in VARIANTS))


def main() -> None:
    if '--variants' in sys.argv:
        with tempfile.TemporaryDirectory() as t:
            build_variants(Path(t))
        return
    for doc in (APP_ICON, AGENT_ICON):
        if not (doc / 'icon.json').exists():
            sys.exit(f'error: {doc} is missing')
    (ASSETS / 'app-icons').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)

        big = on_grid(APP_ICON, 1024, tmp)
        big.save(RESOURCES / 'icon.png')
        save_icns(APP_ICON, big, RESOURCES / 'icon.icns', tmp)
        save_ico(APP_ICON, RESOURCES / 'icon.ico', tmp)
        tile = on_grid(APP_ICON, 256, tmp, shadow=False)
        tile.save(ASSETS / 'providers' / 'eaon.png')
        tile.save(ASSETS / 'app-icons' / 'default.png')

        on_grid(AGENT_ICON, 1024, tmp).save(RESOURCES / 'icon-agent.png')
        save_ico(AGENT_ICON, RESOURCES / 'icon-agent.ico', tmp)
        on_grid(AGENT_ICON, 256, tmp, shadow=False).save(ASSETS / 'app-icons' / 'agent.png')

        car = compile_car(tmp)
        build_variants(tmp)
    print('wrote resources/icon.png, icon.icns, icon.ico, icon-agent.png, icon-agent.ico'
          + (', Assets.car' if car else '') + ', the in-app eaon.png and the Settings app-icon tiles')


if __name__ == '__main__':
    main()
