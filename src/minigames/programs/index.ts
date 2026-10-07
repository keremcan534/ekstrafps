import type { ProgramInfo } from '../Program';
import { BULKHEAD_PROGRAM } from './bulkhead';
import { COLDSTATE_PROGRAM } from './coldstate';
import { ESCORT_PROGRAM } from './escort';
import { HEADCOUNT_PROGRAM } from './headcount';
import { LULLABY_PROGRAM } from './lullaby';
import { SHEEP_PROGRAM } from './sheep';
import { TETHER_PROGRAM } from './tether';

/** The tapes, in story order. */
export const PROGRAMS: ProgramInfo[] = [SHEEP_PROGRAM, LULLABY_PROGRAM, TETHER_PROGRAM, HEADCOUNT_PROGRAM, BULKHEAD_PROGRAM, COLDSTATE_PROGRAM, ESCORT_PROGRAM];
