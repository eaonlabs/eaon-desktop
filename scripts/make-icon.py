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

The PNGs and the icns follow macOS's icon grid: the tile is 824 of 1024 px,
centred, with a soft shadow in the margin (none on the in-app tiles). The ico
files are full bleed, as Windows draws icons.

actool refuses to run until the Xcode licence is accepted
(sudo xcodebuild -license accept). Without it everything except Assets.car
is still rebuilt, and the script says so.

Needs Python 3 with Pillow, and Xcode 26 or later.

    python3 scripts/make-icon.py
"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageFilter

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


def main() -> None:
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
    print('wrote resources/icon.png, icon.icns, icon.ico, icon-agent.png, icon-agent.ico'
          + (', Assets.car' if car else '') + ', the in-app eaon.png and the Settings app-icon tiles')


if __name__ == '__main__':
    main()
