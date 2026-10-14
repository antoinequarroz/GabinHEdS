#!/usr/bin/env python3
"""Rebuild Nino's three French PDF guides with bundled artifact dependencies.

Run with the Codex bundled Python, through Portly, and an explicit --output.
Only public test screenshots are copied into docs/guides/assets.
"""
from __future__ import annotations
import argparse
import importlib.util
import io
import json
import math
import random
import re
import shutil
import subprocess
import sys
from pathlib import Path

from fontTools.ttLib import TTFont as VariableFont
from fontTools.varLib.instancer import instantiateVariableFont
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph
from reportlab.graphics import renderPDF
from svglib.svglib import svg2rlg
from pypdf import PdfReader

sys.dont_write_bytecode = True

STUDIO = Path(__file__).resolve().parents[1]
GUIDES = STUDIO / 'docs' / 'guides'
ASSETS = GUIDES / 'assets'
PAGE_W, PAGE_H = 595.2756, 841.8898
MARGIN = 44
WIDTH = PAGE_W - 2 * MARGIN
INK = colors.HexColor('#202128')
MUTED = colors.HexColor('#626977')
PAPER = colors.HexColor('#F7F6F1')
PALE = colors.HexColor('#ECEEF3')
SLATE = colors.HexColor('#596985')
LINE = colors.HexColor('#D6D9E1')
ACCENT = colors.HexColor('#79859F')
WHITE = colors.HexColor('#F8FAFE')

def clean(s: str) -> str:
    return s.replace('\u2011','-').replace('\u2013','-').replace('\u2014','-')

def initialize_fonts(tmp: Path):
    source = STUDIO / 'apps/web/public/fonts/manrope-variable.ttf'
    for name, weight in [('Manrope',400),('ManropeSemibold',600),('ManropeBold',700)]:
        destination = tmp / f'{name}.ttf'
        font = VariableFont(source)
        instance = instantiateVariableFont(font, {'wght': weight}, inplace=False)
        # ReportLab deduplicates by the PostScript face name. Variable instances
        # otherwise retain one name and silently make semibold/bold regular.
        for record in instance['name'].names:
            if record.nameID == 6:
                record.string=f'NinoManrope-{weight}'.encode(record.getEncoding())
        instance.save(destination)
        pdfmetrics.registerFont(TTFont(name, str(destination)))
    pdfmetrics.registerFontFamily('Manrope', normal='Manrope', bold='ManropeBold', italic='Manrope', boldItalic='ManropeBold')

def style(font='Manrope', size=10.7, leading=16, color=INK):
    return ParagraphStyle('Nino',fontName=font,fontSize=size,leading=leading,textColor=color,alignment=TA_LEFT,spaceAfter=0,allowWidows=0,allowOrphans=0)

class Document:
    def __init__(self, output: Path, doc: dict, draft=False):
        self.doc = doc
        self.c = canvas.Canvas(str(output), pagesize=(PAGE_W,PAGE_H),pageCompression=1,invariant=1)
        self.c.setTitle('Nino | ' + doc['title'])
        self.c.setAuthor('Nino Studio')
        self.c.setSubject(doc['subtitle'])
        self.c.setCreator('Nino - générateur reproductible ReportLab')
        self.page = 0
        self.total = len(doc['pages']) + 1
        self.y = 0
        self.draft = draft
        self.layout = []
        raw = (STUDIO / 'apps/web/public/brand/nino-mark.svg').read_text()
        raw = raw.replace('url(#ribbon)','#FAFBFE').replace('url(#fold)','#A9B3C8').replace('url(#return)','#DAE1F0')
        self.mark = svg2rlg(io.BytesIO(raw.encode()))

    def logo(self, x, y, size=32):
        self.c.saveState()
        self.c.translate(x,y)
        self.c.scale(size/80,size/80)
        renderPDF.draw(self.mark,self.c,0,0)
        self.c.restoreState()

    def para(self, text, x, y, width=WIDTH, font='Manrope', size=10.7, leading=16, color=INK):
        p=Paragraph(clean(text),style(font,size,leading,color))
        _, h=p.wrap(width,1000)
        p.drawOn(self.c,x,y-h)
        return h

    def cover(self):
        self.page = 1
        c=self.c
        c.bookmarkPage('cover')
        c.addOutlineEntry(self.doc['title'].replace('\n',' '),'cover',level=0)
        # Vector gradient and reproducible fine grain echo the app's backdrop.
        for n in range(160):
            t=n/159
            c.setFillColor(colors.Color(.075+.045*t,.078+.049*t,.099+.08*t))
            c.rect(0,PAGE_H*n/160,PAGE_W,PAGE_H/160+1,stroke=0,fill=1)
        rng=random.Random(20261014)
        for _ in range(3600):
            c.setFillColor(colors.Color(.40,.45,.56,alpha=rng.uniform(.035,.09)))
            c.circle(rng.uniform(0,PAGE_W),rng.uniform(0,PAGE_H),rng.uniform(.12,.44),stroke=0,fill=1)
        self.logo(MARGIN,PAGE_H-101,48)
        c.setFillColor(WHITE);c.setFont('ManropeBold',29);c.drawString(MARGIN+64,PAGE_H-83,'Nino')
        c.setFillColor(colors.HexColor('#B9C1D1'));c.setFont('Manrope',9);c.drawString(MARGIN+65,PAGE_H-100,'STUDIO / GUIDES DE LA SALLE')
        c.setStrokeColor(colors.HexColor('#485167'));c.line(MARGIN,PAGE_H-129,PAGE_W-MARGIN,PAGE_H-129)
        c.setFillColor(colors.HexColor('#B9C1D1'));c.setFont('ManropeSemibold',10);c.drawString(MARGIN,PAGE_H-163,'GUIDE '+self.doc['number']+' / '+self.doc['audience'].upper())
        y=PAGE_H-203
        y-=self.para(self.doc['title'].replace('\n','<br/>'),MARGIN,y,WIDTH,'ManropeBold',38,47,WHITE)
        y-=23
        y-=self.para(self.doc['subtitle'],MARGIN,y,WIDTH-20,'Manrope',14,22,colors.HexColor('#C9D0DF'))
        y-=35
        c.setFillColor(colors.HexColor('#303746'));c.roundRect(MARGIN,y-105,WIDTH,105,14,stroke=0,fill=1)
        self.para(self.doc['cover_note'],MARGIN+20,y-18,WIDTH-40,'Manrope',11.5,18,WHITE)
        y-=139
        c.setFillColor(colors.HexColor('#B9C1D1'));c.setFont('ManropeSemibold',9);c.drawString(MARGIN,y,'VOTRE PARCOURS')
        y-=21
        for i, item in enumerate(self.doc['cover_topics'],1):
            c.setFillColor(colors.HexColor('#7D8AA6'));c.circle(MARGIN+9,y-6,9,stroke=0,fill=1)
            c.setFillColor(WHITE);c.setFont('ManropeBold',9);c.drawCentredString(MARGIN+9,y-9,str(i))
            self.para(item,MARGIN+28,y+1,WIDTH-30,'Manrope',11,17,colors.HexColor('#DBE1ED'))
            y-=33
        if y<130: raise ValueError('Cover overflow '+self.doc['title'])
        c.setStrokeColor(colors.HexColor('#485167'));c.line(MARGIN,98,PAGE_W-MARGIN,98)
        c.setFillColor(colors.HexColor('#B9C1D1'));c.setFont('Manrope',9);c.drawString(MARGIN,76,'Version du 14 octobre 2026')
        c.drawRightString(PAGE_W-MARGIN,76,'ninostudio.ch')
        c.setFont('Manrope',8);c.drawString(MARGIN,54,'Logiciel de la salle - PC, iPad et Stream Deck')
        c.showPage()

    def start_page(self, page):
        self.page += 1
        c=self.c
        bookmark=f'page-{self.page}'
        c.bookmarkPage(bookmark)
        c.addOutlineEntry(page['title'],bookmark,level=1)
        c.setFillColor(PAPER);c.rect(0,0,PAGE_W,PAGE_H,stroke=0,fill=1)
        c.setFillColor(INK);c.roundRect(MARGIN,PAGE_H-70,29,29,7,stroke=0,fill=1)
        self.logo(MARGIN+3,PAGE_H-67,23)
        c.setFillColor(INK);c.setFont('ManropeBold',12);c.drawString(MARGIN+39,PAGE_H-55,'Nino')
        c.setFillColor(MUTED);c.setFont('Manrope',8.5);c.drawRightString(PAGE_W-MARGIN,PAGE_H-55,self.doc['short'])
        c.setStrokeColor(LINE);c.line(MARGIN,PAGE_H-84,PAGE_W-MARGIN,PAGE_H-84)
        c.setFillColor(SLATE);c.setFont('ManropeSemibold',8.5);c.drawString(MARGIN,PAGE_H-111,page['tag'].upper())
        self.y=PAGE_H-128
        self.y-=self.para(page['title'],MARGIN,self.y,WIDTH,'ManropeBold',26,33)
        self.y-=11
        if page.get('lead'):
            self.y-=self.para(page['lead'],MARGIN,self.y,WIDTH,'Manrope',11.5,17.5,MUTED)
            self.y-=19

    def footer(self):
        self.layout.append({'page':self.page,'bottom':round(self.y,1)})
        if self.y<66:
            error=f"Page {self.page} overflow by {66-self.y:.1f} pt in {self.doc['title']}"
            if self.draft: print('DRAFT LAYOUT: '+error)
            else: raise ValueError(error)
        c=self.c
        c.setStrokeColor(LINE);c.line(MARGIN,48,PAGE_W-MARGIN,48)
        c.setFont('Manrope',8);c.setFillColor(MUTED);c.drawString(MARGIN,31,'Nino Studio / 14.10.2026')
        c.drawRightString(PAGE_W-MARGIN,31,f'{self.page:02d} / {self.total:02d}')
        c.showPage()

    def p(self,text):
        self.y-=self.para(text,MARGIN,self.y)
        self.y-=13

    def heading(self,text):
        self.y-=self.para(text,MARGIN,self.y,WIDTH,'ManropeBold',13,19)
        self.y-=10

    def box(self,text,title='',tone='dark'):
        dark=tone=='dark'
        text_color=WHITE if dark else INK
        p=Paragraph(clean(text),style(size=10.5,leading=16,color=text_color))
        _,h=p.wrap(WIDTH-34,1000)
        title_h=24 if title else 0
        total=h+30+title_h
        c=self.c;c.setFillColor(INK if dark else PALE);c.roundRect(MARGIN,self.y-total,WIDTH,total,11,stroke=0,fill=1)
        if title: self.para(title,MARGIN+17,self.y-15,WIDTH-34,'ManropeBold',11,16,text_color)
        p.drawOn(c,MARGIN+17,self.y-15-title_h-h)
        self.y-=total+15

    def steps(self,items):
        for i,(title,text) in enumerate(items,1):
            self.c.setFillColor(INK);self.c.circle(MARGIN+11,self.y-11,11,stroke=0,fill=1)
            self.c.setFillColor(WHITE);self.c.setFont('ManropeBold',10);self.c.drawCentredString(MARGIN+11,self.y-14,str(i))
            x=MARGIN+35;w=WIDTH-35
            h=self.para(title,x,self.y,w,'ManropeBold',11.5,17)
            self.y-=h+4
            self.y-=self.para(text,x,self.y,w,'Manrope',10.5,15.5)
            self.y-=13

    def table(self,headers,rows,ratios=None):
        n=len(headers);ratios=ratios or [1]*n
        widths=[WIDTH*v/sum(ratios) for v in ratios]
        c=self.c
        def row(values,head=False):
            pars=[Paragraph(clean(str(v)),style('ManropeBold' if head else 'Manrope',9.5,14,WHITE if head else INK)) for v in values]
            hs=[p.wrap(w-20,1000)[1] for p,w in zip(pars,widths)]
            h=max(hs)+18
            c.setFillColor(INK if head else PALE);c.rect(MARGIN,self.y-h,WIDTH,h,stroke=0,fill=1)
            x=MARGIN
            for p,w,ph in zip(pars,widths,hs):p.drawOn(c,x+10,self.y-9-ph);x+=w
            self.y-=h
            c.setStrokeColor(PAPER);c.line(MARGIN,self.y,PAGE_W-MARGIN,self.y)
        row(headers,True)
        for r in rows: row(r)
        self.y-=17

    def checklist(self,rows):
        c=self.c
        for item in rows:
            c.setStrokeColor(SLATE);c.setLineWidth(.9);c.roundRect(MARGIN,self.y-12,11,11,2,stroke=1,fill=0)
            h=self.para(item,MARGIN+24,self.y,WIDTH-24,'Manrope',10.5,16)
            self.y-=max(h,16)+10

    def code(self,text):
        lines=clean(text).splitlines()
        if any(len(line)>78 for line in lines):raise ValueError('Command line too long: '+text)
        h=len(lines)*14+24
        c=self.c;c.setFillColor(INK);c.roundRect(MARGIN,self.y-h,WIDTH,h,10,stroke=0,fill=1)
        c.setFillColor(WHITE);c.setFont('Courier',9)
        for i,line in enumerate(lines): c.drawString(MARGIN+14,self.y-21-i*14,line)
        self.y-=h+15

    def screenshot(self,key,caption,limit=270,crop=None,points=None):
        path=ASSETS / (key+'.png')
        if not path.is_file(): raise FileNotFoundError(path)
        im=Image.open(path).convert('RGB')
        if crop: im=im.crop(tuple(crop))
        iw,ih=im.size;ratio=min(WIDTH/iw,limit/ih);w=iw*ratio;h=ih*ratio
        x=MARGIN+(WIDTH-w)/2
        stream=io.BytesIO();im.save(stream,format='PNG');stream.seek(0)
        c=self.c
        from reportlab.lib.utils import ImageReader
        c.drawImage(ImageReader(stream),x,self.y-h,w,h)
        c.setStrokeColor(LINE);c.setLineWidth(.7);c.rect(x,self.y-h,w,h,stroke=1,fill=0)
        for i,point in enumerate(points or [],1):
            px=x+point[0]*w;py=self.y-point[1]*h
            c.setFillColor(colors.HexColor('#DDE4F2'));c.setStrokeColor(INK);c.circle(px,py,9,stroke=1,fill=1)
            c.setFillColor(INK);c.setFont('ManropeBold',10);c.drawCentredString(px,py-3,str(i))
        self.y-=h+8
        self.y-=self.para(caption,MARGIN,self.y,WIDTH,'Manrope',8.3,12,MUTED)
        self.y-=17

    def panel(self,key,items,caption,height=385):
        """Legible interface detail beside explanatory text, never stretched."""
        from reportlab.lib.utils import ImageReader
        im=Image.open(ASSETS/(key+'.png')).convert('RGB')
        iw,ih=im.size;w=iw*height/ih
        if w>WIDTH*.43: raise ValueError('Panel screenshot too wide')
        c=self.c;c.drawImage(ImageReader(im),MARGIN,self.y-height,w,height)
        c.setStrokeColor(LINE);c.rect(MARGIN,self.y-height,w,height,stroke=1,fill=0)
        x=MARGIN+w+23;right_width=WIDTH-w-23;yy=self.y-2
        for title,text in items:
            yy-=self.para(title,x,yy,right_width,'ManropeBold',11,16)
            yy-=5
            yy-=self.para(text,x,yy,right_width,'Manrope',10.5,15.5)
            yy-=18
        self.y=min(self.y-height,yy)-10
        self.y-=self.para(caption,MARGIN,self.y,WIDTH,'Manrope',8.3,12,MUTED)
        self.y-=17

    def diagram(self,kind_name):
        kind=kind_name
        c=self.c;x=MARGIN;y=self.y
        def node(nx,ny,w,h,title,sub='',dark=False):
            c.setFillColor(INK if dark else PALE);c.roundRect(nx,ny-h,w,h,9,stroke=0,fill=1)
            col=WHITE if dark else INK
            self.para(title,nx+12,ny-12,w-24,'ManropeBold',10.5,15,col)
            if sub:self.para(sub,nx+12,ny-35,w-24,'Manrope',8.8,13,col)
        def arrow(x1,y1,x2,y2):
            c.setStrokeColor(SLATE);c.setLineWidth(1.4);c.line(x1,y1,x2,y2)
            angle=math.atan2(y2-y1,x2-x1);l=6
            c.line(x2,y2,x2-l*math.cos(angle-.5),y2-l*math.sin(angle-.5));c.line(x2,y2,x2-l*math.cos(angle+.5),y2-l*math.sin(angle+.5))
        if kind=='system':
            node(x,y,142,66,'Caméras + micros','Images et voix dans OBS')
            node(x+180,y,145,66,'OBS sur le PC','Capture et enregistrement',True)
            node(x+363,y,WIDTH-363,66,'Vidéos originales','Sur le disque du PC')
            arrow(x+145,y-33,x+176,y-33);arrow(x+328,y-33,x+358,y-33)
            node(x+180,y-102,145,67,'Nino','Projets et commandes',True)
            arrow(x+253,y-100,x+253,y-70)
            node(x,y-208,WIDTH,57,'PC, iPad, Stream Deck','Même salle, mêmes projets, accès propre à chaque appareil')
            arrow(x+253,y-204,x+253,y-174)
            self.y-=281
        elif kind=='flow':
            labels=[('1. Créer','Nom et format'),('2. Préparer','Image et son'),('3. Produire','REC et/ou LIVE'),('4. Récupérer','Originaux + ZIP')]
            w=(WIDTH-30)/4
            for i,(title,sub) in enumerate(labels):
                node(x+i*(w+10),y,w,76,title,sub,i==2)
                if i<3:arrow(x+i*(w+10)+w+1,y-39,x+(i+1)*(w+10)-2,y-39)
            self.y-=95
        elif kind=='live':
            node(x,y,138,67,'OBS','Programme image + son',True)
            node(x+183,y,141,67,'Transport local','MediaMTX')
            node(x+366,y,WIDTH-366,67,'Relais live','Vers la plateforme')
            arrow(x+141,y-34,x+179,y-34);arrow(x+327,y-34,x+362,y-34)
            node(x,y-106,138,57,'Enregistrement','Fichier original sur PC')
            arrow(x+69,y-70,x+69,y-102)
            node(x+183,y-106,141,57,'Retour PC / iPad','Image avec léger retard')
            arrow(x+253,y-70,x+253,y-102)
            self.y-=169
        elif kind in ('mics','mics_small'):
            node(x,y,144,73,'Personne 1','Micro 1 + Caméra 1')
            node(x+181,y,144,73,'Personne 2','Micro 2 + Caméra 2')
            node(x+362,y,WIDTH-362,73,'Plan large','Toute la table')
            if kind=='mics':
                node(x,y-112,WIDTH,82,'Réalisation automatique locale','Niveau des micros -> confirmation -> changement de scène dans OBS',True)
                for nx in [x+72,x+253,x+434]:arrow(nx,y-78,nx,y-106)
                self.y-=201
            else:self.y-=89
        elif kind=='deck':
            labels=[('REC','Enregistrer'),('STOP','Terminer prise'),('LIVE','Diffuser'),('OFF','Arrêter live'),('LARGE','Plan large'),('REPÈRE','À revoir'),('AUTO','Automatique'),('MANUEL','Reprendre main')]
            gap=9;w=(WIDTH-gap*3)/4
            for i,(a,b) in enumerate(labels):
                col=i%4;row=i//4
                node(x+col*(w+gap),y-row*83,w,74,a,b,i in [0,2])
            self.y-=178
        elif kind=='files':
            node(x,y,WIDTH,61,'Dossier complet de la production','Un ZIP que vous pouvez décompresser et conserver',True)
            entries=[('Vidéo(s) originale(s)','La prise complète produite par OBS'),('Médias associés','Intro, logo, musique, présentation'),('Informations et repères','Noms, prises, positions, journal des plans'),('Export Resolve distinct','Copies MP4 + timeline portable + aide d’import')]
            yy=y-84
            for a,b in entries:
                c.setStrokeColor(LINE);c.line(x+17,yy+1,x+17,yy-42);c.line(x+17,yy-20,x+40,yy-20)
                node(x+45,yy,WIDTH-45,60,a,b)
                yy-=73
            self.y-=84+4*73
        else:raise ValueError(kind)

    def build(self):
        self.cover()
        for page in self.doc['pages']:
            self.start_page(page)
            for block in page['blocks']:
                kind=block['kind'];values={k:v for k,v in block.items() if k!='kind'}
                getattr(self,kind)(**values)
            self.footer()
        self.c.save()

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,default=STUDIO.parent/'output/pdf')
    parser.add_argument('--qa-dir',type=Path,default=STUDIO.parent/'tmp/pdfs/nino-guides')
    parser.add_argument('--import-screenshots',type=Path)
    parser.add_argument('--resolve-screenshot',type=Path)
    parser.add_argument('--import-current-screenshots',type=Path)
    parser.add_argument('--draft',action='store_true',help='Preflight only: permit overflow and report it')
    parser.add_argument('--render',action='store_true')
    parser.add_argument('--render-bin',default='pdftoppm')
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True);args.qa_dir.mkdir(parents=True,exist_ok=True)
    if args.import_screenshots:
        ASSETS.mkdir(parents=True,exist_ok=True)
        for target,source in [('library','nino-library-pc.png'),('regie','gabin-studio-pc.png'),('takes','nino-production-files-pc.png')]:
            shutil.copyfile(args.import_screenshots/source,ASSETS/(target+'.png'))
    if args.resolve_screenshot:
        ASSETS.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(args.resolve_screenshot,ASSETS/'resolve.png')
    if args.import_current_screenshots:
        ASSETS.mkdir(parents=True,exist_ok=True)
        for target,source in [('library','nino-library-pc.png'),('regie','gabin-studio-pc.png'),('takes','nino-resolve-pc.png'),('auto-pc','nino-auto-pc-detail.png')]:
            shutil.copyfile(args.import_current_screenshots/source,ASSETS/(target+'.png'))
    initialize_fonts(args.qa_dir)
    spec=importlib.util.spec_from_file_location('nino_guide_content',GUIDES/'content.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    report=[]
    for doc in module.DOCUMENTS:
        output=args.output/doc['filename'];document=Document(output,doc,args.draft);document.build()
        reader=PdfReader(output)
        texts=[p.extract_text() for p in reader.pages]
        if any(len(t.strip())<100 for t in texts): raise ValueError('Suspiciously empty PDF page')
        if any('\u25a0' in t or '\ufffd' in t for t in texts): raise ValueError('Missing glyph in PDF')
        if args.render:
            rendered=args.qa_dir/output.stem
            rendered.mkdir(parents=True,exist_ok=True)
            subprocess.run([args.render_bin,'-r','100','-png',str(output),str(rendered/'page')],check=True)
        report.append({'file':str(output),'pages':len(reader.pages),'bytes':output.stat().st_size,'layout':document.layout})
    (args.qa_dir/'build-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
