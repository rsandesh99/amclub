"""Product/pool card images for the AMC Mart demo listings.
Emerald & Brass palette (FRONTEND.md): ivory ground, emerald band, brass rule.
No photos — typographic product cards, so nothing is passed off as a real photo."""
import json, os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), 'demo-images')
os.makedirs(OUT, exist_ok=True)
W, H = 640, 640
IVORY, EMERALD, BRASS, INK, MUTED = '#F6F1E7', '#0E6B5C', '#B08D57', '#17202E', '#6B7280'
F = lambda size, bold=False: ImageFont.truetype(r'C:\Windows\Fonts\arialbd.ttf' if bold else r'C:\Windows\Fonts\arial.ttf', size)

def wrap(draw, text, font, maxw):
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if draw.textlength(t, font=font) <= maxw: cur = t
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines

def card(key, category, name, brand, spec, badge=None):
    im = Image.new('RGB', (W, H), IVORY)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 84], fill=EMERALD)
    d.text((36, 26), category.upper(), font=F(24, True), fill='#E8F3EF')
    if badge:
        bw = d.textlength(badge, font=F(22, True)) + 36
        d.rounded_rectangle([W - 40 - bw, 28, W - 40, 68], radius=8, fill=BRASS)
        d.text((W - 40 - bw + 18, 36), badge, font=F(22, True), fill='#FFFFFF')
    y = 130
    for line in wrap(d, name, F(48, True), W - 72)[:4]:
        d.text((40, y), line, font=F(48, True), fill=INK); y += 58
    d.line([40, y + 10, 200, y + 10], fill=BRASS, width=5); y += 40
    if brand:
        d.text((40, y), brand, font=F(32), fill=EMERALD); y += 46
    for line in wrap(d, spec, F(28), W - 80)[:2]:
        d.text((40, y), line, font=F(28), fill=MUTED); y += 38
    d.text((40, H - 60), 'AMC Mart', font=F(24, True), fill=BRASS)
    d.text((W - 40 - d.textlength('amclub.in', font=F(22)), H - 58), 'amclub.in', font=F(22), fill=MUTED)
    im.save(os.path.join(OUT, f'{key}.png'), optimize=True)

items = json.load(open(os.path.join(os.path.dirname(__file__), 'catalog.json'), encoding='utf-8'))
for p in items['products']:
    card(p['key'], p['category_label'], p['name'], p.get('brand'), p['image_spec'])
for pl in items['pools']:
    card(pl['key'], pl['category_label'], pl['title'], None, pl['image_spec'], badge='GROUP BUY')
print('images:', len(os.listdir(OUT)))
