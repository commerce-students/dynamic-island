import os
from PIL import Image, ImageDraw, ImageFilter

S = 1024
BG_TOP = (86, 150, 255)
BG_BOT = (128, 92, 236)
INK = (10, 12, 18)
DOT = (52, 199, 89)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


# gradient background
bg = Image.new("RGB", (S, S))
px = bg.load()
for y in range(S):
    row = lerp(BG_TOP, BG_BOT, y / (S - 1))
    for x in range(S):
        px[x, y] = row

canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255)
canvas.paste(bg, (0, 0), mask)

# soft diagonal sheen
sheen = Image.new("L", (S, S), 0)
d = ImageDraw.Draw(sheen)
d.ellipse([-S * 0.35, -S * 0.75, S * 1.15, S * 0.42], fill=64)
sheen = sheen.filter(ImageFilter.GaussianBlur(S * 0.09))
gloss = Image.new("RGBA", (S, S), (255, 255, 255, 255))
canvas.paste(gloss, (0, 0), Image.composite(sheen, Image.new("L", (S, S), 0), mask))

# capsule shadow
pill_w, pill_h = int(S * 0.66), int(S * 0.245)
x0, y0 = (S - pill_w) // 2, int(S * 0.375)
shadow = Image.new("L", (S, S), 0)
ImageDraw.Draw(shadow).rounded_rectangle(
    [x0, y0 + int(S * 0.045), x0 + pill_w, y0 + pill_h + int(S * 0.045)],
    radius=pill_h // 2, fill=120
)
shadow = shadow.filter(ImageFilter.GaussianBlur(S * 0.035))
canvas.paste(Image.new("RGBA", (S, S), (20, 10, 60, 255)), (0, 0), shadow)

# capsule
pill = Image.new("RGBA", (S, S), (0, 0, 0, 0))
pd = ImageDraw.Draw(pill)
pd.rounded_rectangle([x0, y0, x0 + pill_w, y0 + pill_h], radius=pill_h // 2, fill=INK + (255,))

# inner top highlight
hi = Image.new("L", (S, S), 0)
ImageDraw.Draw(hi).rounded_rectangle(
    [x0 + int(pill_w * 0.10), y0 + int(pill_h * 0.13),
     x0 + pill_w - int(pill_w * 0.10), y0 + int(pill_h * 0.44)],
    radius=int(pill_h * 0.18), fill=46
)
hi = hi.filter(ImageFilter.GaussianBlur(S * 0.012))
pill.paste(Image.new("RGBA", (S, S), (255, 255, 255, 255)), (0, 0), hi)
canvas.alpha_composite(pill)

# live indicator dot
r = int(pill_h * 0.145)
cx = x0 + pill_w - int(pill_h * 0.46)
cy = y0 + pill_h // 2
glow = Image.new("L", (S, S), 0)
ImageDraw.Draw(glow).ellipse([cx - r * 2.6, cy - r * 2.6, cx + r * 2.6, cy + r * 2.6], fill=110)
glow = glow.filter(ImageFilter.GaussianBlur(S * 0.012))
canvas.paste(Image.new("RGBA", (S, S), DOT + (255,)), (0, 0), glow)
ImageDraw.Draw(canvas).ellipse([cx - r, cy - r, cx + r, cy + r], fill=DOT + (255,))

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build")
os.makedirs(out, exist_ok=True)

canvas.save(os.path.join(out, "icon.png"))
sizes = [16, 24, 32, 48, 64, 128, 256]
canvas.save(os.path.join(out, "icon.ico"), sizes=[(s, s) for s in sizes])
print("wrote", os.path.join(out, "icon.ico"))

# small-size preview strip for eyeballing
strip = Image.new("RGBA", (16 + 24 + 32 + 48 + 64 + 128 + 256 + 7 * 12, 256), (24, 24, 28, 255))
x = 0
for s in sizes:
    strip.alpha_composite(canvas.resize((s, s), Image.LANCZOS), (x, 256 - s))
    x += s + 12
strip.save(os.path.join(out, "icon-preview.png"))
