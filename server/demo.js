// Sample portfolio for demos and for exploring before Outlook is connected.
// Everything is tagged source = 'demo' and can be removed in one click. All people and firms are fictional.
import fs from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { db, indexText, insert, logActivity, now, today } from './db.js';
import { addDays } from './domain/risks.js';
import { resolveDocPath } from './paths.js';
import { addDocument } from './docs/pdf.js';
import { rebuildThread } from './sync/mail.js';

const d = (n) => addDays(today(), n);
const at = (n, hm = '09:30') => `${d(n)}T${hm}:00Z`;
const ME = { name: 'Jonathan', email: 'jonathan@nelsongroup.example' };

export const hasDemo = () => !!db.prepare("SELECT 1 FROM projects WHERE source = 'demo' LIMIT 1").get();

async function sampleDrawings() {
  const pdf = await PDFDocument.create();
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.11);
  const sheet = (num, title, lines) => {
    const p = pdf.addPage([1224, 792]); // 17 x 11 in
    p.drawRectangle({ x: 24, y: 24, width: 1176, height: 744, borderColor: ink, borderWidth: 1.5 });
    p.drawRectangle({ x: 960, y: 24, width: 240, height: 744, borderColor: ink, borderWidth: 1 });
    p.drawText('NELSON GROUP', { x: 975, y: 740, size: 14, font: bold, color: ink });
    p.drawText('FULTON ST TOWNHOMES', { x: 975, y: 720, size: 11, font: reg, color: ink });
    p.drawText('88 FULTON ST, MEDFORD MA', { x: 975, y: 704, size: 9, font: reg, color: ink });
    p.drawText('HARBOR LINE ARCHITECTS (SAMPLE)', { x: 975, y: 680, size: 8, font: reg, color: ink });
    p.drawText('SAMPLE DRAWING - NOT FOR CONSTRUCTION', { x: 975, y: 200, size: 7.5, font: bold, color: rgb(0.39, 0.02, 0.07) });
    p.drawText(title, { x: 975, y: 120, size: 12, font: bold, color: ink });
    p.drawText('REV 2  |  ISSUED FOR CONSTRUCTION', { x: 975, y: 102, size: 8, font: reg, color: ink });
    p.drawText(num, { x: 975, y: 48, size: 34, font: bold, color: ink });
    let y = 740;
    for (const [text, size = 11, f = reg] of lines) {
      p.drawText(text, { x: 56, y, size, font: f, color: ink });
      y -= size * 1.9;
    }
  };
  sheet('A-201', 'SECOND FLOOR PLAN', [
    ['SECOND FLOOR PLAN - UNITS 1-6', 16, bold],
    ['WINDOW TAGS: W-1 (3040 DH) TYP. FRONT; W-2 (2840 DH) BEDROOMS; W-3 (2030 AWNING) BATHS; W-4 (6068 SLIDER) REAR'],
    ['REAR ELEVATION WINDOW ROUGH OPENING HEIGHTS: SEE RFI-002. HOLD W-2 AND W-4 RO HEADER HEIGHTS UNTIL ANSWERED.'],
    ['TOTAL WINDOWS ALL UNITS: 38 (W-1: 12, W-2: 14, W-3: 6, W-4: 6)'],
    ['PROVIDE SOLID BLOCKING AT ALL WALL-HUNG FIXTURES AND TV LOCATIONS PER OWNER.'],
    ['FIRE-RATED ASSEMBLY BETWEEN UNITS: 1-HR, UL U305. SEE A-501.'],
  ]);
  sheet('A-401', 'ENLARGED BATHROOM PLANS', [
    ['ENLARGED BATHROOM PLANS AND NOTES', 16, bold],
    ['UNITS 1-6 PRIMARY BATH: VANITY VAN-1, 36" W x 21" D, CENTERED ON WALL, TOP AT 34" AFF.'],
    ['UNITS 1, 2, 3, 5, 6 HALF BATH: VANITY VAN-2, 30" W x 18" D.'],
    ['UNIT 4 POWDER ROOM: VANITY VAN-2 - WIDTH NOT CONFIRMED. CLEAR WALL LENGTH VARIES WITH STAIR. SEE RFI-004.'],
    ['PROVIDE 2x10 BLOCKING AT 30"-36" AFF FOR ALL VANITIES AND GRAB BAR LOCATIONS.'],
    ['SHOWER NICHE: 12" x 24", FRAMED BETWEEN STUDS, WATERPROOF PER MFR. BLOCKING DETAIL 4/A-501.'],
  ]);
  sheet('P-601', 'PLUMBING FIXTURE SCHEDULE', [
    ['PLUMBING FIXTURE SCHEDULE', 16, bold],
    ['TAG     DESCRIPTION                                   QTY   REMARKS'],
    ['VAN-1   36" VANITY, QUARTZ TOP, UNDERMOUNT SINK         6     PRIMARY BATHS'],
    ['VAN-2   30" VANITY, QUARTZ TOP, UNDERMOUNT SINK         6     HALF BATHS AND UNIT 4 POWDER (VERIFY)'],
    ['WC-1    WATER CLOSET, 1.28 GPF, ELONGATED             12'],
    ['SH-1    SHOWER VALVE, PRESSURE BALANCED                6'],
    ['TB-1    TUB, 60" ALCOVE                                 6'],
    ['KS-1    KITCHEN SINK, 30" SINGLE BOWL                   6'],
    ['NOTE: FIXTURE COUNTS ARE FOR PRICING. CONTRACTOR TO VERIFY AGAINST ARCHITECTURAL PLANS.'],
  ]);
  return Buffer.from(await pdf.save());
}

export async function loadDemo() {
  if (hasDemo()) return { loaded: false, reason: 'Sample data is already loaded.' };
  const tag = { source: 'demo', review: 0, created_by: 'user' };

  // ---------- projects ----------
  const fulton = insert('projects', { ...tag, name: 'Fulton St Townhomes', code: 'FUL', address: '88 Fulton St', city: 'Medford', type: '6-unit townhouse, new construction', phase: 'Framing', status: 'active', client: 'Nelson Group (developer)', start_date: d(-150), target_completion: d(210), contract_value: 3200000, budget: 3050000, contingency: 25000, aliases: ['Fulton', '88 Fulton'] });
  const bow = insert('projects', { ...tag, name: 'Bow St Condos', code: 'BOW', address: '14 Bow St', city: 'Somerville', type: '4-unit gut renovation', phase: 'MEP rough-in', status: 'active', client: 'Nelson Group (developer)', start_date: d(-90), target_completion: d(120), contract_value: 1450000, budget: 1380000, contingency: 60000, aliases: ['Bow Street', '14 Bow'] });
  const centre = insert('projects', { ...tag, name: 'Centre St Mixed-Use', code: 'CTR', address: '250 Centre St', city: 'Boston (Jamaica Plain)', type: '12 units over retail', phase: 'Permitting', status: 'active', client: 'Nelson Group (developer)', start_date: d(45), target_completion: d(560), contract_value: 6800000, budget: 6500000, contingency: 300000, aliases: ['Centre Street', '250 Centre', 'JP project'] });

  // ---------- contacts ----------
  const c = (name, email, company, role, trade, project_id) => insert('contacts', { ...tag, name, email, company, role, trade, project_id });
  c('Dana Whitfield', 'dana@harborline-arch.example', 'Harbor Line Architects', 'architect', null, fulton.id);
  c('Marcus Chen', 'mchen@chen-se.example', 'Chen Structural Engineering', 'engineer', 'Structural', fulton.id);
  c('Priya Raman', 'priya@ramanmep.example', 'Raman MEP Engineers', 'engineer', 'MEP', bow.id);
  c('Tom Brennan', 'tbrennan@baystatesupply.example', 'Bay State Plumbing Supply', 'supplier', 'Plumbing fixtures', fulton.id);
  c('Kevin Walsh', 'kwalsh@nswindows.example', 'North Shore Windows & Doors', 'supplier', 'Windows', fulton.id);
  c('Luis Ortega', 'luis@ortegaframing.example', 'Ortega Framing', 'sub', 'Framing', fulton.id);
  c('Joe Russo', 'joe@sparkselectric.example', 'Sparks Electric', 'sub', 'Electrical', bow.id);
  c('Rachel Kim', 'rkim@medfordcapital.example', 'Medford Capital Partners', 'investor', null, fulton.id);
  c('Inspectional Services', 'permits@isd-sample.example', 'Boston ISD (sample)', 'city', null, centre.id);

  // ---------- Fulton: RFIs, submittals, takeoffs, orders, schedule ----------
  const rfi1 = insert('rfis', { ...tag, project_id: fulton.id, subject: 'Stair stringer bearing at second floor', question: 'Detail 3/S-301 shows stringer bearing on a flush beam that conflicts with the 2x10 rim. Confirm hanger type.', to_name: 'Marcus Chen', to_email: 'mchen@chen-se.example', status: 'answered', date_sent: d(-40), date_required: d(-33), date_answered: d(-35), answer: 'Use Simpson LSU26 skewable hangers; add (2) 2x10 blocking per sketch SK-4.', drawing_refs: 'S-301 detail 3' });
  const rfi2 = insert('rfis', { ...tag, project_id: fulton.id, subject: 'Window rough opening heights at rear elevation', question: 'A-201 and the window schedule show different head heights for W-2 and W-4 on the rear elevation (6\'-8" vs 7\'-0"). Which governs? Window shop drawings and the order are on hold until this is answered.', proposed_solution: 'Use 7\'-0" head height to align with the slider (W-4) and adjust headers accordingly.', drawing_refs: 'A-201; A-301 rear elevation; window schedule A-601', spec_refs: '08 53 13', to_name: 'Dana Whitfield', to_email: 'dana@harborline-arch.example', status: 'sent', date_sent: d(-12), date_required: d(-5), cost_impact: 'tbd', schedule_impact: 'yes' });
  insert('rfis', { ...tag, project_id: fulton.id, subject: 'Shower niche blocking and waterproofing', question: 'Confirm niche framing between studs at 16" o.c. is acceptable with the specified waterproofing system (detail 4/A-501 shows 24" wide).', drawing_refs: 'A-401; 4/A-501', to_name: 'Dana Whitfield', to_email: 'dana@harborline-arch.example', status: 'draft', created_at: `${d(-4)}T14:00:00Z` });
  const rfi4 = insert('rfis', { ...tag, project_id: fulton.id, subject: 'Unit 4 powder room vanity width', question: 'A-401 notes the Unit 4 powder room vanity width is not confirmed; the clear wall length varies with the stair. Confirm whether VAN-2 (30") fits or a 24" vanity is required.', drawing_refs: 'A-401; P-601', to_name: 'Dana Whitfield', to_email: 'dana@harborline-arch.example', status: 'sent', date_sent: d(-3), date_required: d(4) });

  const subWin = insert('submittals', { ...tag, project_id: fulton.id, number: '08 53 13-01', spec_section: '08 53 13', title: 'Vinyl windows - shop drawings', kind: 'shop drawings', supplier: 'North Shore Windows & Doors', reviewer_name: 'Dana Whitfield', reviewer_email: 'dana@harborline-arch.example', status: 'received', required_onsite: d(30), lead_time_days: 21, review_days: 10, rfi_id: rfi2.id, notes: 'Package received; cannot finalize rear elevation units until RFI-002 is answered.' });
  const subVan = insert('submittals', { ...tag, project_id: fulton.id, number: '22 40 00-02', spec_section: '22 40 00', title: 'Plumbing fixtures - product data (vanities)', kind: 'product data', supplier: 'Bay State Plumbing Supply', reviewer_name: 'Dana Whitfield', reviewer_email: 'dana@harborline-arch.example', status: 'submitted', date_submitted: d(-16), review_days: 14, required_onsite: d(25), lead_time_days: 14 });
  insert('submittals', { ...tag, project_id: fulton.id, number: '06 17 53-01', spec_section: '06 17 53', title: 'Roof trusses - shop drawings', kind: 'shop drawings', supplier: 'Granite State Truss', reviewer_name: 'Marcus Chen', status: 'approved', date_submitted: d(-70), date_returned: d(-58) });

  const tk1 = insert('takeoffs', { ...tag, project_id: fulton.id, item: 'Vanity VAN-1, 36 in.', spec_section: '22 40 00', quantity: 6, unit: 'ea', location: 'Primary baths, Units 1-6', page: 2, status: 'reviewed', notes: 'Counted from A-401 and P-601; matches.' });
  const tk2 = insert('takeoffs', { ...tag, project_id: fulton.id, item: 'Vanity VAN-2, 30 in.', spec_section: '22 40 00', quantity: 5, unit: 'ea', location: 'Half baths, Units 1, 2, 3, 5, 6', page: 2, status: 'reviewed', unresolved: 'Unit 4 powder room vanity width not dimensioned on A-401 (RFI-004). P-601 shows 6 total; confirmed count is 5 + 1 pending.' });

  const ordWin = insert('orders', { ...tag, project_id: fulton.id, item: 'Vinyl windows (38 units)', spec_section: '08 53 13', quantity: 38, unit: 'ea', supplier: 'North Shore Windows & Doors', supplier_email: 'kwalsh@nswindows.example', status: 'quote', lead_time_days: 21, need_by: d(26), cost: 48200, submittal_id: subWin.id });
  const ordVan = insert('orders', { ...tag, project_id: fulton.id, item: 'Vanities VAN-1 and VAN-2', spec_section: '22 40 00', quantity: 12, unit: 'ea', supplier: 'Bay State Plumbing Supply', supplier_email: 'tbrennan@baystatesupply.example', status: 'quote', lead_time_days: 14, need_by: d(25), cost: 16900, submittal_id: subVan.id, takeoff_id: tk2.id });
  insert('orders', { ...tag, project_id: fulton.id, item: 'Framing lumber package 2', quantity: 1, unit: 'lot', supplier: 'Medford Lumber (sample)', status: 'delivered', delivered_on: d(-24), cost: 61300 });
  const ordDoors = insert('orders', { ...tag, project_id: fulton.id, item: 'Exterior doors (12)', spec_section: '08 14 00', quantity: 12, unit: 'ea', supplier: 'North Shore Windows & Doors', supplier_email: 'kwalsh@nswindows.example', status: 'in_fabrication', lead_time_days: 28, need_by: d(10), expected_delivery: d(12), cost: 21400 });

  const framing = insert('schedule_items', { ...tag, project_id: fulton.id, name: 'Framing - floors 2 and 3', trade: 'Framing', start: d(-20), finish: d(3), status: 'in_progress', percent: 80, responsible: 'Ortega Framing' });
  const roughPl = insert('schedule_items', { ...tag, project_id: fulton.id, name: 'Rough plumbing', trade: 'Plumbing', start: d(4), finish: d(18), status: 'not_started', responsible: 'Cardoso Plumbing (sample)', predecessor_ids: [framing.id] });
  insert('schedule_items', { ...tag, project_id: fulton.id, name: 'Rough electrical', trade: 'Electrical', start: d(6), finish: d(20), status: 'not_started', responsible: 'Sparks Electric', predecessor_ids: [framing.id] });
  const winInst = insert('schedule_items', { ...tag, project_id: fulton.id, name: 'Window installation', trade: 'Windows', start: d(14), finish: d(20), status: 'not_started', responsible: 'Ortega Framing', predecessor_ids: [framing.id], submittal_ids: [subWin.id], order_ids: [ordWin.id], rfi_ids: [rfi2.id] });
  insert('schedule_items', { ...tag, project_id: fulton.id, name: 'Exterior doors installed', trade: 'Doors', start: d(11), finish: d(13), status: 'not_started', responsible: 'Ortega Framing', order_ids: [ordDoors.id] });
  insert('schedule_items', { ...tag, project_id: fulton.id, name: 'Insulation', trade: 'Insulation', start: d(24), finish: d(29), status: 'not_started', predecessor_ids: [roughPl.id, winInst.id] });
  insert('schedule_items', { ...tag, project_id: fulton.id, name: 'Vanity and fixture set', trade: 'Plumbing', start: d(52), finish: d(56), status: 'not_started', submittal_ids: [subVan.id], order_ids: [ordVan.id], rfi_ids: [rfi4.id] });

  insert('changes', { ...tag, project_id: fulton.id, title: 'Blocking for owner TV mounts', description: 'Added 2x10 blocking at 18 TV locations.', amount: 4800, status: 'approved', reason: 'owner', date_approved: d(-30) });
  insert('changes', { ...tag, project_id: fulton.id, title: 'Upgrade to quartz vanity tops', description: 'Owner upgrade from cultured marble to quartz at all vanities.', amount: 18500, status: 'pending', reason: 'owner', date_submitted: d(-9) });
  insert('changes', { ...tag, project_id: fulton.id, title: 'Rear deck ledger repair', description: 'Rot found at existing rear ledger during framing.', amount: 9200, status: 'potential', reason: 'unforeseen' });

  insert('permits', { ...tag, project_id: fulton.id, kind: 'Building permit', number: 'BP-2026-0412 (sample)', jurisdiction: 'City of Medford', status: 'issued', applied_on: d(-170), issued_on: d(-130) });
  insert('permits', { ...tag, project_id: fulton.id, kind: 'Electrical permit', number: 'E-26-1189 (sample)', jurisdiction: 'City of Medford', status: 'issued', issued_on: d(-60) });
  insert('inspections', { ...tag, project_id: fulton.id, kind: 'Rough framing', status: 'needed', scheduled_for: d(4), schedule_item_id: framing.id, notes: 'Must pass before insulation and before rough plumbing closes walls.' });

  // ---------- Bow St ----------
  insert('rfis', { project_id: bow.id, subject: 'Duct routing conflict at Unit 3 beam', question: 'Supply trunk at Unit 3 kitchen conflicts with the new LVL beam. Confirm whether to drop the soffit 6" or reroute through the closet.', to_name: 'Priya Raman', to_email: 'priya@ramanmep.example', status: 'draft', source: 'demo', review: 1, created_by: 'agent' });
  insert('submittals', { ...tag, project_id: bow.id, number: '26 24 16-01', spec_section: '26 24 16', title: 'Panelboards', kind: 'product data', supplier: 'Sparks Electric', reviewer_name: 'Priya Raman', status: 'approved_as_noted', date_submitted: d(-30), date_returned: d(-19) });
  insert('schedule_items', { ...tag, project_id: bow.id, name: 'MEP rough-in, Units 1-4', trade: 'MEP', start: d(-14), finish: d(9), status: 'in_progress', percent: 55, responsible: 'Sparks Electric / Raman MEP' });
  insert('schedule_items', { ...tag, project_id: bow.id, name: 'Rough inspections (building, electrical, plumbing)', trade: 'Inspections', start: d(10), finish: d(12), status: 'not_started' });
  insert('changes', { project_id: bow.id, title: 'Relocate electrical panels (field condition)', description: 'Existing chase too shallow; relocate 4 panels to hall closets.', amount: 3950, status: 'potential', reason: 'field', source: 'demo', review: 1, created_by: 'agent' });
  insert('permits', { ...tag, project_id: bow.id, kind: 'Building permit', number: 'B26-000731 (sample)', jurisdiction: 'City of Somerville', status: 'issued', issued_on: d(-95) });

  // ---------- Centre St ----------
  insert('permits', { ...tag, project_id: centre.id, kind: 'Building permit - Erect/New Construction', number: 'ERT-26-0098 (sample)', jurisdiction: 'Boston ISD', status: 'applied', applied_on: d(-35), notes: 'Zoning review complete; building plan review open.' });
  insert('permits', { ...tag, project_id: centre.id, kind: 'Dig Safe ticket', jurisdiction: 'Dig Safe', status: 'preparing', notes: 'Premark site in white, then notify Dig Safe at least 72 business hours before excavation.' });
  insert('schedule_items', { ...tag, project_id: centre.id, name: 'Site mobilization and excavation', trade: 'Sitework', start: d(45), finish: d(60), status: 'not_started' });

  // ---------- email threads ----------
  const thread = (id, project, subject, msgs, triage) => {
    msgs.forEach((m, i) => {
      db.prepare(`INSERT INTO emails (id, thread_id, project_id, folder, subject, from_name, from_email, to_json, cc_json, received_at, from_me, body_text, preview, has_attachments, attachments_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, 0, '[]', ?)`)
        .run(`${id}-${i}`, id, project?.id || null, m.me ? 'sentitems' : 'inbox', i ? `RE: ${subject}` : subject, m.me ? ME.name : m.name, m.me ? ME.email : m.email,
          JSON.stringify(m.me ? [{ name: m.toName, email: m.to }] : [ME]), m.at, m.me ? 1 : 0, m.body, m.body.slice(0, 200), now());
      indexText('email', `${id}-${i}`, project?.id || null, `${subject} ${m.me ? ME.name : m.name}`, m.body);
    });
    rebuildThread(id);
    db.prepare(`UPDATE threads SET project_id = ?, category = ?, summary = ?, ball = ?, waiting_on = ?, next_action = ?, urgency = ?, suggested_reply = ?, work = ?, triage_source = 'ai', triaged_at = ? WHERE id = ?`)
      .run(project?.id || null, triage.category, triage.summary, triage.ball, triage.waiting_on, triage.next_action, triage.urgency ?? 1, triage.reply || null, triage.work ?? 1, now(), id);
  };

  thread('demo-vanity', fulton, 'Vanity quantities for Fulton St', [
    { name: 'Tom Brennan', email: 'tbrennan@baystatesupply.example', at: at(-2, '13:12'), body: 'Hi Jonathan,\n\nCan you confirm vanity counts and sizes for the six Fulton St units? The manufacturer is raising prices on the 1st, so if we can lock quantities by Friday I can hold current pricing and a 14-day lead time.\n\nThanks,\nTom Brennan\nBay State Plumbing Supply' },
  ], { category: 'procurement', summary: 'Supplier needs confirmed vanity counts and sizes by Friday to hold pricing before an increase on the 1st.', ball: 'me', waiting_on: 'Tom Brennan', next_action: 'Confirm vanity quantities from the reviewed takeoff; flag the Unit 4 powder room as pending RFI-004', urgency: 2,
    reply: `Hi Tom,\n\nHere is where Fulton St stands, from our reviewed takeoff and sheets A-401 and P-601:\n\n- VAN-1, 36": 6 (primary baths, Units 1-6), confirmed.\n- VAN-2, 30": 5 confirmed (half baths, Units 1, 2, 3, 5, 6).\n- Unit 4 powder room: pending. The width isn't dimensioned on A-401 and we have RFI-004 out to the architect, due ${d(4)}. It will be either a 30" VAN-2 or a 24" unit.\n\nPlease lock pricing for 6 x 36" and 5 x 30", and quote the Unit 4 vanity both ways so we can release it as soon as the RFI comes back. The vanity product data is still with the architect for review, so hold off on releasing the order until I confirm approval.\n\nThanks,\nJonathan` });

  thread('demo-rfi2', fulton, 'RFI-002 Window rough opening heights at rear elevation', [
    { me: true, toName: 'Dana Whitfield', to: 'dana@harborline-arch.example', at: at(-12, '15:40'), body: 'Dana,\n\nAttached is RFI-002. A-201 and the window schedule disagree on the W-2 and W-4 head heights at the rear elevation. The window order is on hold until we hear back; please respond by ' + d(-5) + '.\n\nThanks,\nJonathan' },
    { me: true, toName: 'Dana Whitfield', to: 'dana@harborline-arch.example', at: at(-6, '10:05'), body: 'Hi Dana, following up on RFI-002. North Shore needs the rough openings to release the windows for fabrication. Can you get us an answer this week?\n\nJonathan' },
  ], { category: 'rfi', summary: 'RFI-002 on rear-elevation window head heights is overdue; window fabrication is waiting on it.', ball: 'them', waiting_on: 'Dana Whitfield (Harbor Line Architects)', next_action: 'Call Dana; the window release depends on this answer', urgency: 2 });

  thread('demo-windows', fulton, 'Fulton St window shop drawings - need RO confirmation', [
    { name: 'Kevin Walsh', email: 'kwalsh@nswindows.example', at: at(-4, '11:20'), body: 'Jonathan,\n\nShop drawings for all 38 units are attached. We can\'t release to fabrication until the rear elevation rough openings are confirmed (W-2 and W-4). Current lead time is 3 weeks from release. Let me know as soon as the architect responds.\n\nKevin Walsh\nNorth Shore Windows & Doors' },
  ], { category: 'submittal', summary: 'Window supplier sent shop drawings and is holding fabrication until rear rough openings are confirmed; 3-week lead time.', ball: 'me', waiting_on: 'Kevin Walsh', next_action: 'Transmit the window submittal and give Kevin a date for the RO answer', urgency: 2,
    reply: `Kevin,\n\nThanks, received. The rear W-2/W-4 heights are tied up in RFI-002 with the architect; I'm pushing for an answer this week and will send the confirmed ROs the same day. In the meantime, can you hold a production slot so the 3-week clock starts as soon as we release?\n\nJonathan` });

  thread('demo-blocking', fulton, 'Fulton framing - 2nd floor done, blocking question', [
    { name: 'Luis Ortega', email: 'luis@ortegaframing.example', at: at(-1, '16:45'), body: 'Jonathan, second floor walls are done on all six units. Before the plumber starts Thursday I need to know if you want the vanity blocking at 30-36" everywhere like A-401 says or only where the vanities are confirmed. Also need the framing inspection booked. Call me.\n\nLuis' },
  ], { category: 'schedule', summary: 'Framer finished floor 2 and needs a decision on vanity blocking and the framing inspection booked before plumbing starts Thursday.', ball: 'me', waiting_on: 'Luis Ortega', next_action: 'Tell Luis to block per A-401 at all vanity walls including Unit 4; request the framing inspection', urgency: 3,
    reply: `Luis,\n\nBlock per A-401 at every vanity wall, 30" to 36" AFF, including the Unit 4 powder room even though the vanity width is still open (RFI-004). Blocking the full wall covers either size. I'm requesting the framing inspection today and will text you the slot.\n\nJonathan` });

  thread('demo-draw', fulton, 'October draw request and progress update', [
    { name: 'Rachel Kim', email: 'rkim@medfordcapital.example', at: at(-3, '09:02'), body: 'Hi Jonathan,\n\nCould you send the October progress update and draw request for Fulton St by the 31st? Please include the updated schedule and any change orders pending owner approval.\n\nBest,\nRachel' },
  ], { category: 'owner_investor', summary: 'Investor wants the October progress update, draw request, schedule and pending change orders by the 31st.', ball: 'me', waiting_on: 'Rachel Kim', next_action: 'Prepare the October update: progress, schedule, $27,700 in pending/potential changes', urgency: 1 });

  thread('demo-duct', bow, 'Bow St - duct routing at Unit 3 beam', [
    { name: 'Priya Raman', email: 'priya@ramanmep.example', at: at(-2, '14:30'), body: 'Jonathan,\n\nThe new LVL at the Unit 3 kitchen takes the space we had for the supply trunk. Two options: drop the soffit 6" or reroute through the hall closet. I need your call (or a formal RFI if the architect needs to weigh in on the soffit).\n\nPriya' },
  ], { category: 'rfi', summary: 'MEP engineer needs a decision on the Unit 3 duct/beam conflict: drop the soffit 6" or reroute through the closet.', ball: 'me', waiting_on: 'Priya Raman', next_action: 'Send the drafted RFI (detected) or decide on the reroute', urgency: 2 });

  thread('demo-panels', bow, 'Change order request - relocate panels', [
    { name: 'Joe Russo', email: 'joe@sparkselectric.example', at: at(-5, '08:15'), body: 'Jonathan,\n\nThe existing chase is too shallow for the new panels. We priced relocating the four panels to the hall closets at $3,950 including patching. Need approval to keep rough-in moving.\n\nJoe Russo\nSparks Electric' },
  ], { category: 'change_order', summary: 'Electrician requests a $3,950 change order to relocate four panels because the existing chase is too shallow.', ball: 'me', waiting_on: 'Joe Russo', next_action: 'Approve or negotiate the $3,950 panel relocation', urgency: 1 });

  thread('demo-isd', centre, 'Plan review comments - ERT-26-0098', [
    { name: 'Inspectional Services', email: 'permits@isd-sample.example', at: at(-6, '12:00'), body: 'Your application ERT-26-0098 for 250 Centre St has plan review comments. Please upload revised energy code documentation (Specialized Code pathway) and stamped structural calculations through the permit portal.\n\nInspectional Services Department (sample)' },
  ], { category: 'permit_inspection', summary: 'Boston ISD needs revised Specialized Code energy documentation and stamped structural calcs uploaded to the portal.', ball: 'me', waiting_on: 'Boston ISD', next_action: 'Get the energy consultant and structural engineer to update and upload documents', urgency: 2 });

  thread('demo-news', null, 'Builder Weekly: lumber futures, rate outlook', [
    { name: 'Builder Weekly', email: 'news@builderweekly.example', at: at(-1, '07:00'), body: 'This week: lumber futures, the rate outlook, and five jobsite tech tools. Unsubscribe anytime.' },
  ], { category: 'not_work', summary: 'Industry newsletter.', ball: 'none', waiting_on: null, next_action: null, urgency: 0, work: 0 });

  // ---------- calendar ----------
  const ev = (id, subject, day, time, location, project) => db.prepare('INSERT OR REPLACE INTO calendar_events (id, subject, start, end, location, organizer, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, subject, `${d(day)}T${time}`, `${d(day)}T${time}`, location, 'Jonathan', project?.id || null, now(), now());
  ev('demo-ev1', 'OAC meeting - Fulton St', 1, '09:00', '88 Fulton St site trailer', fulton);
  ev('demo-ev2', 'Bow St site walk with Priya', 2, '14:00', '14 Bow St', bow);
  ev('demo-ev3', 'Centre St energy consultant call', 3, '11:00', 'Teams', centre);

  // ---------- activity ----------
  logActivity({ kind: 'demo-detected', project_id: bow.id, title: 'Found RFI "Duct routing conflict at Unit 3 beam" in email', why: 'Priya Raman asked for a decision or a formal RFI. Marked unconfirmed until you review it.', sources: [{ type: 'threads', id: 'demo-duct', label: 'Bow St - duct routing at Unit 3 beam' }], entity_type: 'rfis' });
  logActivity({ kind: 'demo-detected', project_id: bow.id, title: 'Found change order "Relocate electrical panels" in email', why: 'Sparks Electric priced it at $3,950. Marked unconfirmed until you review it.', sources: [{ type: 'threads', id: 'demo-panels', label: 'Change order request - relocate panels' }], entity_type: 'changes' });
  logActivity({ kind: 'demo-reply', project_id: fulton.id, title: 'Suggested a reply to Tom Brennan about vanity quantities', why: 'Used the reviewed takeoff (6 x 36", 5 x 30") and held Unit 4 because RFI-004 is open; did not promise a count that is not confirmed.', sources: [{ type: 'takeoffs', id: tk1.id, label: 'Vanity VAN-1 takeoff' }, { type: 'takeoffs', id: tk2.id, label: 'Vanity VAN-2 takeoff' }, { type: 'rfis', id: rfi4.id, label: 'RFI-004' }] });

  // ---------- sample drawing set ----------
  addDocument({ projectId: fulton.id, filename: 'Fulton St - Sample drawings (A-201, A-401, P-601).pdf', bytes: await sampleDrawings(), kind: 'drawings', source: 'demo' });
  db.prepare("UPDATE documents SET source = 'demo' WHERE project_id = ?").run(fulton.id);
  return { loaded: true, projects: 3, rfi1: rfi1.id };
}

export function clearDemo() {
  const projectIds = db.prepare("SELECT id FROM projects WHERE source = 'demo'").all().map((r) => r.id);
  const inList = projectIds.map(() => '?').join(',') || "''";
  for (const t of ['rfis', 'submittals', 'orders', 'takeoffs', 'schedule_items', 'changes', 'permits', 'inspections', 'contacts', 'actions', 'drafts']) {
    db.prepare(`DELETE FROM ${t} WHERE source = 'demo' OR project_id IN (${inList})`).run(...projectIds);
  }
  for (const doc of db.prepare(`SELECT id, path FROM documents WHERE source = 'demo' OR project_id IN (${inList})`).all(...projectIds)) {
    fs.rmSync(resolveDocPath(doc.path), { force: true });
    db.prepare('DELETE FROM doc_pages WHERE doc_id = ?').run(doc.id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    db.prepare("DELETE FROM search_fts WHERE kind = 'doc_page' AND ref_id LIKE ?").run(`${doc.id}:%`);
  }
  db.prepare("DELETE FROM emails WHERE id LIKE 'demo-%'").run();
  db.prepare("DELETE FROM threads WHERE id LIKE 'demo-%'").run();
  db.prepare("DELETE FROM calendar_events WHERE id LIKE 'demo-%'").run();
  db.prepare(`DELETE FROM activity_log WHERE kind LIKE 'demo%' OR project_id IN (${inList})`).run(...projectIds);
  db.prepare(`DELETE FROM chats WHERE project_id IN (${inList})`).run(...projectIds);
  db.prepare(`DELETE FROM search_fts WHERE ref_id LIKE 'demo-%' OR project_id IN (${inList})`).run(...projectIds);
  db.prepare("DELETE FROM projects WHERE source = 'demo'").run();
  return { cleared: projectIds.length };
}
