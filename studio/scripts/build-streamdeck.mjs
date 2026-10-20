import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgradeCompanionProfile } from './companion-profile.mjs';

export const profileFiles = {
  regie: 'Nino-Regie.companionconfig',
  audio: 'Nino-Audio.companionconfig',
  medias: 'Nino-Medias.companionconfig',
  invites: 'Nino-Invites.companionconfig',
  menu: 'Nino-Menu.companionconfig',
  accueil: 'Nino-Accueil.companionconfig',
};
export const navigationDefaults = { nino_suite_page_regie: '2', nino_suite_page_audio: '3', nino_suite_page_medias: '4', nino_suite_page_invites: '5', nino_suite_page_menu: '6', nino_suite_page_accueil: '7' };
const sourceDirectory = fileURLToPath(new URL('../config/stream-deck/', import.meta.url));
const defaultOutput = fileURLToPath(new URL('../build/stream-deck/', import.meta.url));

/** Validate only the static, shareable page format; no service or credential is contacted. */
export function assertShareableProfile(profile, name = 'profile') {
  if (profile.type !== 'page' || profile.version !== 12 || !profile.page?.name?.startsWith('Nino · ')) throw new Error(`Format Companion Nino invalide : ${name}`);
  if (profile.customVariables && Object.keys(profile.customVariables).length) throw new Error(`Variables privées interdites : ${name}`);
  const serialized = JSON.stringify(profile);
  if (/Bearer (?!\$\(custom:nino_token\))[^"\\]+/.test(serialized) || /sk-proj-|\/Users\/|C:\\\\Users\\\\/.test(serialized)) throw new Error(`Donnée locale ou identifiant littéral interdit : ${name}`);
  for (const instance of Object.values(profile.instances || {})) {
    if (instance.moduleId !== 'generic-http') throw new Error(`Connexion inattendue : ${name}`);
    for (const [key, value] of Object.entries(instance.config || {})) if (/(password|token|secret|apikey)/i.test(key) && value !== '' && value !== null && value !== false) throw new Error(`Secret de connexion interdit : ${name}`);
  }
  const controls = Object.values(profile.page.controls).flatMap(row => Object.values(row));
  if (controls.length !== 15) throw new Error(`La page doit contenir quinze touches : ${name}`);
  for (const control of controls) {
    const actions = control.steps?.['0']?.action_sets?.down || [];
    for (const action of actions) {
      if (action.connectionId === 'internal' && action.definitionId === 'set_page') {
        const target = action.options.page?.value?.match(/^\$\(custom:(nino_suite_page_(regie|audio|medias|invites|menu|accueil))\)(?: \|\| ([2-7]))?$/);
        if (action.options.page?.isExpression !== true || !target || (target[3] && target[3] !== navigationDefaults[target[1]])) throw new Error(`Navigation non portable : ${name}`);
        continue;
      }
      if (action.connectionId !== 'internal' || action.definitionId !== 'logic_if') throw new Error(`Une commande non gardée est interdite : ${name}`);
      const expression = action.children?.condition?.[0]?.options?.expression?.value || '';
      for (const command of action.children?.actions || []) {
        const options = command.options;
        if (command.definitionId !== 'post' || options?.url?.value !== '/api/control') throw new Error(`Commande hors API Nino : ${name}`);
        if (options.header?.value !== '{"Authorization":"Bearer $(custom:nino_token)"}') throw new Error(`Accès opérateur non portable : ${name}`);
        const payload = JSON.parse(options.body.value);
        if (payload.action === 'studio.open') {
          if (profile.page.name !== 'Nino · Accueil' || Object.keys(payload).length !== 1 || !expression.includes('nino_state_updated_at') || !expression.includes('nino_token')
            || !expression.includes('$(custom:nino_state_studio_open_available) == 1')
            || /nino_suite_binding_project_id|nino_project_id|nino_state_obs_connected|nino_state_project_conflict/.test(expression)) throw new Error(`Ouverture logicielle non bornée : ${name}`);
        } else {
          if (profile.page.name === 'Nino · Accueil') throw new Error(`L’accueil ne doit jamais lancer une production : ${name}`);
          for (const variable of ['nino_state_updated_at', 'nino_suite_binding_project_id', 'nino_state_project_conflict']) if (!expression.includes(variable)) throw new Error(`Garde de production incomplète : ${name}`);
        }
        if (payload.action === 'production.start' && payload.includeLive !== false) throw new Error(`Le lancement doit conserver le live séparé : ${name}`);
      }
    }
  }
}

/** Complete bitmap glyphs are embedded in the committed templates, so this is offline and portable. */
export async function buildStreamDeckProfiles(output = defaultOutput) {
  const destination = path.resolve(output);
  const relative = path.relative(sourceDirectory, destination);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('Le dossier de sortie doit être séparé des modèles versionnés.');
  const pages = Object.fromEntries(await Promise.all(Object.entries(profileFiles).map(async ([key, file]) => {
    const profile = JSON.parse(await readFile(path.join(sourceDirectory, file), 'utf8'));
    assertShareableProfile(profile, file);
    return [key, profile];
  })));
  const [connectionId, instance] = Object.entries(pages.regie.instances).find(([, item]) => item.moduleId === 'generic-http') || [];
  if (!connectionId) throw new Error('Connexion HTTP Nino introuvable dans le modèle Régie.');
  const defaults = JSON.parse(await readFile(path.join(sourceDirectory, 'variables-navigation.json'), 'utf8'));
  if (JSON.stringify(defaults) !== JSON.stringify(navigationDefaults)) throw new Error('Les valeurs de navigation des modèles ont changé.');
  await mkdir(destination, { recursive: true });
  const logo = await readFile(path.join(sourceDirectory, 'nino-logo.png'));
  if (logo.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Le logo Nino embarqué doit être un PNG.');
  const logoImage = `data:image/png;base64,${logo.toString('base64')}`;
  for (const [key, file] of Object.entries(profileFiles)) {
    const profile = upgradeCompanionProfile(pages[key], key, { id: connectionId, instance }, { logoImage });
    assertShareableProfile(profile, file);
    await writeFile(path.join(destination, file), `${JSON.stringify(profile)}\n`);
  }
  await copyFile(path.join(sourceDirectory, 'README.md'), path.join(destination, 'README.md'));
  await copyFile(path.join(sourceDirectory, 'variables-navigation.json'), path.join(destination, 'variables-navigation.json'));
  await copyFile(path.join(sourceDirectory, 'nino-logo.png'), path.join(destination, 'nino-logo.png'));
  return { output: destination, files: Object.values(profileFiles), companionFormat: 12, credentialsIncluded: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage : node scripts/build-streamdeck.mjs [--output DOSSIER]');
  console.log(JSON.stringify(await buildStreamDeckProfiles(args[1] || defaultOutput), null, 2));
}
