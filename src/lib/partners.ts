/**
 * Approved partner program.
 *
 * A partner is an approved Nostr account with a public vanity slug
 * (`savedd.com/glennbeck`). Their visitors are remembered in the browser
 * (the existing first-touch referrer). Result links use that partner's
 * affiliate rules first and Savedd's rules for every host they didn't
 * cover.
 *
 * The account link — "this login came from this partner" — is a NIP-17
 * gift wrap. The outer event is signed by a one-time key and is readable
 * only by the partner and the owner. It is encrypted from the first
 * record; there is no public version to migrate later.
 */
import type { NostrEvent } from '@nostrify/nostrify';
import { nip44 } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getEventHash } from 'nostr-tools/pure';

import type { AffiliateRule } from '@/lib/affiliates';
import { SAVEDD_PROTOCOL, ROLES_KIND } from '@/lib/saveddProtocol';

export const PARTNER_DIRECTORY_KIND = ROLES_KIND;
export const PARTNER_APPLICATION_KIND = ROLES_KIND;
export const ENROLLMENT_RUMOR_KIND = ROLES_KIND;
export const SEAL_KIND = 13;
export const GIFT_WRAP_KIND = 1059;
export const ENROLLMENT_D_TAG = 'savedd:referred-by';

const HEX = /^[0-9a-f]{64}$/;
const MAX_PARTNERS = 200;
const MAX_NAME = 60;
const MAX_NOTE = 280;

/** Paths the app already owns. A partner slug must not take one. */
export const RESERVED_PARTNER_SLUGS = new Set([
  'about', 'admin', 'api', 'assets', 'bookmarks', 'build', 'community',
  'dashboard', 'docs', 'explore', 'goodbye', 'heaven', 'index', 'instances',
  'network', 'partners', 'policy', 'protocol', 'remoteloginsuccess',
  'settings', 'www',
]);

export interface PartnerRecord {
  slug: string;
  pubkey: string;
  name: string;
}

export interface PartnerApplication {
  pubkey: string;
  slug: string;
  name: string;
  note: string;
  at: number;
}

export function normalizePartnerSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\/+|\/+$/g, '');
}

export function isValidPartnerSlug(slug: string): boolean {
  if (slug.length < 2 || slug.length > 32) return false;
  if (RESERVED_PARTNER_SLUGS.has(slug)) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
}

export function parsePartnerDirectory(event: NostrEvent, trusted: Set<string>): PartnerRecord[] {
  if (event.kind !== PARTNER_DIRECTORY_KIND) return [];
  if (!trusted.has(event.pubkey)) return [];
  if (event.tags.find(([n]) => n === 'd')?.[1] !== SAVEDD_PROTOCOL.partnerDirectory) return [];
  try {
    const parsed = JSON.parse(event.content) as { partners?: unknown };
    if (!parsed || !Array.isArray(parsed.partners)) return [];
    const out: PartnerRecord[] = [];
    const seenSlug = new Set<string>();
    const seenKey = new Set<string>();
    for (const item of parsed.partners) {
      if (!item || typeof item !== 'object') continue;
      const raw = item as Record<string, unknown>;
      const slug = typeof raw.slug === 'string' ? normalizePartnerSlug(raw.slug) : '';
      const pubkey = typeof raw.pubkey === 'string' ? raw.pubkey.toLowerCase() : '';
      const name = cleanName(raw.name);
      if (!isValidPartnerSlug(slug) || !HEX.test(pubkey) || !name) continue;
      if (seenSlug.has(slug) || seenKey.has(pubkey)) continue;
      seenSlug.add(slug);
      seenKey.add(pubkey);
      out.push({ slug, pubkey, name });
      if (out.length >= MAX_PARTNERS) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function buildPartnerDirectoryEvent(partners: PartnerRecord[]): {
  kind: number;
  content: string;
  tags: string[][];
} {
  return {
    kind: PARTNER_DIRECTORY_KIND,
    content: JSON.stringify({ version: 1, partners }),
    tags: [
      ['d', SAVEDD_PROTOCOL.partnerDirectory],
      ['t', 'savedd-partners'],
      ['alt', 'SAVEDD approved partner directory'],
    ],
  };
}

export function buildPartnerApplicationEvent(application: {
  slug: string;
  name: string;
  note: string;
}): { kind: number; content: string; tags: string[][] } {
  return {
    kind: PARTNER_APPLICATION_KIND,
    content: JSON.stringify({
      version: 1,
      slug: normalizePartnerSlug(application.slug),
      name: cleanName(application.name),
      note: application.note.trim().slice(0, MAX_NOTE),
    }),
    tags: [
      ['d', SAVEDD_PROTOCOL.partnerApplication],
      ['t', 'savedd-partner-application'],
      ['alt', 'SAVEDD partner program application'],
    ],
  };
}

export function parsePartnerApplication(event: NostrEvent): PartnerApplication | null {
  if (event.kind !== PARTNER_APPLICATION_KIND) return null;
  if (!HEX.test(event.pubkey)) return null;
  if (event.tags.find(([n]) => n === 'd')?.[1] !== SAVEDD_PROTOCOL.partnerApplication) return null;
  try {
    const raw = JSON.parse(event.content) as Record<string, unknown>;
    const slug = typeof raw.slug === 'string' ? normalizePartnerSlug(raw.slug) : '';
    const name = cleanName(raw.name);
    if (!isValidPartnerSlug(slug) || !name) return null;
    const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, MAX_NOTE) : '';
    return { pubkey: event.pubkey.toLowerCase(), slug, name, note, at: event.created_at };
  } catch {
    return null;
  }
}

/** Partner rules first, then Savedd's. First matching host wins. */
export function mergeAffiliateRules(partner: AffiliateRule[], central: AffiliateRule[]): AffiliateRule[] {
  if (partner.length === 0) return central;
  return [...partner, ...central];
}

type EventTemplate = {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
};

function randomPast(): number {
  return Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 2 * 24 * 60 * 60);
}

/**
 * Gift-wrap an enrollment to one recipient. The outer event's author is a
 * one-time key. The visitor's pubkey and the partner's pubkey are only
 * inside the ciphertext.
 */
export async function createEnrollmentGiftWrap(args: {
  userPubkey: string;
  partnerPubkey: string;
  recipientPubkey: string;
  encrypt: (recipientPubkey: string, plaintext: string) => Promise<string>;
  signEvent: (template: EventTemplate) => Promise<NostrEvent>;
}): Promise<NostrEvent> {
  const rumor = {
    kind: ENROLLMENT_RUMOR_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', ENROLLMENT_D_TAG], ['t', 'savedd-referral-enrollment']],
    content: JSON.stringify({ v: 1, partner: args.partnerPubkey.toLowerCase() }),
    pubkey: args.userPubkey.toLowerCase(),
  };
  const sealed = await args.encrypt(
    args.recipientPubkey,
    JSON.stringify({ ...rumor, id: getEventHash(rumor) }),
  );
  const seal = await args.signEvent({
    kind: SEAL_KIND,
    content: sealed,
    tags: [],
    created_at: randomPast(),
  });

  const ephemeral = generateSecretKey();
  const conversation = nip44.v2.utils.getConversationKey(ephemeral, args.recipientPubkey);
  return finalizeEvent(
    {
      kind: GIFT_WRAP_KIND,
      content: nip44.v2.encrypt(JSON.stringify(seal), conversation),
      created_at: randomPast(),
      tags: [['p', args.recipientPubkey.toLowerCase()]],
    },
    ephemeral,
  );
}

/** Open a gift wrap with the recipient's signer. Returns null for anything that isn't an enrollment. */
export async function openEnrollmentWrap(
  wrap: NostrEvent,
  decrypt: (senderPubkey: string, ciphertext: string) => Promise<string>,
): Promise<{ user: string; partner: string } | null> {
  if (wrap.kind !== GIFT_WRAP_KIND || typeof wrap.content !== 'string' || !HEX.test(wrap.pubkey)) return null;
  try {
    const seal = JSON.parse(await decrypt(wrap.pubkey, wrap.content)) as NostrEvent;
    if (!seal || seal.kind !== SEAL_KIND || typeof seal.content !== 'string' || !HEX.test(seal.pubkey)) return null;
    const rumor = JSON.parse(await decrypt(seal.pubkey, seal.content)) as {
      pubkey?: string;
      kind?: number;
      content?: string;
      tags?: string[][];
    };
    if (rumor.pubkey?.toLowerCase() !== seal.pubkey.toLowerCase()) return null;
    if (rumor.kind !== ENROLLMENT_RUMOR_KIND) return null;
    if (rumor.tags?.find(([n]) => n === 'd')?.[1] !== ENROLLMENT_D_TAG) return null;
    const body = JSON.parse(rumor.content ?? '') as { v?: number; partner?: string };
    if (body.v !== 1 || typeof body.partner !== 'string' || !HEX.test(body.partner)) return null;
    return { user: seal.pubkey.toLowerCase(), partner: body.partner.toLowerCase() };
  } catch {
    return null;
  }
}
