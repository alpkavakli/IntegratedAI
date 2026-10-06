// @ts-check
// Action names as people read them, in the interface language (ACTIONS[name].label stays the English one,
// used in text for the AI and in exported Markdown).

import { ACTIONS } from '../../shared/actions.js';
import { t } from '../../shared/i18n.js';

const LABELS = {
  inspect_element: t('alInspect', 'Inspect element'),
  find_elements: t('alFind', 'Find elements'),
  page_outline: t('alOutline', 'Look at the page'),
  read_text: t('alReadText', 'Read text'),
  inspect_console: t('alConsole', 'Read console'),
  inspect_network: t('alNetwork', 'Read network log'),
  inspect_resources: t('alResources', 'Read page resources'),
  screenshot: t('alScreenshot', 'Screenshot'),
  remember: t('alRemember', 'Remember'),
  forget: t('alForget', 'Forget'),
  define_page_group: t('alNameGroup', 'Name page type'),
  inject_css: t('alCss', 'Inject CSS'),
  modify_element: t('alModify', 'Modify element'),
  translate_page: t('alTranslate', 'Translate the page'),
  interact: t('alInteract', 'Interact with the page'),
  navigate: t('alNavigate', 'Go to a page'),
  execute_js: t('alJs', 'Execute JavaScript'),
};

/** @param {string} name */
export function actionLabel(name) {
  return /** @type {Record<string, string>} */ (LABELS)[name] ?? ACTIONS[name]?.label ?? name;
}
