# Bakes Lobe Icons (MIT, @lobehub/icons-static-svg) into square provider tiles.
# Usage: npm pack @lobehub/icons-static-svg@1.95.1 && tar xzf *.tgz &&
#        python3 scripts/make-provider-tiles.py package/icons
import re, os, sys
SRC = sys.argv[1]
OUT = 'src/renderer/src/assets/providers'
# name -> (lobe icon, background, foreground for single-colour marks or None for colour marks, glyph size out of 40)
TILES = {
  'deepseek':   ('deepseek-color', '#ffffff', None, 26),
  'cohere':     ('cohere-color', '#ffffff', None, 26),
  'perplexity': ('perplexity-color', '#ffffff', None, 26),
  'poe':        ('poe-color', '#ffffff', None, 26),
  'cerebras':   ('cerebras-color', '#ffffff', None, 26),
  'fireworks':  ('fireworks-color', '#ffffff', None, 26),
  'together':   ('together-color', '#ffffff', None, 26),
  'deepinfra':  ('deepinfra-color', '#ffffff', None, 26),
  'novita':     ('novita-color', '#ffffff', None, 26),
  'sambanova':  ('sambanova-color', '#ffffff', None, 26),
  'kimi':       ('kimi-color', '#000000', None, 26),
  'qwen':       ('qwen-color', '#ffffff', None, 26),
  'zhipu':      ('zhipu-color', '#ffffff', None, 26),
  'vllm':       ('vllm-color', '#ffffff', None, 26),
  'workersai':  ('workersai-color', '#ffffff', None, 26),
  'cloudflare': ('cloudflare-color', '#ffffff', None, 28),
  'bedrock':    ('bedrock-color', '#ffffff', None, 26),
  'codex':      ('codex-color', '#ffffff', None, 26),
  'geminicli':  ('geminicli-color', '#ffffff', None, 26),
  'zai':        ('zai', '#000000', '#ffffff', 24),
  'xiaomimimo': ('xiaomimimo', '#ff6900', '#ffffff', 24),
  'opencode':   ('opencode', '#111111', '#ffffff', 22),
  'vercel':     ('vercel', '#000000', '#ffffff', 20),
  'baseten':    ('baseten', '#0b1215', '#ffffff', 24),
  'nebius':     ('nebius', '#0e1d2b', '#e0ff4f', 24),
  'lmstudio':   ('lmstudio', '#4338ca', '#ffffff', 24),
  'githubcopilot': ('githubcopilot', '#000000', '#ffffff', 24),
}
for name, (icon, bg, fg, glyph) in TILES.items():
    raw = open(os.path.join(SRC, icon + '.svg')).read()
    m = re.match(r'\s*<svg([^>]*)>(.*)</svg>\s*$', raw, re.S)
    attrs, inner = m.group(1), m.group(2)
    vb = re.search(r'viewBox="([^"]+)"', attrs).group(1)
    inner = re.sub(r'<title>.*?</title>', '', inner, flags=re.S)
    # Gradient/mask ids must not collide once several tiles are on one page.
    for gid in set(re.findall(r'id="([^"]+)"', inner)):
        inner = inner.replace(f'id="{gid}"', f'id="{name}-{gid}"').replace(f'url(#{gid})', f'url(#{name}-{gid})').replace(f'href="#{gid}"', f'href="#{name}-{gid}"')
    fill = ''
    if not fg:
        # A colour mark's neutral parts: black on the white tile, as in an <img> they default to nothing useful.
        inner = inner.replace('currentColor', '#000000')
    if fg:
        inner = inner.replace('currentColor', fg)
        fill = f' fill="{fg}"'
        rule = re.search(r'fill-rule="([^"]+)"', attrs)
        if rule: fill += f' fill-rule="{rule.group(1)}"'
    off = (40 - glyph) / 2
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="160" height="160">'
           f'<rect width="40" height="40" fill="{bg}"/>'
           f'<svg x="{off}" y="{off}" width="{glyph}" height="{glyph}" viewBox="{vb}"{fill}>{inner}</svg></svg>\n')
    open(os.path.join(OUT, f'{name}.svg'), 'w').write(svg)
    print('wrote', name)
