/**
 * Static fake data for the clickable mockups (#41). Nothing here talks to Supabase;
 * real screens will replace these with queries.
 */
import type { ServiceTag } from '@/theme/tokens';

export const stylist = { name: 'Jordan Reyes', salon: 'Studio Jordan' };

/** Fixed "now" so the mockups always look the same: 9:42 AM. */
export const MOCK_NOW_MINUTES = 9 * 60 + 42;
export const MOCK_TODAY = new Date(2026, 10, 10);

export type SegmentKind = 'work' | 'processing' | 'finish';
export type Segment = { kind: SegmentKind; label: string; minutes: number };

export type Service = {
  id: string;
  name: string;
  tag: ServiceTag;
  price: number;
  segments: Segment[];
};

export const services: Service[] = [
  {
    id: 'root-color',
    name: 'Root color',
    tag: 'violet',
    price: 95,
    segments: [
      { kind: 'work', label: 'Apply', minutes: 30 },
      { kind: 'processing', label: 'Process', minutes: 35 },
      { kind: 'finish', label: 'Rinse + style', minutes: 25 },
    ],
  },
  {
    id: 'balayage',
    name: 'Balayage',
    tag: 'amber',
    price: 220,
    segments: [
      { kind: 'work', label: 'Paint', minutes: 60 },
      { kind: 'processing', label: 'Lift', minutes: 45 },
      { kind: 'finish', label: 'Tone + style', minutes: 45 },
    ],
  },
  {
    id: 'womens-cut',
    name: "Women's cut",
    tag: 'rose',
    price: 65,
    segments: [{ kind: 'work', label: 'Cut + style', minutes: 45 }],
  },
  {
    id: 'mens-cut',
    name: "Men's cut",
    tag: 'sky',
    price: 40,
    segments: [{ kind: 'work', label: 'Cut', minutes: 30 }],
  },
  {
    id: 'blowout',
    name: 'Blowout',
    tag: 'teal',
    price: 50,
    segments: [{ kind: 'work', label: 'Wash + blowout', minutes: 40 }],
  },
  {
    id: 'gloss',
    name: 'Gloss',
    tag: 'fuchsia',
    price: 45,
    segments: [
      { kind: 'work', label: 'Apply', minutes: 10 },
      { kind: 'processing', label: 'Process', minutes: 20 },
      { kind: 'finish', label: 'Rinse', minutes: 10 },
    ],
  },
];

export function serviceById(id: string): Service {
  const s = services.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown service ${id}`);
  return s;
}

export function serviceMinutes(s: Service): number {
  return s.segments.reduce((sum, seg) => sum + seg.minutes, 0);
}

export type Appointment = {
  id: string;
  client: string;
  serviceIds: string[];
  /** Minutes from midnight. */
  start: number;
  status: 'done' | 'in-progress' | 'upcoming' | 'blocked';
  note?: string;
};

export const todayAppointments: Appointment[] = [
  {
    id: 'a1',
    client: 'Karina Lopez',
    serviceIds: ['root-color'],
    start: 9 * 60,
    status: 'in-progress',
  },
  { id: 'a2', client: 'Ben Carter', serviceIds: ['mens-cut'], start: 9 * 60 + 30, status: 'done' },
  {
    id: 'a3',
    client: 'Priya Shah',
    serviceIds: ['balayage', 'gloss'],
    start: 10 * 60 + 30,
    status: 'upcoming',
    note: 'Wants it a little brighter than last time',
  },
  { id: 'a4', client: 'Lunch', serviceIds: [], start: 13 * 60 + 45, status: 'blocked' },
  {
    id: 'a5',
    client: 'Dana Kim',
    serviceIds: ['womens-cut'],
    start: 14 * 60 + 30,
    status: 'upcoming',
  },
  {
    id: 'a6',
    client: 'Sofia Martinez',
    serviceIds: ['blowout'],
    start: 15 * 60 + 30,
    status: 'upcoming',
  },
  {
    id: 'a7',
    client: 'Leo Park',
    serviceIds: ['mens-cut'],
    start: 16 * 60 + 30,
    status: 'upcoming',
  },
];

export function appointmentMinutes(a: Appointment): number {
  if (a.status === 'blocked') return 45;
  return a.serviceIds.reduce((sum, id) => sum + serviceMinutes(serviceById(id)), 0);
}

export function appointmentPrice(a: Appointment): number {
  return a.serviceIds.reduce((sum, id) => sum + serviceById(id).price, 0);
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export const WORK_DAY = { start: 9 * 60, end: 18 * 60 };

export type Client = {
  id: string;
  name: string;
  phone: string;
  lastVisit: string;
  visits: number;
  tag: ServiceTag;
  favorite: string;
  formula?: string;
};

export const clients: Client[] = [
  {
    id: 'c1',
    name: 'Karina Lopez',
    phone: '(555) 201-3344',
    lastVisit: 'Today',
    visits: 14,
    tag: 'violet',
    favorite: 'Root color',
    formula: '6N + 6G, 20 vol, 35 min',
  },
  {
    id: 'c2',
    name: 'Priya Shah',
    phone: '(555) 918-2210',
    lastVisit: 'Sep 28',
    visits: 6,
    tag: 'amber',
    favorite: 'Balayage',
    formula: 'Lightener 1:2, 30 vol; gloss 9V',
  },
  {
    id: 'c3',
    name: 'Ben Carter',
    phone: '(555) 340-1120',
    lastVisit: 'Today',
    visits: 22,
    tag: 'sky',
    favorite: "Men's cut",
  },
  {
    id: 'c4',
    name: 'Dana Kim',
    phone: '(555) 772-0091',
    lastVisit: 'Oct 15',
    visits: 9,
    tag: 'rose',
    favorite: "Women's cut",
  },
  {
    id: 'c5',
    name: 'Sofia Martinez',
    phone: '(555) 610-4482',
    lastVisit: 'Oct 30',
    visits: 4,
    tag: 'teal',
    favorite: 'Blowout',
  },
  {
    id: 'c6',
    name: 'Leo Park',
    phone: '(555) 245-7713',
    lastVisit: 'Oct 20',
    visits: 11,
    tag: 'sky',
    favorite: "Men's cut",
  },
  {
    id: 'c7',
    name: 'Maya Thompson',
    phone: '(555) 309-5520',
    lastVisit: 'Aug 2',
    visits: 3,
    tag: 'violet',
    favorite: 'Root color',
    formula: '7N + 7A, 20 vol',
  },
  {
    id: 'c8',
    name: 'Chris Nguyen',
    phone: '(555) 455-8823',
    lastVisit: 'Oct 8',
    visits: 7,
    tag: 'sky',
    favorite: "Men's cut",
  },
  {
    id: 'c9',
    name: 'Olivia Bennett',
    phone: '(555) 128-6650',
    lastVisit: 'Jul 19',
    visits: 2,
    tag: 'fuchsia',
    favorite: 'Gloss',
  },
  {
    id: 'c10',
    name: 'Hannah Lee',
    phone: '(555) 887-1032',
    lastVisit: 'Oct 2',
    visits: 12,
    tag: 'emerald',
    favorite: 'Blowout',
  },
];

/** Deterministic 0..1 busyness for a date (closed Sun/Mon). */
export function busyness(date: Date): number {
  const dow = date.getDay();
  if (dow === 0 || dow === 1) return 0;
  if (date.toDateString() === MOCK_TODAY.toDateString()) {
    const booked = todayAppointments
      .filter((a) => a.status !== 'blocked')
      .reduce((sum, a) => sum + appointmentMinutes(a), 0);
    return booked / (WORK_DAY.end - WORK_DAY.start);
  }
  const seed = (date.getDate() * 37 + date.getMonth() * 11) % 100;
  return Math.min(1, 0.25 + (seed / 100) * 0.8);
}

export const quickActions = [
  { id: 'book', label: 'Book', icon: 'add-circle-outline' },
  { id: 'block', label: 'Block time', icon: 'remove-circle-outline' },
  { id: 'late', label: 'Running late', icon: 'time-outline' },
  { id: 'checkout', label: 'Checkout', icon: 'card-outline' },
] as const;
