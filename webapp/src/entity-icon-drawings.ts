// The entity icon drawings — one notebook family drawn on Lucide's geometry
// (lucide-static 1.66.0, ISC license): its 24-unit grid, its 2-unit stroke,
// and its shapes for the notebook, the pencil, the bookmark, the ring and the
// file page. The instance is the notebook; an entry is the pencil writing in
// it; a project is a bookmark ribbon left in it; an action is the round
// checkbox in its margin; artifacts and attachments are the pages kept with
// it, keyed by how the reader renders them. Shapes are drawn in line, as
// Lucide's are. Fill marks a state — the ring and the ribbon fill when their
// work settles, the open instance's cover as it swings open — and gives a
// media mark its weight.
//
// Smart elements — the dates and places content mentions — are not entities,
// but they draw on the same grid, stroke and rules: a date is the calendar
// page the notebook's days are kept on, a location the map pin.
//
// Each drawing is a set of layers back to front, each masked by the layers in
// front of it, and marks — `in` marks sit on a layer (knocked out of it once
// the body fills), `over` marks cut a gap through what they cross, `free`
// marks draw as they are. A state shows marks and layers, swings or stacks
// layers, and fills or empties the body. Every state of a drawing has the
// same elements, so a state change rewrites only class and style attributes,
// and the CSS transitions in style.css animate the morph. A few icons have a
// second drawing for 13px and below, where detail closes up.
//
// Kept free of imports so the design demo can embed it as is.

interface Layer {
  id: string;
  d: string;
  // Shown only by the states that list it.
  alt?: boolean;
  // The layers drawn in front of this one, masking it.
  occ?: string[];
  // Where a swing or a stack pivots.
  origin?: string;
}

interface Mark {
  d: string;
  on?: string;
  kind?: 'in' | 'over' | 'free';
  fill?: boolean;
  weight?: 'bold' | 'letters';
}

interface Pose {
  marks: string[];
  show?: string[];
  filled?: boolean;
  // Layers solid in this state alone.
  solid?: string[];
  move?: Record<string, string>;
  // The body's dash pattern and offset, for drawings with `edges`.
  edge?: [string, number];
}

interface Drawing {
  layers: Layer[];
  marks: Record<string, Mark>;
  states: Record<string, Pose>;
  edges?: boolean;
}

interface Icon { initial: string; full: Drawing; small?: Drawing }

// Lucide's shapes: `circle`, `notebook`, `pencil-line`, `bookmark`, `file`,
// `git-branch`, `calendar` and `map-pin`.
const RING = 'M12 2a10 10 0 1 1 0 20a10 10 0 1 1 0-20Z';
const NOTEBOOK = 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z';
const PENCIL = 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z';
const BOOKMARK = 'M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z';
const PAGE = 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z';
const FOLD = 'M14 2v5a1 1 0 0 0 1 1h5';
// The page opened at the lower left for a large mark, as Lucide's own file
// icons are (`file-chart-pie`, `file-video-camera`): the left border ends at
// `left` and the bottom border starts at `bottom`, each stopping two units
// short of the mark. A bottom at the corner leaves the whole bottom open.
const openPage = (left: number, bottom: number) => bottom >= 18
  ? `M4 ${left}V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2`
  : `M${bottom} 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.704l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v${left - 4}`;
const BRANCH = 'M15 6a9 9 0 0 0-9 9V3M18 3a3 3 0 1 1 0 6a3 3 0 1 1 0-6ZM6 15a3 3 0 1 1 0 6a3 3 0 1 1 0-6Z';
const RINGS = 'M2 6h4M2 10h4M2 14h4M2 18h4';
const CALENDAR = 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z';
// The calendar opened at the lower right around a clock, as Lucide's
// `calendar-clock` is: each border stops two units short of the face.
const CALENDAR_OPEN = 'M21 7.338V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h2.338';
// Lucide's pin, started at its crown so the dashes of a pending pin fall
// symmetrically, one of them across the tip.
const PIN = 'M12 2a8 8 0 0 1 8 8c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 8-8Z';

// The open instance's cover swings half open about the rings, turning solid
// against the first page.
const SWING = 'scaleX(0.5) skewY(-14deg)';
const HINGE = '4px 12px';
// A collection's pages take Lucide's `files` places: the front page shrinks
// up and right, and a second one steps out below and left.
const STACK = { back: 'translate(0px, 5.5px) scale(0.75)', page: 'translate(6px, 0.5px) scale(0.75)' };

// The settling tick is Lucide's check enlarged: cut out of a filled body it
// reads smaller than the same tick drawn in ink.
const RINGED: Record<string, Mark> = {
  check: { d: 'm7.5 12 3 3 6-6', on: 'ring' },
  hands: { d: 'M12 6v6l4 2', on: 'ring' },
  slash: { d: 'M22 2 2 22', kind: 'over' },
  arrow: { d: 'M10.5.5 12 2l-1.5 1.5', kind: 'free' },
};
// A cancelled ring takes Lucide's corner-to-corner slash, matching the
// struck-through name; a recurring one opens into a loop arrow; a backlog one
// breaks into the eight dashes of Lucide's `circle-dashed`.
const ACTION_STATES: Record<string, Pose> = {
  backlog: { marks: [], edge: ['3.65 3.85', 1.825] },
  scheduled: { marks: [] },
  slipped: { marks: ['hands'] },
  done: { marks: ['check'], filled: true },
  cancelled: { marks: ['slash'] },
  recurring: { marks: ['arrow'], edge: ['51 9', 51] },
};
const RIBBONED: Record<string, Mark> = { check: { d: 'm8 9.5 3 3 5-5', on: 'rib' } };
const PROJECT_STATES: Record<string, Pose> = { live: { marks: [] }, ended: { marks: ['check'], filled: true } };

const ICONS: Record<IconKind, Icon> = {
  instance: {
    initial: 'available',
    // The first page sits behind the cover and shows as it swings open; a
    // worktree gives the whole cover to the git branch.
    full: {
      layers: [
        { id: 'leaves', d: NOTEBOOK, alt: true, occ: ['cover'] },
        { id: 'cover', d: NOTEBOOK, origin: HINGE },
      ],
      marks: {
        rings: { d: RINGS, kind: 'free' },
        spine: { d: 'M16 2v20', on: 'cover' },
        lines: { d: 'M14 8h3M14 12h4M14 16h2.5', on: 'leaves' },
        branch: { d: 'M13.65 8.7a4.95 4.95 0 0 0-4.95 4.95V7.05M15.3 7.05a1.65 1.65 0 1 1 0 3.3a1.65 1.65 0 1 1 0-3.3ZM8.7 13.65a1.65 1.65 0 1 1 0 3.3a1.65 1.65 0 1 1 0-3.3Z', on: 'cover' },
      },
      states: {
        available: { marks: ['rings', 'spine'] },
        active: { marks: ['rings', 'lines'], show: ['leaves'], solid: ['cover'], move: { cover: SWING } },
        worktree: { marks: ['rings', 'branch'] },
      },
    },
    // At 13px and below the cover drops its spine and the open notebook its page
    // lines; a worktree is Lucide's git branch on its own.
    small: {
      layers: [
        { id: 'leaves', d: NOTEBOOK, alt: true, occ: ['cover'] },
        { id: 'cover', d: NOTEBOOK, alt: true, origin: HINGE },
      ],
      marks: {
        rings: { d: RINGS, kind: 'free' },
        git: { d: BRANCH, kind: 'free' },
      },
      states: {
        available: { marks: ['rings'], show: ['cover'] },
        active: { marks: ['rings'], show: ['leaves', 'cover'], solid: ['cover'], move: { cover: SWING } },
        worktree: { marks: ['git'] },
      },
    },
  },
  entry: {
    initial: 'recorded',
    full: {
      layers: [{ id: 'pen', d: PENCIL }],
      marks: {
        ferrule: { d: 'm15 5 4 4', on: 'pen' },
        eraser: { d: 'M15 5.013 17.188 2.825a2.819 2.819 0 0 1 3.986 3.987L19 8.986Z', on: 'pen', fill: true },
        line: { d: 'M13 21h8', kind: 'free' },
      },
      states: { recorded: { marks: ['ferrule', 'eraser', 'line'] } },
    },
  },
  project: {
    initial: 'live',
    full: { layers: [{ id: 'rib', d: BOOKMARK }], marks: RIBBONED, states: PROJECT_STATES },
    // The settling tick grows bolder at 13px and below, where the standard one
    // shrinks to a hairline.
    small: { layers: [{ id: 'rib', d: BOOKMARK }], marks: { check: { ...RIBBONED.check, weight: 'bold' } }, states: PROJECT_STATES },
  },
  action: {
    initial: 'scheduled',
    full: { layers: [{ id: 'ring', d: RING }], marks: RINGED, states: ACTION_STATES, edges: true },
    small: {
      layers: [{ id: 'ring', d: RING }],
      marks: { ...RINGED, check: { ...RINGED.check, weight: 'bold' } },
      states: ACTION_STATES, edges: true,
    },
  },
  content: {
    initial: 'text',
    // Lucide's file page at every size, its mark previewing what the reader
    // opens. Text sits inside a closed page. A media mark or the PDF label is
    // large, and the page opens around it the way Lucide's own file icons do,
    // each opening cut to fit its mark.
    full: {
      layers: [
        { id: 'back', d: PAGE, alt: true, occ: ['page'], origin: '0 0' },
        { id: 'page', d: PAGE, alt: true, origin: '0 0' },
        { id: 'open-pdf', d: openPage(11.5, 18), alt: true },
        { id: 'open-image', d: openPage(13, 16), alt: true },
        { id: 'open-video', d: openPage(8.75, 11), alt: true },
        { id: 'open-audio', d: openPage(9, 13.5), alt: true },
        { id: 'open-webpage', d: openPage(9.25, 13.75), alt: true },
      ],
      marks: {
        fold: { d: FOLD, on: 'page' },
        lines: { d: 'M10 9H8M16 13H8M16 17H8', on: 'page' },
        // Drawn as strokes rather than text, so the label never joins the
        // text of the link or row it labels.
        pdf: { d: 'M2 22.5v-7h1.55a1.75 1.75 0 0 1 0 3.5H2M7.9 15.5h.2a3 3 0 0 1 0 6h-.2ZM13.7 22.5v-7h2.8M13.7 18.5h2.3', kind: 'free', weight: 'letters' },
        sun: { d: 'M11 9a1.25 1.25 0 1 1 0 2.5a1.25 1.25 0 1 1 0-2.5Z', kind: 'free', fill: true },
        land: { d: 'M1.5 22.5 6.5 15.5l3 4 1.5-1.5 1 4.5Z', kind: 'free', fill: true },
        // Lucide's `play`, scaled into the corner.
        play: { d: 'M2 13.7a1.2 1.2 0 0 1 1.805-1.037l7.198 4.199a1.2 1.2 0 0 1 .002 2.075l-7.2 4.2A1.2 1.2 0 0 1 2 22.1Z', kind: 'free', fill: true },
        // Four bars, the second tallest, each to its side shorter.
        wave: { d: 'M2.5 14.5v5M6 12v10M9.5 13.5v7M13 15.5v3', kind: 'free' },
        // A pie with its slice pulled out: rich, interactive content. The
        // slice stands far enough off that a gap survives the outline.
        pie: { d: 'M6.5 17.5V13a4.5 4.5 0 1 0 4.5 4.5ZM10 14V9.5a4.5 4.5 0 0 1 4.5 4.5Z', kind: 'free', fill: true },
      },
      states: {
        text: { marks: ['fold', 'lines'], show: ['page'] },
        pdf: { marks: ['fold', 'pdf'], show: ['open-pdf'] },
        image: { marks: ['fold', 'sun', 'land'], show: ['open-image'] },
        video: { marks: ['fold', 'play'], show: ['open-video'] },
        audio: { marks: ['fold', 'wave'], show: ['open-audio'] },
        webpage: { marks: ['fold', 'pie'], show: ['open-webpage'] },
        file: { marks: ['fold'], show: ['page'] },
        collection: { marks: ['fold'], show: ['back', 'page'], move: STACK },
      },
    },
  },
  date: {
    initial: 'day',
    // Lucide's calendar page, its mark previewing the value: a day is the
    // bare page, a range of days carries `calendar-range`'s two spans, and a
    // clock time opens the page around the clock face, as `calendar-clock`
    // does — the header stopping short of the face with the borders.
    full: {
      layers: [
        { id: 'page', d: CALENDAR, alt: true },
        { id: 'open', d: CALENDAR_OPEN, alt: true },
      ],
      marks: {
        rings: { d: 'M8 2v3M16 2v3', on: 'page' },
        head: { d: 'M3 9h18', on: 'page' },
        stub: { d: 'M3 9h5.859', on: 'page' },
        span: { d: 'M7 13h.01M11 13h6M7 17h6M17 17h.01', on: 'page' },
        face: { d: 'M16 10a6 6 0 1 1 0 12a6 6 0 1 1 0-12Z', kind: 'free' },
        hands: { d: 'M16 14v2.2l1.6 1', kind: 'free' },
      },
      states: {
        day: { marks: ['rings', 'head'], show: ['page'] },
        range: { marks: ['rings', 'head', 'span'], show: ['page'] },
        time: { marks: ['rings', 'stub', 'face', 'hands'], show: ['open'] },
      },
    },
  },
  location: {
    initial: 'geo',
    // Lucide's map pin around its point. A postal address with no saved
    // coordinates has no point yet: it pends, its edge breaking into dashes
    // as a backlog ring's does — six, spaced by the ring's gap and long
    // enough to keep the crown, the shoulders and the tip.
    full: {
      layers: [{ id: 'pin', d: PIN }],
      marks: { point: { d: 'M12 7a3 3 0 1 1 0 6a3 3 0 1 1 0-6Z', on: 'pin' } },
      states: {
        geo: { marks: ['point'] },
        postal: { marks: [], edge: ['5.6 4.4', 2.8] },
      },
      edges: true,
    },
  },
};

export type IconKind = 'instance' | 'entry' | 'project' | 'action' | 'content' | 'date' | 'location';

export function iconStates(kind: IconKind): string[] {
  return Object.keys(ICONS[kind].full.states);
}

// Initial sizes before mounted references take their dimensions from CSS.
export const ICON_SIZE = { pill: 10, stat: 11, row: 14, tile: 13, identity: 14, list: 16, title: 20 } as const;
const SMALL_MAX = 13;
const drawingAt = (kind: IconKind, size: number): Drawing => size <= SMALL_MAX && ICONS[kind].small || ICONS[kind].full;

const style = (props: Record<string, string | number | undefined>): string => {
  const text = Object.entries(props).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}:${value}`).join(';');
  return text ? ` style="${text}"` : '';
};

let nextMask = 0;

// The icon's SVG markup in one state. Geometry and state names are constants
// — never user data — so the markup is safe to set as innerHTML.
export function iconMarkup(kind: IconKind, state: string, size: number): string {
  const icon = ICONS[kind];
  const drawing = drawingAt(kind, size);
  const name = state in drawing.states ? state : icon.initial;
  const pose = drawing.states[name];
  const layerOf = new Map(drawing.layers.map(layer => [layer.id, layer]));
  // Motion rides every element of a layer: its body, its occluder, its marks.
  const motion = (id: string | undefined) => {
    const layer = id === undefined ? undefined : layerOf.get(id);
    return layer?.origin ? { transform: pose.move?.[layer.id], 'transform-origin': layer.origin } : {};
  };
  const hidden = (layer: Layer) => layer.alt && !pose.show?.includes(layer.id) ? 0 : undefined;
  const marks = Object.entries(drawing.marks);
  const markEl = ([name, mark]: [string, Mark]) => {
    const classes = ['m', mark.kind ?? 'in', mark.fill && 'fill', mark.weight].filter(Boolean).join(' ');
    const attrs = style({ '--icon-on': pose.marks.includes(name) ? 1 : undefined, ...motion(mark.on) });
    return `<path class="${classes}" d="${mark.d}"${mark.fill ? '' : ' pathLength="1"'}${attrs}/>`;
  };
  const gap = marks.filter(([, mark]) => mark.kind === 'over').map(markEl).join('');
  const id = `entity-icon-${++nextMask}`;
  let defs = '', layers = '';
  drawing.layers.forEach((layer, index) => {
    const occluders = drawing.layers.filter(front => layer.occ?.includes(front.id))
      .map(front => `<path class="o" d="${front.d}"${style({ opacity: hidden(front), ...motion(front.id) })}/>`).join('');
    const own = marks.filter(([, mark]) => (mark.kind ?? 'in') === 'in' && mark.on === layer.id).map(markEl).join('');
    // A layer with nothing to hide, knock out or cut through needs no mask.
    const masked = occluders || own || gap;
    const [dash, offset] = pose.edge ?? ['60 0', 0];
    const body = style({
      opacity: hidden(layer),
      'fill-opacity': pose.solid?.includes(layer.id) ? 1 : undefined,
      ...(drawing.edges && { 'stroke-dasharray': dash, 'stroke-dashoffset': offset }),
      ...motion(layer.id),
    });
    if (masked) defs += `<mask id="${id}-${index}" maskUnits="userSpaceOnUse" x="-6" y="-6" width="36" height="36"><rect x="-6" y="-6" width="36" height="36" fill="#fff"/><g class="occ">${occluders}</g><g class="knock">${own}</g><g class="gap">${gap}</g></mask>`;
    layers += `<g class="lay"${masked ? ` mask="url(#${id}-${index})"` : ''}><path class="body" d="${layer.d}" pathLength="60"${body}/>${own}</g>`;
  });
  const top = marks.filter(([, mark]) => mark.kind === 'free' || mark.kind === 'over').map(markEl).join('');
  const classes = `entity-icon${pose.filled ? ' filled' : ''}`;
  return `<svg class="${classes}" data-icon="${kind}" data-state="${name}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><defs>${defs}</defs>${layers}<g class="marks">${top}</g></svg>`;
}

// Put a host's icon in a state: the first time, the icon is created; after
// that, the drawing stays and only its state attributes change, so the CSS
// transitions animate the morph. Attributes are touched only when they
// differ — a repaint in the same state leaves the icon alone.
export function setEntityIcon(host: Element, kind: IconKind, state: string, size: number): void {
  const current = host.querySelector<SVGSVGElement>(':scope > svg.entity-icon');
  if (current?.dataset.state === state && current.dataset.icon === kind && current.getAttribute('width') === String(size)) return;
  const template = document.createElement('template');
  template.innerHTML = iconMarkup(kind, state, size);
  const next = template.content.firstElementChild as SVGSVGElement;
  if (!current || current.dataset.icon !== kind || drawingAt(kind, Number(current.getAttribute('width'))) !== drawingAt(kind, size)) {
    if (current) current.replaceWith(next);
    else host.prepend(next);
    return;
  }
  const before = [current, ...current.querySelectorAll('*')];
  const after = [next, ...next.querySelectorAll('*')];
  current.setAttribute('width', String(size));
  current.setAttribute('height', String(size));
  before.forEach((node, index) => {
    for (const name of ['class', 'style', 'data-state']) {
      const value = after[index].getAttribute(name);
      if (node.getAttribute(name) === value) continue;
      if (value === null) node.removeAttribute(name);
      else node.setAttribute(name, value);
    }
  });
}
