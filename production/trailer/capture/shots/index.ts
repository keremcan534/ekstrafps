import type { Shot } from '../Director';
import { A02, A03, A04, A05, XRIG } from './macro';
import { FC, SQ, SG } from './site9';
import { RB } from './robot';
import { IN } from './insertion';
import { SV, PW, HG, WH, AT, LB } from './patrol';
import { BD } from './breach';

/** Every capturable shot or take, keyed by id (edl.json ids for single shots). */
export const SHOTS: Record<string, Shot> = { A02, A03, A04, A05, XRIG, FC, SQ, SG, RB, IN, SV, PW, HG, WH, AT, LB, BD };
