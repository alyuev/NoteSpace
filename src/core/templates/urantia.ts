import { newId, type Space } from '../types';
import snapshot from './urantia.json?raw';

/**
 * Cosmology of the Urantia Book as a NoteSpace.
 *
 * The template is a snapshot of a space built and edited in the app (`urantia.json`): the master
 * universe with its outer space levels and reservoirs of unpervaded space, the grand universe with
 * Havona and the seven superuniverses, Orvonton divided down to the Solar System and Urantia, with
 * Russian and English texts. To carry the current state of a space over into the template, run
 * `node scripts/snapshot-template.mjs` (the active space, or pass a space id).
 */
export function urantiaSpace(): Space {
  return { ...(JSON.parse(snapshot) as Omit<Space, 'id'>), id: newId() };
}
