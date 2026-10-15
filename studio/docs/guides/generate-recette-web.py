#!/usr/bin/env python3
"""Build only the new beginner's web acceptance guide, through Portly.

The shared Manrope/Nino renderer is imported without rebuilding its documents.
An optional JSON manifest maps screenshot keys to {path, caption}. Each caption
is mandatory, so an illustration cannot silently become room-test evidence.
"""
from __future__ import annotations

import argparse
import importlib.util
import io
import json
import math
import random
import sys
from pathlib import Path

from PIL import Image
from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.utils import ImageReader

sys.dont_write_bytecode = True
STUDIO = Path(__file__).resolve().parents[2]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


base = load_module('nino_guide_renderer', STUDIO / 'scripts/generate-guides.py')
content = load_module('nino_web_acceptance_content', Path(__file__).with_name('recette-web-content.py'))


class WebGuide(base.Document):
    def __init__(self, output, doc, screenshots, draft=False):
        super().__init__(output, doc, draft)
        self.screenshots = screenshots
        self.image_sources = []

    def cover(self):
        self.page = 1
        c = self.c
        c.bookmarkPage('cover')
        c.addOutlineEntry(self.doc['title'].replace('\n', ' '), 'cover', level=0)
        for n in range(160):
            t = n / 159
            c.setFillColor(colors.Color(.075 + .045*t, .078 + .049*t, .099 + .08*t))
            c.rect(0, base.PAGE_H*n/160, base.PAGE_W, base.PAGE_H/160+1, stroke=0, fill=1)
        rng = random.Random(20261015)
        for _ in range(3600):
            c.setFillColor(colors.Color(.40, .45, .56, alpha=rng.uniform(.035, .09)))
            c.circle(rng.uniform(0, base.PAGE_W), rng.uniform(0, base.PAGE_H), rng.uniform(.12, .44), stroke=0, fill=1)
        self.logo(base.MARGIN, base.PAGE_H-101, 48)
        c.setFillColor(base.WHITE); c.setFont('ManropeBold', 29)
        c.drawString(base.MARGIN+64, base.PAGE_H-83, 'Nino')
        c.setFillColor(colors.HexColor('#B9C1D1')); c.setFont('Manrope', 9)
        c.drawString(base.MARGIN+65, base.PAGE_H-100, 'STUDIO / TESTER DEPUIS LE NAVIGATEUR')
        c.setStrokeColor(colors.HexColor('#485167')); c.line(base.MARGIN, base.PAGE_H-129, base.PAGE_W-base.MARGIN, base.PAGE_H-129)
        c.setFont('ManropeSemibold', 10)
        c.drawString(base.MARGIN, base.PAGE_H-163, 'GUIDE 04 / ' + self.doc['audience'].upper())
        y = base.PAGE_H-203
        y -= self.para(self.doc['title'].replace('\n', '<br/>'), base.MARGIN, y, base.WIDTH, 'ManropeBold', 38, 47, base.WHITE)
        y -= 23
        y -= self.para(self.doc['subtitle'], base.MARGIN, y, base.WIDTH-20, 'Manrope', 14, 22, colors.HexColor('#C9D0DF'))
        y -= 20
        c.setFillColor(colors.HexColor('#303746')); c.roundRect(base.MARGIN, y-115, base.WIDTH, 115, 14, stroke=0, fill=1)
        self.para(self.doc['cover_note'], base.MARGIN+20, y-18, base.WIDTH-40, 'Manrope', 11.5, 18, base.WHITE)
        y -= 145
        c.setFillColor(colors.HexColor('#B9C1D1')); c.setFont('ManropeSemibold', 9)
        c.drawString(base.MARGIN, y, 'VOTRE PARCOURS')
        y -= 21
        for i, item in enumerate(self.doc['cover_topics'], 1):
            c.setFillColor(colors.HexColor('#7D8AA6')); c.circle(base.MARGIN+9, y-6, 9, stroke=0, fill=1)
            c.setFillColor(base.WHITE); c.setFont('ManropeBold', 9); c.drawCentredString(base.MARGIN+9, y-9, str(i))
            self.para(item, base.MARGIN+28, y+1, base.WIDTH-30, 'Manrope', 11, 17, colors.HexColor('#DBE1ED'))
            y -= 33
        if y < 130:
            raise ValueError('Cover overflow')
        c.setStrokeColor(colors.HexColor('#485167')); c.line(base.MARGIN, 98, base.PAGE_W-base.MARGIN, 98)
        c.setFillColor(colors.HexColor('#B9C1D1')); c.setFont('Manrope', 9)
        c.drawString(base.MARGIN, 76, 'Version du 15 octobre 2026')
        c.drawRightString(base.PAGE_W-base.MARGIN, 76, 'ninostudio.ch')
        c.setFont('Manrope', 8); c.drawString(base.MARGIN, 54, 'Mode d’emploi de test - les cases se valident dans votre salle')
        c.showPage()

    def footer(self):
        self.layout.append({'page': self.page, 'bottom': round(self.y, 1)})
        if self.y < 66:
            error = f'Page {self.page} overflow by {66-self.y:.1f} pt'
            if self.draft:
                print('DRAFT LAYOUT: ' + error)
            else:
                raise ValueError(error)
        c = self.c
        c.setStrokeColor(base.LINE); c.line(base.MARGIN, 48, base.PAGE_W-base.MARGIN, 48)
        c.setFont('Manrope', 8); c.setFillColor(base.MUTED)
        c.drawString(base.MARGIN, 31, 'Nino Studio / 15.10.2026')
        c.drawRightString(base.PAGE_W-base.MARGIN, 31, f'{self.page:02d} / {self.total:02d}')
        c.showPage()

    def screen(self, key, fallback, limit=190):
        supplied = self.screenshots.get(key)
        if supplied:
            source = Path(supplied['path'])
            caption = supplied['caption']
        else:
            demo = {'library': 'library', 'regie': 'regie', 'takes': 'takes'}
            if key not in demo:
                self.box(fallback, 'Repère à l’écran', 'light')
                return
            source = base.ASSETS / (demo[key] + '.png')
            caption = 'Capture de démonstration isolée : mire et fichiers synthétiques. Elle illustre l’écran ; elle ne valide pas le test de votre salle.'
        if not source.is_file() or not isinstance(caption, str) or not caption.strip():
            raise ValueError(f'Screenshot {key} requires an existing image and a clear caption')
        image = Image.open(source).convert('RGB')
        iw, ih = image.size
        ratio = min(base.WIDTH/iw, limit/ih)
        w, h = iw*ratio, ih*ratio
        x = base.MARGIN + (base.WIDTH-w)/2
        stream = io.BytesIO(); image.save(stream, format='PNG'); stream.seek(0)
        self.c.drawImage(ImageReader(stream), x, self.y-h, w, h)
        self.c.setStrokeColor(base.LINE); self.c.setLineWidth(.7); self.c.rect(x, self.y-h, w, h, stroke=1, fill=0)
        self.y -= h+8
        self.y -= self.para(caption, base.MARGIN, self.y, base.WIDTH, 'Manrope', 8.3, 12, base.MUTED)
        self.y -= 17
        self.image_sources.append({'key': key, 'path': str(source), 'caption': caption})

    def diagram(self, kind_name):
        if kind_name not in {'scope', 'presentation', 'record', 'package', 'guests', 'diagnostic'}:
            return super().diagram(kind_name)
        c = self.c
        x, y = base.MARGIN, self.y

        def node(nx, top, width, height, title, sub, dark=False):
            c.setFillColor(base.INK if dark else base.PALE)
            c.roundRect(nx, top-height, width, height, 9, stroke=0, fill=1)
            color = base.WHITE if dark else base.INK
            h = self.para(title, nx+11, top-11, width-22, 'ManropeBold', 10.2, 14, color)
            self.para(sub, nx+11, top-16-h, width-22, 'Manrope', 8.5, 12, color)

        def arrow(x1, y1, x2, y2):
            c.setStrokeColor(base.SLATE); c.setLineWidth(1.3); c.line(x1, y1, x2, y2)
            angle = math.atan2(y2-y1, x2-x1)
            for delta in (-.5, .5):
                c.line(x2, y2, x2-5*math.cos(angle+delta), y2-5*math.sin(angle+delta))

        items = {
            'scope': [('1. Le PC seul', 'Créer, enregistrer, relire'), ('2. Les options', 'Tester selon le matériel'), ('3. Le résultat', 'OK / Échec / Non testé')],
            'presentation': [('Contenu ouvert', 'Page, document, logiciel'), ('Capture dans OBS', 'Fenêtre, écran ou HDMI'), ('Vidéo finale', 'Image partagée + voix')],
            'record': [('Vous cliquez REC', 'La demande part vers OBS'), ('OBS confirme', 'REC actif, compteur'), ('Vous relisez', 'Image et son du fichier')],
            'package': [('Original', 'Vidéo entière produite par OBS'), ('Dossier complet', 'Originaux, médias, repères'), ('Paquet Resolve', 'Copies compatibles + OTIO')],
        }
        if kind_name in items:
            width = (base.WIDTH-32)/3
            for i, (title, sub) in enumerate(items[kind_name]):
                nx = x+i*(width+16)
                node(nx, y, width, 82, title, sub, i == 1)
                if i < 2:
                    arrow(nx+width+2, y-41, nx+width+14, y-41)
            self.y -= 100
        elif kind_name == 'guests':
            width = (base.WIDTH-24)/2
            node(x, y, width, 80, 'Ce que reçoit A', 'Salle + B ; jamais A', True)
            node(x+width+24, y, width, 80, 'Ce que reçoit B', 'Salle + A ; jamais B', True)
            self.y -= 93
            self.y -= self.para('Casques aux trois postes. OBS reçoit les invités séparément pour construire son programme.', x, self.y, base.WIDTH, 'Manrope', 9.5, 14, base.MUTED)
            self.y -= 16
        elif kind_name == 'diagnostic':
            width = (base.WIDTH-32)/3
            for i, (title, sub) in enumerate([
                ('1. Nino est ouvert ?', 'Non : adresse / service'),
                ('2. OBS est relié ?', 'Non : ouvrir / connecter'),
                ('3. OBS confirme ?', 'Non : lire le blocage'),
            ]):
                nx = x+i*(width+16)
                node(nx, y, width, 89, title, sub, i == 1)
                if i < 2:
                    arrow(nx+width+2, y-44, nx+width+14, y-44)
            self.y -= 107


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=STUDIO.parent / 'output/pdf/nino-recette-web.pdf')
    parser.add_argument('--qa-dir', type=Path, default=STUDIO.parent / 'tmp/pdfs/nino-recette-web')
    parser.add_argument('--screenshots-manifest', type=Path)
    parser.add_argument('--render', action='store_true')
    parser.add_argument('--render-bin', default='pdftoppm')
    parser.add_argument('--draft', action='store_true')
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.qa_dir.mkdir(parents=True, exist_ok=True)
    screenshots = json.loads(args.screenshots_manifest.read_text()) if args.screenshots_manifest else {}
    base.initialize_fonts(args.qa_dir)
    document = WebGuide(args.output, content.GUIDE, screenshots, args.draft)
    document.build()
    reader = PdfReader(args.output)
    texts = [page.extract_text() or '' for page in reader.pages]
    if any(len(text.strip()) < 100 or '\u25a0' in text or '\ufffd' in text for text in texts):
        raise ValueError('Empty page or missing PDF glyph')
    if args.render:
        import subprocess
        subprocess.run([args.render_bin, '-r', '110', '-png', str(args.output), str(args.qa_dir / 'page')], check=True)
    report = {'file': str(args.output), 'pages': len(reader.pages), 'bytes': args.output.stat().st_size,
              'layout': document.layout, 'images': document.image_sources}
    (args.qa_dir / 'build-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
