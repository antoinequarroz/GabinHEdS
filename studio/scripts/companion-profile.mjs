import { randomUUID } from 'node:crypto';

const V = (value, isExpression = false) => ({ value, isExpression });
const ref = name => `$(custom:${name})`;
const quote = value => JSON.stringify(value);
export const FRESH = `${ref('nino_state_online')} == 1 && ${ref('nino_state_updated_at')} > 0 && $(internal:time_unix) - ${ref('nino_state_updated_at')} >= 0 && $(internal:time_unix) - ${ref('nino_state_updated_at')} <= 4`;
export const BOUND = `!!${ref('nino_project_id')} && ${ref('nino_project_id')} == ${ref('nino_suite_binding_project_id')} && ${ref('nino_project_id')} == ${ref('nino_state_project_id')}`;
const OBS = `${ref('nino_state_obs_connected')} == 1`;
const REC = `${ref('nino_state_recording')} == 1`;
const PAUSED = `${ref('nino_state_paused')} == 1`;
const LIVE = ref('nino_state_live_status');
const RUNNING = `${ref('nino_state_launch_status')} == 'running'`;
const NO_CONFLICT = `${ref('nino_state_project_conflict')} != 1`;
const common = (guard = `!!${ref('nino_token')}`) => `(${FRESH}) && (${BOUND}) && (${NO_CONFLICT}) && (${guard})`;
const layerBase = (type, name, position = {}) => ({ id: randomUUID(), type, name, usage: 'auto', pinnedProperties: [], enabled: V(true), opacity: V(100), x: V(position.x || 0), y: V(position.y || 0), width: V(position.width ?? 100), height: V(position.height ?? 100), rotation: V(0) });
const box = (name, color, position) => ({ ...layerBase('box', name, position), color, cornerRadius: V(0), borderWidth: V(0), borderColor: V(0), borderPosition: V('inside') });
const text = (name, value, position, size = 65) => ({ ...layerBase('text', name, position), text: value, color: V(0xffffff), halign: V('center'), valign: V('center'), fontsize: V(size), fontsizeAllowShrink: V(true), font: V('companion-sans'), weight: V('bold'), styles: V([]), outlineColor: V(0xff202028) });

function getPost(control) {
  const actions = control.steps?.['0']?.action_sets?.down || [];
  const conditional = actions.find(action => action.connectionId === 'internal' && action.definitionId === 'logic_if');
  const post = conditional?.children?.actions?.find(action => action.definitionId === 'post');
  return post ? { conditional, post, payload: JSON.parse(post.options.body.value) } : null;
}

function observed(payload) {
  const action = payload.action;
  if (action === 'scene.set') return { active: `${ref('nino_state_scene')} == ${payload.sceneName}`, text: `${ref('nino_state_scene')} == ${payload.sceneName} ? 'À L’IMAGE' : 'PRÊT'` };
  if (action.startsWith('record.') || action === 'marker.add') return { active: action === 'record.start' ? REC : action === 'record.pause' ? `(${REC}) && (${PAUSED})` : 'false', text: `${REC} ? concat((${PAUSED} ? 'PAUSE ' : 'REC '), ${ref('nino_state_record_timecode')}) : 'ARRÊTÉ'`, accent: action === 'record.pause' ? 'amber' : 'rose', statusRose: action === 'record.stop' ? REC : 'false' };
  if (action.startsWith('stream.')) return { active: action === 'stream.start' ? `${LIVE} == 'live'` : 'false', text: `${LIVE} == 'live' ? 'EN DIRECT' : ${LIVE} == 'starting' ? 'CONNEXION…' : ${LIVE} == 'stopping' ? 'ARRÊT…' : ${LIVE} == 'error' ? 'ERREUR LIVE' : 'HORS DIRECT'`, accent: 'rose', needsObs: false };
  if (action.startsWith('auto.')) return { active: action === 'auto.stop' ? `${ref('nino_state_auto_enabled')} != 1` : `${ref('nino_state_auto_enabled')} == 1 && ${ref('nino_state_auto_status')} != 'suspended'`, text: `${ref('nino_state_auto_status')} == 'suspended' ? 'SUSPENDU' : ${ref('nino_state_auto_status')} == 'listening' ? 'AUTO ACTIF' : ${ref('nino_state_auto_status')} == 'waiting' ? 'ATTENTE VOIX' : ${ref('nino_state_auto_status')} == 'error' ? 'ERREUR AUTO' : 'MANUEL'` };
  if (action === 'input.mute') {
    const match = payload.inputName.match(/nino_suite_mic_([1-4])/);
    const mic = ref(`nino_state_mic_${match?.[1] || 1}`);
    return { active: `${mic} == '${payload.muted ? 'muted' : 'open'}'`, text: `${mic} == 'muted' ? 'MICRO COUPÉ' : ${mic} == 'open' ? 'MICRO OUVERT' : 'ÉTAT INCONNU'`, accent: payload.muted ? 'rose' : 'ice' };
  }
  if (action.startsWith('preview.')) return { active: action === 'preview.start' ? `${ref('nino_state_preview_ready')} == 1` : 'false', text: `${ref('nino_state_preview_ready')} == 1 ? 'RETOUR ACTIF' : 'RETOUR ARRÊTÉ'`, needsObs: false };
  if (action.startsWith('media.')) {
    const current = ref('nino_state_media_asset'), status = ref('nino_state_media_status');
    const own = payload.assetId ? `${current} == ${payload.assetId}` : `!!${current}`;
    return { active: action === 'media.play' ? `(${own}) && (${status} == 'playing' || ${status} == 'shown')` : action === 'media.pause' ? `(${own}) && ${status} == 'paused'` : 'false', text: `!(${own}) ? 'PRÊT' : ${status} == 'paused' ? 'EN PAUSE' : ${status} == 'playing' ? 'EN LECTURE' : ${status} == 'shown' ? 'AFFICHÉ' : ${status} == 'unknown' ? 'ÉTAT INCONNU' : 'ARRÊTÉ'`, accent: action === 'media.pause' ? 'amber' : 'ice' };
  }
  if (action.startsWith('guest.')) {
    const match = payload.guestId?.match(/nino_suite_guest_([12])/);
    if (match) {
      const guest = ref(`nino_state_guest_${match[1]}`), muted = ref(`nino_state_guest_${match[1]}_muted`);
      const active = action === 'guest.admit' ? `${guest} == 'admitted'` : action === 'guest.scene' ? `!!${ref(`nino_state_guest_${match[1]}_scene`)} && ${ref('nino_state_scene')} == ${ref(`nino_state_guest_${match[1]}_scene`)}` : action === 'guest.mute' ? `${guest} == 'admitted' && ${muted} == ${payload.muted ? 1 : 0}` : 'false';
      return { active, text: `${guest} == 'admitted' ? (${muted} == 1 ? 'ADMIS · MUET' : 'INVITÉ ADMIS') : ${guest} == 'ready' ? 'PRÊT À ACCUEILLIR' : ${guest} == 'waiting' ? 'EN ATTENTE' : ${guest} == 'invited' ? 'INVITÉ ATTENDU' : 'DÉCONNECTÉ'`, accent: action === 'guest.mute' && payload.muted ? 'rose' : 'ice' };
    }
    return { active: 'false', text: "'LIAISON INVITÉS'", needsObs: false };
  }
  if (action === 'production.start') return { active: RUNNING, text: `${RUNNING} ? (${ref('nino_state_launch_step')} == 'intro' ? 'INTRO EN COURS' : ${ref('nino_state_launch_step')} == 'recording' ? 'DÉMARRAGE REC' : 'LANCEMENT…') : ${ref('nino_state_launch_status')} == 'failed' ? 'ÉCHEC · VOIR NINO' : (${REC} ? 'PRISE EN COURS' : 'REC + INTRO')`, accent: 'rose' };
  return { active: 'false', text: "'PRÊT'" };
}

function availability(action) {
  if (action === 'record.start' || action === 'production.start') return `!(${REC}) && !(${RUNNING})`;
  if (action === 'record.stop' || action === 'marker.add') return REC;
  if (action === 'record.pause') return `(${REC}) && !(${PAUSED})`;
  if (action === 'record.resume') return `(${REC}) && (${PAUSED})`;
  if (action === 'stream.start') return `${LIVE} == 'idle' || ${LIVE} == 'error'`;
  if (action === 'stream.stop') return `${LIVE} != 'idle'`;
  return 'true';
}

function addFeedback(control, configurationGuard, payload) {
  const info = observed(payload);
  const online = `(${FRESH}) && (${BOUND}) && (${NO_CONFLICT})`;
  const ready = `(${online}) && (${configurationGuard})`;
  const healthy = info.needsObs === false ? ready : `(${ready}) && (${OBS})`;
  const status = `!(${FRESH}) ? 'NINO HORS LIGNE' : !(${NO_CONFLICT}) ? 'AUTRE PRODUCTION' : !(${BOUND}) ? 'CHOISIR PRODUCTION' : !(${configurationGuard}) ? 'À CONFIGURER' : ${info.needsObs === false ? 'false' : `!(${OBS})`} ? 'OBS DÉCONNECTÉ' : (${info.text})`;
  // Keep the chosen dark bitmap design, with a readable state band and a clear
  // perimeter/indicator only for the function whose real state is active.
  for (const image of control.style.layers.filter(layer => layer.type === 'image')) { image.height = V(76); image.y = V(0); image.valign = V('top'); }
  control.style.layers = control.style.layers.filter(layer => !layer.name?.startsWith('Nino · État'));
  control.style.layers.splice(1, 0, box('Nino · État fond général', V(0x111116)));
  const color = info.accent === 'rose' ? 0xeb9cac : info.accent === 'amber' ? 0xf1c27b : 0xcee5ff;
  const active = `(${healthy}) && (${info.active})`;
  const indicator = box('Nino · État voyant', V(color), { x: 85, y: 6, width: 9, height: 9 });
  indicator.enabled = V(active, true); indicator.cornerRadius = V(100);
  const label = text('Nino · État réel', V(status, true), { x: 4, y: 76, width: 92, height: 24 }, 65);
  label.color = V(`(${healthy}) && (${info.statusRose || 'false'}) ? ${0xeb9cac} : ${0xffffff}`, true);
  const edges = [{ y: 0, height: 3.5 }, { y: 96.5, height: 3.5 }, { width: 3.5 }, { x: 96.5, width: 3.5 }].map((position, index) => {
    const edge = box(`Nino · État contour ${index}`, V(color), position); edge.enabled = V(active, true); return edge;
  });
  control.style.layers.push(
    box('Nino · État fond', V(0x282832), { y: 76, height: 24 }), label, indicator, ...edges,
  );
  control.options.notes = 'État réel observé par Nino. Fraîcheur ≤ 4 s, sources du projet synchronisé, API authentifiée. LIVE = relais public. Une réponse HTTP seule ne confirme pas une prise.';
}

function startButton(template, connectionId) {
  const control = structuredClone(template);
  const payload = { action: 'production.start', projectId: '$(custom:nino_project_id)', includeLive: false };
  const guard = common();
  const post = { type: 'action', id: randomUUID(), connectionId, definitionId: 'post', upgradeIndex: 2, options: { url: V('/api/control'), body: V(JSON.stringify(payload)), header: V('{"Authorization":"Bearer $(custom:nino_token)"}'), contenttype: V('application/json'), jsonResultDataVariable: V(''), result_stringify: V(true), statusCodeVariable: V('nino_suite_last_http') } };
  control.steps = { '0': { options: { runWhileHeld: [] }, action_sets: { down: [{ type: 'action', id: randomUUID(), connectionId: 'internal', definitionId: 'logic_if', options: {}, children: { condition: [{ type: 'feedback', id: randomUUID(), connectionId: 'internal', definitionId: 'check_expression', isInverted: false, options: { expression: V(`(${guard}) && (${OBS}) && (${availability(payload.action)})`) } }], actions: [post], else_actions: [] } }], up: [], rotate_left: [], rotate_right: [] } } };
  control.feedbacks = []; control.localVariables = [];
  control.style.layers = [control.style.layers.find(layer => layer.type === 'canvas'), box('Nino · fond', V(0x202028)), text('Nino · Tout lancer', V('▶\nTOUT\nLANCER'), { x: 4, y: 7, width: 92, height: 70 }, 26)].filter(Boolean);
  addFeedback(control, `!!${ref('nino_token')}`, payload);
  return control;
}

/** Upgrade an existing secret-free Nino page export; all unrelated pages and connections stay intact. */
export function upgradeCompanionProfile(exported, key, connection) {
  const result = structuredClone(exported);
  if (result.type !== 'page' || !result.page?.name?.startsWith('Nino · ')) throw new Error('Une page Nino exportée est nécessaire.');
  if (connection) { result.instances ||= {}; result.instances[connection.id] ||= structuredClone(connection.instance); }
  const connectionId = Object.keys(result.instances || {}).find(id => result.instances[id].moduleId === 'generic-http');
  if (!connectionId) throw new Error('Connexion HTTP Nino introuvable.');
  if (key === 'menu') result.page.controls['0']['4'] = startButton(result.page.controls['0']['4'], connectionId);
  for (const row of Object.values(result.page.controls)) for (const control of Object.values(row)) {
    const found = getPost(control);
    if (!found || found.payload.action === 'production.start') continue;
    const condition = found.conditional.children.condition[0];
    const prior = condition.options.expression.value;
    const original = control.options.ninoConfigurationGuard || prior;
    control.options.ninoConfigurationGuard = original;
    const needsObs = !['stream.stop', 'preview.start', 'preview.stop', 'guest.bridge.stop'].includes(found.payload.action);
    condition.options.expression = V(`(${common(original)}) && (${needsObs ? OBS : 'true'}) && (${availability(found.payload.action)})`);
    addFeedback(control, original, found.payload);
  }
  // On the Menu, show the production name without reducing the navigation hit area.
  if (key === 'menu') {
    const control = result.page.controls['2']['3'];
    control.style.layers = [control.style.layers.find(layer => layer.type === 'canvas'), box('Nino · fond', V(0x202028)), text('Nino · production', V(`(${FRESH}) ? ${ref('nino_state_project_title')} : 'Nino hors ligne'`, true), { x: 6, y: 10, width: 88, height: 80 }, 24)].filter(Boolean);
    control.options.notes = 'Nom réel de la production sélectionnée dans Nino. Aucune commande.';
  }
  return result;
}
