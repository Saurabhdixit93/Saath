"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, useToast } from "@saath/ui";
import type { PartySummaryDTO } from "@saath/contracts";
import { Link } from "@/i18n/navigation";

export interface PartyAvatarRowProps {
  party: PartySummaryDTO;
  serviceNo: string;
  serviceDate: string;
  onGenerateInvite: () => Promise<string | null>;
  onRemoveMember?: (seatHolderId: string) => Promise<void>;
}

export function PartyAvatarRow({
  party,
  serviceNo,
  serviceDate,
  onGenerateInvite,
  onRemoveMember,
}: PartyAvatarRowProps) {
  const t = useTranslations("journeys");
  const { showToast } = useToast();
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const hasSeniorUpper = party.members.some(
    (m) => m.age_band === "senior" && (m.seat_type === "UB" || m.seat_type === "SU")
  );
  const coaches = new Set(party.members.map((m) => m.coach).filter(Boolean));
  const splitCoaches = coaches.size > 1;

  const handleInvite = async () => {
    setInviting(true);
    try {
      const url = await onGenerateInvite();
      if (url) {
        setInviteUrl(url);
        try {
          await navigator.clipboard.writeText(
            t("inviteShareText", { serviceNo, date: serviceDate, url })
          );
        } catch {
          // Clipboard permission optional
        }
        showToast({ variant: "success", message: t("inviteCopied") });
      }
    } finally {
      setInviting(false);
    }
  };

  return (
    <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2
            className="text-base font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {t("partyTitle", {
              count: party.member_count,
              max: party.max_party_members,
            })}
          </h2>
          {party.has_organiser_pass ? (
            <span className="rounded-full border border-[var(--secondary)] bg-[var(--surface-2)] px-2.5 py-0.5 text-xs font-semibold text-[var(--secondary)]">
              {t("organiserBadge")}
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="md"
            className="px-3.5 py-2 text-sm"
            loading={inviting}
            onClick={() => void handleInvite()}
          >
            {t("addFamilyCta")}
          </Button>
          {!party.has_organiser_pass && party.member_count >= 3 ? (
            <Link
              href="/pricing"
              className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] border border-[var(--primary-btn-bg)] px-3 text-xs font-semibold text-[var(--primary-text)] hover:bg-[var(--surface-2)]"
            >
              {t("upgradeCta")}
            </Link>
          ) : null}
        </div>
      </div>

      {hasSeniorUpper ? (
        <p className="rounded-[var(--radius-sm)] border border-[var(--warning)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text)]">
          ⚠ {t("warningSeniorUpper")}
        </p>
      ) : null}
      {splitCoaches ? (
        <p className="rounded-[var(--radius-sm)] border border-[var(--warning)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text)]">
          ⚠ {t("warningSplitCoaches")}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {party.members.map((m) => {
          const ageLabel =
            m.age_band === "senior"
              ? t("ageSenior")
              : m.age_band === "child"
                ? t("ageChild")
                : m.age_band === "adult"
                  ? t("ageAdult")
                  : t("ageUnknown");
          const seatDesc = m.seat_no
            ? `${m.coach && m.coach !== "CABIN" ? `${m.coach}-` : ""}${m.seat_no} (${m.seat_type ?? ""})`
            : m.current_status ?? "WL";
          return (
            <div
              key={m.id}
              className="inline-flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs"
            >
              <span className="font-semibold text-[var(--text)]">
                #{m.pax_seq} · {ageLabel}
                {m.gender_band !== "U" ? ` (${m.gender_band})` : ""}
              </span>
              <span
                className="font-bold text-[var(--primary-text)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {seatDesc}
              </span>
              {party.leader_is_me && party.members.length > 1 && onRemoveMember ? (
                <button
                  type="button"
                  onClick={() => void onRemoveMember(m.id)}
                  className="ml-1 inline-flex min-h-[48px] min-w-[48px] items-center justify-center rounded px-2 text-xs font-semibold text-[var(--danger-text)] hover:bg-[var(--surface-2)]"
                  aria-label={`${t("removeMemberCta")} #${m.pax_seq}`}
                >
                  {t("removeMemberCta")}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {inviteUrl ? (
        <div className="space-y-1 rounded-[var(--radius-sm)] border border-[var(--secondary)] bg-[var(--surface-2)] p-3">
          <p className="text-xs font-semibold text-[var(--text)]">
            {t("inviteUrlLabel")}
          </p>
          <input
            type="text"
            readOnly
            value={inviteUrl}
            aria-label={t("inviteUrlLabel")}
            onClick={(ev) => ev.currentTarget.select()}
            className="min-h-[40px] w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2.5 text-xs text-[var(--text)]"
            style={{ fontFamily: "var(--font-mono)" }}
          />
        </div>
      ) : null}
    </section>
  );
}
