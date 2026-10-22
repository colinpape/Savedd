/**
 * `/:param` is either a Nostr id (npub, note, naddr…) or an approved
 * partner slug. A slug stores the same first-touch referrer as `?ref=`
 * and then opens the search page.
 */
import { Navigate, useParams } from 'react-router-dom';
import { nip19 } from 'nostr-tools';

import { Layout } from '@/components/Layout';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { usePartnerDirectory } from '@/hooks/usePartners';
import { useReferralConfig } from '@/hooks/useReferrals';
import { publishToRelayPool } from '@/lib/searchRelays';
import { getModerationRelayUrls } from '@/lib/moderation';
import { buildReferralPing, storeReferrer } from '@/lib/referrals';
import { isValidPartnerSlug, normalizePartnerSlug } from '@/lib/partners';
import { NIP19Page } from '@/pages/NIP19Page';

function isNip19(value: string): boolean {
  try {
    nip19.decode(value);
    return true;
  } catch {
    return false;
  }
}

const captured = new Set<string>();

function capturePartner(pubkey: string, windowDays: number, self: boolean) {
  if (captured.has(pubkey)) return;
  captured.add(pubkey);
  if (self) return;
  if (storeReferrer(pubkey, windowDays)) {
    void publishToRelayPool(getModerationRelayUrls(), buildReferralPing(pubkey), 5000).catch(() => {});
  }
}

export function SlugOrNip19() {
  const { nip19: param = '' } = useParams();
  const { user } = useCurrentUser();
  const { partners, isLoading } = usePartnerDirectory();
  const { config, isLoading: configLoading } = useReferralConfig();

  if (isNip19(param)) return <NIP19Page />;

  const slug = normalizePartnerSlug(param);
  const slugShaped = isValidPartnerSlug(slug);
  if (!slugShaped) return <NIP19Page />;
  if (isLoading || configLoading) {
    return (
      <Layout>
        <div className="container max-w-3xl py-16">
          <Skeleton className="h-10 w-48" />
        </div>
      </Layout>
    );
  }

  const partner = config.enabled ? partners.find((p) => p.slug === slug) : undefined;
  if (!partner) return <NIP19Page />;
  capturePartner(partner.pubkey, config.attributionWindowDays, user?.pubkey === partner.pubkey);
  return <Navigate to="/" replace />;
}
