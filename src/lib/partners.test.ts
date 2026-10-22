import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import type { NostrEvent } from '@nostrify/nostrify';

import { applyAffiliateRules, type AffiliateRule } from './affiliates';
import { OWNER_PUBKEY } from './saveddProtocol';
import {
  buildPartnerDirectoryEvent,
  createEnrollmentGiftWrap,
  isValidPartnerSlug,
  mergeAffiliateRules,
  openEnrollmentWrap,
  parsePartnerDirectory,
} from './partners';

const AMAZON_CENTRAL: AffiliateRule = { host: 'amazon.ca', mode: 'param', params: { tag: 'savedd-21' } };
const AMAZON_PARTNER: AffiliateRule = { host: 'amazon.ca', mode: 'param', params: { tag: 'glenn-21' } };
const EBAY: AffiliateRule = { host: 'ebay.com', mode: 'param', params: { campid: 'savedd' } };

function hexKey(): { sk: Uint8Array; pk: string } {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return { sk, pk: typeof pk === 'string' ? pk : '' };
}

describe('partner slugs', () => {
  it('accepts a plain name and rejects reserved paths', () => {
    expect(isValidPartnerSlug('glennbeck')).toBe(true);
    expect(isValidPartnerSlug('glenn-beck')).toBe(true);
    expect(isValidPartnerSlug('admin')).toBe(false);
    expect(isValidPartnerSlug('heaven')).toBe(false);
    expect(isValidPartnerSlug('a')).toBe(false);
    expect(isValidPartnerSlug('-glenn')).toBe(false);
  });
});

describe('partner directory', () => {
  it('ignores a directory that is not signed by the team', () => {
    const stranger = 'd'.repeat(64);
    const template = buildPartnerDirectoryEvent([
      { slug: 'glennbeck', pubkey: 'ab'.repeat(32), name: 'Glenn Beck' },
    ]);
    const event = {
      id: 'e'.repeat(64),
      pubkey: stranger,
      kind: template.kind,
      created_at: 1,
      content: template.content,
      tags: template.tags,
      sig: 'f'.repeat(128),
    } as NostrEvent;
    expect(parsePartnerDirectory(event, new Set([OWNER_PUBKEY]))).toEqual([]);
    expect(parsePartnerDirectory(event, new Set([stranger]))).toEqual([
      { slug: 'glennbeck', pubkey: 'ab'.repeat(32), name: 'Glenn Beck' },
    ]);
  });
});

describe('affiliate failover', () => {
  it('uses the partner rule for a host they cover and Savedd for the rest', () => {
    const rules = mergeAffiliateRules([AMAZON_PARTNER], [AMAZON_CENTRAL, EBAY]);
    expect(applyAffiliateRules('https://www.amazon.ca/dp/1', rules)).toContain('tag=glenn-21');
    expect(applyAffiliateRules('https://www.ebay.com/itm/1', rules)).toContain('campid=savedd');
  });
});

describe('encrypted enrollment', () => {
  it('hides the visitor and the partner from everyone except the recipient', async () => {
    const visitor = hexKey();
    const partner = hexKey();
    const owner = hexKey();
    const encrypt = (recipient: string, plaintext: string) =>
      Promise.resolve(nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(visitor.sk, recipient)));
    const signEvent = (template: { kind: number; content: string; tags: string[][]; created_at: number }) =>
      Promise.resolve(finalizeEvent(template, visitor.sk));

    const toPartner = await createEnrollmentGiftWrap({
      userPubkey: visitor.pk,
      partnerPubkey: partner.pk,
      recipientPubkey: partner.pk,
      encrypt,
      signEvent,
    });

    expect(toPartner.pubkey).not.toBe(visitor.pk);
    expect(toPartner.pubkey).not.toBe(partner.pk);
    expect(toPartner.tags).toEqual([['p', partner.pk]]);
    expect(JSON.stringify(toPartner)).not.toContain(visitor.pk);

    const decryptPartner = (sender: string, ciphertext: string) =>
      Promise.resolve(nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(partner.sk, sender)));
    await expect(openEnrollmentWrap(toPartner, decryptPartner)).resolves.toEqual({
      user: visitor.pk,
      partner: partner.pk,
    });

    const decryptOwner = (sender: string, ciphertext: string) =>
      Promise.resolve(nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(owner.sk, sender)));
    await expect(openEnrollmentWrap(toPartner, decryptOwner)).resolves.toBeNull();
  });
});
