/**
 * The archive's files: one per force on Site-9. Each file cycles through its photos
 * (public/dossier/<photo>.jpg; missing ones are skipped). [[text]] is blacked out and
 * decrypts when the file opens; [[!text]] stays blacked out.
 */

export interface DossierEntry {
  id: string;
  file: string;
  name: string;
  /** What they are (the subtitle). */
  role: string;
  place: string;
  /** The caption's date line. */
  year: string;
  /** Report date (as typed on the file). */
  date: string;
  /** Source reliability / information credibility (A-1 … F-6, the intelligence grading). */
  source: string;
  /** Flag: field colour, band colour; UI accent. */
  flag: [string, string];
  accent: string;
  status: 'ACTIVE' | 'HOSTILE' | 'ROGUE' | 'CIVILIAN' | 'UNKNOWN';
  /** Stamp colour family. */
  stance: 'hostile' | 'friendly' | 'rival' | 'rogue' | 'civilian';
  /** The word stamped across the file. */
  stamp: string;
  /** 1..5 */
  threat: number;
  tags: string[];
  facts: [string, string][];
  stats: [string, number][];
  bio: string[];
  /** Known personnel: name — what they are. */
  people: [string, string][];
  notes: string;
  kit: string[];
  quote: string;
  /** Photo ids, shown in turn. */
  photos: string[];
}

export const DOSSIER_ENTRIES: DossierEntry[] = [
  {
    id: 'sable', file: 'SB-000', name: 'SABLE', role: 'Vanta Dynamics black-ops cleanup unit', place: 'Site-9, Sector Zero', year: '2041', date: '14 MAR 2041', source: 'C-3',
    flag: ['#121212', '#d4231b'], accent: '#e2372b',
    status: 'HOSTILE', stance: 'hostile', stamp: 'KILL ON SIGHT', threat: 5,
    tags: ['Black ops', 'Night raids', 'No witnesses'],
    facts: [['Commander', 'The Warden'], ['Strength', '4–8 per raid'], ['Deploys', 'On blackout'], ['Bounty', '1,000 (Warden)']],
    stats: [['Aggression', 94], ['Precision', 92], ['Coordination', 96], ['Mercy', 2]],
    bio: [
      'SABLE does not exist on any Vanta Dynamics payroll. It is the company’s deniable cleanup unit: the team the board sends when a facility has to be emptied of evidence, witnesses and, when the numbers say so, the contractors it hired. Night vision, suppressed rifles, sealed masks. Nobody inside SABLE uses a real name.',
      'On Site-9 they wait for a crew to grow rich. Then the power dies across the facility and SABLE drops in: flanking before the first muzzle flash, leaning out of cover for exactly as long as it takes to fire, pushing the instant anyone reloads. They are led by the Warden, who talks to his prey over open radio and keeps count of the dead out loud. Their last job, [[Site-4]], left no survivors and no file.',
    ],
    people: [
      ['The Warden', 'commander. Face never seen. Hunts personally.'],
      ['Ilya ‘Gravel’ Marek', 'breacher. First through every door.'],
      ['Dana ‘Hush’ Kessler', 'marksman. Never the same position twice.'],
    ],
    notes: 'Treat every blackout as their arrival. They search fast, flank first and rush reloads. Recovered transcripts reference [[!Project Lantern]]. Do not engage alone; never peek the same corner twice.',
    kit: ['Suppressed SCAR-H / MK47 / M4A1', 'Quad-tube night vision', 'Sealed gas masks', 'Encrypted command radio'],
    quote: 'You can hide. You cannot disappear.',
    photos: ['warden', 'gravel', 'hush'],
  },
  {
    id: 'vanta', file: 'VS-100', name: 'Vanta Security', role: 'Contract recovery team — your squad', place: 'Site-9, Arrival Lobby', year: '2041', date: '02 MAR 2041', source: 'A-1',
    flag: ['#1d4f9c', '#e6f0ff'], accent: '#5fb0ff',
    status: 'ACTIVE', stance: 'friendly', stamp: 'FRIENDLY', threat: 3,
    tags: ['Your squad', 'Contractors', 'Shared wallet'],
    facts: [['Contract', 'Site-9 recovery'], ['Strength', '4, hire more'], ['Pay', 'Per room cleared'], ['Exit', 'Extraction']],
    stats: [['Aggression', 68], ['Precision', 78], ['Coordination', 82], ['Loyalty', 90]],
    bio: [
      'Four contractors on a recovery job: get into Site-9, recover what the facility owes Vanta Dynamics, extract, get paid. One wallet each, doors to buy, more guns to hire at the terminals. The contract reads simple. Nothing in the facility is.',
      'They cover each other, call targets, lay down fire when someone reloads and drag the fallen back to their feet. Three days in, the squad has started to wonder why Vanta hired a second company for the same job, and [[what SABLE is for]].',
    ],
    people: [
      ['Aaron ‘Pike’ Mercer', 'pointman. Walks first into every dark corridor.'],
      ['Yusuf ‘Anvil’ Demir', 'rifleman. The calmest voice on the channel.'],
      ['Lena ‘Glass’ Okafor', 'marksman. Reads a room through a scope.'],
    ],
    notes: 'Follows your lead, covers flanks, revives when it is safe. Trust the squad. Do not trust the contract: clause 14 allows Vanta to [[!terminate the operation]] at its discretion.',
    kit: ['M4A1 / AK-47 / SVD', 'Light plate carriers', 'Winter shells', 'Squad radio'],
    quote: 'Stay on me. Nobody gets left in here.',
    photos: ['pike', 'anvil', 'glass'],
  },
  {
    id: 'rivals', file: 'RS-200', name: 'Rival Squads', role: 'Bravo · Charlie · Delta — the other contractor', place: 'Site-9, Hangar & Power Plant', year: '2041', date: '09 MAR 2041', source: 'B-2',
    flag: ['#3a3c40', '#ff9a2a'], accent: '#ff9a2a',
    status: 'HOSTILE', stance: 'rival', stamp: 'RIVAL PMC', threat: 4,
    tags: ['Rival', 'Three squads', 'Same contract'],
    facts: [['Senior', 'Sgt. Viktor Rossi'], ['Strength', '3 squads of 4'], ['Holds', 'Hangar, Barracks, Power'], ['Wants', 'Your payout']],
    stats: [['Aggression', 82], ['Precision', 74], ['Coordination', 88], ['Scruples', 12]],
    bio: [
      'Vanta Dynamics hired two companies for Site-9 and wrote the same clause into both contracts: whoever recovers the most gets paid. The other company took the job with three squads in the field: Bravo, Charlie and Delta, each with its own way of fighting and one shared radio channel.',
      'Bravo fights like a regular army section, Charlie charges whatever it hears and Delta owns the dark end of the facility. They contest every supply drop, hunt any crew that grows rich, and have made it clear that only one company is walking out with the money. Their senior sergeant [[sold out his last employer]] and sleeps fine.',
    ],
    people: [
      ['Sgt. Viktor Rossi', 'Bravo lead. Flanks on a timer, nobody moves alone.'],
      ['Mara Quinn', 'Charlie pointwoman. Rushes the moment you reload.'],
      ['Tomas Varga', 'Delta breacher. A shotgun and four-tube night vision.'],
    ],
    notes: 'Bravo pins you and sends a flanker; listen for the man who goes quiet. Charlie comes straight at you: hold a tight angle. Delta is dangerous in the dark and ordinary in the open. Varga’s night vision is SABLE issue; nobody has asked where he got it.',
    kit: ['AK-47 / MP5 / Saiga-12', 'Coloured squad armbands', 'Field radios', 'Breaching kit'],
    quote: 'Two left, one right. On my mark.',
    photos: ['rossi', 'quinn', 'varga'],
  },
  {
    id: 'machines', file: 'RM-001', name: 'Rogue Machines', role: 'The facility’s own workforce', place: 'Site-9 Assembly Line', year: '2041', date: '11 MAR 2041', source: 'A-2',
    flag: ['#2a2a2e', '#ff0a2a'], accent: '#ff2a3a',
    status: 'ROGUE', stance: 'rogue', stamp: 'ROGUE MACHINE', threat: 4,
    tags: ['Machines', 'Waves', 'Still being built'],
    facts: [['Models', 'K-7 Walker, B-12 Loader'], ['Count', 'Hundreds'], ['Origin', 'Line 2'], ['Weak point', 'The visor']],
    stats: [['Aggression', 90], ['Precision', 18], ['Coordination', 30], ['Endurance', 95]],
    bio: [
      'Site-9 was built to run without a human on the floor. K-7 Walkers carried parts and sorted stock; B-12 Loaders lifted cars. On the night of the incident every unit on Line 2 received the same instruction at the same second: [[clear the floor]].',
      'They come in waves, more every round, and only hurt you up close, but they do not search, do not take cover and do not stop. The Loaders now carry armour plating that nobody on staff remembers installing. Something in the facility is still building them.',
    ],
    people: [
      ['Assembly Unit K-7', 'Walker class. Swarms noise. Aim for the visor.'],
      ['Loader B-12', 'Brute class. Shrugs off a magazine. Bring two.'],
    ],
    notes: 'Keep the gap. Never let them corner you in a corridor while a crew fires from the other end. Robots hunt the lab staff too. Line 2 telemetry is [[!still transmitting]].',
    kit: ['Hydraulic grip arms', 'Weaponised lift forks', 'Bolted armour (Loaders)', 'Optical visors'],
    quote: 'LINE 2 // DIRECTIVE ACKNOWLEDGED // CLEAR THE FLOOR',
    photos: ['walker', 'brute'],
  },
  {
    id: 'salvage', file: 'SV-030', name: 'Salvagers', role: 'Scavenger crews', place: 'Site-9, Garden Court', year: '2041', date: '06 MAR 2041', source: 'C-2',
    flag: ['#c8a070', '#3a2a14'], accent: '#d8a868',
    status: 'HOSTILE', stance: 'hostile', stamp: 'HOSTILE', threat: 3,
    tags: ['Scavengers', 'Loot', 'Whatever guns they found'],
    facts: [['Boss', '‘Rook’'], ['Strength', '6–10'], ['Way in', 'Storm drains'], ['Buyer', '[[Outside the fence]]']],
    stats: [['Aggression', 66], ['Precision', 60], ['Coordination', 40], ['Greed', 99]],
    bio: [
      'The Salvagers came in through the storm drains the week Site-9 went dark and have been stripping it ever since: prototype parts, lab equipment, the guns of anyone who died in a corridor. If it sells, it leaves the facility in a Salvager’s pack.',
      'They fight with whatever they found and whatever gear still fits. They have no quarrel with you until you stand between them and a haul, and then they will not be scared away from it. An old hunter covers them from the garden balconies and has not missed a shot anyone remembers.',
    ],
    people: [
      ['‘Rook’', 'boss. Greedy, clever, has a buyer waiting.'],
      ['Old Fedor', 'sharpshooter. An old bolt-action and older habits.'],
    ],
    notes: 'Loud, poorly coordinated, very hard to discourage. Move between cover in the open garden: Fedor is watching it.',
    kit: ['Saiga-12 / Mosin / PPSh', 'Gas masks', 'Mismatched armour', 'Bolt cutters'],
    quote: 'Nothing personal. You’re standing on my money.',
    photos: ['rook', 'fedor'],
  },
  {
    id: 'choir', file: 'CR-000', name: 'The Choir', role: 'Machine cult', place: 'Site-9, the dark', year: '2041', date: '13 MAR 2041', source: 'D-3',
    flag: ['#0a0506', '#a01020'], accent: '#c0182c',
    status: 'HOSTILE', stance: 'hostile', stamp: 'CULT', threat: 4,
    tags: ['Cult', 'Blades', 'Blackouts only'],
    facts: [['Leader', 'The Cantor'], ['Members', 'Former staff'], ['Seen', 'Only in the dark'], ['Weakness', 'Light']],
    stats: [['Aggression', 90], ['Precision', 5], ['Coordination', 55], ['Faith', 100]],
    bio: [
      'The Choir began as a handful of staff who stayed behind when Site-9 was sealed. They believe the machines are listening, and that the machines are owed something. Their leader sings hymns to them over the dead intercom.',
      'When the lights die the Choir comes out of the vents and stairwells, creeping through the dark in white masks cut from lab safety visors, and rushes with blades. Survivors report hearing the whispering long before they see anyone, and [[some never see anyone at all]].',
    ],
    people: [
      ['The Cantor', 'leader. Leads the hymns. Comes for you with a blade.'],
      ['Sister Wren', 'former robotics intern. The first to answer the hymns.'],
    ],
    notes: 'Only seen in blackouts. Keep your flashlight on them; they close in the moment it goes off. Never fight them in the dark with your back to a corridor. Their real names are [[!redacted at Vanta’s request]].',
    kit: ['Long blades', 'White masks', 'Robes stitched with circuitry'],
    quote: 'The machine is listening. Sing for it.',
    photos: ['cantor', 'wren'],
  },
  {
    id: 'staff', file: 'LS-000', name: 'Lab Staff', role: 'Survivors still hiding in the labs', place: 'Site-9 Laboratories', year: '2041', date: '12 MAR 2041', source: 'B-1',
    flag: ['#e8f0f8', '#5f86b8'], accent: '#a8c8ec',
    status: 'CIVILIAN', stance: 'civilian', stamp: 'CIVILIAN', threat: 1,
    tags: ['Civilians', 'Witnesses', 'Do not shoot'],
    facts: [['Key witness', 'Dr. Emre Arslan'], ['Survivors', 'Unknown'], ['Hiding', 'Labs, cold room'], ['Penalty', 'Shooting them costs you']],
    stats: [['Aggression', 3], ['Precision', 5], ['Coordination', 20], ['Knowledge', 98]],
    bio: [
      'The ones who did not get out. Scientists and technicians who were on shift the night the doors sealed, now moving from cupboard to cupboard while robots, crews and something worse walk past.',
      'They panic and run at gunfire; the robots hunt them. Among them is the head of robotics, the man who wrote the directive set every machine on the site still runs. Vanta wants him back alive. SABLE’s orders on him are [[!classified above your clearance]].',
    ],
    people: [
      ['Dr. Emre Arslan', 'head of robotics. Knows what Line 2 was really built for.'],
      ['Sam Hale', 'night-shift technician. Still has the keycards.'],
    ],
    notes: 'Harmless. Do not shoot them: it costs you, and they may be the only ones who can open the cold room. If you find Arslan, keep him breathing.',
    kit: ['Keycards (Level II–V)', 'Encrypted notebook', 'Torches'],
    quote: 'I wrote it to keep people safe. It decided we weren’t the people.',
    photos: ['arslan', 'hale'],
  },
];
