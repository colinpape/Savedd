/**
 * Approve or remove partners. Applications are public (the person is
 * asking for a public link). The directory is the allow-list.
 */
import { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/useToast';
import { usePartnerAdminActions, usePartnerApplications, usePartnerDirectory } from '@/hooks/usePartners';
import { isValidPartnerSlug, normalizePartnerSlug } from '@/lib/partners';

function shortKey(pubkey: string): string {
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

export function PartnerAdmin() {
  const { partners, isLoading } = usePartnerDirectory();
  const { applications, isLoading: appsLoading } = usePartnerApplications();
  const { publishDirectory } = usePartnerAdminActions();
  const { toast } = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const [slugs, setSlugs] = useState<Record<string, string>>({});

  const pendingApps = applications.filter((a) => !partners.some((p) => p.pubkey === a.pubkey));

  const approve = async (pubkey: string, name: string, requested: string) => {
    const slug = normalizePartnerSlug(slugs[pubkey] ?? requested);
    if (!isValidPartnerSlug(slug)) {
      toast({ title: 'Slug not available', description: 'Use a short name that is not already a page, such as glennbeck.', variant: 'destructive' });
      return;
    }
    if (partners.some((p) => p.slug === slug)) {
      toast({ title: 'Slug taken', description: 'Another partner already has that link.', variant: 'destructive' });
      return;
    }
    setPending(pubkey);
    try {
      await publishDirectory([...partners, { slug, pubkey, name }]);
      toast({ title: 'Partner approved', description: `savedd.com/${slug} is theirs.` });
    } catch (err) {
      toast({ title: 'Publish failed', description: err instanceof Error ? err.message : 'Publish failed', variant: 'destructive' });
    } finally {
      setPending(null);
    }
  };

  const remove = async (pubkey: string) => {
    setPending(pubkey);
    try {
      await publishDirectory(partners.filter((p) => p.pubkey !== pubkey));
      toast({ title: 'Partner removed', description: 'Their vanity link and affiliate rules no longer apply.' });
    } catch (err) {
      toast({ title: 'Publish failed', description: err instanceof Error ? err.message : 'Publish failed', variant: 'destructive' });
    } finally {
      setPending(null);
    }
  };

  return (
    <Card>
      <CardContent className="py-4 space-y-4">
        <div>
          <p className="text-sm font-medium">Approved partners</p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            An approved partner gets savedd.com/their-name. People who arrive that way
            use the partner's affiliate links first, then Savedd's. A login from
            one of those browsers is recorded encrypted to you and to the partner —
            the partner dashboard shows a count, not the names.
          </p>
        </div>
        {isLoading ? <p className="text-xs text-muted-foreground">Loading…</p> : partners.length === 0 ? (
          <p className="text-xs text-muted-foreground">No approved partners yet.</p>
        ) : (
          <div className="space-y-1.5">
            {partners.map((p) => (
              <div key={p.pubkey} className="flex items-center gap-2 text-xs">
                <span className="font-mono flex-1 truncate">/{p.slug}</span>
                <span className="text-muted-foreground truncate">{p.name}</span>
                <span className="font-mono text-muted-foreground/70">{shortKey(p.pubkey)}</span>
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Remove ${p.slug}`} disabled={pending === p.pubkey} onClick={() => void remove(p.pubkey)}>
                  {pending === p.pubkey ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                </Button>
              </div>
            ))}
          </div>
        )}
        <div>
          <p className="text-sm font-medium mb-2">Applications</p>
          {appsLoading ? <p className="text-xs text-muted-foreground">Loading…</p> : pendingApps.length === 0 ? (
            <p className="text-xs text-muted-foreground">No pending applications.</p>
          ) : (
            <div className="space-y-2">
              {pendingApps.map((a) => (
                <div key={a.pubkey} className="flex flex-wrap items-center gap-2 text-xs border border-border/60 rounded-lg px-3 py-2">
                  <div className="flex-1 min-w-40">
                    <p className="font-medium">{a.name}</p>
                    <p className="font-mono text-muted-foreground">{shortKey(a.pubkey)}</p>
                    {a.note && <p className="text-muted-foreground mt-1">{a.note}</p>}
                  </div>
                  <Input
                    value={slugs[a.pubkey] ?? a.slug}
                    onChange={(e) => setSlugs({ ...slugs, [a.pubkey]: e.target.value })}
                    className="font-mono text-xs w-36"
                    aria-label={`Slug for ${a.name}`}
                  />
                  <Button size="sm" disabled={pending === a.pubkey} onClick={() => void approve(a.pubkey, a.name, a.slug)}>
                    Approve
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
