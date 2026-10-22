/**
 * When a referred visitor logs in, publish one encrypted enrollment to
 * the partner and one to the owner. The browser referrer is unchanged
 * either way — affiliate links do not depend on this record.
 */
import { useEffect, useRef } from 'react';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { usePartnerDirectory } from '@/hooks/usePartners';
import { useReferralConfig } from '@/hooks/useReferrals';
import { publishToRelayPool } from '@/lib/searchRelays';
import { getModerationRelayUrls } from '@/lib/moderation';
import { getStoredReferrer } from '@/lib/referrals';
import { createEnrollmentGiftWrap } from '@/lib/partners';
import { OWNER_PUBKEY } from '@/lib/saveddProtocol';

const LS_ENROLLED = 'savedd:referral-enrolled';

export function ReferralEnrollment() {
  const { user } = useCurrentUser();
  const { config, isLoading: configLoading } = useReferralConfig();
  const { partners, isLoading } = usePartnerDirectory();
  const started = useRef(false);

  useEffect(() => {
    if (started.current || configLoading || isLoading) return;
    if (!config.enabled || !user?.signer.nip44) return;
    const stored = getStoredReferrer();
    if (!stored || stored.pubkey === user.pubkey) return;
    if (!partners.some((p) => p.pubkey === stored.pubkey)) return;

    const flag = `${user.pubkey}:${stored.pubkey}`;
    try {
      if (localStorage.getItem(LS_ENROLLED) === flag) return;
    } catch {
      return;
    }
    started.current = true;

    const encrypt = user.signer.nip44.encrypt.bind(user.signer.nip44);
    const signEvent = user.signer.signEvent.bind(user.signer);
    const recipients = [...new Set([stored.pubkey, OWNER_PUBKEY])];

    void (async () => {
      let partnerAccepted = false;
      for (const recipient of recipients) {
        try {
          const wrap = await createEnrollmentGiftWrap({
            userPubkey: user.pubkey,
            partnerPubkey: stored.pubkey,
            recipientPubkey: recipient,
            encrypt,
            signEvent,
          });
          const accepted = await publishToRelayPool(getModerationRelayUrls(), wrap, 12_000);
          if (recipient === stored.pubkey && accepted > 0) partnerAccepted = true;
        } catch {
          // A lost enrollment undercounts signups. The browser referrer still works.
        }
      }
      if (partnerAccepted) {
        try { localStorage.setItem(LS_ENROLLED, flag); } catch { /* ignore */ }
      }
    })();
  }, [user, config, configLoading, partners, isLoading]);

  return null;
}
