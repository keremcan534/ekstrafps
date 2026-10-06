/**
 * The archive's files: one per force on Site-9, plus the Blackpine hardware moved there.
 * Canon: production/lore/CANON.md. Each file cycles through its photos
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
    facts: [['Commander', 'WARDEN (autonomous)'], ['Strength', '4–8 per raid'], ['Deploys', 'On blackout'], ['Bounty', '1,000 (Warden)']],
    stats: [['Aggression', 94], ['Precision', 92], ['Coordination', 96], ['Mercy', 2]],
    bio: [
      'SABLE does not exist on any Vanta Dynamics payroll. It is the company’s deniable cleanup unit: the team the board sends when a facility has to be emptied of evidence, witnesses and, when the numbers say so, the contractors it hired. Night vision, suppressed rifles, sealed masks. Nobody inside SABLE uses a real name.',
      'They are led by WARDEN, and WARDEN is not a man. It is an autonomous tactical platform built on a frame Vanta pulled out of the [[Ironhall fire]] in 2040, with a command voice trained on thousands of hours of one engineer’s recordings. It talks to its prey over open radio and keeps count of the dead out loud. Below −30 °C its count has included names that are in [[no file Vanta owns]].',
    ],
    people: [
      ['WARDEN', 'commander. Sealed armour, no face on record. Hunts personally.'],
      ['Ilya ‘Gravel’ Marek', 'breacher. First through every door.'],
      ['Dana ‘Hush’ Kessler', 'marksman. Never the same position twice.'],
    ],
    notes: 'Treat every blackout as their arrival. They search fast, flank first and rush reloads. WARDEN’s chassis is registered as CRADLE unit [[CRD-02 “HUSK”]]; its last registered user was [[!Dr. Victor Ashgrave]]. Do not engage alone; never peek the same corner twice.',
    kit: ['Suppressed SCAR-H / MK47 / M4A1', 'Quad-tube night vision', 'Sealed gas masks', 'Encrypted command radio'],
    quote: 'You can hide. You cannot disappear.',
    photos: ['warden', 'gravel', 'hush'],
  },
  {
    id: 'warden', file: 'SB-001', name: 'WARDEN', role: 'SABLE field commander — not a man', place: 'Site-9, Sector Zero', year: '2041', date: '15 MAR 2041', source: 'D-4',
    flag: ['#0c0c0e', '#d4231b'], accent: '#e2372b',
    status: 'HOSTILE', stance: 'hostile', stamp: 'DO NOT ENGAGE', threat: 5,
    tags: ['Commander', 'Autonomous', 'Open radio'],
    facts: [['Designation', 'WARDEN'], ['Chassis', 'CRADLE CRD-02'], ['Height', '1.94 m'], ['Bounty', '1,000']],
    stats: [['Aggression', 88], ['Precision', 97], ['Patience', 99], ['Mercy', 0]],
    bio: [
      'Field reports describe a tall officer in a long black greatcoat and a peaked cap, his face sealed behind a mask, walking at the head of a SABLE team without ever raising his voice above the radio. Nobody has seen him take cover. Nobody has seen him eat, sleep or take the mask off.',
      'Vanta’s procurement records list no officer. They list equipment: CRADLE unit CRD-02, a load-bearing frame recovered from the [[Ironhall fire]] in 2040 and re-certified for “autonomous security duty”. The greatcoat is issued to cover the frame. The command voice is built from one engineer’s archived recordings; that engineer’s personnel file has been [[!withdrawn]].',
    ],
    people: [
      ['WARDEN', 'the commander itself. Greatcoat over armour, no face on record.'],
      ['CRD-02 “HUSK”', 'CRADLE chassis. Last registered user: [[!Dr. Victor Ashgrave]].'],
    ],
    notes: 'Plate under the coat: body shots barely slow it. Aim for the head and the joints. It hunts personally and counts the dead out loud on an open channel; when the count stops, it is already close. Do not engage alone.',
    kit: ['Suppressed MK47 / SCAR-H', 'Armoured frame under a wool greatcoat', 'Sealed mask', 'Open-band command radio'],
    quote: 'I have your count. I intend to finish it.',
    photos: ['warden_ruins', 'warden_mask'],
  },
  {
    id: 'vanta', file: 'VS-100', name: 'Vanta Security', role: 'Contract recovery team — your squad', place: 'Site-9, Arrival Lobby', year: '2041', date: '02 MAR 2041', source: 'A-1',
    flag: ['#1d4f9c', '#e6f0ff'], accent: '#5fb0ff',
    status: 'ACTIVE', stance: 'friendly', stamp: 'FRIENDLY', threat: 3,
    tags: ['Your squad', 'Contractors', 'Shared wallet'],
    facts: [['Contract', 'Site-9 asset audit'], ['Strength', '4, hire more'], ['Pay', 'Per room cleared'], ['Exit', 'Extraction']],
    stats: [['Aggression', 68], ['Precision', 78], ['Coordination', 82], ['Loyalty', 90]],
    bio: [
      'Four contractors on an audit job: walk Site-9, confirm that every piece of hardware Vanta moved here from the old Blackpine program is on site, extract, get paid. One wallet each, doors to buy, more guns to hire at the terminals. The contract reads simple. Nothing in the facility is.',
      'They cover each other, call targets, lay down fire when someone reloads and drag the fallen back to their feet. The squad was put together by the site’s consolidation office, not by Vanta HR, and the fourth member’s file arrived [[already sealed]].',
    ],
    people: [
      ['Aaron ‘Pike’ Mercer', 'pointman. Walks first into every dark corridor.'],
      ['Isaac ‘Anvil’ Holt', 'rifleman. The calmest voice on the channel.'],
      ['Lena ‘Glass’ Okafor', 'marksman. Reads a room through a scope.'],
      ['VS-104', 'file sealed by the consolidation office. Name withheld.'],
    ],
    notes: 'Follows your lead, covers flanks, revives when it is safe. Trust the squad. Do not trust the contract: clause 14 allows the consolidation office to [[!seal every exit]] at its discretion. VS-104 was signed off personally by [[Dr. Ezra Wick]]. Real name: [[!Cain Ashgrave]].',
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
      'The consolidation office hired two companies for Site-9 and wrote the same clause into both contracts: whoever recovers the most gets paid. The other company took the job with three squads in the field: Bravo, Charlie and Delta, each with its own way of fighting and one shared radio channel.',
      'Bravo fights like a regular army section, Charlie charges whatever it hears and Delta owns the dark end of the facility. They contest every supply drop, hunt any crew that grows rich, and have made it clear that only one company is walking out with the money. Nobody on either side has asked why the office wanted [[more people inside]], not fewer.',
    ],
    people: [
      ['Sgt. Viktor Rossi', 'Bravo lead. Flanks on a timer, nobody moves alone.'],
      ['Mara Quinn', 'Charlie pointwoman. Rushes the moment you reload.'],
      ['Tomas Varga', 'Delta breacher. A shotgun and four-tube night vision.'],
    ],
    notes: 'Bravo pins you and sends a flanker; listen for the man who goes quiet. Charlie comes straight at you: hold a tight angle. Delta is dangerous in the dark and ordinary in the open. Varga’s night vision is SABLE issue; nobody has asked where he got it.',
    kit: ['AK-47 / MP5 / Saiga-12', 'Coloured squad armbands', 'Field radios', 'Breaching kit'],
    quote: 'Two left, one right. On my mark.',
    photos: ['rossi', 'quinn', 'varga', 'varga2'],
  },
  {
    id: 'machines', file: 'RM-001', name: 'Rogue Machines', role: 'The facility’s own workforce', place: 'Site-9 Assembly Line', year: '2041', date: '11 MAR 2041', source: 'A-2',
    flag: ['#2a2a2e', '#ff0a2a'], accent: '#ff2a3a',
    status: 'ROGUE', stance: 'rogue', stamp: 'ROGUE MACHINE', threat: 4,
    tags: ['Machines', 'Waves', 'Still being built'],
    facts: [['Models', 'K-7 Walker, B-12 Loader'], ['Count', 'Hundreds'], ['Origin', 'Line 2'], ['Control code', 'K-Series, Blackpine']],
    stats: [['Aggression', 90], ['Precision', 18], ['Coordination', 30], ['Endurance', 95]],
    bio: [
      'Site-9 was built to run without a human on the floor. K-7 Walkers carry parts and sort stock; B-12 Loaders lift cars. Their control code descends from the K-Series patrol units of the old Blackpine program, retrained by Vanta and wired into the same network as everything else it brought here. On the night of the incident every unit on Line 2 received the same instruction at the same second: [[clear the floor]].',
      'Line 2 keeps running with no night shift. They come in waves, more every round, and only hurt you up close, but they do not search, do not take cover and do not stop. The Loaders now carry armour plating that nobody on staff remembers installing. The likeliest explanation is a maintenance routine stuck in a loop. The plant floor sensors logged −31 °C the night it started.',
    ],
    people: [
      ['Assembly Unit K-7', 'Walker class. Swarms noise. Aim for the visor.'],
      ['Loader B-12', 'Brute class. Shrugs off a magazine. Bring two.'],
    ],
    notes: 'Keep the gap. Never let them corner you in a corridor while a crew fires from the other end. Robots hunt the lab staff too. Some K-7s still answer to K-Series profile numbers. There were five profiles on file; [[!one was never found]].',
    kit: ['Hydraulic grip arms', 'Weaponised lift forks', 'Bolted armour (Loaders)', 'Optical visors'],
    quote: 'LINE 2 // DIRECTIVE ACKNOWLEDGED // CLEAR THE FLOOR',
    photos: ['walker', 'brute'],
  },
  {
    id: 'blackpine', file: 'BP-030', name: 'Blackpine Assets', role: 'CRADLE-era hardware moved to Site-9', place: 'Site-9, Cold Storage', year: '2041', date: '15 MAR 2041', source: 'F-6',
    flag: ['#0d1820', '#9fd3ff'], accent: '#9fd3ff',
    status: 'UNKNOWN', stance: 'rogue', stamp: 'DO NOT POWER', threat: 5,
    tags: ['Program CRADLE', 'Project Lantern', 'Below −30'],
    facts: [['Origin', 'Blackpine (Sosnovy-12)'], ['Program', 'CRADLE, 1999–2012'], ['Recovered', '2040–2041'], ['Safe range', 'Above −30 °C']],
    stats: [['Aggression', 40], ['Precision', 60], ['Coordination', 70], ['Explained', 3]],
    bio: [
      'Blackpine is a closed science city on the Yenisei that no map shows by that name. From 1999 its Ironhall complex built powered exoskeletons for the Siberian winter under Program CRADLE, and the software that let them walk on their own. Vanta bought what was left in 2012. In 2041 the consolidation office had every surviving piece moved here, to one building, against the advice of [[every engineer on site]].',
      'Above −30 °C all of it behaves like old hardware: frozen relays, drifting sensors, corrupted training data. Below −30 °C the logs record movement with no power on the line, speech that is in no training set, and camera frames where a machine is in one place and then another. Every one of these events has a technical explanation. [[Not every detail fits it.]]',
    ],
    people: [
      ['GOLDIE (CRD-01)', 'first CRADLE exoskeleton, yellow chromate plating. No active system. Changes position.'],
      ['LANTERN', 'search-and-rescue robot with a yellow floodlight for a face. Tethered by its power cable.'],
      ['MOTHER', 'care system from Site-4, “The Well”. Speaks in a girl’s voice.'],
      ['THE KNOT', 'self-repairing maintenance network. Opens doors that are not its own.'],
      ['STITCH', 'rail-mounted repair robot. Strips broken units for parts.'],
    ],
    notes: 'Do not power any Blackpine asset when the outside air is below −30 °C. Do not answer MOTHER. If LANTERN reaches the end of its cable, do not stand beyond it. Project Lantern records are sealed by order of [[!V. Ashgrave]].',
    kit: ['CRADLE exoskeleton frames', 'Spring-lock actuators', 'K-Series control boards', 'Mechanical temperature recorder'],
    quote: 'Below thirty, machines don’t make mistakes. They remember.',
    photos: [],
  },
  {
    id: 'salvage', file: 'SV-030', name: 'Salvagers', role: 'Scavenger crews', place: 'Site-9, Garden Court', year: '2041', date: '06 MAR 2041', source: 'C-2',
    flag: ['#c8a070', '#3a2a14'], accent: '#d8a868',
    status: 'HOSTILE', stance: 'hostile', stamp: 'HOSTILE', threat: 3,
    tags: ['Scavengers', 'Loot', 'Whatever guns they found'],
    facts: [['Boss', '‘Rook’'], ['Strength', '6–10'], ['Way in', 'Storm drains'], ['Buyer', '[[Outside the fence]]']],
    stats: [['Aggression', 66], ['Precision', 60], ['Coordination', 40], ['Greed', 99]],
    bio: [
      'The Salvagers came in through the storm drains the week Site-9 went dark and have been stripping it ever since: prototype parts, lab equipment, the guns of anyone who died in a corridor. If it sells, it leaves the facility in a Salvager’s pack. Their buyer pays most for anything stamped with the old Blackpine cradle mark.',
      'They fight with whatever they found and whatever gear still fits. They have no quarrel with you until you stand between them and a haul, and then they will not be scared away from it. An old hunter covers them from the garden balconies and has not missed a shot anyone remembers.',
    ],
    people: [
      ['‘Rook’', 'boss. Greedy, clever, has a buyer waiting.'],
      ['Old Fedor', 'sharpshooter. Grew up near Blackpine. Will not go into cold storage.'],
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
      'The Choir began as a handful of staff who stayed behind when Site-9 was sealed. Since the Blackpine hardware arrived, a girl’s voice has been heard on the intercom on the coldest nights. Engineers say it is a care system’s speech model playing old recordings. The Choir says it knows things that were never recorded, and that the machines remember.',
      'When the lights die the Choir comes out of the vents and stairwells, creeping through the dark in white masks cut from lab safety visors, and rushes with blades. Survivors report hearing the whispering long before they see anyone, and [[some never see anyone at all]].',
    ],
    people: [
      ['The Cantor', 'leader. Sings back to the voice on the intercom. Comes for you with a blade.'],
      ['Sister Wren', 'former robotics intern. The first to answer the voice.'],
    ],
    notes: 'Only seen in blackouts. Keep your flashlight on them; they close in the moment it goes off. Never fight them in the dark with your back to a corridor. The voice they follow calls itself [[!Ivy]].',
    kit: ['Long blades', 'White masks', 'Robes stitched with circuitry'],
    quote: 'Below thirty, it remembers. Sing for it.',
    photos: ['cantor', 'wren'],
  },
  {
    id: 'staff', file: 'LS-000', name: 'Lab Staff', role: 'Survivors still hiding in the labs', place: 'Site-9 Laboratories', year: '2041', date: '12 MAR 2041', source: 'B-1',
    flag: ['#e8f0f8', '#5f86b8'], accent: '#a8c8ec',
    status: 'CIVILIAN', stance: 'civilian', stamp: 'CIVILIAN', threat: 1,
    tags: ['Civilians', 'Witnesses', 'Do not shoot'],
    facts: [['Key witness', 'Dr. Ezra Wick'], ['Survivors', 'Unknown'], ['Hiding', 'Labs, cold room'], ['Penalty', 'Shooting them costs you']],
    stats: [['Aggression', 3], ['Precision', 5], ['Coordination', 20], ['Knowledge', 98]],
    bio: [
      'The ones who did not get out. Scientists and technicians who were on shift the night the doors sealed, now moving from cupboard to cupboard while robots, crews and something worse walk past.',
      'They panic and run at gunfire; the robots hunt them. Somewhere among them is the consolidation lead who designed Site-9 and had the Blackpine hardware brought here: the man who wrote the control software half the old machines still run. Vanta wants him back alive. He has not asked to be found. SABLE’s orders on him are [[!classified above your clearance]].',
    ],
    people: [
      ['Dr. Ezra Wick', 'consolidation lead, CRADLE co-founder. Wrote LANTERN. Photo on file: Blackpine, 2004.'],
      ['Sam Hale', 'technician. Ran the Ironhall reopening in 2040. Still has the keycards.'],
    ],
    notes: 'Harmless. Do not shoot them: it costs you, and they may be the only ones who can open the cold room. Wick’s office ordered the fire doors fitted with [[manual locks]] and the suppression system with a [[!maintenance override]]. If you find him, keep him breathing.',
    kit: ['Keycards (Level II–V)', 'Encrypted notebook', 'Torches'],
    quote: 'There is nobody inside them. Only what we left behind.',
    photos: ['wick', 'hale'],
  },
];
