import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const DOMAINS = ["tinola.eu.cc", "schiro.qzz.io", "schiro.dpdns.org", "mailshed.dev", "inboxfwd.net", "tempbox.one"] as const;

export type Domain = (typeof DOMAINS)[number];

export function getTempMailDomains(): readonly Domain[] {
  return DOMAINS;
}

export default function InboxCreatorCard(props: {
  loadingInbox: boolean;
  address: string | null;
  expiresAt: string | null;

  selectedDomain: Domain | null;
  onSelectedDomainChange: (d: Domain) => void;

  localPart: string;
  onLocalPartChange: (v: string) => void;

  onCreate: () => void;
  onRegenerate: () => void;
  onCopy: () => void;
  onClear: () => void;
}) {
  const {
    loadingInbox,
    address,
    expiresAt,
    selectedDomain,
    onSelectedDomainChange,
    localPart,
    onLocalPartChange,
    onCreate,
    onRegenerate,
    onCopy,
    onClear,
  } = props;

  const hasInbox = Boolean(address);

  return (
    <Card className="glass border-border/80 shadow-elev">
      <div className="p-5 md:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">Your temporary address</div>
            <div className="mt-1 text-sm font-medium">
              <span className="text-mono break-all">{address ?? (loadingInbox ? "Loading…" : "—")}</span>
            </div>
            {expiresAt ? (
              <div className="mt-1 text-xs text-muted-foreground">
                Expires: {new Date(expiresAt).getFullYear() >= 3000 ? "Never" : new Date(expiresAt).toLocaleString()}
              </div>
            ) : null}
          </div>

          <Button
            size="icon"
            variant="outline"
            onClick={onRegenerate}
            aria-label="Regenerate inbox"
            disabled={loadingInbox || !hasInbox}
          >
            <RotateCcw />
          </Button>
        </div>

        <div className="mt-4 grid gap-2">
          <label className="text-xs text-muted-foreground">Email name (optional)</label>
          <Input
            value={localPart}
            onChange={(e) => onLocalPartChange(e.target.value)}
            placeholder="e.g. my.signup"
            className="text-mono"
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Email name"
            disabled={loadingInbox}
          />
          <div className="text-xs text-muted-foreground">
            Leave blank to randomize. Allowed: letters, numbers, dot, underscore, hyphen.
          </div>

          <label className="mt-2 text-xs text-muted-foreground">Choose domain</label>
          <Select value={selectedDomain ?? undefined} onValueChange={(v) => onSelectedDomainChange(v as Domain)} disabled={loadingInbox}>
            <SelectTrigger className="text-mono">
              <SelectValue placeholder="Select a domain" />
            </SelectTrigger>
            <SelectContent>
              {DOMAINS.map((d) => (
                <SelectItem key={d} value={d} className="text-mono">
                  @{d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="mt-3">
            <Button
              variant="hero"
              className="w-full"
              onClick={onCreate}
              disabled={loadingInbox || !selectedDomain}
            >
              {hasInbox ? "Create new email" : "Create email"}
            </Button>
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="glass" className="flex-1" onClick={onCopy} disabled={!hasInbox}>
              Copy
            </Button>
            <Button variant="outline" className="flex-1" onClick={onClear} disabled={!hasInbox}>
              Clear
            </Button>
          </div>

          <div className="mt-2 rounded-lg border bg-background/60 p-3 text-xs text-muted-foreground">
            Tip: Create an email first, then press “Receive” to deliver a real test message.
          </div>
        </div>
      </div>
    </Card>
  );
}
