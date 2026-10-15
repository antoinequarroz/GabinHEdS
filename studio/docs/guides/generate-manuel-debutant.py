#!/usr/bin/env python3
"""Build Nino's complete beginner manual without rebuilding existing guides."""
from __future__ import annotations
import argparse
import importlib.util
import json
import math
import random
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
STUDIO = Path(__file__).resolve().parents[2]
GUIDES = Path(__file__).parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, GUIDES / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


web = load('nino_manual_shared_renderer', 'generate-recette-web.py')
base = web.base
colors = base.colors


def page(tag, title, lead, *blocks):
    return dict(tag=tag, title=title, lead=lead, blocks=list(blocks))


def assemble():
    foundation = load('nino_manual_foundation', 'manuel-decouverte-content.py')
    production = load('nino_manual_production', 'manuel-production-content.py')
    options = load('nino_manual_options', 'manuel-options-content.py')
    groups = [
        ('Découvrir et prendre ses repères', foundation.PAGES_BEGIN),
        ('Créer, enregistrer et récupérer', production.PAGES),
        ('Appareils, invités, automatique et live', options.PAGES),
        ('Sauvegarder et se dépanner', foundation.PAGES_END),
    ]
    content = [p for _, pages in groups for p in pages]
    for entry in content:
        subject = (entry['tag']+' '+entry['title']).lower()
        if 'usb' in subject and 'windows' in subject:
            entry['reference'] = ('Aide officielle Microsoft : copier et transférer les fichiers',
                'https://support.microsoft.com/fr-fr/windows/experience/backup-recovery/move-your-files-to-a-new-windows-pc-using-an-external-storage-device')
        elif 'usb' in subject and 'mac' in subject:
            entry['reference'] = ('Aide officielle Apple : utiliser et éjecter une clé USB',
                'https://support.apple.com/fr-fr/guide/mac-help/-mchl027f1d66/mac')
        elif 'importer' in subject and 'mp4' in subject:
            entry['reference'] = ('Aide officielle Blackmagic Design : importer les médias dans Resolve',
                'https://www.blackmagicdesign.com/products/davinciresolve/media')
        elif 'besoin d’aide' in subject and 'usb' in subject:
            entry['reference'] = ('Aide du fabricant : clé USB, FAT32 et fichiers de plus de 4 Go',
                'https://support-fr.sandisk.com/app/answers/detailweb/a_id/36629/')
    entries_per_page = 26
    index_count = math.ceil(len(content) / entries_per_page)
    first_content = 3 + index_count
    entries = [dict(title=p['title'], page=first_content+i) for i, p in enumerate(content)]
    starts, cursor = [], first_content
    for title, pages in groups:
        starts.append(dict(title=title, page=cursor))
        cursor += len(pages)
    quick = page('Lire ce manuel', 'Choisir votre point de départ',
        'Vous pouvez lire dans l’ordre ou cliquer sur un titre du sommaire. Les signets du lecteur PDF et le lien Sommaire en bas de page facilitent les retours.',
        dict(kind='contents', items=starts, spacious=True),
        dict(kind='box', title='Pour votre première vidéo', tone='dark',
             text='Commencez par les repères, puis suivez Créer, enregistrer et récupérer. Faites une prise de trente secondes avant une vraie séance. Le live et les invités s’ajoutent ensuite.'),
        dict(kind='box', title='Comment suivre une page', tone='light',
             text='Lisez le but, faites les gestes numérotés, puis vérifiez le résultat indiqué. Les commandes citées reprennent les noms de Nino. Si votre accès ne montre pas un réglage, demandez à la personne qui prépare la salle.'),
        dict(kind='box', title='Emporter la vidéo pour la monter ailleurs', tone='light',
             text='Suivez le parcours MP4 et clé USB : téléchargement, copie sur la clé, puis sur l’autre ordinateur et import dans DaVinci. Le logiciel de montage est installé sur cet autre ordinateur.'),
        dict(kind='p', text='Ce manuel décrit les fonctions disponibles au 15 octobre 2026. Les noms de scènes et les appareils dépendent de votre salle. Les illustrations de démonstration ne prouvent pas que votre matériel a été testé.'))
    indexes = []
    for i in range(index_count):
        indexes.append(page('Sommaire cliquable', f'Toutes les manipulations {i+1}/{index_count}',
                            'Cliquez sur un titre pour ouvrir directement la page correspondante.',
                            dict(kind='contents', items=entries[i*entries_per_page:(i+1)*entries_per_page])))
    return dict(filename='nino-manuel-complet.pdf', number='05',
        title='Le manuel\npour débuter', short='Manuel complet / débutant',
        audience='Prendre en main toute la salle',
        subtitle='Préparer, enregistrer, diffuser et récupérer une production, même quand on commence de zéro.',
        cover_note='<b>Un mode d’emploi à garder près de vous.</b><br/>Des gestes expliqués dans l’ordre, des schémas, des exemples et des solutions aux blocages. La première installation et les branchements spécifiques se font avec la personne qui prépare la salle.',
        cover_topics=['Votre première vidéo, du titre au fichier final',
                      'Podcast, table ronde, présentation et direct',
                      'iPad, Stream Deck, invités et caméras automatiques',
                      'Vidéo MP4, clé USB et montage dans DaVinci'],
        pages=[quick, *indexes, *content])


class Manual(web.WebGuide):
    def cover(self):
        self.page = 1
        c = self.c
        c.bookmarkPage('cover')
        c.addOutlineEntry('Nino - Le manuel pour débuter', 'cover', level=0)
        for n in range(160):
            t = n/159
            c.setFillColor(colors.Color(.075+.045*t, .078+.049*t, .099+.08*t))
            c.rect(0, base.PAGE_H*n/160, base.PAGE_W, base.PAGE_H/160+1, stroke=0, fill=1)
        rng = random.Random(20261015)
        for _ in range(3600):
            c.setFillColor(colors.Color(.40, .45, .56, alpha=rng.uniform(.035,.09)))
            c.circle(rng.uniform(0,base.PAGE_W), rng.uniform(0,base.PAGE_H), rng.uniform(.12,.44), stroke=0, fill=1)
        self.logo(base.MARGIN, base.PAGE_H-101, 48)
        c.setFillColor(base.WHITE); c.setFont('ManropeBold',29)
        c.drawString(base.MARGIN+64, base.PAGE_H-83, 'Nino')
        c.setFillColor(colors.HexColor('#B9C1D1')); c.setFont('Manrope',9)
        c.drawString(base.MARGIN+65, base.PAGE_H-100, 'STUDIO / MODE D’EMPLOI COMPLET')
        c.setStrokeColor(colors.HexColor('#485167'))
        c.line(base.MARGIN, base.PAGE_H-129, base.PAGE_W-base.MARGIN, base.PAGE_H-129)
        c.setFont('ManropeSemibold',10)
        c.drawString(base.MARGIN, base.PAGE_H-163, 'GUIDE 05 / POUR COMMENCER EN CONFIANCE')
        y = base.PAGE_H-203
        y -= self.para(self.doc['title'].replace('\n','<br/>'),base.MARGIN,y,base.WIDTH,'ManropeBold',38,47,base.WHITE)
        y -= 23
        y -= self.para(self.doc['subtitle'],base.MARGIN,y,base.WIDTH-20,'Manrope',14,22,colors.HexColor('#C9D0DF'))
        y -= 20
        c.setFillColor(colors.HexColor('#303746'))
        c.roundRect(base.MARGIN,y-115,base.WIDTH,115,14,stroke=0,fill=1)
        self.para(self.doc['cover_note'],base.MARGIN+20,y-18,base.WIDTH-40,'Manrope',11.5,18,base.WHITE)
        y -= 145
        c.setFillColor(colors.HexColor('#B9C1D1')); c.setFont('ManropeSemibold',9)
        c.drawString(base.MARGIN,y,'À VOTRE RYTHME')
        y -= 21
        for i, text in enumerate(self.doc['cover_topics'],1):
            c.setFillColor(colors.HexColor('#7D8AA6')); c.circle(base.MARGIN+9,y-6,9,stroke=0,fill=1)
            c.setFillColor(base.WHITE); c.setFont('ManropeBold',9)
            c.drawCentredString(base.MARGIN+9,y-9,str(i))
            self.para(text,base.MARGIN+28,y+1,base.WIDTH-30,'Manrope',11,17,colors.HexColor('#DBE1ED'))
            y -= 33
        if y < 130: raise ValueError('Cover overflow')
        c.setStrokeColor(colors.HexColor('#485167'))
        c.line(base.MARGIN,98,base.PAGE_W-base.MARGIN,98)
        c.setFillColor(colors.HexColor('#B9C1D1')); c.setFont('Manrope',9)
        c.drawString(base.MARGIN,76,'Version du 15 octobre 2026')
        c.drawRightString(base.PAGE_W-base.MARGIN,76,'ninostudio.ch')
        c.setFont('Manrope',8)
        c.drawString(base.MARGIN,54,'PC de la salle, iPad, mobile et Stream Deck')
        c.showPage()

    def footer(self):
        self.layout.append(dict(page=self.page, bottom=round(self.y,1)))
        if self.y < 66:
            if self.draft: print(f'DRAFT LAYOUT: Page {self.page} overflow by {66-self.y:.1f} pt')
            else: raise ValueError(f'Page {self.page} overflow by {66-self.y:.1f} pt')
        c = self.c
        reference = self.doc['pages'][self.page-2].get('reference')
        if reference:
            label, url = reference
            c.setFont('Manrope', 7.6); c.setFillColor(base.SLATE)
            c.drawString(base.MARGIN, 58, label)
            width = base.pdfmetrics.stringWidth(label, 'Manrope', 7.6)
            c.linkURL(url, (base.MARGIN, 55, base.MARGIN+width, 66), relative=0, thickness=0)
        c.setStrokeColor(base.LINE); c.line(base.MARGIN,48,base.PAGE_W-base.MARGIN,48)
        c.setFont('Manrope',8); c.setFillColor(base.MUTED)
        c.drawString(base.MARGIN,31,'Nino Studio / Manuel complet / 15.10.2026')
        c.setFillColor(base.SLATE)
        c.drawString(360,31,'Sommaire')
        c.linkRect('','page-2',(356,25,410,42),relative=0,thickness=0)
        c.setFillColor(base.MUTED)
        c.drawRightString(base.PAGE_W-base.MARGIN,31,f'{self.page:02d} / {self.total:02d}')
        c.showPage()

    def contents(self, items, spacious=False):
        for item in items:
            size = 11.3 if spacious else 9.5
            leading = 16 if spacious else 13
            top = self.y
            h = self.para(item['title'],base.MARGIN+8,top,base.WIDTH-49,'ManropeSemibold' if spacious else 'Manrope',size,leading)
            c = self.c
            c.setFillColor(base.SLATE); c.setFont('ManropeSemibold',size)
            c.drawRightString(base.PAGE_W-base.MARGIN-6,top-size,str(item['page']))
            row_h = max(h+(9 if spacious else 7),34 if spacious else 20)
            c.linkRect('',f"page-{item['page']}",(base.MARGIN,top-row_h,base.PAGE_W-base.MARGIN,top+2),relative=0,thickness=0)
            self.y -= row_h
            c.setStrokeColor(base.LINE); c.setLineWidth(.35)
            c.line(base.MARGIN,self.y+3,base.PAGE_W-base.MARGIN,self.y+3)
        self.y -= 14

    def diagram(self, kind_name):
        if kind_name == 'flow':
            labels = [('1. Créer', 'Nom et format'), ('2. Préparer', 'Image et son'),
                      ('3. Produire', 'REC et/ou LIVE'), ('4. Récupérer', 'MP4 ou dossier')]
            width = (base.WIDTH-30)/4
            for i, (title, sub) in enumerate(labels):
                x = base.MARGIN+i*(width+10)
                self.c.setFillColor(base.INK if i == 2 else base.PALE)
                self.c.roundRect(x, self.y-76, width, 76, 9, stroke=0, fill=1)
                color = base.WHITE if i == 2 else base.INK
                self.para(title, x+10, self.y-12, width-20, 'ManropeBold', 10.2, 15, color)
                self.para(sub, x+10, self.y-37, width-20, 'Manrope', 8.8, 13, color)
                if i < 3:
                    self.c.setStrokeColor(base.SLATE); self.c.setLineWidth(1.2)
                    self.c.line(x+width+1, self.y-39, x+width+8, self.y-39)
                    self.c.line(x+width+5, self.y-42, x+width+8, self.y-39)
                    self.c.line(x+width+5, self.y-36, x+width+8, self.y-39)
            self.y -= 95
            return
        if kind_name == 'deck':
            labels = [('REC','Enregistrer'),('STOP','Terminer la prise'),('LIVE','Diffuser'),('OFF','Arrêter le direct'),
                      ('LARGE','Plan large'),('REPÈRE','À revoir'),('AUTO','Automatique'),('MANUEL','Reprendre la main')]
            gap, height = 9, 54
            width = (base.WIDTH-gap*3)/4
            for i,(title,text) in enumerate(labels):
                row, col = divmod(i,4)
                x, top = base.MARGIN+col*(width+gap), self.y-row*(height+gap)
                dark = i in (0,2)
                self.c.setFillColor(base.INK if dark else base.PALE)
                self.c.roundRect(x,top-height,width,height,8,stroke=0,fill=1)
                color = base.WHITE if dark else base.INK
                self.para(title,x+10,top-9,width-20,'ManropeBold',10,14,color)
                self.para(text,x+10,top-29,width-20,'Manrope',8.3,11,color)
            self.y -= height*2+gap+17
            return
        if kind_name not in ('backup','states','formats','routine','network','usb-transfer','resolve-import','package'):
            return super().diagram(kind_name)
        sets = {
            'backup': [('1. Sur le PC','Les fichiers de la production'),('2. Autre support','Une copie complète vérifiée'),('3. Réouverture','Lire une vidéo depuis la copie')],
            'states': [('REC','Crée la vidéo sur le PC'),('LIVE','Envoie vers la plateforme'),('Retour','Permet de voir et écouter')],
            'formats': [('Podcast','Une voix ou une interview'),('Table ronde','Une discussion à plusieurs'),('Présentation','Un écran, un document, une démo')],
            'routine': [('Avant','Image, son, disque et bon projet'),('Pendant','REC, plans, médias et repères'),('Après','Arrêt confirmé et copie vérifiée')],
            'network': [('PC de la salle','OBS et Nino restent ici'),('Réseau privé','L’adresse du PC est fournie'),('iPad / mobile','Le navigateur pilote la salle')],
            'usb-transfer': [('PC de la salle','Télécharger le fichier .mp4'),('Clé USB','Copier, vérifier et éjecter'),('Autre ordinateur','Copier sur le disque, puis monter')],
            'resolve-import': [('1. Fichier local','Le MP4 est sur le disque de travail'),('2. Bibliothèque','Importer le média dans Resolve'),('3. Timeline','Glisser la vidéo, lire et enregistrer')],
            'package': [('Prises originales','Les vidéos terminées du projet'),('Médias associés','Supports, images et sons'),('Notes et repères','Informations de la production')],
        }
        width = (base.WIDTH-32)/3
        for i,(title,text) in enumerate(sets[kind_name]):
            x = base.MARGIN+i*(width+16)
            self.c.setFillColor(base.INK if i==1 else base.PALE)
            self.c.roundRect(x,self.y-84,width,84,9,stroke=0,fill=1)
            color = base.WHITE if i==1 else base.INK
            h = self.para(title,x+11,self.y-11,width-22,'ManropeBold',10.2,14,color)
            self.para(text,x+11,self.y-16-h,width-22,'Manrope',8.5,12,color)
            if i<2 and kind_name not in ('states','formats','package'):
                self.c.setStrokeColor(base.SLATE); self.c.setLineWidth(1.2)
                self.c.line(x+width+2,self.y-42,x+width+14,self.y-42)
                self.c.line(x+width+10,self.y-45,x+width+14,self.y-42)
                self.c.line(x+width+10,self.y-39,x+width+14,self.y-42)
        self.y -= 103


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=STUDIO.parent/'output/pdf/nino-manuel-complet.pdf')
    parser.add_argument('--qa-dir', type=Path, default=STUDIO.parent/'tmp/pdfs/nino-manuel-complet')
    parser.add_argument('--render', action='store_true')
    parser.add_argument('--render-bin', default='pdftoppm')
    parser.add_argument('--draft', action='store_true')
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.qa_dir.mkdir(parents=True,exist_ok=True)
    base.initialize_fonts(args.qa_dir)
    doc = assemble()
    images = {key: dict(path=str(base.ASSETS/(key+'.png')),
        caption='Capture de démonstration : noms, mire et fichiers de test. Elle sert à reconnaître les commandes ; elle ne valide pas le matériel de votre salle.')
        for key in ('regie','library','takes','resolve','auto-pc')}
    images['takes'] = dict(path=str(base.ASSETS/'takes-overview-mp4.png'),
        caption='Capture de démonstration isolée : une prise terminée et ses boutons de récupération. Les noms et les fichiers sont synthétiques ; il ne s’agit pas d’un test de votre salle.')
    images['takes-mp4'] = dict(path=str(base.ASSETS/'takes-mp4.png'),
        caption='Détail réel de l’interface dans un test isolé : le bouton clair télécharge le MP4 ; le second bouton conserve le format original OBS.')
    result = Manual(args.output,doc,images,args.draft)
    result.build()
    reader = base.PdfReader(args.output)
    texts = [p.extract_text() or '' for p in reader.pages]
    if any(len(t.strip())<100 or '\u25a0' in t or '\ufffd' in t for t in texts):
        raise ValueError('Empty page or missing glyph in PDF')
    links = sum(len(p.get('/Annots',[])) for p in reader.pages)
    if links < len(doc['pages'])-3: raise ValueError('The contents links are missing')
    if args.render:
        subprocess.run([args.render_bin,'-r','110','-png',str(args.output),str(args.qa_dir/'page')],check=True)
    report = dict(file=str(args.output),pages=len(reader.pages),bytes=args.output.stat().st_size,draft=args.draft,
                  layout=result.layout,images=result.image_sources,links=links,
                  titles=[p['title'] for p in doc['pages']])
    (args.qa_dir/'build-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__ == '__main__': main()
