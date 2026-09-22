import { PythonObject } from '../../../src/contracts/python-object';
import { get, has, integer, object, set, string, text, serialize } from '../../../src/contracts/workspace/values';
import type { Document, Value } from '../../../src/contracts/workspace/values';
import type { ProfileSnapshot } from './facts-model';

export type PreferredBrowser = 'codex_browser'|'chrome';
export type BrowserFallback = 'ask'|'other_supported';
export type ProgressionMode = 'standard'|'guided';
export type PreferredAutomationMode = 'guided'|'autofill_to_review'|'campaign_to_review';
export type ApplicationPreferences = {
  preferredBrowser: PreferredBrowser;
  browserFallback: BrowserFallback;
  progressionMode: ProgressionMode;
  preferredAutomationMode: PreferredAutomationMode;
};

export const defaultApplicationPreferences: ApplicationPreferences = {
  preferredBrowser: 'codex_browser', browserFallback: 'ask', progressionMode: 'standard', preferredAutomationMode: 'guided'
};

const allowedBrowsers = new Set<PreferredBrowser>(['codex_browser','chrome']);
const allowedFallbacks = new Set<BrowserFallback>(['ask','other_supported']);
const allowedProgression = new Set<ProgressionMode>(['standard','guided']);
const allowedAutomation = new Set<PreferredAutomationMode>(['guided','autofill_to_review','campaign_to_review']);

export function readApplicationPreferences(profile: Document): { preferences: ApplicationPreferences; complete: boolean } {
  if (!has(profile,'applicationPreferences')) return { preferences: defaultApplicationPreferences, complete: false };
  let stored: Document;
  try { stored=object(get(profile,'applicationPreferences'),'application preferences'); }
  catch { return { preferences: defaultApplicationPreferences, complete: false }; }
  const browser=string(get(stored,'preferredBrowser')) as PreferredBrowser|null;
  const fallback=string(get(stored,'browserFallback')) as BrowserFallback|null;
  const progression=string(get(stored,'progressionMode')) as ProgressionMode|null;
  const automation=string(get(stored,'preferredAutomationMode')) as PreferredAutomationMode|null;
  return {
    preferences: {
      preferredBrowser: browser&&allowedBrowsers.has(browser)?browser:defaultApplicationPreferences.preferredBrowser,
      browserFallback: fallback&&allowedFallbacks.has(fallback)?fallback:defaultApplicationPreferences.browserFallback,
      progressionMode: progression&&allowedProgression.has(progression)?progression:defaultApplicationPreferences.progressionMode,
      preferredAutomationMode: automation&&allowedAutomation.has(automation)?automation:defaultApplicationPreferences.preferredAutomationMode
    },
    complete: Boolean(browser&&allowedBrowsers.has(browser)&&fallback&&allowedFallbacks.has(fallback)
      &&progression&&allowedProgression.has(progression)&&automation&&allowedAutomation.has(automation))
  };
}

export function applicationPreferencesPatch(snapshot: ProfileSnapshot, preferences: ApplicationPreferences): string {
  const values = new PythonObject<Value>();
  set(values,'preferredBrowser',text(preferences.preferredBrowser));
  set(values,'browserFallback',text(preferences.browserFallback));
  set(values,'progressionMode',text(preferences.progressionMode));
  set(values,'preferredAutomationMode',text(preferences.preferredAutomationMode));
  const patch = new PythonObject<Value>(); set(patch,'applicationPreferences',values);
  const body = new PythonObject<Value>();
  set(body,'patch',patch); set(body,'expectedRevision',integer(snapshot.revision));
  set(body,'atomicPaths',[]); set(body,'deletedPaths',[]);
  return serialize(body);
}
