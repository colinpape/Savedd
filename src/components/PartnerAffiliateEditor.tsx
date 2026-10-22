/**
 * An approved partner's own affiliate rules. Visitors they referred use
 * these first; Savedd's rules cover every host missing from this list.
 */
import { useState } from 'react';
import { CheckCircle2, Loader2, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/useToast';
import { usePartnerAffiliateActions, usePartnerAffiliateRules } from '@/hooks/usePartners';
import {
  isValidAffiliateRule,
  normalizeHostInput,
  paramsFromUrl,
  type AffiliateRule,
} from '@/lib/affiliates';

export function PartnerAffiliateEditor({ pubkey }: { pubkey: string }) {
  const { rules, isLoading } = usePartnerAffiliateRules(pubkey);
  const { updateRules } = usePartnerAffiliateActions();
  const { toast } = useToast();
  const [override, setOverride] = useState<AffiliateRule[] | null>(null);
  const current = override ?? rules;
  const dirty = override !== null && JSON.stringify(override) !== JSON.stringify(rules);
  const [host, setHost] = useState('');
  const [mode, setMode] = useState<AffiliateRule['mode']>('param');
  const [paramRows, setParamRows] = useState<{ k: string; v: string }[]>([{ k: '', v: '' }]);
  const [importUrl, setImportUrl] = useState('');
  const [target, setTarget] = useState('');
  const [pending, setPending] = useState(false);

  const handleImport = () => {
    const parsed = paramsFromUrl(importUrl);
    if (!parsed) {
      toast({ title: 'Not a URL', description: 'Paste a full affiliate link.', variant: 'destructive' });
      return;
    }
    setHost(parsed.host);
    setMode('param');
    const rows = Object.entries(parsed.params).map(([k, v]) => ({ k, v }));
    setParamRows(rows.length > 0 ? rows : [{ k: '', v: '' }]);
    setImportUrl('');
  };

  const handleAdd = () => {
    const params = mode === 'param'
      ? Object.fromEntries(paramRows.map((r) => [r.k.trim(), r.v.trim()]).filter(([k, v]) => k && v))
      : undefined;
    const rule: AffiliateRule = {
      host: normalizeHostInput(host),
      mode,
      params,
      target: mode === 'redirect' ? target.trim() : undefined,
    };
    if (!isValidAffiliateRule(rule)) {
      toast({ title: 'Invalid rule', description: 'Check the host and the link or parameters.', variant: 'destructive' });
      return;
    }
    if (current.some((r) => r.host === rule.host)) {
      toast({ title: 'Duplicate host', description: 'Remove the existing rule for that site first.', variant: 'destructive' });
      return;
    }
    setOverride([...current, rule]);
    setHost('');
    setParamRows([{ k: '', v: '' }]);
    setTarget('');
  };

  const handlePublish = async () => {
    setPending(true);
    try {
      await updateRules(current);
      setOverride(null);
      toast({ title: 'Your links are published', description: 'People you refer will use them within a minute.' });
    } catch (err) {
      toast({ title: 'Publish failed', description: err instanceof Error ? err.message : 'Publish failed', variant: 'destructive' });
    } finally {
      setPending(false);
    }
  };

  if (isLoading && override === null && rules.length === 0) return null;

  return (
    <Card>
      <CardContent className="py-4 space-y-3">
        <div>
          <p className="text-sm font-medium">Your affiliate links</p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            For people who arrived through your link, your rule is used when you have one
            for that site. Otherwise Savedd's link is used. Everyone else is unchanged.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Input placeholder="Host (amazon.ca)" value={host} onChange={(e) => setHost(e.target.value)} className="font-mono text-sm flex-1 min-w-36" />
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as AffiliateRule['mode'])}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            aria-label="Rule type"
          >
            <option value="param">Query param</option>
            <option value="redirect">Referral link</option>
          </select>
        </div>
        {mode === 'param' ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input placeholder="Paste a full affiliate URL to auto-fill…" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} className="font-mono text-xs" />
              <Button variant="outline" size="sm" onClick={handleImport} disabled={!importUrl.trim()}>Auto-fill</Button>
            </div>
            {paramRows.map((row, i) => (
              <div key={i} className="flex gap-2">
                <Input placeholder="Param" value={row.k} onChange={(e) => setParamRows(paramRows.map((r, j) => j === i ? { ...r, k: e.target.value } : r))} className="font-mono text-sm w-28" />
                <Input placeholder="Value" value={row.v} onChange={(e) => setParamRows(paramRows.map((r, j) => j === i ? { ...r, v: e.target.value } : r))} className="font-mono text-sm flex-1" />
              </div>
            ))}
            {paramRows.length < 10 && (
              <Button variant="ghost" size="sm" onClick={() => setParamRows([...paramRows, { k: '', v: '' }])}>Add parameter</Button>
            )}
          </div>
        ) : (
          <Input placeholder="https://example.com/invite/your-code" value={target} onChange={(e) => setTarget(e.target.value)} className="font-mono text-xs" />
        )}
        <Button variant="outline" size="sm" onClick={handleAdd}>Add site</Button>
        <div className="space-y-1.5">
          {current.length === 0 && <p className="text-xs text-muted-foreground">No sites yet. Savedd's links are used until you add one.</p>}
          {current.map((rule) => (
            <div key={rule.host} className="flex items-center gap-2 text-xs">
              <span className="font-mono flex-1 truncate">{rule.host}</span>
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Remove ${rule.host}`} onClick={() => setOverride(current.filter((r) => r.host !== rule.host))}>
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <Button onClick={() => void handlePublish()} disabled={pending || !dirty}>
          {pending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-1.5" />}
          Publish your links
        </Button>
      </CardContent>
    </Card>
  );
}
