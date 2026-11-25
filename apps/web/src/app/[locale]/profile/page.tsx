"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, useToast } from "@saath/ui";
import { parseProblemDetail, type UserProfile } from "@saath/contracts";
import { usePathname, useRouter } from "@/i18n/navigation";
import { useAuth } from "@/components/AuthProvider";

export default function ProfilePage() {
  const t = useTranslations("profile");
  const tCommon = useTranslations("common");
  const { authKind, apiClient, openOtpModal, setUser, logout } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();

  const meQuery = useQuery({
    queryKey: ["me"],
    enabled: authKind === "user",
    queryFn: async () => {
      const { data, error } = await apiClient.GET("/v1/me");
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || "Failed to load profile");
      }
      return data;
    },
  });

  const [displayAlias, setDisplayAlias] = useState("");
  const [locale, setLocale] = useState<"en" | "hi">("en");
  const [genderSelf, setGenderSelf] = useState<UserProfile["gender_self"]>("undisclosed");
  const [womenOnlyDefault, setWomenOnlyDefault] = useState(false);

  useEffect(() => {
    if (meQuery.data) {
      setUser(meQuery.data);
      setDisplayAlias(meQuery.data.display_alias ?? "");
      setLocale(meQuery.data.locale);
      setGenderSelf(meQuery.data.gender_self);
      setWomenOnlyDefault(meQuery.data.women_only_default);
    }
  }, [meQuery.data, setUser]);

  const updateMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await apiClient.PATCH("/v1/me", {
        body: {
          display_alias: displayAlias.trim() || null,
          locale,
          gender_self: genderSelf,
          women_only_default: womenOnlyDefault,
        },
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || "Failed to save profile");
      }
      return data;
    },
    onSuccess: async (updated) => {
      setUser(updated);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      showToast({ variant: "success", message: t("savedToast") });
      router.replace(pathname, { locale: updated.locale });
    },
    onError: (err) => {
      showToast({ variant: "error", message: err.message });
    },
  });

  const handleSave = (ev: FormEvent) => {
    ev.preventDefault();
    updateMutation.mutate();
  };

  return (
    <div className="space-y-6">
      <h1
        className="text-2xl font-bold text-[var(--text)]"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {t("title")}
      </h1>

      {authKind !== "user" ? (
        <EmptyState
          title={t("anonTitle")}
          description={t("anonDescription")}
          primaryAction={
            <Button variant="primary" onClick={openOtpModal}>
              {t("anonVerifyCta")}
            </Button>
          }
        />
      ) : meQuery.isLoading ? (
        <section
          role="status"
          aria-live="polite"
          className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]"
        >
          <p className="text-sm font-medium text-[var(--text-muted)]">{t("loadingProfile")}</p>
          <div className="h-5 w-40 animate-pulse rounded bg-[var(--surface-2)]" />
          <div className="h-12 w-full animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-2)]" />
          <div className="h-12 w-full animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-2)]" />
        </section>
      ) : meQuery.isError ? (
        <EmptyState
          title={t("loadErrorTitle")}
          description={meQuery.error.message || t("loadErrorDescription")}
          primaryAction={
            <Button variant="primary" onClick={() => void meQuery.refetch()}>
              {tCommon("retry")}
            </Button>
          }
        />
      ) : (
        <div className="space-y-5">
          <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
            <h2 className="text-sm font-semibold text-[var(--text-muted)]">
              {t("reliabilityTitle")}
            </h2>
            <p className="mt-1 text-lg font-bold text-[var(--secondary)]">
              {t("reliabilityBadge", {
                completed: meQuery.data?.reliability_completed ?? 0,
                accepted: meQuery.data?.reliability_accepted ?? 0,
              })}
            </p>
          </section>

          <form
            onSubmit={handleSave}
            className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]"
          >
            <div>
              <label
                htmlFor="profile-alias"
                className="mb-1.5 block text-sm font-medium text-[var(--text)]"
              >
                {t("aliasLabel")}
              </label>
              <input
                id="profile-alias"
                type="text"
                maxLength={40}
                value={displayAlias}
                onChange={(ev) => setDisplayAlias(ev.target.value)}
                placeholder={t("aliasPlaceholder")}
                className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3.5 text-base text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
              />
            </div>

            <div>
              <label
                htmlFor="profile-locale"
                className="mb-1.5 block text-sm font-medium text-[var(--text)]"
              >
                {t("localeLabel")}
              </label>
              <select
                id="profile-locale"
                value={locale}
                onChange={(ev) => setLocale(ev.target.value === "hi" ? "hi" : "en")}
                className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3.5 text-base text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
              >
                <option value="en">{t("localeEn")}</option>
                <option value="hi">{t("localeHi")}</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="profile-gender"
                className="mb-1.5 block text-sm font-medium text-[var(--text)]"
              >
                {t("genderLabel")}
              </label>
              <select
                id="profile-gender"
                value={genderSelf}
                onChange={(ev) =>
                  setGenderSelf(ev.target.value as UserProfile["gender_self"])
                }
                className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3.5 text-base text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
              >
                <option value="undisclosed">{t("genderUndisclosed")}</option>
                <option value="female">{t("genderFemale")}</option>
                <option value="male">{t("genderMale")}</option>
                <option value="other">{t("genderOther")}</option>
              </select>
            </div>

            <label className="flex min-h-[48px] cursor-pointer items-start gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-3.5">
              <input
                type="checkbox"
                checked={womenOnlyDefault}
                onChange={(ev) => setWomenOnlyDefault(ev.target.checked)}
                className="mt-1 h-5 w-5 accent-[var(--women-mode)]"
              />
              <div>
                <span className="block text-sm font-semibold text-[var(--text)]">
                  {t("womenOnlyLabel")}
                </span>
                <span className="block text-xs text-[var(--text-muted)]">
                  {t("womenOnlyHint")}
                </span>
              </div>
            </label>

            <div className="flex flex-wrap gap-3 pt-1">
              <Button type="submit" loading={updateMutation.isPending}>
                {t("saveCta")}
              </Button>
              <Button variant="ghost" onClick={() => void logout()}>
                {t("logoutCta")}
              </Button>
            </div>
          </form>
        </div>
      )}

      <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <h2
          className="text-base font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("emergencyTitle")}
        </h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <a
            href="tel:139"
            className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-4 text-sm font-semibold text-[var(--text)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          >
            {t("railMadad")}
          </a>
          <a
            href="tel:182"
            className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-4 text-sm font-semibold text-[var(--text)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          >
            {t("rpfHelpline")}
          </a>
        </div>
      </section>
    </div>
  );
}
