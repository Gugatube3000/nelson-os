// Massachusetts / Greater Boston requirements reference.
// status "verified": checked against the cited sources on `checked`.
// status "assumption": common practice or older knowledge, not re-checked; confirm before relying on it.
export const CHECKED = '2026-10-27';

export const REQUIREMENTS = [
  {
    id: 'ma-building-code',
    topic: 'Building code',
    jurisdiction: 'Massachusetts',
    status: 'verified',
    checked: CHECKED,
    rule: 'The 10th edition of the Massachusetts State Building Code (780 CMR) is the only building code in effect. It is based on the 2021 International Codes with Massachusetts amendments. It took effect October 11, 2024; the 9th-edition concurrency period ended June 30, 2025.',
    action: 'Confirm the design team stamped drawings to 780 CMR 10th edition for any permit filed on or after July 1, 2025.',
    sources: [
      { label: 'Mass.gov: Tenth edition of the MA State Building Code', url: 'https://www.mass.gov/handbook/tenth-edition-of-the-ma-state-building-code-780' },
      { label: 'Mass.gov: 10th edition news (BBRS)', url: 'https://www.mass.gov/news/10th-edition-of-the-state-building-code-board-of-building-regulations-and-standards' },
    ],
  },
  {
    id: 'ma-specialized-energy-code',
    topic: 'Energy code',
    jurisdiction: 'Boston, Medford, Cambridge, Somerville',
    status: 'verified',
    checked: CHECKED,
    rule: 'Boston, Cambridge, Medford and Somerville have adopted the Municipal Opt-in Specialized Energy Code (state list as of June 4, 2026). Reported effective dates: Cambridge and Somerville July 1, 2023; Boston January 1, 2024; Medford July 1, 2024.',
    action: 'New construction in these cities must meet the Specialized Code (all-electric or pre-wired/solar paths, HERS/Passive House pathways for residential). Confirm the pathway with the energy consultant before permit.',
    caveat: "Boston's January 1, 2024 date comes from a law-firm summary; confirm with Boston ISD.",
    sources: [
      { label: 'Mass.gov: Building energy code adoption by municipality', url: 'https://www.mass.gov/info-details/massachusetts-building-energy-code-adoption-by-municipality' },
      { label: 'Bowditch: 29 municipalities opt in to the Specialized Code', url: 'https://www.bowditch.com/bowditchrealestateblog/2023/12/01/leading-the-way-to-a-greenhouse-gas-limited-future-29-massachusetts-cities-and-towns-opt-in-to-the-commonwealths-specialized-energy-code' },
    ],
  },
  {
    id: 'boston-work-hours',
    topic: 'Work hours and noise',
    jurisdiction: 'Boston',
    status: 'verified',
    checked: CHECKED,
    rule: 'Regular construction hours in Boston are 7:00 AM to 6:00 PM on weekdays. Work outside those hours, including weekends and holidays, needs an Off-Hours Work Permit from Inspectional Services (ISD). The application is due by 12:00 PM on the Thursday before the proposed work date, and project delays or contractor availability are not accepted as justification.',
    action: 'Plan concrete pours, crane picks and street work inside regular hours, or file the off-hours permit by Thursday noon of the prior week.',
    sources: [
      { label: 'Boston.gov: Noise in Boston', url: 'https://www.boston.gov/government/cabinets/boston-public-health-commission/healthy-homes-and-environment/noise-boston' },
      { label: 'Boston ISD: Off-Hours Permit application (PDF)', url: 'https://www.boston.gov/sites/default/files/file/2026/06/Off%20Hours%20Permit%202025%20final.pdf' },
    ],
  },
  {
    id: 'boston-building-permits',
    topic: 'Building permits',
    jurisdiction: 'Boston',
    status: 'verified',
    checked: CHECKED,
    rule: 'Boston building permits are filed through the ISD online permit portal (an account is required; in-person filing at 1010 Massachusetts Ave still uses the portal). Long Form / Alteration covers structural work or change of occupancy; Erect / New Construction is for a new building on an empty lot. Work must start within six months of issuance; some permits can be extended 180 days. Inspections can be requested online or by phone at 617-635-5300.',
    action: 'Track the issue date on each permit; Nelson OS warns when the six-month start window is closing.',
    sources: [
      { label: 'Boston.gov: Apply for a building permit', url: 'https://www.boston.gov/node/151' },
    ],
  },
  {
    id: 'ma-dig-safe',
    topic: 'Excavation (Dig Safe)',
    jurisdiction: 'Massachusetts',
    status: 'verified',
    checked: CHECKED,
    rule: 'Before excavating, premark the area in white, then notify Dig Safe at least 72 hours ahead, excluding Saturdays, Sundays and legal holidays, and not more than 30 days before digging starts. A ticket is valid for 30 days. Planned blasting also needs 72 hours notice.',
    action: 'Call 811 at least three business days before excavation and log the ticket number on the permit record.',
    sources: [
      { label: '220 CMR 99.00 (Dig Safe regulations)', url: 'https://www.mass.gov/doc/220-cmr-99-procedures-for-the-determination-and-enforcement-of-violations-of-safety-codes-pertaining-to-damage-prevention/download' },
      { label: 'Mass.gov: About Dig Safe', url: 'https://www.mass.gov/guides/about-dig-safe' },
    ],
  },
  {
    id: 'ma-construction-supervisor',
    topic: 'Licensing',
    jurisdiction: 'Massachusetts',
    status: 'verified',
    checked: CHECKED,
    rule: 'People supervising construction regulated by 780 CMR on one- and two-family dwellings must hold a Construction Supervisor License (780 CMR 110.R5). A homeowner doing their own permitted work is exempt but then acts as supervisor.',
    action: 'Keep the CSL number of the supervising person on each 1–2 family permit; check that sub CSLs are current.',
    sources: [
      { label: 'Mass.gov: 780 CMR 110.R5 Licensing of construction supervisors', url: 'https://www.mass.gov/doc/10th-edition-chapter-110r5-licensing-of-construction-supervisors/download' },
    ],
  },
  {
    id: 'ma-osha10-public',
    topic: 'Safety training',
    jurisdiction: 'Massachusetts (public projects)',
    status: 'verified',
    checked: CHECKED,
    rule: 'On public construction projects estimated over $10,000, every worker needs OSHA 10-hour (or 30-hour) training documentation on site, submitted with the first certified payroll. This does not apply to private projects.',
    action: 'Only relevant if Nelson Group bids public work.',
    sources: [
      { label: 'Mass.gov: Prevailing wage guide for public construction contractors', url: 'https://www.mass.gov/doc/massachusetts-prevailing-wage-laws-an-important-guide-for-public-construction-contractors/download' },
    ],
  },
  {
    id: 'ma-hic',
    topic: 'Licensing',
    jurisdiction: 'Massachusetts',
    status: 'assumption',
    rule: 'Home Improvement Contractor (HIC) registration (M.G.L. c.142A) is required for contractors doing residential work on existing owner-occupied 1–4 unit homes. It is generally not required for new construction.',
    action: 'Confirm with the Office of Consumer Affairs and Business Regulation before relying on this.',
    sources: [],
  },
  {
    id: 'boston-street-occupancy',
    topic: 'Street use',
    jurisdiction: 'Boston',
    status: 'assumption',
    rule: 'Dumpsters, staging, cranes or sidewalk closures on the public way need a Street Occupancy Permit from Boston Public Works, plus traffic management plans for larger closures.',
    action: 'Confirm requirements and lead time with Boston Public Works before mobilizing.',
    sources: [],
  },
  {
    id: 'boston-berdo',
    topic: 'Building emissions',
    jurisdiction: 'Boston',
    status: 'assumption',
    rule: 'BERDO 2.0 requires energy and emissions reporting for buildings of 20,000 sq ft or more, or 15 or more residential units, with emissions limits phasing in over time.',
    action: 'Confirm whether finished buildings fall under BERDO and who files once occupied.',
    sources: [],
  },
  {
    id: 'boston-article-80',
    topic: 'Development review',
    jurisdiction: 'Boston',
    status: 'assumption',
    rule: 'Article 80 review by the Boston Planning Department applies to larger projects (Small Project Review generally above 20,000 sq ft or 15+ units; Large Project Review above 50,000 sq ft). Zoning relief goes to the Zoning Board of Appeal.',
    action: 'Confirm thresholds and the current process with the Boston Planning Department during due diligence.',
    sources: [],
  },
  {
    id: 'medford-permits',
    topic: 'Building permits',
    jurisdiction: 'Medford',
    status: 'assumption',
    rule: 'Medford building, electrical, plumbing and gas permits are filed through the city Building Department online permitting system.',
    action: 'Confirm the portal and current fee schedule with the Medford Building Department.',
    sources: [],
  },
];

export function findRequirements(topic) {
  if (!topic) return REQUIREMENTS;
  const words = String(topic).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const scored = REQUIREMENTS.map((r) => {
    const hay = `${r.topic} ${r.jurisdiction} ${r.rule} ${r.action}`.toLowerCase();
    return { r, score: words.filter((w) => hay.includes(w)).length };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  return scored.length ? scored.map((x) => x.r) : REQUIREMENTS;
}
