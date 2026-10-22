/**
 * Partner directory, applications, per-partner affiliate rules, and the
 * encrypted signup count. Visitors read the directory to resolve a vanity
 * slug. Only an approved partner's own rules are applied, and only for
 * browsers that arrived through that partner.
 */
import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';

import { queryRelayPool, publishToRelayPool } from '@/lib/searchRelays';
import { getModerationRelayUrls } from '@/lib/moderation';
import {
  OWNER_PUBKEY,
  ROLES_KIND,
  ROLE_LIST_D_TAGS,
  PERMISSIONS,
  SAVEDD_PROTOCOL,
  resolveRoleEvents,
} from '@/lib/saveddProtocol';
import {
  parseAffiliateRules,
  buildAffiliateRulesEvent,
  type AffiliateRule,
} from '@/lib/affiliates';
import { useAffiliateRules } from '@/hooks/useAffiliates';
import { useAdminAccess } from '@/hooks/useAdminAccess';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { getStoredReferrer } from '@/lib/referrals';
import {
  GIFT_WRAP_KIND,
  buildPartnerApplicationEvent,
  buildPartnerDirectoryEvent,
  mergeAffiliateRules,
  openEnrollmentWrap,
  parsePartnerApplication,
  parsePartnerDirectory,
  type PartnerApplication,
  type PartnerRecord,
} from '@/lib/partners';

async function publishSigned(
  signEvent: (template: { kind: number; content: string; tags: string[][]; created_at: number }) => Promise<NostrEvent>,
  template: { kind: number; content: string; tags: string[][] },
): Promise<void> {
  let event: NostrEvent;
  try {
    event = await signEvent({ ...template, created_at: Math.floor(Date.now() / 1000) });
  } catch {
    throw new Error('Signing failed — your signer did not respond. Check its connection and try again.');
  }
  let accepted = await publishToRelayPool(getModerationRelayUrls(), event, 12_000);
  if (accepted === 0) {
    await new Promise((r) => setTimeout(r, 2000));
    accepted = await publishToRelayPool(getModerationRelayUrls(), event, 12_000);
  }
  if (accepted === 0) throw new Error('No relay accepted the event — check your connection and try again.');
}

function useTrustedAuthors() {
  return useQuery({
    queryKey: ['partner-directory'],
    queryFn: async ({ signal }) => {
      const filters: NostrFilter[] = [
        {
          kinds: [ROLES_KIND],
          authors: [OWNER_PUBKEY],
          '#d': [...ROLE_LIST_D_TAGS],
          limit: ROLE_LIST_D_TAGS.length,
        },
        { kinds: [ROLES_KIND], '#d': [SAVEDD_PROTOCOL.partnerDirectory], limit: 10 },
      ];
      const settled = await queryRelayPool(getModerationRelayUrls(), filters, { signal, timeoutMs: 5000 });
      const roleEvents: NostrEvent[] = [];
      const directoryEvents: NostrEvent[] = [];
      for (const value of settled) {
        for (const event of value) {
          if (event.kind !== ROLES_KIND) continue;
          const d = event.tags.find(([n]) => n === 'd')?.[1];
          if (d === SAVEDD_PROTOCOL.partnerDirectory) directoryEvents.push(event);
          else roleEvents.push(event);
        }
      }
      const { admins } = resolveRoleEvents(roleEvents);
      const trusted = new Set([OWNER_PUBKEY, ...admins]);
      let best: NostrEvent | null = null;
      for (const event of directoryEvents) {
        if (!trusted.has(event.pubkey)) continue;
        if (!best || event.created_at > best.created_at) best = event;
      }
      return { partners: best ? parsePartnerDirectory(best, trusted) : [], trusted: [...trusted] };
    },
    staleTime: 5 * 60_000,
    retry: 0,
  });
}

export function usePartnerDirectory(): { partners: PartnerRecord[]; isLoading: boolean } {
  const { data, isLoading } = useTrustedAuthors();
  return { partners: data?.partners ?? [], isLoading };
}

export function usePartnerApplications(): { applications: PartnerApplication[]; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['partner-applications'],
    queryFn: async ({ signal }) => {
      const settled = await queryRelayPool(
        getModerationRelayUrls(),
        [{ kinds: [ROLES_KIND], '#d': [SAVEDD_PROTOCOL.partnerApplication], limit: 80 }],
        { signal, timeoutMs: 5000 },
      );
      const latest = new Map<string, NostrEvent>();
      for (const value of settled) {
        for (const event of value) {
          const existing = latest.get(event.pubkey);
          if (!existing || event.created_at > existing.created_at) latest.set(event.pubkey, event);
        }
      }
      return [...latest.values()]
        .map(parsePartnerApplication)
        .filter((a): a is PartnerApplication => !!a)
        .sort((a, b) => b.at - a.at);
    },
    staleTime: 60_000,
    retry: 0,
  });
  return { applications: data ?? [], isLoading };
}

export function usePartnerAdminActions() {
  const { user } = useCurrentUser();
  const { role } = useAdminAccess();
  const queryClient = useQueryClient();
  const canManage = !!user && PERMISSIONS.canManageAffiliates(role);

  const publishDirectory = useCallback(async (partners: PartnerRecord[]) => {
    if (!user || !canManage) throw new Error('Only the owner or an admin can approve partners');
    await publishSigned(user.signer.signEvent.bind(user.signer), buildPartnerDirectoryEvent(partners));
    setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['partner-directory'] }), 2000);
  }, [user, canManage, queryClient]);

  return { canManage, publishDirectory };
}

export function usePartnerApplicationActions() {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  const apply = useCallback(async (input: { slug: string; name: string; note: string }) => {
    if (!user) throw new Error('Log in to apply');
    await publishSigned(user.signer.signEvent.bind(user.signer), buildPartnerApplicationEvent(input));
    setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['partner-applications'] }), 2000);
  }, [user, queryClient]);

  return { apply };
}

export function usePartnerAffiliateRules(pubkey: string | null): { rules: AffiliateRule[]; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['partner-affiliates', pubkey ?? ''],
    enabled: !!pubkey,
    queryFn: async ({ signal }) => {
      const settled = await queryRelayPool(
        getModerationRelayUrls(),
        [{
          kinds: [ROLES_KIND],
          authors: [pubkey!],
          '#d': [SAVEDD_PROTOCOL.partnerAffiliates],
          limit: 5,
        }],
        { signal, timeoutMs: 5000 },
      );
      let best: NostrEvent | null = null;
      for (const value of settled) {
        for (const event of value) {
          if (event.pubkey !== pubkey) continue;
          if (!best || event.created_at > best.created_at) best = event;
        }
      }
      return best ? parseAffiliateRules(best, new Set([pubkey!]), SAVEDD_PROTOCOL.partnerAffiliates) : [];
    },
    staleTime: 5 * 60_000,
    retry: 0,
  });
  return { rules: data ?? [], isLoading: !!pubkey && isLoading };
}

export function usePartnerAffiliateActions() {
  const { user } = useCurrentUser();
  const { partners } = usePartnerDirectory();
  const queryClient = useQueryClient();
  const approved = !!user && partners.some((p) => p.pubkey === user.pubkey);

  const updateRules = useCallback(async (rules: AffiliateRule[]) => {
    if (!user || !approved) throw new Error('Only an approved partner can publish these links');
    const template = buildAffiliateRulesEvent(
      rules,
      SAVEDD_PROTOCOL.partnerAffiliates,
      'SAVEDD partner affiliate links',
    );
    await publishSigned(user.signer.signEvent.bind(user.signer), template);
    setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ['partner-affiliates', user.pubkey] });
    }, 2000);
  }, [user, approved, queryClient]);

  return { approved, updateRules };
}

/** Central rules, with the referring partner's rules in front when they have any. */
export function useEffectiveAffiliateRules(): { rules: AffiliateRule[]; isLoading: boolean } {
  const { rules: central, isLoading: centralLoading } = useAffiliateRules();
  const { partners, isLoading: directoryLoading } = usePartnerDirectory();
  const stored = getStoredReferrer();
  const partnerPubkey = stored && partners.some((p) => p.pubkey === stored.pubkey) ? stored.pubkey : null;
  const { rules: partnerRules, isLoading: partnerLoading } = usePartnerAffiliateRules(partnerPubkey);
  const rules = useMemo(
    () => (partnerPubkey ? mergeAffiliateRules(partnerRules, central) : central),
    [partnerPubkey, partnerRules, central],
  );
  return { rules, isLoading: centralLoading || directoryLoading || partnerLoading };
}

export function usePartnerSignupCount(pubkey: string | null): { count: number | null; isLoading: boolean } {
  const { user } = useCurrentUser();
  const canDecrypt = !!user && user.pubkey === pubkey && !!user.signer.nip44;
  const { data, isLoading } = useQuery({
    queryKey: ['partner-signups', pubkey ?? ''],
    enabled: canDecrypt,
    queryFn: async ({ signal }) => {
      const decrypt = user!.signer.nip44!.decrypt.bind(user!.signer.nip44);
      const settled = await queryRelayPool(
        getModerationRelayUrls(),
        [{ kinds: [GIFT_WRAP_KIND], '#p': [pubkey!], limit: 300 }],
        { signal, timeoutMs: 8000 },
      );
      const users = new Set<string>();
      for (const value of settled) {
        for (const event of value) {
          const opened = await openEnrollmentWrap(event, decrypt);
          if (opened && opened.partner === pubkey) users.add(opened.user);
        }
      }
      return users.size;
    },
    staleTime: 60_000,
    retry: 0,
  });
  return { count: canDecrypt ? (data ?? 0) : null, isLoading: canDecrypt && isLoading };
}
