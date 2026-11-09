import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';

export interface SemanticCase {
  id: string;
  category: 'paraphrase' | 'exact';
  query: string;
  regex: string;
  relevance: Record<string, number>;
}
export interface SemanticFixture { cases: SemanticCase[]; records: number; editedFile: string; editedHandle: string }

// Authored relevance judgments are independent of either retrieval engine.
// Each topic has an answer-bearing entry (grade 3), an actionable follow-up
// (grade 2), and a broader project overview (grade 1).
const topics = [
  { slug: 'cold-copy', name: 'Cold copy', question: 'How can I recover my notes if my computer disappears?', regex: 'recover|notes|computer|disappears',
    note: 'The recovery rehearsal succeeded. An encrypted archive of the Markdown journal now goes to an external drive every Sunday. A second copy stays at my sister’s house. The restore script rebuilds the full workspace on a replacement machine, including project links and open tasks. Losing the laptop would cost at most one week of writing.',
    action: 'Rehearse restoring the encrypted journal archive onto a spare machine. Verify that project links and open tasks survive the transfer.', overview: 'Personal disaster recovery. Keep independently stored copies of the writing workspace and verify the restoration procedure.' },
  { slug: 'quiet-stage', name: 'Quiet stage', question: 'What did we decide about the ending without any dialogue?', regex: 'ending|dialogue',
    note: 'Robin and I rehearsed the final scene of our comedy sketch. We removed the last spoken line and held the embarrassed pause for four beats. The audience laughed harder when the actors simply exchanged a look. Keep the silent finish for Friday’s performance.',
    action: 'Run the sketch finale with Robin. Hold the pause for four beats and finish with an exchanged look.', overview: 'Develop a short comedy performance with Robin. Experiment with timing, physical reactions, and audience response.' },
  { slug: 'doorstep', name: 'Doorstep', question: 'Why were new users abandoning setup before they could try the app?', regex: 'new users|abandon|setup',
    note: 'The onboarding interviews exposed the drop-off: people had to configure a calendar account before seeing their first saved note. We moved account linking after the first successful capture and shortened the welcome form to a single field. Activation rose in the follow-up trial.',
    action: 'Move calendar linking behind the first successful capture. Reduce the welcome form to one field, then measure activation.', overview: 'Improve the first-run product experience. Study activation friction and test a simpler onboarding journey.' },
  { slug: 'far-table', name: 'Far table', question: 'Which plan makes the team gathering work for people who cannot eat dairy?', regex: 'team gathering|dairy',
    note: 'For the offsite dinner, Mina cannot have milk products and Sam avoids gluten. The restaurant confirmed a separate vegan menu, rice-based main dishes, and clean utensils. Order the shared vegetable platter without cheese and keep the sauce on the side.',
    action: 'Confirm the offsite restaurant can serve the vegan and gluten-free options with separate utensils.', overview: 'Plan the team offsite dinner and collect dietary restrictions. Coordinate an inclusive meal with the venue.' },
  { slug: 'handrail', name: 'Handrail', question: 'How do we stop a failed rollout from taking the website down?', regex: 'failed|rollout|website',
    note: 'The deployment review chose a staged release. Send one percent of traffic to the new build, watch the error budget for ten minutes, and automatically revert if failures exceed the threshold. The previous healthy container stays warm until the canary passes.',
    action: 'Implement the one-percent canary and automatic rollback when the error threshold is exceeded.', overview: 'Make production releases safer with gradual traffic shifts, health checks, and a fast return to the previous build.' },
  { slug: 'long-hall', name: 'Long hall', question: 'What makes the meeting screen usable without touching a mouse?', regex: 'meeting|screen|mouse',
    note: 'The accessibility audit found that the dialog trapped focus behind the overlay. Every control now follows a logical tab sequence, has an announced label, and responds to Enter or Escape. We tested the complete scheduling flow with only a keyboard and a screen reader.',
    action: 'Verify tab order, focus return, announced labels, and Escape handling in the scheduling dialog.', overview: 'Improve accessible scheduling. Support assistive technology and complete keyboard navigation throughout the interface.' },
  { slug: 'steady-mile', name: 'Steady mile', question: 'What was the plan for getting back to running without hurting my leg again?', regex: 'running|leg|hurting',
    note: 'After the calf strain, the physiotherapist recommended alternating two minutes of easy jogging with three minutes of walking. Stay on flat ground, leave a rest day between sessions, and stop if the pain returns. Increase total time only after a symptom-free week.',
    action: 'Schedule three walk-jog sessions with a rest day between each. Track calf soreness the following morning.', overview: 'Return gradually to regular exercise following a muscle injury. Build tolerance with conservative intervals and recovery days.' },
  { slug: 'paper-trail', name: 'Paper trail', question: 'Where is the agreement about how long we keep customer information?', regex: 'agreement|customer information|keep',
    note: 'The privacy review settled the retention policy. Raw support transcripts are erased after ninety days. Aggregated counts may remain for one year, but names and email addresses must be removed first. Deletion requests trigger an immediate purge of the corresponding records and stored vectors.',
    action: 'Add the ninety-day purge for support transcripts and remove identifiers before computing annual aggregates.', overview: 'Document the data lifecycle for support operations, including retention limits, anonymization, and deletion requests.' },
  { slug: 'air-gap', name: 'Air gap', question: 'Can I keep working on a plane when there is no internet?', regex: 'plane|internet|working',
    note: 'The travel prototype stores the complete note workspace on the device. Edits enter a local operation log and synchronize after connectivity returns. Conflict copies preserve both versions when the same paragraph changed elsewhere. Search uses a downloaded model and does not call a remote API.',
    action: 'Test note capture, edits, and local retrieval in airplane mode. Reconnect and inspect synchronization conflicts.', overview: 'Make the application useful offline. Keep data and retrieval local, with resilient synchronization after reconnection.' },
  { slug: 'small-envelope', name: 'Small envelope', question: 'How will we avoid spending too much on model requests this month?', regex: 'spending|model requests|month',
    note: 'The inference budget uses a daily token allowance per workspace. Cache identical prompts, route short classifications to the small local model, and reserve the larger endpoint for long synthesis. Alert at eighty percent of the monthly cap and pause optional summarization at the limit.',
    action: 'Add token allowance counters, an eighty-percent budget alert, and a pause for optional summarization at the cap.', overview: 'Control inference costs through prompt caching, model routing, and per-workspace usage limits.' },
  { slug: 'last-train', name: 'Last train', question: 'What should I do if my evening connection is cancelled?', regex: 'connection|cancelled|evening',
    note: 'The return itinerary has a contingency. If the final rail service from the airport is suspended, take the express bus to the central station and use the prepaid hotel voucher. The voucher code is saved in the travel folder. Do not rely on the last regional transfer.',
    action: 'Save the express bus timetable and prepaid hotel voucher before the return journey.', overview: 'Arrange a reliable return journey with a fallback route and accommodation if the late rail service fails.' },
  { slug: 'green-room', name: 'Green room', question: 'Why are the leaves turning yellow even though I water every day?', regex: 'leaves|yellow|water',
    note: 'The balcony basil sits in saturated soil because the pot has no drainage holes. Daily irrigation deprived the roots of oxygen. Repot it into a container that drains freely, remove damaged roots, and wait until the top layer dries before watering again.',
    action: 'Repot the basil into a draining container and reduce irrigation until the soil surface feels dry.', overview: 'Care for the balcony herb garden. Track soil moisture, drainage, and plant health.' },
];

const noise = [
  ['Design review', 'Compare the spacing and typography of the navigation controls. Record the preferred icon alignment and update the component screenshots.'],
  ['Grocery list', 'Pick up apples, lentils, bread, and coffee on the way home. Check the pantry before adding more rice to the shopping basket.'],
  ['Reading club', 'Read the next three chapters of the novel. Bring one question about the narrator and another about the setting to Saturday’s discussion.'],
  ['Garden bench', 'Sand the wooden bench, apply a weatherproof finish, and tighten the loose screws before moving it back onto the patio.'],
  ['Invoice review', 'Check the supplier invoice against the purchase order. Confirm the quantities and payment details before approving the transfer.'],
  ['Photo album', 'Choose photographs from the family picnic, correct the exposure, and print a small album for the grandparents.'],
  ['Workshop supplies', 'Sort the spare cables, label the storage boxes, and replace the broken soldering stand in the workshop.'],
  ['Music lesson', 'Practice the left-hand arpeggio slowly with a metronome. Increase the tempo only after playing four clean repetitions.'],
  ['Museum afternoon', 'Reserve entry tickets for the sculpture exhibition. Meet outside the north entrance and bring a sketchbook.'],
  ['Volunteer rota', 'Confirm who can cover the Saturday library shift. Update the volunteer roster and prepare the book donation table.'],
  ['API cleanup', 'Remove obsolete response fields after checking downstream consumers. Document the remaining request parameters and response examples.'],
  ['Bicycle service', 'Clean the chain, inspect the brake pads, and adjust the rear derailleur before the weekend ride.'],
];

export function writeSemanticFixture(root: string, records = 300): SemanticFixture {
  if (!Number.isSafeInteger(records) || records < topics.length * 3 || records > 100_000) throw new Error('Semantic fixture size must be 36–100000 records.');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'aside.md'), '---\nid: semantic-benchmark\nname: Synthetic semantic benchmark\ndescription: Authored benchmark records; no personal data\n---\n');
  const indexes = new Map<string, Array<{ id: string; description: string }>>();
  const notes: string[] = [];
  const cases: SemanticCase[] = [];
  let editedFile = '', editedHandle = '';
  const record = (kind: 'projects' | 'actions' | 'artifacts', id: string, name: string, body: string) => {
    const directory = join(root, kind, '2026');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `${id}.md`);
    writeFileSync(file, `---\n${stringify({ name, created: '2026-06-08T08:00' })}---\n\n${body}\n`);
    const items = indexes.get(directory) ?? []; items.push({ id, description: name }); indexes.set(directory, items);
    return file;
  };
  topics.forEach((topic, i) => {
    const id = `2026-06-08-${topic.slug}`;
    const entryId = `2026-06-08T09:${String(i).padStart(2, '0')}`;
    record('projects', id, topic.name, topic.overview);
    const actionFile = record('actions', id, `Follow up: ${topic.name}`, `${topic.action}\n\nContext: #project/${id}`);
    const directory = join(root, 'notes', '2026');
    const items = indexes.get(directory) ?? []; items.push({ id: entryId, description: `Decision for ${topic.name}` }); indexes.set(directory, items);
    notes.push(`---\n\`\`\`entry\n${stringify({ created: entryId, projects: [id], actions: [id] })}\`\`\`\n\n${topic.note}`);
    const relevance = { [`#entry/${entryId}`]: 3, [`#action/${id}`]: 2, [`#project/${id}`]: 1 };
    cases.push({ id: `${topic.slug}-paraphrase`, category: 'paraphrase', query: topic.question, regex: topic.regex, relevance });
    cases.push({ id: `${topic.slug}-exact`, category: 'exact', query: topic.name, regex: topic.name, relevance });
    if (i === 0) { editedFile = actionFile; editedHandle = `#action/${id}`; }
  });
  for (let i = topics.length * 3; i < records; i++) {
    const [name, body] = noise[(i - topics.length * 3) % noise.length];
    const id = `2026-06-09-distractor-${String(i).padStart(6, '0')}`;
    const kind = i % 3 === 0 ? 'projects' : i % 3 === 1 ? 'actions' : 'artifacts';
    record(kind, id, `${name} ${i}`, `${body}\n\nSession ${i}: ${['Write down the result and choose the next step.', 'Discuss the available options before committing.', 'Keep the supporting materials together for review.'][i % 3]}`);
  }
  mkdirSync(join(root, 'notes', '2026'), { recursive: true });
  writeFileSync(join(root, 'notes', '2026', '2026-06-08.md'), `---\nweek: 24\nweek_start: 2026-06-08\nweek_end: 2026-06-14\n---\n\n${notes.reverse().join('\n\n')}\n`);
  for (const [directory, items] of indexes) writeFileSync(join(directory, 'index.yaml'), stringify(items.reverse()));
  return { cases, records, editedFile, editedHandle };
}
