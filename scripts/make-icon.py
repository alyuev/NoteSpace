"""Draws the NoteSpace app icon (1024×1024): concentric tilted rings around a glowing centre.

Usage: python scripts/make-icon.py  →  src-tauri/icons/source.png
Then: npx tauri icon src-tauri/icons/source.png  (generates all sizes and icon.ico)
"""
from PIL import Image, ImageDraw, ImageFilter
import os

S = 1024
SS = 4  # supersampling for smooth edges
W = S * SS
out = os.path.join(os.path.dirname(__file__), '..', 'src-tauri', 'icons', 'source.png')

img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Rounded-square background in the app's dark theme.
d.rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.22), fill=(22, 22, 30, 255))

cx, cy = W / 2, W * 0.52
# Tilted rings (flattened ellipses): Havona-like circuits around the centre.
rings = [
    (0.40, (115, 218, 202)),  # outer, teal
    (0.31, (137, 221, 255)),  # blue
    (0.22, (255, 255, 255)),  # white
    (0.14, (255, 216, 102)),  # gold, inner
]
for rx, color in rings:
    a, b = rx * W, rx * W * 0.42
    d.ellipse([cx - a, cy - b, cx + a, cy + b], outline=color + (235,), width=int(W * 0.022))

# Glowing centre (Paradise).
glow = Image.new('RGBA', (W, W), (0, 0, 0, 0))
g = ImageDraw.Draw(glow)
r = W * 0.085
g.ellipse([cx - r * 2.2, cy - r * 2.2, cx + r * 2.2, cy + r * 2.2], fill=(255, 216, 102, 120))
glow = glow.filter(ImageFilter.GaussianBlur(W * 0.04))
img = Image.alpha_composite(img, glow)
d = ImageDraw.Draw(img)
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 236, 170, 255))

# A vertical axis through the centre, as in the app.
d.line([cx, W * 0.16, cx, W * 0.86], fill=(169, 177, 214, 110), width=int(W * 0.008))

img = img.resize((S, S), Image.LANCZOS)
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out)
print('saved', os.path.abspath(out))
